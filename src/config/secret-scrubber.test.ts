import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { wrapConfig } from './secret-scrubber.ts';
import type { Config } from './config.ts';

const REAL_TOKEN = 'live-secret-bearer-1234';
const REDACTED = '***redacted***';

function makeRaw(overrides: Partial<Config> = {}): Config {
  return {
    silverbulletUrl: 'https://example.com',
    silverbulletToken: REAL_TOKEN,
    ...overrides,
  };
}

await test('wrapConfig: live token preserved on direct property access', () => {
  const raw = makeRaw();
  const wrapped = wrapConfig(raw);
  assert.strictEqual(wrapped.silverbulletToken, REAL_TOKEN);
});

await test('wrapConfig: silverbulletUrl preserved on direct property access', () => {
  const raw = makeRaw({ silverbulletUrl: 'https://notes.example.com' });
  const wrapped = wrapConfig(raw);
  assert.strictEqual(wrapped.silverbulletUrl, 'https://notes.example.com');
});

await test('wrapConfig: auditLogPath preserved on direct property access when present', () => {
  const raw = makeRaw({ auditLogPath: '/var/log/x/audit.jsonl' });
  const wrapped = wrapConfig(raw);
  assert.strictEqual(wrapped.auditLogPath, '/var/log/x/audit.jsonl');
});

await test('JSON.stringify(wrapped) masks the token; other fields round-trip', () => {
  const raw = makeRaw({ auditLogPath: '/var/log/x/audit.jsonl' });
  const wrapped = wrapConfig(raw);
  const parsed = JSON.parse(JSON.stringify(wrapped)) as Record<string, string>;
  assert.strictEqual(parsed.silverbulletToken, REDACTED);
  assert.strictEqual(parsed.silverbulletUrl, 'https://example.com');
  assert.strictEqual(parsed.auditLogPath, '/var/log/x/audit.jsonl');
});

await test('JSON.stringify(wrapped) does not contain the live token substring', () => {
  const wrapped = wrapConfig(makeRaw());
  assert.ok(!JSON.stringify(wrapped).includes(REAL_TOKEN));
});

await test('JSON.stringify(wrapped) with auditLogPath undefined omits the field cleanly', () => {
  const wrapped = wrapConfig(makeRaw());
  const parsed = JSON.parse(JSON.stringify(wrapped)) as Record<string, unknown>;
  assert.strictEqual('auditLogPath' in parsed, false);
});

await test('String(wrapped) contains ***redacted*** and not the live token', () => {
  const s = String(wrapConfig(makeRaw()));
  assert.ok(s.includes(REDACTED));
  assert.ok(!s.includes(REAL_TOKEN));
});

await test('Template literal interpolation masks the token (via toString)', () => {
  const s = `${wrapConfig(makeRaw()).toString()}`;
  assert.ok(s.includes(REDACTED));
  assert.ok(!s.includes(REAL_TOKEN));
});

await test('util.inspect(wrapped) masks the token', () => {
  const s = inspect(wrapConfig(makeRaw()));
  assert.ok(s.includes(REDACTED));
  assert.ok(!s.includes(REAL_TOKEN));
});

await test('Spread guard: JSON.stringify({ ...wrapped }) does NOT leak the live token', () => {
  // The token is a non-enumerable getter, so spread copies don't see it.
  // The result is the absence of the token entirely (safer than masking).
  const wrapped = wrapConfig(makeRaw());
  const spread = { ...wrapped };
  const s = JSON.stringify(spread);
  assert.ok(!s.includes(REAL_TOKEN), `live token leaked through spread: ${s}`);
  assert.strictEqual('silverbulletToken' in spread, false);
});

await test('Positive control: an unwrapped plain object DOES expose the token via JSON.stringify (proves leak harness works)', () => {
  // Mirrors the wrapper's tested path: feed a plain object (no scrubber)
  // into JSON.stringify and verify the live token appears verbatim. If
  // this ever stops finding the marker, the leak harness in the wrapped
  // tests above is silently broken — failing this control flags that.
  const plain = { silverbulletToken: 'live-marker' };
  assert.ok(
    JSON.stringify(plain).includes('live-marker'),
    'unwrapped plain object must expose the token via JSON.stringify',
  );
});

await test('Object.keys(wrapped) excludes silverbulletToken (non-enumerable getter)', () => {
  const wrapped = wrapConfig(makeRaw({ auditLogPath: '/abs/path' }));
  const keys = Object.keys(wrapped).sort();
  assert.deepStrictEqual(keys, ['auditLogPath', 'silverbulletUrl']);
});

await test('Object.keys(wrapped) does NOT include toJSON / toString / inspect hook', () => {
  const keys = Object.keys(wrapConfig(makeRaw()));
  assert.ok(!keys.includes('toJSON'), 'toJSON must be non-enumerable');
  assert.ok(!keys.includes('toString'), 'toString must be non-enumerable');
  assert.ok(!keys.includes('silverbulletToken'), 'silverbulletToken must be non-enumerable');
});

await test('JSON.stringify(wrapped) still includes the redacted token (toJSON path)', () => {
  // Direct serialization of the wrapper itself — not a spread — invokes the
  // toJSON hook and produces the masked projection including silverbulletToken.
  const s = JSON.stringify(wrapConfig(makeRaw()));
  const parsed = JSON.parse(s) as Record<string, string>;
  assert.strictEqual(parsed.silverbulletToken, REDACTED);
});

await test('String(wrapped) renders auditLogPath=undefined literally when absent', () => {
  const s = String(wrapConfig(makeRaw()));
  assert.match(s, /auditLogPath=undefined/);
});

await test('String(wrapped) renders auditLogPath value when present', () => {
  const s = String(wrapConfig(makeRaw({ auditLogPath: '/var/x/y.jsonl' })));
  assert.match(s, /auditLogPath=\/var\/x\/y\.jsonl/);
});
