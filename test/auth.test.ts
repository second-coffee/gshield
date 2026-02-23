import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticate, issueSignedToken } from '../src/auth.ts';
import crypto from 'node:crypto';
import type { WrapperConfig } from '../src/types.ts';

const replayDir = path.join(os.tmpdir(), `gshield-auth-${Date.now()}`);
process.env.SECURE_WRAPPER_REPLAY_DIR = replayDir;

const cfg: WrapperConfig = {
  server: { port: 0, bind: '127.0.0.1', maxPayloadBytes: 2048, rateLimitPerMinute: 5 },
  auth: { apiKey: 'k123', tokenSigningKey: 'sign', previousTokenSigningKey: '', tokenTtlSeconds: 3600 },
  gmail: { account: 'acct' },
  calendar: { ids: ['primary'] },
  policy: {
    email: { maxRecentDays: 2, authHandlingMode: 'block', threadContextMode: 'full_thread' },
    calendar: { defaultThisWeek: true, maxPastDays: 0, maxFutureDays: 7, allowAttendeeEmails: true, allowLocation: false, allowMeetingUrls: false },
    outbound: { replyOnlyDefault: true, allowAllRecipients: false, allowReplyToAnyone: true, recipientAllowlist: ['ok@example.com'], domainAllowlist: [], maxSendsPerHour: 5, maxSendsPerDay: 20 }
  }
};

test('authenticate handles malformed and wrong-length signatures safely', () => {
  const malformed = authenticate(new Headers({ authorization: 'Bearer a.b' }), cfg);
  assert.equal(malformed.ok, false);

  const weirdPayload = Buffer.from('{bad-json', 'utf8').toString('base64url');
  const badSigToken = `a.${weirdPayload}.x`;
  const bad = authenticate(new Headers({ authorization: `Bearer ${badSigToken}` }), cfg);
  assert.equal(bad.ok, false);
});

test('api key compare supports mismatched lengths without throw', () => {
  const short = authenticate(new Headers({ 'x-api-key': 'x' }), cfg);
  assert.equal(short.ok, false);
  const exact = authenticate(new Headers({ 'x-api-key': 'k123' }), cfg);
  assert.equal(exact.ok, true);
});

test('replay marker is one-time even under repeated use', () => {
  fs.mkdirSync(replayDir, { recursive: true });
  const token = issueSignedToken('agent', cfg);
  const first = authenticate(new Headers({ authorization: `Bearer ${token}` }), cfg);
  const second = authenticate(new Headers({ authorization: `Bearer ${token}` }), cfg);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});

test('rejects token with unsafe jti path content', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: 'agent', iat: now, exp: now + 300, jti: '../../evil', aud: 'secure-wrapper' })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.auth.tokenSigningKey).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${sig}`;
  const out = authenticate(new Headers({ authorization: `Bearer ${token}` }), cfg);
  assert.equal(out.ok, false);
});
