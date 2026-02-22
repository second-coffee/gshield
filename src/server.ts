import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { authenticate, issueSignedToken } from './auth.ts';
import { clampCalendarRange, clampEmailDays, allowedRecipient } from './policy.ts';
import { classifyAuthSensitive, redactSecrets } from './redaction.ts';
import { logAudit } from './audit.ts';
import { canSend, recordSend } from './rate-limit.ts';
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
async function parseJsonLimited(c: any, maxBytes: number): Promise<any> {
  const len = Number(c.req.header('content-length') || '0');
  if (len > maxBytes) return null;
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return null;
  return JSON.parse(text || '{}');
}

export function buildApp(cfg: WrapperConfig, provider?: Provider) {
  const app = new Hono();
  const p: Provider = provider || (process.env.SECURE_WRAPPER_USE_MOCK === '1' ? new MockProvider() : new GogProvider(cfg.gmail.account, cfg.calendar.id));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/v1/auth/token', async (c) => {
    const apiKey = c.req.header('x-api-key') || c.req.header('x-agent-key');
    if (!apiKey || apiKey !== cfg.auth.apiKey) return asErr(c, 401, 'unauthorized');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (body === null) return asErr(c, 413, 'payload_too_large');
    const sub = typeof body.sub === 'string' ? body.sub : 'agent';
    return c.json({ token: issueSignedToken(sub, cfg), ttlSeconds: cfg.auth.tokenTtlSeconds });
  });

  app.use('/v1/*', async (c, next) => {
    const auth = authenticate(c.req.raw.headers, cfg);
    if (!auth.ok) {
      logAudit({ action: 'auth_deny', path: c.req.path, reason: auth.reason });
      return asErr(c, 401, 'unauthorized');
    }
    const principal = auth.principal || 'unknown';
    if (!principalRateOk(principal, cfg.server.rateLimitPerMinute)) return asErr(c, 429, 'rate_limited');
    c.set('principal', principal);
    await next();
  });

  app.get('/v1/email/unread', async (c) => {
    if (cfg.features?.emailEnabled === false) return asErr(c, 403, 'email_disabled');
    const days = clampEmailDays(c.req.query('days') || null, cfg.policy.email.maxRecentDays);
    const raw = await p.getUnreadEmails(days);
    const items = raw.map((m) => {
      const sensitive = classifyAuthSensitive(`${m.subject || ''}\n${m.snippet || ''}\n${m.body || ''}`);
      const R = (s?: string) => sensitive ? redactSecrets(s || '') : (s || '');
      return { id: m.id, threadId: m.threadId, from: R(m.from), to: R(m.to), subject: R(m.subject), snippet: R(m.snippet), body: R(m.body), internalDate: m.internalDate || null, sensitivity: sensitive ? 'auth_sensitive' : 'normal' };
    }).filter((m) => cfg.policy.email.returnSensitiveAuth ? true : m.sensitivity === 'normal');
    logAudit({ action: 'email_unread', days, count: items.length });
    return c.json({ days, count: items.length, items });
  });

  app.get('/v1/calendar/events', async (c) => {
    if (cfg.features?.calendarEnabled === false) return asErr(c, 403, 'calendar_disabled');
    const range = clampCalendarRange({ start: c.req.query('start'), end: c.req.query('end'), maxPastDays: cfg.policy.calendar.maxPastDays, maxFutureDays: cfg.policy.calendar.maxFutureDays, defaultThisWeek: cfg.policy.calendar.defaultThisWeek });
    const raw = await p.getCalendarEvents(range.start.toISOString(), range.end.toISOString());
    const items = raw.map((e) => ({ id: e.id, summary: e.summary || '', start: e.start?.dateTime || e.start?.date || null, end: e.end?.dateTime || e.end?.date || null, location: e.location || '' }));
    logAudit({ action: 'calendar_events', start: range.start.toISOString(), end: range.end.toISOString(), count: items.length });
    return c.json({ start: range.start.toISOString(), end: range.end.toISOString(), count: items.length, items });
  });

  app.post('/v1/email/reply', async (c) => {
    if (cfg.features?.emailEnabled === false) return asErr(c, 403, 'email_disabled');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (body === null) return asErr(c, 413, 'payload_too_large');
    if (!body.threadId || !body.to || !body.subject || !body.body) return asErr(c, 400, 'missing_fields');
    if (!allowedRecipient(body.to, cfg.policy.outbound.recipientAllowlist, cfg.policy.outbound.domainAllowlist)) return asErr(c, 403, 'recipient_not_allowed');
    const lim = canSend(cfg.policy.outbound.maxSendsPerHour, cfg.policy.outbound.maxSendsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.sendReply({ threadId: body.threadId, to: body.to, subject: body.subject, body: body.body });
    recordSend();
    logAudit({ action: 'send_reply', to: body.to, threadId: body.threadId, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.post('/v1/email/send', async (c) => {
    if (cfg.features?.emailEnabled === false) return asErr(c, 403, 'email_disabled');
    if (cfg.policy.outbound.replyOnlyDefault) return asErr(c, 403, 'reply_only_mode');
    const body = await parseJsonLimited(c, cfg.server.maxPayloadBytes);
    if (body === null) return asErr(c, 413, 'payload_too_large');
    if (!body.to || !body.subject || !body.body) return asErr(c, 400, 'missing_fields');
    if (!allowedRecipient(body.to, cfg.policy.outbound.recipientAllowlist, cfg.policy.outbound.domainAllowlist)) return asErr(c, 403, 'recipient_not_allowed');
    const lim = canSend(cfg.policy.outbound.maxSendsPerHour, cfg.policy.outbound.maxSendsPerDay);
    if (!lim.ok) return asErr(c, 429, lim.reason || 'rate_limited');
    const result = await p.sendNew({ to: body.to, subject: body.subject, body: body.body });
    recordSend();
    logAudit({ action: 'send_new', to: body.to, id: result.id });
    return c.json({ success: true, id: result.id });
  });

  app.all('*', (c) => asErr(c, 404, 'deny-by-default'));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = buildApp(cfg);
  serve({ fetch: app.fetch, port: cfg.server.port, hostname: cfg.server.bind }, () => console.log(`secure-wrapper-service listening on ${cfg.server.bind}:${cfg.server.port}`));
}
