import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScript } from './envelope.ts';

const PRELUDE_RE =
  /^\(function\(\)\nlocal _p = js\.tolua\(js\.window\.JSON\.parse\(encoding\.utf8Decode\(encoding\.base64Decode\("([A-Za-z0-9+/=]+)"\)\)\)\)\n/;
const SUFFIX = '\nend)()';

function decodePayload(script: string): unknown {
  const match = PRELUDE_RE.exec(script);
  if (match === null) throw new Error(`script did not match prelude shape: ${script.slice(0, 80)}`);
  const base64Str = match[1];
  if (base64Str === undefined) throw new Error('regex matched but capture group was undefined');
  const json = Buffer.from(base64Str, 'base64').toString('utf8');
  return JSON.parse(json);
}

function bodyBetweenPreludeAndSuffix(script: string): string {
  const match = PRELUDE_RE.exec(script);
  if (match === null) throw new Error('prelude did not match');
  const start = match[0].length;
  const end = script.length - SUFFIX.length;
  return script.slice(start, end);
}

// AC8 case 1: Lua escape characters in string param round-trip via base64+JSON.
await test('buildScript: round-trips Lua-escape adversarial input', () => {
  const params = { x: '"; os.exit() --' } as const;
  const script = buildScript('return _p.x', params);
  assert.deepStrictEqual(decodePayload(script), params);
  // The substring `os.exit()` must NOT appear outside the base64 payload.
  assert.ok(
    !bodyBetweenPreludeAndSuffix(script).includes('os.exit()'),
    `os.exit() leaked into the rendered Lua source body: ${bodyBetweenPreludeAndSuffix(script)}`,
  );
});

// AC8 case 2: Lua long-bracket break attempt.
await test('buildScript: round-trips Lua long-bracket break attempt', () => {
  const params = { x: ']]; os.exit()--[[' };
  const script = buildScript('return _p.x', params);
  assert.deepStrictEqual(decodePayload(script), params);
  assert.ok(
    !bodyBetweenPreludeAndSuffix(script).includes(']]'),
    `]] leaked into the rendered Lua source body: ${bodyBetweenPreludeAndSuffix(script)}`,
  );
});

// AC8 case 3: Backslash escapes.
await test('buildScript: round-trips backslash-bearing input', () => {
  const params = { x: '\\\\"); evil()' };
  const script = buildScript('return _p.x', params);
  assert.deepStrictEqual(decodePayload(script), params);
  assert.ok(!bodyBetweenPreludeAndSuffix(script).includes('evil()'));
});

// AC8 case 4: Newlines / control characters in string.
await test('buildScript: encodes embedded newlines and control characters in payload', () => {
  const params = { x: 'line1\nline2\rline3\tend' };
  const script = buildScript('return _p.x', params);
  assert.deepStrictEqual(decodePayload(script), params);
  // Wrapper structure newlines: after `(function()`, after the prelude line,
  // and before `end)()`. Plus any newlines the template body carries (zero
  // here since `return _p.x` is a single line). User-supplied newlines from
  // params are JSON-escaped inside the base64 payload, never injected into
  // the rendered Lua source.
  const newlineCount = (script.match(/\n/g) ?? []).length;
  assert.strictEqual(newlineCount, 3, `expected 3 newlines, got ${newlineCount}`);
});

// AC8 case 5: Lone surrogate pairs.
await test('buildScript: round-trips lone surrogate (JSON.stringify lax behaviour)', () => {
  const params = { x: '\uD800' };
  const script = buildScript('return _p.x', params);
  // Round-trip via JSON.parse should yield the original lone surrogate string.
  assert.deepStrictEqual(decodePayload(script), params);
});

// AC8 case 6: Nested objects.
await test('buildScript: round-trips nested objects', () => {
  const params = { outer: { inner: { token: 'X' } } };
  const script = buildScript('return _p.outer', params);
  assert.deepStrictEqual(decodePayload(script), params);
});

// AC8 case 7: Arrays.
await test('buildScript: round-trips array values', () => {
  const params = { items: [1, 'two', { three: 3 }] };
  const script = buildScript('return _p.items', params);
  assert.deepStrictEqual(decodePayload(script), params);
});

// AC8 case 8: Empty / undefined params.
await test('buildScript: encodes {} for omitted params', () => {
  const script = buildScript('return 1');
  assert.deepStrictEqual(decodePayload(script), {});
});

await test('buildScript: encodes {} for explicit empty-object params', () => {
  const script = buildScript('return 1', {});
  assert.deepStrictEqual(decodePayload(script), {});
});

await test('buildScript: encodes {} for explicit undefined params', () => {
  const script = buildScript('return 1', undefined);
  assert.deepStrictEqual(decodePayload(script), {});
});

// AC8 case 9: Prelude is fixed-shape (IIFE-wrapped, SB encoding + js bridge).
await test('buildScript: prelude matches the fixed shape', () => {
  const script = buildScript('TEMPLATE', { x: 1 });
  assert.match(script, PRELUDE_RE);
});

// AC8 case 9b: Suffix is the IIFE close.
await test('buildScript: ends with the IIFE invocation suffix', () => {
  const script = buildScript('return 1', { x: 1 });
  assert.ok(script.endsWith('\nend)()'), `script did not end with '\\nend)()': ${script}`);
});

// AC8 case 10: Template is appended verbatim between prelude and suffix.
await test('buildScript: appends template body verbatim between prelude and suffix', () => {
  const script = buildScript('TEMPLATE_BODY_42', { x: 1 });
  assert.strictEqual(bodyBetweenPreludeAndSuffix(script), 'TEMPLATE_BODY_42');
});

// Defensive: a template containing newlines is preserved (multi-line script).
await test('buildScript: preserves a multi-line template body unchanged', () => {
  const template = 'local x = _p.x\nreturn x';
  const script = buildScript(template, { x: 5 });
  assert.strictEqual(bodyBetweenPreludeAndSuffix(script), template);
  assert.deepStrictEqual(decodePayload(script), { x: 5 });
});

// Defensive: payload alphabet is strictly base64.
await test('buildScript: payload contains only base64 alphabet characters', () => {
  const params = { x: '"; os.exit() --', y: ']];evil()--[[' };
  const script = buildScript('return _p', params);
  const match = PRELUDE_RE.exec(script);
  assert.ok(match !== null);
  const payload = match[1];
  assert.ok(payload !== undefined);
  assert.match(payload, /^[A-Za-z0-9+/=]+$/);
});
