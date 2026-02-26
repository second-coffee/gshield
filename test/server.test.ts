import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.ts';
import { MockProvider } from '../src/provider.ts';
import type { WrapperConfig } from '../src/types.ts';

const auditFile = path.join(os.tmpdir(), `gshield-audit-${Date.now()}.jsonl`);
process.env.SECURE_WRAPPER_AUDIT = auditFile;
process.env.SECURE_WRAPPER_REPLAY_DIR = path.join(os.tmpdir(), 'gshield-replay-test');
process.env.SECURE_WRAPPER_RATE = path.join(os.tmpdir(), `gshield-send-${Date.now()}.json`);
process.env.SECURE_WRAPPER_CALENDAR_RATE = path.join(os.tmpdir(), `gshield-cal-${Date.now()}.json`);

const cfg: WrapperConfig = {
  server: { port: 0, bind: '127.0.0.1', maxPayloadBytes: 2048, rateLimitPerMinute: 30 },
  auth: { apiKey: 'k123', tokenSigningKey: 'sign', previousTokenSigningKey: '', tokenTtlSeconds: 3600 },
  gmail: { account: 'acct' },
  calendar: { ids: ['primary'] },
  policy: {
    email: { maxRecentDays: 2, authHandlingMode: 'block', threadContextMode: 'full_thread' },
    calendar: { defaultThisWeek: true, maxPastDays: 0, maxFutureDays: 7, allowAttendeeEmails: true, allowLocation: false, allowMeetingUrls: false },
    calendarWrite: { enabled: false, allowedCalendarIds: [], allowAttendees: false, sendUpdates: 'none' as const, maxEventsPerHour: 10, maxEventsPerDay: 50 },
    outbound: { replyOnlyDefault: true, allowAllRecipients: false, allowReplyToAnyone: true, recipientAllowlist: ['ok@example.com'], domainAllowlist: [], maxSendsPerHour: 5, maxSendsPerDay: 20 }
  }
};

test('auth required', async () => {
  const app = buildApp(cfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/email/unread'));
  assert.equal(res.status, 401);
});

test('token mint then replay denied', async () => {
  const app = buildApp(cfg, new MockProvider());
  const mint = await app.fetch(new Request('http://local/v1/auth/token', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ sub: 'agent-1' })
  }));
  const { token } = await mint.json() as any;
  const ok = await app.fetch(new Request('http://local/v1/calendar/events', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(ok.status, 200);
  const replay = await app.fetch(new Request('http://local/v1/calendar/events', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(replay.status, 401);
});

test('malformed json returns 400 invalid_json (not 500)', async () => {
  const app = buildApp(cfg, new MockProvider());
  const mint = await app.fetch(new Request('http://local/v1/auth/token', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: '{bad'
  }));
  assert.equal(mint.status, 400);
  const data = await mint.json() as any;
  assert.equal(data.error, 'invalid_json');
});

test('unread filters auth sensitive', async () => {
  const provider = new MockProvider({ emails: [
    { id: '1', threadId: 't1', subject: 'hello', snippet: 'normal', body: 'full body' },
    { id: '2', threadId: 't2', subject: 'OTP 999999', snippet: 'login code 999999', body: 'code 999999' }
  ] });
  const app = buildApp(cfg, provider);
  const res = await app.fetch(new Request('http://local/v1/email/unread?days=10', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  assert.equal(data.days, 2);
  assert.equal(data.count, 1);
});

test('outbound controls enforced', async () => {
  const app = buildApp(cfg, new MockProvider());

  // replyOnlyDefault blocks new sends
  const send = await app.fetch(new Request('http://local/v1/email/send', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'ok@example.com', subject: 'x', body: 'y' })
  }));
  assert.equal(send.status, 403);

  // allowReplyToAnyone:true (default) lets replies bypass the allowlist
  const replyAllowed = await app.fetch(new Request('http://local/v1/email/reply', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 't1', to: 'anyone@example.com', subject: 'x', body: 'y' })
  }));
  assert.equal(replyAllowed.status, 200);

  // allowReplyToAnyone:false enforces the allowlist for replies too
  const strictCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, outbound: { ...cfg.policy.outbound, allowReplyToAnyone: false } } };
  const strictApp = buildApp(strictCfg, new MockProvider());
  const replyDenied = await strictApp.fetch(new Request('http://local/v1/email/reply', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 't1', to: 'bad@example.com', subject: 'x', body: 'y' })
  }));
  assert.equal(replyDenied.status, 403);
});

test('audit log contains principal', async () => {
  const app = buildApp(cfg, new MockProvider());
  fs.rmSync(auditFile, { force: true });
  const res = await app.fetch(new Request('http://local/v1/email/unread', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 200);
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
  const row = JSON.parse(lines.at(-1) || '{}');
  assert.equal(row.principal, 'api-key');
});

test('provider exception is contained and returned as upstream_failure', async () => {
  const app = buildApp(cfg, {
    getUnreadEmails: async () => { throw Object.assign(new Error('boom'), { code: 'GOG_DOWN' }); },
    getCalendarEvents: async () => [],
    sendReply: async () => ({ id: 'x' }),
    sendNew: async () => ({ id: 'y' }),
    createEvent: async () => ({ id: 'z' }),
    updateEvent: async () => ({ id: 'z' })
  });
  const res = await app.fetch(new Request('http://local/v1/email/unread', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 502);
  const data = await res.json() as any;
  assert.equal(data.error, 'upstream_failure');
});

test('calendar privacy: location and meetingUrls hidden, attendees shown by default', async () => {
  const cfgWith: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 } };
  const provider = new MockProvider({ events: [
    { id: 'e1', summary: 'Standup', location: '123 Main St', hangoutLink: 'https://meet.google.com/abc', attendees: [{ email: 'alice@example.com', self: true, responseStatus: 'accepted' }] }
  ] });
  const app = buildApp(cfgWith, provider);
  const res = await app.fetch(new Request('http://local/v1/calendar/events', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  const item = data.items[0];
  assert.equal('location' in item, false);
  assert.equal('hangoutLink' in item, false);
  assert.ok(Array.isArray(item.attendees));
  assert.equal(item.attendees[0].email, 'alice@example.com');
});

test('calendar privacy: fields exposed when flags enabled', async () => {
  const cfgWith: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendar: { ...cfg.policy.calendar, allowLocation: true, allowMeetingUrls: true, allowAttendeeEmails: true } } };
  const provider = new MockProvider({ events: [
    { id: 'e1', summary: 'Standup', location: '123 Main St', hangoutLink: 'https://meet.google.com/abc', attendees: [{ email: 'alice@example.com' }] }
  ] });
  const app = buildApp(cfgWith, provider);
  const res = await app.fetch(new Request('http://local/v1/calendar/events', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  const item = data.items[0];
  assert.equal(item.location, '123 Main St');
  assert.equal(item.hangoutLink, 'https://meet.google.com/abc');
  assert.ok(Array.isArray(item.attendees));
});

test('calendar privacy: attendees absent when allowAttendeeEmails false', async () => {
  const cfgWith: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendar: { ...cfg.policy.calendar, allowAttendeeEmails: false } } };
  const provider = new MockProvider({ events: [
    { id: 'e1', summary: 'Standup', attendees: [{ email: 'alice@example.com' }] }
  ] });
  const app = buildApp(cfgWith, provider);
  const res = await app.fetch(new Request('http://local/v1/calendar/events', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  const item = data.items[0];
  assert.equal('attendees' in item, false);
});

// --- Calendar write tests ---

test('calendar create blocked when calendarWrite.enabled is false', async () => {
  const app = buildApp(cfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' })
  }));
  assert.equal(res.status, 403);
  const data = await res.json() as any;
  assert.equal(data.error, 'calendar_write_disabled');
});

test('calendar create succeeds when enabled with valid fields', async () => {
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true } } };
  const app = buildApp(cwCfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Team Sync', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' })
  }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  assert.equal(data.success, true);
  assert.ok(data.id);
});

test('calendar create rejects unknown calendarId', async () => {
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true } } };
  const app = buildApp(cwCfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'unknown-cal', summary: 'Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' })
  }));
  assert.equal(res.status, 403);
  const data = await res.json() as any;
  assert.equal(data.error, 'calendar_not_allowed');
});

test('calendar create returns 400 for missing fields', async () => {
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true } } };
  const app = buildApp(cwCfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary' })
  }));
  assert.equal(res.status, 400);
  const data = await res.json() as any;
  assert.equal(data.error, 'missing_fields');
});

test('calendar update works with valid eventId', async () => {
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true } } };
  const app = buildApp(cwCfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events/evt123', {
    method: 'PATCH', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Updated Meeting' })
  }));
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  assert.equal(data.success, true);
});

test('calendar update blocked when calendarWrite.enabled is false', async () => {
  const app = buildApp(cfg, new MockProvider());
  const res = await app.fetch(new Request('http://local/v1/calendar/events/evt123', {
    method: 'PATCH', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Updated' })
  }));
  assert.equal(res.status, 403);
  const data = await res.json() as any;
  assert.equal(data.error, 'calendar_write_disabled');
});

test('attendees stripped when allowAttendees is false', async () => {
  let capturedInput: any = null;
  const trackingProvider: any = {
    ...new MockProvider(),
    createEvent: async (input: any) => { capturedInput = input; return { id: 'tracked' }; },
    updateEvent: async (input: any) => { capturedInput = input; return { id: 'tracked' }; },
    getUnreadEmails: async () => [],
    getCalendarEvents: async () => [],
    sendReply: async () => ({ id: 'x' }),
    sendNew: async () => ({ id: 'x' }),
  };
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true, allowAttendees: false } } };
  const app = buildApp(cwCfg, trackingProvider);

  // Create: attendees should be stripped
  await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z', attendees: ['spam@evil.com'] })
  }));
  assert.equal(capturedInput.attendees, undefined);

  // Update: addAttendees should be stripped
  capturedInput = null;
  await app.fetch(new Request('http://local/v1/calendar/events/evt1', {
    method: 'PATCH', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', addAttendees: ['spam@evil.com'] })
  }));
  assert.equal(capturedInput.addAttendees, undefined);
});

test('sendUpdates forced to policy value regardless of request', async () => {
  let capturedInput: any = null;
  const trackingProvider: any = {
    ...new MockProvider(),
    createEvent: async (input: any) => { capturedInput = input; return { id: 'tracked' }; },
    updateEvent: async () => ({ id: 'x' }),
    getUnreadEmails: async () => [],
    getCalendarEvents: async () => [],
    sendReply: async () => ({ id: 'x' }),
    sendNew: async () => ({ id: 'x' }),
  };
  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true, sendUpdates: 'none' } } };
  const app = buildApp(cwCfg, trackingProvider);
  await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z', sendUpdates: 'all' })
  }));
  assert.equal(capturedInput.sendUpdates, 'none');
});

test('rate limiting enforced for calendar mutations', async () => {
  // Reset calendar rate counter
  const calRateFile = process.env.SECURE_WRAPPER_CALENDAR_RATE!;
  fs.rmSync(calRateFile, { force: true });

  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 200 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true, maxEventsPerHour: 2, maxEventsPerDay: 5 } } };
  const app = buildApp(cwCfg, new MockProvider());
  const makeReq = () => app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' })
  }));

  const r1 = await makeReq();
  assert.equal(r1.status, 200);
  const r2 = await makeReq();
  assert.equal(r2.status, 200);
  const r3 = await makeReq();
  assert.equal(r3.status, 429);
});

test('audit log entries for calendar create/update', async () => {
  fs.rmSync(auditFile, { force: true });
  // Reset calendar rate counter for this test
  const calRateFile = process.env.SECURE_WRAPPER_CALENDAR_RATE!;
  fs.rmSync(calRateFile, { force: true });

  const cwCfg: WrapperConfig = { ...cfg, server: { ...cfg.server, rateLimitPerMinute: 100 }, policy: { ...cfg.policy, calendarWrite: { ...cfg.policy.calendarWrite, enabled: true } } };
  const app = buildApp(cwCfg, new MockProvider());

  await app.fetch(new Request('http://local/v1/calendar/events', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Audit Test', start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' })
  }));

  await app.fetch(new Request('http://local/v1/calendar/events/evt456', {
    method: 'PATCH', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'primary', summary: 'Updated Audit' })
  }));

  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const createEntry = lines.find((l: any) => l.action === 'calendar_create');
  const updateEntry = lines.find((l: any) => l.action === 'calendar_update');
  assert.ok(createEntry, 'expected calendar_create audit entry');
  assert.equal(createEntry.calendarId, 'primary');
  assert.ok(updateEntry, 'expected calendar_update audit entry');
  assert.equal(updateEntry.eventId, 'evt456');
});
