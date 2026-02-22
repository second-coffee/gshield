import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { consumeSendQuota } from '../src/rate-limit.ts';

const rateFile = path.join(process.cwd(), 'logs', 'send-counters.json');
const lockFile = `${rateFile}.lock`;

test('consumeSendQuota increments atomically and enforces limits', () => {
  fs.rmSync(rateFile, { force: true });
  fs.rmSync(lockFile, { force: true });

  assert.equal(consumeSendQuota(2, 10).ok, true);
  assert.equal(consumeSendQuota(2, 10).ok, true);
  const blocked = consumeSendQuota(2, 10);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'hour_limit_exceeded');
});
