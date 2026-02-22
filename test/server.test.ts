import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/server.ts';
import { MockProvider } from '../src/provider.ts';
import type { WrapperConfig } from '../src/types.ts';

const auditFile = path.join('/data/scratch', `gshield-audit-${Date.now()}.jsonl`);
process.env.SECURE_WRAPPER_AUDIT = auditFile;

const cfg: WrapperConfig = {
  server: { port: 0, bind: '127.0.0.1', maxPayloadBytes: 2048, rateLimitPerMinute: 5 },
  auth: { apiKey: 'k123', tokenSigningKey: 'sign', previousTokenSigningKey: '', tokenTtlSeconds: 3600 },
  gmail: { account: 'acct' },
  calendar: { ids: ['primary'] },
  policy: {
    email: { maxRecentDays: 2, authHandlingMode: 'block', threadContextMode: 'full_thread' },
    calendar: { defaultThisWeek: true, maxPastDays: 0, maxFutureDays: 7 },
    outbound: { replyOnlyDefault: true, recipientAllowlist: ['ok@example.com'], domainAllowlist: [], maxSendsPerHour: 5, maxSendsPerDay: 20 }
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
  const send = await app.fetch(new Request('http://local/v1/email/send', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'ok@example.com', subject: 'x', body: 'y' })
  }));
  assert.equal(send.status, 403);

  const deny = await app.fetch(new Request('http://local/v1/email/reply', {
    method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 't1', to: 'bad@example.com', subject: 'x', body: 'y' })
  }));
  assert.equal(deny.status, 403);
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
    sendNew: async () => ({ id: 'y' })
  });
  const res = await app.fetch(new Request('http://local/v1/email/unread', { headers: { 'x-api-key': 'k123' } }));
  assert.equal(res.status, 502);
  const data = await res.json() as any;
  assert.equal(data.error, 'upstream_failure');
});
