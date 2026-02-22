import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmailOutput } from '../src/provider.ts';

test('non-json gog output does not become garbage email items', () => {
  const out = parseEmailOutput('totally non-json output\nwarning: foo\nsubject line');
  assert.deepEqual(out, []);
});

test('jsonl fallback accepts only valid email item objects', () => {
  const out = parseEmailOutput('{"id":"1","threadId":"t1","subject":"ok"}\n{"nope":1}\nnot-json');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '1');
});
