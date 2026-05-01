import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_MODES,
  accessRank,
  isAccessMode,
  maxAccess,
  permits,
  type AccessOperation,
} from './access-mode.ts';

// isAccessMode — happy path

await test('isAccessMode accepts "none"', () => {
  assert.strictEqual(isAccessMode('none'), true);
});

await test('isAccessMode accepts "read"', () => {
  assert.strictEqual(isAccessMode('read'), true);
});

await test('isAccessMode accepts "append"', () => {
  assert.strictEqual(isAccessMode('append'), true);
});

await test('isAccessMode accepts "write"', () => {
  assert.strictEqual(isAccessMode('write'), true);
});

// isAccessMode — case sensitivity

await test('isAccessMode rejects uppercase "NONE"', () => {
  assert.strictEqual(isAccessMode('NONE'), false);
});

await test('isAccessMode rejects mixed-case "Read"', () => {
  assert.strictEqual(isAccessMode('Read'), false);
});

await test('isAccessMode rejects whitespace-padded "  write  "', () => {
  assert.strictEqual(isAccessMode('  write  '), false);
});

// isAccessMode — out-of-vocabulary

await test('isAccessMode rejects legacy "readonly"', () => {
  assert.strictEqual(isAccessMode('readonly'), false);
});

await test('isAccessMode rejects empty string', () => {
  assert.strictEqual(isAccessMode(''), false);
});

await test('isAccessMode rejects null', () => {
  assert.strictEqual(isAccessMode(null), false);
});

await test('isAccessMode rejects undefined', () => {
  assert.strictEqual(isAccessMode(undefined), false);
});

await test('isAccessMode rejects numbers', () => {
  assert.strictEqual(isAccessMode(42), false);
});

await test('isAccessMode rejects objects', () => {
  assert.strictEqual(isAccessMode({}), false);
});

await test('isAccessMode rejects arrays', () => {
  assert.strictEqual(isAccessMode([]), false);
});

// accessRank

await test('accessRank("none") === 0', () => {
  assert.strictEqual(accessRank('none'), 0);
});

await test('accessRank("read") === 1', () => {
  assert.strictEqual(accessRank('read'), 1);
});

await test('accessRank("append") === 2', () => {
  assert.strictEqual(accessRank('append'), 2);
});

await test('accessRank("write") === 3', () => {
  assert.strictEqual(accessRank('write'), 3);
});

// maxAccess

await test('maxAccess("read", "write") === "write"', () => {
  assert.strictEqual(maxAccess('read', 'write'), 'write');
});

await test('maxAccess("append", "read") === "append"', () => {
  assert.strictEqual(maxAccess('append', 'read'), 'append');
});

await test('maxAccess("none", "none") === "none"', () => {
  assert.strictEqual(maxAccess('none', 'none'), 'none');
});

await test('maxAccess("write", "write") === "write"', () => {
  assert.strictEqual(maxAccess('write', 'write'), 'write');
});

await test('maxAccess("append", "write") === "write"', () => {
  assert.strictEqual(maxAccess('append', 'write'), 'write');
});

// permits — happy paths (mode meets requirement)

await test('permits("write", "edit") === true', () => {
  assert.strictEqual(permits('write', 'edit'), true);
});

await test('permits("write", "append") === true', () => {
  assert.strictEqual(permits('write', 'append'), true);
});

await test('permits("write", "read") === true', () => {
  assert.strictEqual(permits('write', 'read'), true);
});

await test('permits("append", "append") === true', () => {
  assert.strictEqual(permits('append', 'append'), true);
});

await test('permits("append", "read") === true', () => {
  assert.strictEqual(permits('append', 'read'), true);
});

await test('permits("read", "list") === true', () => {
  assert.strictEqual(permits('read', 'list'), true);
});

await test('permits("read", "search") === true', () => {
  assert.strictEqual(permits('read', 'search'), true);
});

// permits — rejection paths (mode below requirement)

const noneOps: readonly AccessOperation[] = [
  'read',
  'list',
  'search',
  'append',
  'edit',
  'delete',
  'create',
];
for (const op of noneOps) {
  await test(`permits("none", "${op}") === false`, () => {
    assert.strictEqual(permits('none', op), false);
  });
}

await test('permits("read", "append") === false', () => {
  assert.strictEqual(permits('read', 'append'), false);
});

await test('permits("read", "edit") === false', () => {
  assert.strictEqual(permits('read', 'edit'), false);
});

await test('permits("append", "edit") === false', () => {
  assert.strictEqual(permits('append', 'edit'), false);
});

await test('permits("append", "delete") === false', () => {
  assert.strictEqual(permits('append', 'delete'), false);
});

await test('permits("append", "create") === false', () => {
  assert.strictEqual(permits('append', 'create'), false);
});

// ACCESS_MODES tuple ordering

await test('ACCESS_MODES has length 4', () => {
  assert.strictEqual(ACCESS_MODES.length, 4);
});

await test('ACCESS_MODES[0] === "none"', () => {
  assert.strictEqual(ACCESS_MODES[0], 'none');
});

await test('ACCESS_MODES[1] === "read"', () => {
  assert.strictEqual(ACCESS_MODES[1], 'read');
});

await test('ACCESS_MODES[2] === "append"', () => {
  assert.strictEqual(ACCESS_MODES[2], 'append');
});

await test('ACCESS_MODES[3] === "write"', () => {
  assert.strictEqual(ACCESS_MODES[3], 'write');
});

await test('every ACCESS_MODES entry is recognised by isAccessMode', () => {
  for (const mode of ACCESS_MODES) {
    assert.strictEqual(isAccessMode(mode), true);
  }
});

// AccessMode rank ordering matches the documented total order
// (sanity check that the ordering of ACCESS_MODES, accessRank, and maxAccess all agree).

await test('ACCESS_MODES order matches accessRank ascending', () => {
  for (const [i, mode] of ACCESS_MODES.entries()) {
    assert.strictEqual(accessRank(mode), i);
  }
});
