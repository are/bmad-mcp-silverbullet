import { test } from 'node:test';
import assert from 'node:assert/strict';

import { digest } from './digest.ts';

await test('digest empty string → size 0 + canonical SHA-256', () => {
  const out = digest('');
  assert.deepStrictEqual(out, {
    size: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
});

await test('digest ASCII "hello" → size 5 + known SHA-256', () => {
  const out = digest('hello');
  assert.deepStrictEqual(out, {
    size: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  });
});

await test('digest multi-byte UTF-8 "café" → size is byte length 5, not JS-string length 4', () => {
  const out = digest('café');
  assert.strictEqual(out.size, 5);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  // Sanity: hashing the same content twice yields the same digest.
  assert.strictEqual(digest('café').sha256, out.sha256);
});

await test('digest 4-byte UTF-8 emoji "🎉" → size is byte length 4', () => {
  const out = digest('🎉');
  assert.strictEqual(out.size, 4);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});

await test('digest of long content (≥ 64 KiB) → exact size + valid 64-char hex sha256', () => {
  const content = 'a'.repeat(70_000);
  const out = digest(content);
  assert.strictEqual(out.size, 70_000);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});

await test('digest is deterministic — same input yields identical output', () => {
  const a = digest('the quick brown fox jumps over the lazy dog');
  const b = digest('the quick brown fox jumps over the lazy dog');
  assert.deepStrictEqual(a, b);
});

await test('digest hex output is lowercase only', () => {
  const out = digest('HELLO WORLD');
  assert.strictEqual(out.sha256, out.sha256.toLowerCase());
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});
