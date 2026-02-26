import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { authenticate, issueSignedToken, startReplaySweeper } from './auth.ts';
import { clampCalendarRange, clampEmailDays, allowedRecipient, allowedCalendarForWrite } from './policy.ts';
import { classifyAuthSensitive } from './redaction.ts';
import { logAudit } from './audit.ts';
import { consumeSendQuota, consumeCalendarQuota } from './rate-limit.ts';
import { GogProvider, MockProvider, type Provider } from './provider.ts';
import type { WrapperConfig } from './types.ts';

function asErr(c: any, status: number, error: string) { return c.json({ error }, status); }
const memRate = new Map<string, { bucket: string; count: number }>();
function principalRateOk(principal: string, limit: number): boolean {
  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()+1}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  const cur = memRate.get(principal);
  if (!cur || cur.bucket !== bucket) { memRate.set(principal, { bucket, count: 1 }); return true; }
  if (cur.count >= limit) return false;
  cur.count += 1;
  return true;
}

async function readBodyLimited(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; error: 'payload_too_large' | 'invalid_json' }> {
  const len = Number(req.headers.get('content-length') || '0');
  if (len > maxBytes) return { ok: false, error: 'payload_too_large' };

  if (!req.body) return { ok: true, text: '' };

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { reader.cancel(); } catch {}
      return { ok: false, error: 'payload_too_large' };
    }
    chunks.push(Buffer.from(value));
  }

  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

async function parseJsonLimited(c: any, maxBytes: number): Promise<{ ok: true; body: any } | { ok: false; error: 'payload_too_large' | 'invalid_json' }> {
  const body = await readBodyLimited(c.req.raw, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, body: JSON.parse(body.text || '{}') };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function audit(c: any, entry: Record<string, unknown> & { action: string }) {
  const principal = c.get('principal') || 'unknown';
  logAudit({ principal, ...entry });
}

function stripQuotedReplyText(text = ''): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const cutPatterns = [
    /^\s*>+/, // quoted lines
    /^\s*On\s.+wrote:\s*$/i,
    /^\s*From:\s.+$/i,
    /^\s*Sent:\s.+$/i,
    /^\s*Subject:\s.+$/i,
    /^\s*To:\s.+$/i,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^\s*Begin forwarded message:\s*$/i
  ];
  const out: string[] = [];
  for (const line of lines) {
    if (cutPatterns.some((p) => p.test(line))) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function parseCalendarIds(input: string | null | undefined, fallback: string[]): string[] {
  if (!input) return fallback;
  const ids = input.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : fallback;
}

export function buildApp(cfg: WrapperConfig, provider?: Provider) {
  const app = new Hono();
  const p: Provider = provider || (process.env.SECURE_WRAPPER_USE_MOCK === '1' ? new MockProvider() : new GogProvider(cfg.gmail.account, cfg.calendar.ids));

  app.onError((err, c) => {
    const principal = c.get('principal') || 'unknown';
    const path = c.req.path;
    const code = typeof (err as any)?.code === 'string' ? (err as any).code : 'INTERNAL_ERROR';
    logAudit({ principal, action: 'request_error', path, code });
    return asErr(c, 502, 'upstream_failure');
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'secure-wrapper-service' }));

  app.post('/v1/auth/token', async (c) => {
    const apiKey = c.req.header('x-api-key') || c.req.header('x-agent-key');
    const auth = authenticate(new Headers({ 'x-api-key': apiKey || '' }), cfg);
    if (!auth.ok) return asErr(c, 401, 'unauthorized');

    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (!body.ok) return asErr(c, body.error === 'payload_too_large' ? 413 : 400, body.error);
    const sub = typeof body.body.sub === 'string' ? body.body.sub : 'agent';
    return c.json({ token: issueSignedToken(sub, cfg), ttlSeconds: cfg.auth.tokenTtlSeconds });
  });

  app.use('/v1/*', async (c, next) => {
    const auth = authenticate(c.req.raw.headers, cfg);
    if (!auth.ok) {
      logAudit({ principal: 'unknown', action: 'auth_deny', path: c.req.path, reason: auth.reason });
      return asErr(c, 401, 'unauthorized');
    }
    const principal = auth.principal || 'unknown';
    if (!principalRateOk(principal, cfg.server.rateLimitPerMinute)) return asErr(c, 429, 'rate_limited');
    c.set('principal', principal);
    await next();
  });

  app.get('/v1/email/unread', async (c) => {
    const days = clampEmailDays(c.req.query('days') || null, cfg.policy.email.maxRecentDays);
    const contextModeQ = c.req.query('contextMode');
    const contextMode = contextModeQ === 'latest_only' || contextModeQ === 'full_thread'
      ? contextModeQ
      : cfg.policy.email.threadContextMode;
    const raw = await p.getUnreadEmails(days);

    const transformed = raw.map((m) => {
      const subject = m.subject || '';
      const snippet = contextMode === 'latest_only' ? stripQuotedReplyText(m.snippet || '') : (m.snippet || '');
      const body = contextMode === 'latest_only' ? stripQuotedReplyText(m.body || '') : (m.body || '');
      const sensitive = classifyAuthSensitive(`${subject}\n${snippet}\n${body}`);
      return {
        id: m.id,
        threadId: m.threadId,
        from: m.from || '',
        to: m.to || '',
        subject,
        snippet,
        body,
        internalDate: m.internalDate || null,
        sensitivity: sensitive ? 'auth_sensitive' : 'normal' as 'auth_sensitive' | 'normal'
      };
    });

    const items = cfg.policy.email.authHandlingMode === 'block'
      ? transformed.filter((m) => m.sensitivity === 'normal')
      : transformed;

    audit(c, {
      action: 'email_unread',
      days,
      contextMode,
      authHandlingMode: cfg.policy.email.authHandlingMode,
      blockedCount: transformed.filter((m) => m.sensitivity === 'auth_sensitive').length,
      count: items.length
    });

    return c.json({
      days,
      contextMode,
      authHandlingMode: cfg.policy.email.authHandlingMode,
      count: items.length,
      items,
      warnings: cfg.policy.email.authHandlingMode === 'warn'
        ? transformed
            .filter((m) => m.sensitivity === 'auth_sensitive')
            .map((m) => ({ id: m.id, threadId: m.threadId, wouldBlock: true, reason: 'auth_artifact_detected', category: 'auth_sensitive' }))
        : undefined
    });
  });

  app.get('/v1/calendar/events', async (c) => {
    const range = clampCalendarRange({ start: c.req.query('start'), end: c.req.query('end'), maxPastDays: cfg.policy.calendar.maxPastDays, maxFutureDays: cfg.policy.calendar.maxFutureDays, defaultThisWeek: cfg.policy.calendar.defaultThisWeek });
    const calendarIds = parseCalendarIds(c.req.query('calendars'), cfg.calendar.ids);
    const raw = await p.getCalendarEvents(range.start.toISOString(), range.end.toISOString(), calendarIds);
    const calPol = cfg.policy.calendar;
    const items = raw.map((e) => ({
      id: e.id,
      summary: e.summary || '',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      ...(calPol.allowLocation && e.location ? { location: e.location } : {}),
      ...(calPol.allowMeetingUrls && e.hangoutLink ? { hangoutLink: e.hangoutLink } : {}),
      ...(calPol.allowAttendeeEmails && e.attendees?.length
        ? { attendees: e.attendees.map((a) => ({ email: a.email, displayName: a.displayName, self: a.self, responseStatus: a.responseStatus })) }
        : {}),
    }));
    audit(c, {
      action: 'calendar_events',
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      calendars: calendarIds,
      count: items.length,
      allowAttendeeEmails: calPol.allowAttendeeEmails,
      allowLocation: calPol.allowLocation,
      allowMeetingUrls: calPol.allowMeetingUrls,
    });
    return c.json({ start: range.start.toISOString(), end: range.end.toISOString(), calendars: calendarIds, count: items.length, items });
  });

  app.post('/v1/calendar/events', async (c) => {
    const cwPol = cfg.policy.calendarWrite;
    if (!cwPol.enabled) return asErr(c, 403, 'calendar_write_disabled');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (!body.ok) return asErr(c, body.error === 'payload_too_large' ? 413 : 400, body.error);
    const { calendarId, summary, start, end, location } = body.body;
    if (!calendarId || !summary || !start || !end) return asErr(c, 400, 'missing_fields');
    if (!allowedCalendarForWrite(calendarId, cwPol.allowedCalendarIds, cfg.calendar.ids)) return asErr(c, 403, 'calendar_not_allowed');
    const attendees = cwPol.allowAttendees ? (body.body.attendees || undefined) : undefined;
    const sendUpdates = cwPol.sendUpdates;
    const lim = consumeCalendarQuota(cwPol.maxEventsPerHour, cwPol.maxEventsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.createEvent({ calendarId, summary, start, end, attendees, location, sendUpdates });
    audit(c, { action: 'calendar_create', calendarId, summary, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.patch('/v1/calendar/events/:id', async (c) => {
    const cwPol = cfg.policy.calendarWrite;
    if (!cwPol.enabled) return asErr(c, 403, 'calendar_write_disabled');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (!body.ok) return asErr(c, body.error === 'payload_too_large' ? 413 : 400, body.error);
    const eventId = c.req.param('id');
    const { calendarId, summary, start, end, location } = body.body;
    if (!calendarId) return asErr(c, 400, 'missing_fields');
    if (!allowedCalendarForWrite(calendarId, cwPol.allowedCalendarIds, cfg.calendar.ids)) return asErr(c, 403, 'calendar_not_allowed');
    const addAttendees = cwPol.allowAttendees ? (body.body.addAttendees || undefined) : undefined;
    const sendUpdates = cwPol.sendUpdates;
    const lim = consumeCalendarQuota(cwPol.maxEventsPerHour, cwPol.maxEventsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.updateEvent({ calendarId, eventId, summary, start, end, addAttendees, location, sendUpdates });
    audit(c, { action: 'calendar_update', calendarId, eventId, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.post('/v1/email/reply', async (c) => {
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (!body.ok) return asErr(c, body.error === 'payload_too_large' ? 413 : 400, body.error);
    if (!body.body.threadId || !body.body.to || !body.body.subject || !body.body.body) return asErr(c, 400, 'missing_fields');
    if (!cfg.policy.outbound.allowReplyToAnyone && !allowedRecipient(body.body.to, cfg.policy.outbound.recipientAllowlist, cfg.policy.outbound.domainAllowlist, cfg.policy.outbound.allowAllRecipients)) return asErr(c, 403, 'recipient_not_allowed');
    const lim = consumeSendQuota(cfg.policy.outbound.maxSendsPerHour, cfg.policy.outbound.maxSendsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.sendReply({ threadId: body.body.threadId, to: body.body.to, subject: body.body.subject, body: body.body.body });
    audit(c, { action: 'send_reply', to: body.body.to, threadId: body.body.threadId, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.post('/v1/email/send', async (c) => {
    if (cfg.policy.outbound.replyOnlyDefault) return asErr(c, 403, 'reply_only_mode');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (!body.ok) return asErr(c, body.error === 'payload_too_large' ? 413 : 400, body.error);
    if (!body.body.to || !body.body.subject || !body.body.body) return asErr(c, 400, 'missing_fields');
    if (!allowedRecipient(body.body.to, cfg.policy.outbound.recipientAllowlist, cfg.policy.outbound.domainAllowlist, cfg.policy.outbound.allowAllRecipients)) return asErr(c, 403, 'recipient_not_allowed');
    const lim = consumeSendQuota(cfg.policy.outbound.maxSendsPerHour, cfg.policy.outbound.maxSendsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.sendNew({ to: body.body.to, subject: body.body.subject, body: body.body.body });
    audit(c, { action: 'send_new', to: body.body.to, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.all('*', (c) => asErr(c, 404, 'deny-by-default'));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = buildApp(cfg);
  const replaySweeper = startReplaySweeper();
  replaySweeper.unref?.();
  serve({ fetch: app.fetch, port: cfg.server.port, hostname: cfg.server.bind }, () => console.log(`secure-wrapper-service listening on ${cfg.server.bind}:${cfg.server.port}`));
}
