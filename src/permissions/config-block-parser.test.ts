import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRef } from '../domain/ref.ts';

import { parseConfigBlocks } from './config-block-parser.ts';

// Happy path

await test('empty input returns empty blocks and errors', () => {
  const result = parseConfigBlocks([]);
  assert.deepStrictEqual(result, { blocks: [], errors: [] });
});

await test('single valid block surfaces in blocks with branded ref', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'write', exact: false }]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks.length, 1);
  const block = result.blocks[0];
  assert.ok(block !== undefined);
  assert.strictEqual(block.page, makeRef('Personal'));
  assert.strictEqual(block.access, 'write');
  assert.strictEqual(block.exact, false);
});

await test('valid block with exact undefined defaults to false', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read', exact: undefined }]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks[0]?.exact, false);
});

await test('valid block with exact key absent defaults to false', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read' }]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks[0]?.exact, false);
});

await test('valid block with exact: true is preserved', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read', exact: true }]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks[0]?.exact, true);
});

await test('CONFIG-page block is valid (CONFIG is a valid Ref)', () => {
  const result = parseConfigBlocks([{ page: 'CONFIG', access: 'write' }]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks[0]?.page, makeRef('CONFIG'));
});

await test('multiple valid blocks all surface in blocks', () => {
  const result = parseConfigBlocks([
    { page: 'CONFIG', access: 'read' },
    { page: 'Personal', access: 'none' },
    { page: 'Work/Q2', access: 'write', exact: true },
  ]);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.blocks.length, 3);
});

await test('mixed valid + invalid: only valid in blocks, invalid in errors', () => {
  const result = parseConfigBlocks([
    { page: 'Personal', access: 'write' },
    { page: 'BadAccess', access: 'INVALID' },
    { page: 'Work', access: 'read' },
  ]);
  assert.strictEqual(result.blocks.length, 2);
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0]?.reason, 'access_invalid');
});

// Page validation

await test('page missing (key absent) → page_missing', () => {
  const result = parseConfigBlocks([{ access: 'write' }]);
  assert.strictEqual(result.blocks.length, 0);
  assert.strictEqual(result.errors[0]?.reason, 'page_missing');
});

await test('page === undefined → page_missing', () => {
  const result = parseConfigBlocks([{ page: undefined, access: 'write' }]);
  assert.strictEqual(result.errors[0]?.reason, 'page_missing');
});

await test('page is a number → page_missing', () => {
  const result = parseConfigBlocks([{ page: 42, access: 'write' }]);
  assert.strictEqual(result.errors[0]?.reason, 'page_missing');
});

await test('page is "" → page_invalid', () => {
  const result = parseConfigBlocks([{ page: '', access: 'write' }]);
  assert.strictEqual(result.errors[0]?.reason, 'page_invalid');
});

await test('page with whitespace padding → page_invalid', () => {
  const result = parseConfigBlocks([{ page: '  Foo  ', access: 'write' }]);
  assert.strictEqual(result.errors[0]?.reason, 'page_invalid');
});

await test('page with path traversal → page_invalid', () => {
  const result = parseConfigBlocks([{ page: '../etc/passwd', access: 'write' }]);
  assert.strictEqual(result.errors[0]?.reason, 'page_invalid');
});

// Access validation

await test('access missing → access_missing', () => {
  const result = parseConfigBlocks([{ page: 'Personal' }]);
  assert.strictEqual(result.errors[0]?.reason, 'access_missing');
});

await test('access is a number → access_missing', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 1 }]);
  assert.strictEqual(result.errors[0]?.reason, 'access_missing');
});

await test('access "WRITE" (uppercase) → access_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'WRITE' }]);
  assert.strictEqual(result.errors[0]?.reason, 'access_invalid');
});

await test('access "readonly" (legacy) → access_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'readonly' }]);
  assert.strictEqual(result.errors[0]?.reason, 'access_invalid');
});

await test('access "" → access_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: '' }]);
  assert.strictEqual(result.errors[0]?.reason, 'access_invalid');
});

// Exact validation — no truthy/falsy coercion

await test('exact "true" (string) → exact_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read', exact: 'true' }]);
  assert.strictEqual(result.errors[0]?.reason, 'exact_invalid');
});

await test('exact 1 (number) → exact_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read', exact: 1 }]);
  assert.strictEqual(result.errors[0]?.reason, 'exact_invalid');
});

await test('exact null → exact_invalid', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'read', exact: null }]);
  assert.strictEqual(result.errors[0]?.reason, 'exact_invalid');
});

// raw-field preservation

await test('errors[i].raw preserves original casing of access', () => {
  const result = parseConfigBlocks([{ page: 'Personal', access: 'WRITE' }]);
  assert.strictEqual(result.errors[0]?.raw.access, 'WRITE');
});

await test('errors[i].raw includes only {page, access, exact}; ignores extraneous keys', () => {
  const input = {
    page: 'Personal',
    access: 'WRITE',
    exact: true,
    extra: 'should-not-be-preserved',
  } as Record<string, unknown>;
  const result = parseConfigBlocks([input]);
  const raw = result.errors[0]?.raw;
  assert.ok(raw !== undefined);
  assert.strictEqual(raw.page, 'Personal');
  assert.strictEqual(raw.access, 'WRITE');
  assert.strictEqual(raw.exact, true);
  // Use Object.keys to assert only three keys are present.
  const keys = Object.keys(raw).sort();
  assert.deepStrictEqual(keys, ['access', 'exact', 'page']);
});

// Pure-function properties

await test('parseConfigBlocks does not throw on Object.create(null) input', () => {
  const obj = Object.create(null) as Record<string, unknown>;
  const result = parseConfigBlocks([obj]);
  assert.strictEqual(result.errors[0]?.reason, 'page_missing');
});

await test('parseConfigBlocks treats __proto__-bearing input as a page_missing data row', () => {
  // JSON.parse-style attacker input. Our parser does not recurse into
  // nested objects, so __proto__ as a key surfaces as missing/invalid
  // page rather than mutating the prototype chain.
  const attacker = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const result = parseConfigBlocks([attacker]);
  assert.strictEqual(result.errors[0]?.reason, 'page_missing');
  // Confirm Object.prototype was not polluted.
  assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
});

await test('parseConfigBlocks does not retain a reference to the input array', () => {
  const input: { page?: unknown; access?: unknown; exact?: unknown }[] = [
    { page: 'Personal', access: 'read' },
  ];
  const result1 = parseConfigBlocks(input);
  input.push({ page: 'Work', access: 'write' });
  // The first call's result is unchanged by mutating the source array.
  assert.strictEqual(result1.blocks.length, 1);
});
