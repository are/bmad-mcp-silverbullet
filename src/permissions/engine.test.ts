import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRef } from '../domain/ref.ts';

import type { AccessMode } from './access-mode.ts';
import type { ConfigBlock } from './config-block-parser.ts';
import { resolveAccess, CONFIG_PAGE } from './engine.ts';

function block(page: string, access: AccessMode, exact = false): ConfigBlock {
  return { page: makeRef(page), access, exact };
}

// CONFIG_PAGE constant

await test('CONFIG_PAGE is the literal Ref "CONFIG"', () => {
  assert.strictEqual(CONFIG_PAGE, makeRef('CONFIG'));
  assert.strictEqual(String(CONFIG_PAGE), 'CONFIG');
});

// Specificity ordering — across-specificity wins regardless of permissiveness

await test('global "write" + scope "none" on Personal — Personal resolves "none"', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Personal'), blocks), 'none');
});

await test('global "write" + scope "none" on Personal — Personal/Diary resolves "none"', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Personal/Diary'), blocks), 'none');
});

await test('global "write" + scope "none" on Personal — Personal/2026/04 resolves "none"', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Personal/2026/04'), blocks), 'none');
});

await test('global "write" + scope "none" on Personal — Work/Q2 falls back to global "write"', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Work/Q2'), blocks), 'write');
});

await test('global "write" — Index resolves "write"', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Index'), blocks), 'write');
});

// Specificity — exact > scope on same root

await test('exact "write" + non-exact "none" on Personal — Personal resolves "write"', () => {
  const blocks = [block('Personal', 'write', true), block('Personal', 'none', false)];
  assert.strictEqual(resolveAccess(makeRef('Personal'), blocks), 'write');
});

await test('exact "write" + non-exact "none" on Personal — Personal/Diary resolves "none" (exact does not extend)', () => {
  const blocks = [block('Personal', 'write', true), block('Personal', 'none', false)];
  assert.strictEqual(resolveAccess(makeRef('Personal/Diary'), blocks), 'none');
});

// Specificity — within scope, longer root wins

await test('scope "read" on Projects + scope "none" on Projects/Active — Projects/Active/Q2 resolves "none"', () => {
  const blocks = [block('Projects', 'read'), block('Projects/Active', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Projects/Active/Q2'), blocks), 'none');
});

await test('scope "read" on Projects + scope "none" on Projects/Active — Projects/Other resolves "read"', () => {
  const blocks = [block('Projects', 'read'), block('Projects/Active', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Projects/Other'), blocks), 'read');
});

// Specificity — exact does not match descendants

await test('non-exact "read" on Personal + exact "write" on Personal/Public — Personal/Public resolves "write"', () => {
  const blocks = [block('Personal', 'read'), block('Personal/Public', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Personal/Public'), blocks), 'write');
});

await test('non-exact "read" on Personal + exact "write" on Personal/Public — Personal/Public/Sub resolves "read" (exact does not extend)', () => {
  const blocks = [block('Personal', 'read'), block('Personal/Public', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Personal/Public/Sub'), blocks), 'read');
});

// Cross-specificity — global + exact

await test('global "append" + exact "write" on Index — Index resolves "write"', () => {
  const blocks = [block('CONFIG', 'append'), block('Index', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Index'), blocks), 'write');
});

await test('global "append" + exact "write" on Index — Other resolves "append" (global)', () => {
  const blocks = [block('CONFIG', 'append'), block('Index', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Other'), blocks), 'append');
});

// Tie-break — most-permissive wins within same specificity

await test('two scope blocks on Foo with "read" and "write" — Foo/Bar resolves "write"', () => {
  const blocks = [block('Foo', 'read'), block('Foo', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Foo/Bar'), blocks), 'write');
});

await test('three scope blocks on Foo with "none", "read", "append" — Foo resolves "append"', () => {
  const blocks = [block('Foo', 'none'), block('Foo', 'read'), block('Foo', 'append')];
  assert.strictEqual(resolveAccess(makeRef('Foo'), blocks), 'append');
});

await test('two exact blocks on same page with "read" and "write" — host page resolves "write"', () => {
  const blocks = [block('Foo', 'read', true), block('Foo', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Foo'), blocks), 'write');
});

await test('two CONFIG-page (global) blocks with "read" and "write" — unmatched ref resolves "write"', () => {
  const blocks = [block('CONFIG', 'read'), block('CONFIG', 'write')];
  assert.strictEqual(resolveAccess(makeRef('AnyPage'), blocks), 'write');
});

await test('tie-break is commutative — reordering inputs does not change outcome', () => {
  // Six permutations of three scope blocks on Foo with none / read / append.
  const permutations = [
    [block('Foo', 'none'), block('Foo', 'read'), block('Foo', 'append')],
    [block('Foo', 'none'), block('Foo', 'append'), block('Foo', 'read')],
    [block('Foo', 'read'), block('Foo', 'none'), block('Foo', 'append')],
    [block('Foo', 'read'), block('Foo', 'append'), block('Foo', 'none')],
    [block('Foo', 'append'), block('Foo', 'none'), block('Foo', 'read')],
    [block('Foo', 'append'), block('Foo', 'read'), block('Foo', 'none')],
  ];
  for (const perm of permutations) {
    assert.strictEqual(resolveAccess(makeRef('Foo'), perm), 'append');
  }
});

// Default-deny

await test('empty blocks — any ref resolves "none"', () => {
  assert.strictEqual(resolveAccess(makeRef('AnyPage'), []), 'none');
  assert.strictEqual(resolveAccess(makeRef('Personal/Diary'), []), 'none');
});

await test('single scope block on Personal "write" — Work/Q2 resolves "none"', () => {
  const blocks = [block('Personal', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Work/Q2'), blocks), 'none');
});

await test('exact: true block on Personal "write" — Personal/Diary resolves "none"', () => {
  const blocks = [block('Personal', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Personal/Diary'), blocks), 'none');
});

await test('scope block on Personal "write" — PersonalAssistant resolves "none" (segment-boundary rule)', () => {
  const blocks = [block('Personal', 'write')];
  assert.strictEqual(resolveAccess(makeRef('PersonalAssistant'), blocks), 'none');
});

await test('no global block — non-matching scope yields default-deny', () => {
  const blocks = [block('Personal', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Index'), blocks), 'none');
});

// Boundary cases

await test('scope block on Foo "write" — Foo (host page itself) resolves "write"', () => {
  const blocks = [block('Foo', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Foo'), blocks), 'write');
});

await test('two scope blocks of equal-length disjoint roots — Foo/x → "read"; Bar/x → "write"', () => {
  const blocks = [block('Foo', 'read'), block('Bar', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Foo/x'), blocks), 'read');
  assert.strictEqual(resolveAccess(makeRef('Bar/x'), blocks), 'write');
});

await test('nested scope blocks at multiple depths — most-specific wins', () => {
  const blocks = [block('A', 'write'), block('A/B', 'read'), block('A/B/C', 'none')];
  assert.strictEqual(resolveAccess(makeRef('A/B/C/D'), blocks), 'none');
  assert.strictEqual(resolveAccess(makeRef('A/B/X'), blocks), 'read');
  assert.strictEqual(resolveAccess(makeRef('A/X'), blocks), 'write');
});

await test('CONFIG-block coexisting with same-name scope rule — only literal CONFIG is global', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  assert.strictEqual(resolveAccess(makeRef('Personal'), blocks), 'none');
  assert.strictEqual(resolveAccess(makeRef('Index'), blocks), 'write');
});

await test('"Config" (capital C only) is NOT treated as global — only the exact ref "CONFIG"', () => {
  // A block hosted on a page literally named `Config` is a scope block on
  // that page, not a global declaration. Only `CONFIG` is global.
  const blocks = [block('Config', 'write')];
  assert.strictEqual(resolveAccess(makeRef('Index'), blocks), 'none');
  assert.strictEqual(resolveAccess(makeRef('Config'), blocks), 'write');
});

await test('CONFIG block with exact: true is still treated as global (D1 algorithm: CONFIG branch precedes exact)', () => {
  // The D1 algorithm (architecture.md:231-265) routes CONFIG-page blocks
  // through the global branch before any exact-flag check, so combining
  // exact: true with page: 'CONFIG' does NOT scope the rule to the host
  // page only — it still applies globally. This test pins that contract
  // so a refactor that re-orders the branches surfaces immediately.
  const blocks = [block('CONFIG', 'write', true)];
  assert.strictEqual(resolveAccess(makeRef('Anything'), blocks), 'write');
  assert.strictEqual(resolveAccess(makeRef('Personal/Diary'), blocks), 'write');
  assert.strictEqual(resolveAccess(makeRef('CONFIG'), blocks), 'write');
});

// Pure-function properties

await test('resolveAccess is referentially transparent — same args, same result', () => {
  const blocks = [block('CONFIG', 'write'), block('Personal', 'none')];
  const a = resolveAccess(makeRef('Personal/X'), blocks);
  const b = resolveAccess(makeRef('Personal/X'), blocks);
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'none');
});

await test('resolveAccess does not retain a reference to the input blocks array', () => {
  const blocks: ConfigBlock[] = [block('Personal', 'write')];
  const result1 = resolveAccess(makeRef('Personal'), blocks);
  // Mutate after the call — the result was captured at call time.
  blocks.length = 0;
  blocks.push(block('Personal', 'none'));
  assert.strictEqual(result1, 'write');
  // Confirm a fresh call sees the mutation, proving the engine reads the
  // array on each invocation rather than the previous frame.
  assert.strictEqual(resolveAccess(makeRef('Personal'), blocks), 'none');
});
