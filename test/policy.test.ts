import test from 'node:test';
import assert from 'node:assert/strict';
import { clampEmailDays, clampCalendarRange, allowedRecipient } from '../src/policy.ts';
import { classifyAuthSensitive, redactSecrets } from '../src/redaction.ts';

test('email days clamped to policy max', () => {
  assert.equal(clampEmailDays('10', 2), 2);
  assert.equal(clampEmailDays('0', 2), 1);
});

test('calendar range defaults and clamps', () => {
  const now = new Date('2026-02-22T05:00:00Z');
  const r = clampCalendarRange({ now, maxPastDays: 0, maxFutureDays: 7, defaultThisWeek: true });
  assert.ok(r.start <= r.end);
  assert.ok(r.end <= new Date('2026-03-01T23:59:59.999Z'));
});

test('auth-sensitive detection and redaction', () => {
  const t = 'Your OTP code is 123456. Reset your password here: https://example.com/reset';
  assert.equal(classifyAuthSensitive(t), true);
  assert.equal(classifyAuthSensitive('Use this magic link to verify your email and approve sign-in'), true);
  const r = redactSecrets(t);
  assert.ok(!r.includes('123456'));
  assert.ok(!r.includes('https://'));
});

test('recipient allowlists fail closed and reject malformed multi-@', () => {
  assert.equal(allowedRecipient('a@b.com', [], []), false);
  assert.equal(allowedRecipient('a@b.com', ['a@b.com'], []), true);
  assert.equal(allowedRecipient('a@b.com', [], ['b.com']), true);
  assert.equal(allowedRecipient('a@x.com', ['a@b.com'], ['b.com']), false);
  assert.equal(allowedRecipient('victim@example.com@attacker.com', [], ['example.com']), false);
});
