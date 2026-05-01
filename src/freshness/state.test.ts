import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRef } from '../domain/ref.ts';

import { DEFAULT_FRESHNESS_CAPACITY, createFreshnessState } from './state.ts';

const ref = (n: string) => makeRef(n);

// ---------------------------------------------------------------------------
// Round-trip (AC2)
// ---------------------------------------------------------------------------

await test('touch then get returns the exact Date instance (referential equality)', () => {
  const state = createFreshnessState();
  const refA = ref('PageA');
  const dateA = new Date(0);
  state.touch(refA, dateA);
  assert.strictEqual(state.get(refA), dateA);
});

await test('get on never-touched ref returns undefined', () => {
  const state = createFreshnessState();
  assert.strictEqual(state.get(ref('NeverTouched')), undefined);
});

await test('two independent refs are stored without crosstalk', () => {
  const state = createFreshnessState();
  const refA = ref('PageA');
  const refB = ref('PageB');
  const dateA = new Date(10);
  const dateB = new Date(20);
  state.touch(refA, dateA);
  state.touch(refB, dateB);
  assert.strictEqual(state.get(refA), dateA);
  assert.strictEqual(state.get(refB), dateB);
});

await test('get does NOT bump recency: A is evicted even after repeated get(A)', () => {
  const state = createFreshnessState({ capacity: 2 });
  const refA = ref('PageA');
  const refB = ref('PageB');
  const refC = ref('PageC');
  state.touch(refA, new Date(0));
  state.touch(refB, new Date(1));
  // Repeated reads of A must not save it from eviction.
  state.get(refA);
  state.get(refA);
  state.get(refA);
  state.touch(refC, new Date(2));
  assert.strictEqual(state.get(refA), undefined);
  assert.equal(state.get(refB)?.getTime(), 1);
  assert.equal(state.get(refC)?.getTime(), 2);
});

await test('stored Date is the caller reference (no defensive copy)', () => {
  const state = createFreshnessState();
  const refA = ref('PageA');
  const date = new Date(100);
  state.touch(refA, date);
  assert.strictEqual(state.get(refA), date);
});

// ---------------------------------------------------------------------------
// Re-touch / recency (AC3)
// ---------------------------------------------------------------------------

await test('re-touch overwrites stored timestamp with newer Date', () => {
  const state = createFreshnessState();
  const refA = ref('PageA');
  state.touch(refA, new Date(10));
  state.touch(refA, new Date(20));
  assert.equal(state.get(refA)?.getTime(), 20);
});

await test('re-touch with earlier Date is stored as-is (no monotonicity guard)', () => {
  const state = createFreshnessState();
  const refA = ref('PageA');
  state.touch(refA, new Date(20));
  state.touch(refA, new Date(10));
  assert.equal(state.get(refA)?.getTime(), 10);
});

await test('re-touch moves entry to MRU end (capacity = 3, A re-touched, D inserted, B is LRU)', () => {
  const state = createFreshnessState({ capacity: 3 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  state.touch(ref('C'), new Date(2));
  state.touch(ref('A'), new Date(3));
  state.touch(ref('D'), new Date(4));
  assert.strictEqual(state.get(ref('B')), undefined, 'B is the new LRU and should be evicted');
  assert.equal(state.get(ref('A'))?.getTime(), 3);
  assert.equal(state.get(ref('C'))?.getTime(), 2);
  assert.equal(state.get(ref('D'))?.getTime(), 4);
});

await test('repeated re-touch of same ref at capacity = 1 keeps the entry alive', () => {
  const state = createFreshnessState({ capacity: 1 });
  const refA = ref('PageA');
  state.touch(refA, new Date(1));
  state.touch(refA, new Date(2));
  state.touch(refA, new Date(3));
  assert.equal(state.get(refA)?.getTime(), 3);
});

// ---------------------------------------------------------------------------
// LRU eviction (AC4)
// ---------------------------------------------------------------------------

await test('capacity = 3: four sequential touches evict the first', () => {
  const state = createFreshnessState({ capacity: 3 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  state.touch(ref('C'), new Date(2));
  state.touch(ref('D'), new Date(3));
  assert.strictEqual(state.get(ref('A')), undefined);
  assert.equal(state.get(ref('B'))?.getTime(), 1);
  assert.equal(state.get(ref('C'))?.getTime(), 2);
  assert.equal(state.get(ref('D'))?.getTime(), 3);
});

await test('capacity = 1: each new touch evicts the prior entry', () => {
  const state = createFreshnessState({ capacity: 1 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  assert.strictEqual(state.get(ref('A')), undefined);
  assert.equal(state.get(ref('B'))?.getTime(), 1);
});

await test('capacity = 2: insertion order A, B, C, D — only C and D survive', () => {
  const state = createFreshnessState({ capacity: 2 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  state.touch(ref('C'), new Date(2));
  state.touch(ref('D'), new Date(3));
  assert.strictEqual(state.get(ref('A')), undefined);
  assert.strictEqual(state.get(ref('B')), undefined);
  assert.equal(state.get(ref('C'))?.getTime(), 2);
  assert.equal(state.get(ref('D'))?.getTime(), 3);
});

await test('capacity = 3: exactly 3 touches → all three present, no eviction yet', () => {
  const state = createFreshnessState({ capacity: 3 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  state.touch(ref('C'), new Date(2));
  assert.equal(state.get(ref('A'))?.getTime(), 0);
  assert.equal(state.get(ref('B'))?.getTime(), 1);
  assert.equal(state.get(ref('C'))?.getTime(), 2);
});

await test('capacity = 2 with re-touch: A, B, A, C → B evicted, A and C survive', () => {
  const state = createFreshnessState({ capacity: 2 });
  state.touch(ref('A'), new Date(0));
  state.touch(ref('B'), new Date(1));
  state.touch(ref('A'), new Date(2));
  state.touch(ref('C'), new Date(3));
  assert.equal(state.get(ref('A'))?.getTime(), 2);
  assert.strictEqual(state.get(ref('B')), undefined);
  assert.equal(state.get(ref('C'))?.getTime(), 3);
});

// ---------------------------------------------------------------------------
// Capacity invariant (AC5)
// ---------------------------------------------------------------------------

await test('createFreshnessState rejects capacity = 0', () => {
  assert.throws(() => createFreshnessState({ capacity: 0 }), /capacity/);
});

await test('createFreshnessState rejects negative capacity', () => {
  assert.throws(() => createFreshnessState({ capacity: -1 }), /capacity/);
});

await test('createFreshnessState rejects NaN capacity', () => {
  assert.throws(() => createFreshnessState({ capacity: Number.NaN }), /capacity/);
});

await test('createFreshnessState rejects Infinity capacity', () => {
  assert.throws(() => createFreshnessState({ capacity: Number.POSITIVE_INFINITY }), /capacity/);
});

await test('createFreshnessState rejects non-integer capacity', () => {
  assert.throws(() => createFreshnessState({ capacity: 2.5 }), /capacity/);
});

await test('createFreshnessState() with no options uses DEFAULT_FRESHNESS_CAPACITY', () => {
  const state = createFreshnessState();
  // Smoke: factory does not throw and returns a usable instance.
  state.touch(ref('Smoke'), new Date(0));
  assert.equal(state.get(ref('Smoke'))?.getTime(), 0);
});

await test('createFreshnessState({}) without capacity uses DEFAULT_FRESHNESS_CAPACITY', () => {
  const state = createFreshnessState({});
  state.touch(ref('Smoke'), new Date(1));
  assert.equal(state.get(ref('Smoke'))?.getTime(), 1);
});

await test('DEFAULT_FRESHNESS_CAPACITY === 1024', () => {
  assert.strictEqual(DEFAULT_FRESHNESS_CAPACITY, 1024);
});

// ---------------------------------------------------------------------------
// Pure-function / isolation properties (AC6)
// ---------------------------------------------------------------------------

await test('two factory instances are independent — touches in one do not leak to the other', () => {
  const s1 = createFreshnessState();
  const s2 = createFreshnessState();
  s1.touch(ref('Shared'), new Date(0));
  assert.strictEqual(s2.get(ref('Shared')), undefined);
});

await test('factory returns object with touch and get bound to a shared private store', () => {
  // Indirect closure check: writes through `touch` are visible to `get` on
  // the SAME instance. The independent-instances test above pins the
  // per-factory isolation; this one pins the within-instance binding.
  const state = createFreshnessState();
  const refA = ref('PageA');
  const refB = ref('PageB');
  state.touch(refA, new Date(42));
  assert.equal(state.get(refA)?.getTime(), 42);
  state.touch(refB, new Date(7));
  assert.equal(state.get(refA)?.getTime(), 42);
  assert.equal(state.get(refB)?.getTime(), 7);
});
