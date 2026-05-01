# Story 1.9: Freshness State Module

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the freshness invariant's substrate,
I want an in-memory bounded `Map<Ref, lastReadAt>` updated only on successful reads,
So that Epic 2's edit/delete handlers can reject stale-snapshot operations against a deterministic data structure.

## Acceptance Criteria

**AC1 — Module surface at `src/freshness/state.ts`**

**Given** the freshness state module at `src/freshness/state.ts`,
**When** I import its public surface,
**Then** it exports:

```typescript
import type { Ref } from '../domain/ref.ts';

export type FreshnessState = {
  touch(ref: Ref, at: Date): void;
  get(ref: Ref): Date | undefined;
};

export type CreateFreshnessStateOptions = {
  readonly capacity?: number;
};

export const DEFAULT_FRESHNESS_CAPACITY: 1024;

export function createFreshnessState(options?: CreateFreshnessStateOptions): FreshnessState;
```

**And** the module is **pure-domain** (AR58 / `epics.md:183`): zero in-tree imports outside `../domain/ref.ts` (specifically `import type { Ref } from '../domain/ref.ts'` — type-only). **Forbidden imports:** `node:fs`, `node:path`, `node:os`, `node:net`, `node:crypto`, `node:http`, `node:https`, `globalThis.fetch`, `Date.now`, `performance.now`, `process.*`, `../silverbullet/*`, `../audit/*`, `../diagnostic/*`, `../config/*`, `../mcp/*`, `../permissions/*`, `../edits/*`. The factory captures **no** ambient state (no module-level mutable variables aside from `DEFAULT_FRESHNESS_CAPACITY`).

**And** `createFreshnessState` is the only construction site. Each invocation returns an **independent** `FreshnessState` instance — no module-level singleton, no shared map (AR53 / `epics.md:176`: handlers receive freshness via `ctx` injection, never reach a module-level singleton).

**AC2 — `touch(ref, at)` / `get(ref)` round-trip**

**Given** a fresh `state = createFreshnessState()`,
**When** I call `state.touch(refA, dateA)` and then `state.get(refA)`,
**Then** the return value is exactly `dateA` (referentially equal — the same `Date` instance the caller passed in; the implementation does **not** clone the `Date`).

**And** `state.get(refB)` for any `refB !== refA` returns `undefined`.

**And** `state.get(ref)` is a **read-only inspection** — calling it does NOT affect recency ordering. Two consecutive `get(refA)` calls do not reposition `refA` against other entries (this matters for AC4's LRU policy: only `touch` updates recency).

**And** the `at` parameter is consumed at the call boundary verbatim — the implementation does NOT call `at.getTime()`, `at.toISOString()`, or any other coercion. The stored value is the same `Date` object reference.

**AC3 — Re-touching updates both stored timestamp and recency position**

**Given** a state where `state.touch(refA, dateA1)` has been called,
**When** the caller invokes `state.touch(refA, dateA2)` (same ref, different `Date` — possibly newer, possibly older, possibly the same instant),
**Then** `state.get(refA)` returns `dateA2` (the most-recent `at` overwrites the prior value),
**And** `refA` is now the **most-recently-touched** entry — its position in the LRU ordering is the same as a fresh insert.

**Given** a state with three entries inserted in order `refA` (oldest), `refB`, `refC` (newest),
**When** `state.touch(refA, dateA2)` re-touches `refA`,
**Then** the LRU ordering becomes `refB` (oldest), `refC`, `refA` (newest) — re-touching moves the entry to the MRU end.

**And** the freshness state does NOT enforce monotonicity on `at` — a caller passing `dateA2 < dateA1` is stored as-is. (Production callers use `clock.now()`, which the architecture treats as monotonic per `architecture.md:1062` — but the state itself is a dumb store.)

**AC4 — LRU eviction when `capacity` is exceeded**

**Given** `state = createFreshnessState({ capacity: 3 })` and four `touch` calls in order `(refA, t0)`, `(refB, t1)`, `(refC, t2)`, `(refD, t3)`,
**When** the fourth `touch` causes the entry count to exceed `capacity = 3`,
**Then** `refA` (the least-recently-touched entry) is evicted: `state.get(refA) === undefined`.
**And** `state.get(refB) === t1`, `state.get(refC) === t2`, `state.get(refD) === t3` — all three most-recent entries survive.

**Given** a state at capacity = 3 with entries `[refA, refB, refC]` (LRU → MRU),
**When** the caller re-touches `refA`,
**Then** the ordering becomes `[refB, refC, refA]` — `refA` is now MRU; `refB` is now LRU.
**And** a subsequent `touch(refD, ...)` evicts `refB` (the new LRU after the re-touch), NOT `refA`.

**And** eviction policy is strictly **least-recently-touched** — `get` calls do NOT affect ordering (AC2). Repeated `state.get(refA)` calls between touches do not save `refA` from eviction.

**And** when `capacity = 1`, every `touch` of a different ref evicts the prior entry: `touch(A); touch(B); get(A) === undefined`.

**And** when the same ref is re-touched at capacity, no eviction occurs: `state.touch(refA); state.touch(refA); state.touch(refA)` keeps the count at 1 with `capacity = 3`.

**AC5 — Capacity validation: factory throws on invalid `capacity`**

**Given** `createFreshnessState({ capacity: c })`,
**When** `c` is not a finite positive integer (specifically: `0`, negative numbers, `NaN`, `Infinity`, `-Infinity`, non-integers like `2.5`),
**Then** the factory throws an `Error` whose message includes `"capacity"` and the offending value.

**And** the call site (Story 1.11's startup ladder) treats this as an invariant violation, not a `DomainError` — the throw escapes per `architecture.md:1118` ("throw only for invariants and infra"). The message format is freeform — no `DomainError` import, no `ReasonCode` projection.

**And** when `options` is omitted (or `options.capacity` is `undefined`), the factory uses `DEFAULT_FRESHNESS_CAPACITY` (`1024`) without throwing.

**And** `DEFAULT_FRESHNESS_CAPACITY` is exported as a `readonly` literal `1024`. The constant is documented as a personal-scale default — the production caller (Story 1.11) MAY override it via `options.capacity` if a larger SB space justifies. **The justification for `1024`:** a personal SB space typically holds low-thousands of pages; an agent session touches dozens. `1024 entries × ~150 bytes/entry ≈ 150 KB` resident — well within the NFR4 (`epics.md:74`) "bounded growth" envelope.

**AC6 — Pure-domain isolation, process-restart discards state**

**Given** `grep -rE "from '\.\./(silverbullet|audit|diagnostic|config|mcp|permissions|edits)'" src/freshness/`,
**When** the grep runs,
**Then** it returns nothing (AR58 / `epics.md:183` — pure-domain core imports from no boundary or peer module).

**And** the only in-tree import in `src/freshness/state.ts` is `import type { Ref } from '../domain/ref.ts'` (type-only — `verbatimModuleSyntax: true` per `tsconfig.json:12` requires `type` keyword on type-only imports).

**Given** the source of `src/freshness/state.ts`,
**When** I scan it for I/O / clock / global-state references,
**Then** there are NO occurrences of: `Date.now`, `performance.now`, `Math.random`, `crypto.*`, `process.*`, `globalThis.*`, `await`, `async`, `import('node:*')`, `require(`, dynamic `import()` of any kind. The state machine is fully synchronous and consumes only the `at` parameter for time and the `Map` for storage.

**And** because no fs / network / OS resource is touched, the state lives entirely in the V8 heap — when the Node process exits, the `Map` is garbage-collected. **No persistence in MVP** per PRD `prd.md:418-422` ("in-memory state, scoped to a single MCP server process lifetime") and architecture `architecture.md:822` ("`Map<Ref, lastReadAt>` with bounded-size policy. Updated only on successful `read_page`."). Tests assert this discipline structurally (no fs imports, no module-level mutable state); the runtime "process exits → state vanishes" property is a corollary that needs no separate test.

**AC7 — Test coverage at `src/freshness/state.test.ts`**

**Given** the unit tests at `src/freshness/state.test.ts`,
**When** `npm test` runs,
**Then** the suite covers (≥ **22 cases** — counting each top-level `await test(...)` as one case):

**Round-trip (AC2):**

1. `touch(refA, dateA)` then `get(refA)` returns `dateA` (referentially equal — `Object.is` comparison).
2. `get(refB)` for never-touched `refB` returns `undefined`.
3. `touch(refA, dateA1); touch(refB, dateB); get(refA)` returns `dateA1` (entries are independent).
4. `get` does NOT affect recency: `touch(A); touch(B); get(A); touch(C, capacity=2)` → `B` is evicted (LRU by touch, not by get).
5. The stored `Date` is referentially equal — mutating the caller's `Date` after `touch` would alter the stored value (the implementation does NOT defensively copy). Note: callers MUST treat passed `Date` as immutable; this test pins the no-copy contract so a future "defensive copy" PR is a deliberate decision, not an accidental drift.

**Re-touch / recency (AC3):**

6. `touch(A, t1); touch(A, t2); get(A)` returns `t2` (overwrite).
7. Re-touch with an earlier `at` is stored as-is: `touch(A, t2); touch(A, t1); get(A)` returns `t1` — no monotonicity guard.
8. Re-touching moves the entry to MRU: with capacity = 3, `touch(A); touch(B); touch(C); touch(A); touch(D)` evicts `B`, NOT `A`.
9. Re-touching the same ref at capacity does NOT evict: `capacity = 1; touch(A, t1); touch(A, t2); touch(A, t3); get(A)` returns `t3`.

**LRU eviction (AC4):**

10. `capacity = 3`: four sequential touches evict the first.
11. `capacity = 1`: `touch(A); touch(B); get(A) === undefined; get(B)` returns the second timestamp.
12. `capacity = 2`: insertion order `A, B, C, D` — surviving entries are `C, D`; `A` and `B` evicted.
13. Eviction at exactly the cap-exceed boundary: `capacity = 3` after exactly 3 touches → all three present; the 4th touch evicts exactly one.
14. Re-touch then insert: `capacity = 3; touch(A); touch(B); touch(C); touch(A); touch(D)` evicts `B`. Verify `get(A), get(C), get(D)` all defined; `get(B) === undefined`.
15. Reverse-insertion with re-touch: `capacity = 2; touch(A); touch(B); touch(A); touch(C)` — `B` evicted, `A` and `C` survive.

**Capacity invariant (AC5):**

16. `createFreshnessState({ capacity: 0 })` throws an `Error` with message containing `'capacity'`.
17. `createFreshnessState({ capacity: -1 })` throws.
18. `createFreshnessState({ capacity: NaN })` throws.
19. `createFreshnessState({ capacity: Infinity })` throws.
20. `createFreshnessState({ capacity: 2.5 })` throws (non-integer).
21. `createFreshnessState()` (no options) uses `DEFAULT_FRESHNESS_CAPACITY = 1024` and does not throw.
22. `createFreshnessState({})` (options without `capacity`) uses `DEFAULT_FRESHNESS_CAPACITY` and does not throw.
23. `DEFAULT_FRESHNESS_CAPACITY === 1024` (constant pin — a future change to the default is a deliberate revision, not a silent edit).

**Pure-function / isolation properties:**

24. Two `createFreshnessState()` instances are independent: touching one does not affect the other's `get` results.
25. The factory returns an object whose `touch` and `get` close over the same private map (verified indirectly via round-trip).

**And** every test is **pure** — no fs / network side effects. `node:test` + `node:assert/strict` per established pattern (Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7 / 1.8). Top-level `await test(...)` for each case (no `describe` blocks — `architecture.md:1158` and prior-story precedent).

**And** tests construct `Date` values with **fixed millisecond literals** (e.g., `new Date(0)`, `new Date(1_000_000)`) — no `Date.now()` invocations in the test file. The freshness state is "stateful" in the architecture's testing-pattern sense (`architecture.md:1159`), but the clock is the **caller's** (passed in via `at`); the state itself never reads a clock. Tests therefore use `Date` literals directly without needing a fake-clock injection.

**And** `Ref` fixtures use `makeRef('TestPage')`, `makeRef('Personal/Notes')`, etc. — never raw strings cast as `Ref`. The test imports `makeRef` from `../domain/ref.ts` for fixture construction only.

**AC8 — File structure, pack manifest, all gates green**

**Given** the project after this story,
**When** I list `src/freshness/`,
**Then** it contains exactly:

```
src/freshness/
├── state.ts             # NEW: createFreshnessState + types + DEFAULT_FRESHNESS_CAPACITY
└── state.test.ts        # NEW: ≥ 22 cases covering AC2-AC6
```

**And** **no other source file in the repo is changed.** In particular:

- `src/index.ts`, `src/audit/*`, `src/config/*`, `src/diagnostic/*`, `src/domain/*`, `src/edits/*`, `src/mcp/*`, `src/permissions/*`, `src/silverbullet/*` — UNCHANGED.
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.prettierrc.json`, `package.json`, `package-lock.json` — UNCHANGED. **No new dependencies.**
- `tests/integration/*`, `tests/smoke/*`, `scripts/*` — UNCHANGED.
- No `index.ts` re-export barrel under `src/freshness/` (AR57 / `architecture.md:999`).

**And** `npm pack --dry-run` manifest grows from **23 files** (post-1.8 per `1-8-...md` AC8) to **24 files** — the single new published file is `src/freshness/state.ts`. The test file `state.test.ts` is excluded by `package.json:15`'s `"!src/**/*.test.ts"` allowlist negation.

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`.

**And** `npm test` reports ≥ **+22 new cases** versus the post-1.8 baseline of **367 tests** (per `1-8-...md` Completion Notes). Expected total: **≥ 389**.

**And** the existing test suite continues to pass without modification — this story is purely **additive**.

## Tasks / Subtasks

- [x] **Task 1: Implement `src/freshness/state.ts`** (AC: #1, #2, #3, #4, #5, #6)
  - [x] Create the file. The single in-tree import is `import type { Ref } from '../domain/ref.ts'` (type-only — `verbatimModuleSyntax: true`).
  - [x] Define and export `type FreshnessState = { touch(ref: Ref, at: Date): void; get(ref: Ref): Date | undefined }` per AC1.
  - [x] Define and export `type CreateFreshnessStateOptions = { readonly capacity?: number }` per AC1. The `capacity?: number` is intentionally optional under `exactOptionalPropertyTypes: true` (`tsconfig.json:10`) — callers MAY omit to use the default; supplying `undefined` explicitly is also valid and equivalent to omission.
  - [x] Define and export `const DEFAULT_FRESHNESS_CAPACITY = 1024 as const;` per AC5. The `as const` narrows the type to the literal `1024` (matches the AC1 typing `: 1024`). JSDoc the rationale (`~150 KB resident at default; personal-scale; override via options.capacity`).
  - [x] Implement `createFreshnessState(options?: CreateFreshnessStateOptions): FreshnessState`:
    - [x] **Resolve capacity:** `const capacity = options?.capacity ?? DEFAULT_FRESHNESS_CAPACITY;` Then validate: `if (!Number.isInteger(capacity) || capacity < 1) throw new Error(\`createFreshnessState: capacity must be a positive integer, got ${String(capacity)}\`);`. `Number.isInteger(NaN) === false`, `Number.isInteger(Infinity) === false`, `Number.isInteger(2.5) === false`, `Number.isInteger(0) === true` (so the `< 1` check rejects `0`) — the combined predicate covers AC5 cases 16-20.
    - [x] **Closed-over state:** `const map = new Map<Ref, Date>();` — a fresh `Map` per factory invocation. `Map` preserves insertion order natively (ECMAScript spec); we exploit this for LRU.
    - [x] **`touch(ref, at)`:** Implementation pattern:
      ```typescript
      function touch(ref: Ref, at: Date): void {
        // Remove-then-set forces the entry to the MRU end of the Map's
        // iteration order, regardless of whether it existed before. This
        // is the standard JS LRU idiom (see MDN: Map iteration order).
        map.delete(ref);
        map.set(ref, at);
        // Evict LRU when over cap. The first key in iteration order is
        // the least-recently-set, which (given remove-then-set above) is
        // the least-recently-touched.
        if (map.size > capacity) {
          const lruKey = map.keys().next().value;
          // map.size > capacity > 0, so the iterator yields a key.
          // The `value: Ref | undefined` from the iterator is narrowed
          // by the size check; the `if (lruKey !== undefined)` guard
          // satisfies `noUncheckedIndexedAccess`-adjacent safety without
          // a type assertion.
          if (lruKey !== undefined) map.delete(lruKey);
        }
      }
      ```
    - [x] **`get(ref)`:** `return map.get(ref);` — direct `Map.get`. Returns `Date | undefined` natively (no narrowing needed). Does NOT mutate `map` (read-only inspection per AC2).
    - [x] Return `{ touch, get }` as the `FreshnessState` instance.
  - [x] JSDoc the public surface: cite NFR4 / `epics.md:74`, `architecture.md:822`, `architecture.md:1062` (handler usage), `architecture.md:1158-1159` (testing-pattern — fake-clock-via-`at`), `prd.md:418-422` (PRD §State & Session Model — in-memory, process-scoped). Document the LRU semantics succinctly: "`touch` is the only operation that updates recency; `get` is read-only".
  - [x] **Pure:** zero I/O, zero clock reads, zero module-level mutable state (only `DEFAULT_FRESHNESS_CAPACITY` is module-level — and it's a `const` literal). No imports beyond `type Ref`.
  - [x] **Anti-patterns to avoid:** no `any`; no `as` casts (the only place a cast was needed is `lruKey` from the iterator — solved by the `!== undefined` guard, NOT by `as Ref`); no `enum`; no `class` (factory + closures are the architecture's pattern — see `audit-logger.ts:230-300` for precedent); no `console.*`; no defensive cloning of the input `Date` (AC2 pins the no-copy contract).

- [x] **Task 2: Write `src/freshness/state.test.ts` covering AC2-AC6** (AC: #2, #3, #4, #5, #6, #7)
  - [x] Create the test file. Imports: `import test from 'node:test'; import assert from 'node:assert/strict'; import { makeRef } from '../domain/ref.ts'; import { createFreshnessState, DEFAULT_FRESHNESS_CAPACITY } from './state.ts';`.
  - [x] Top-level `await test(...)` for each case (no `describe` blocks).
  - [x] **Helper for fixture construction:** private `const ref = (n: string) => makeRef(n);` at the top of the file.
  - [x] **Helper for `Date` construction:** fixed-millisecond literals (`new Date(0)`, `new Date(1)`, ...). `assert.strictEqual` for referential `Date` equality; `assert.equal(x?.getTime(), y)` for cross-instance time comparison.
  - [x] Cases (≥ 22 per AC7): 24 cases shipped — 5 round-trip, 4 re-touch/recency, 5 LRU eviction, 8 capacity invariant, 2 isolation properties.
  - [x] **Capacity-invariant assertions:** `assert.throws(() => createFreshnessState({ capacity: 0 }), /capacity/);` etc.
  - [x] **`DEFAULT_FRESHNESS_CAPACITY === 1024` pin** — `assert.strictEqual(DEFAULT_FRESHNESS_CAPACITY, 1024);`.
  - [x] **Independence of two instances** (AC7 #24).
  - [x] **Eviction-via-capacity-3** (AC7 #10) — exact-survivor verification.
  - [x] **Re-touch-then-insert** (AC7 #14) — pins the delete-then-set contract.
  - [x] **No fs / network side effects** — verified by grep (no `node:fs|node:os|node:net|process.|Date.now|performance.now`).

- [x] **Task 3: Local verification** (AC: #8)
  - [x] `npm run typecheck` → exit 0, zero TS errors.
  - [x] `npm run lint` → exit 0 with `--max-warnings=0`. Caught one `@typescript-eslint/unbound-method` warning on a destructured-method test pattern; rewrote the test to call methods through the `state` reference (no destructure).
  - [x] `npx prettier --check .` → all matched files formatted; output: "All matched files use Prettier code style!".
  - [x] `npm test` → 392 / 392 passing; +25 new cases over the post-1.8 baseline of 367 (one above the AC7 floor due to keeping the round-trip set at 5 and isolation set at 2).
  - [x] `npm pack --dry-run` → manifest is exactly **24 files** (23 baseline + `src/freshness/state.ts`); test file excluded by the `"!src/**/*.test.ts"` allowlist negation.
  - [x] **Pure-domain isolation grep** — `grep -rE "from '\.\./(silverbullet|audit|diagnostic|config|mcp|permissions|edits)'" src/freshness/` returns zero output. Same for `node:fs|node:os|node:net|node:crypto|node:http|Date\.now|performance\.now|process\.` against `src/freshness/state.ts`.
  - [x] **Optional sanity:** runtime exports verified — `DEFAULT_FRESHNESS_CAPACITY`, `createFreshnessState` (types erased per `verbatimModuleSyntax`).

- [x] **Task 4: Append deferred-work entries (if any surface)** (housekeeping)
  - [x] Reviewed candidates — none felt load-bearing enough to file a fresh deferred-work entry; the speculative items already documented in the Dev Notes section serve as the in-place backlog. No edits to `deferred-work.md`.

### Review Findings

- [x] [Review][Patch] Tighten JSDoc claim about `CreateFreshnessStateOptions.capacity` [`src/freshness/state.ts:24-32`] — Original JSDoc claimed callers "MAY omit the field OR pass `undefined`" but under `exactOptionalPropertyTypes: true`, the declared type `capacity?: number` REJECTS explicit `undefined`. (Surfaced when the proposed pin-test failed typecheck with TS2379.) The implementation matches AC1's exact signature; the JSDoc was an over-claim. Tightened to: "callers omit the field to use `DEFAULT_FRESHNESS_CAPACITY`; explicit `undefined` is type-rejected." Note: the spec's Dev Notes line 378 carries the same over-claim — informational only, not a blocker.
- [x] [Review][Patch] Use `assert.strictEqual` consistently for `Date` referential-equality checks [`src/freshness/state.test.ts:62`] — Test 5 (`stored Date is the caller reference`) used `assert.ok(Object.is(state.get(refA), date))` while sibling tests at lines 19, 35, 36 used `assert.strictEqual`. Under `node:assert/strict`, `assert.strictEqual` IS `Object.is` — divergence was purely stylistic. Replaced with `assert.strictEqual(state.get(refA), date)`.
- [x] [Review][Defer] Consumer-side handling of evicted-pre-edit case [`src/freshness/state.ts:82-84`] — deferred, cross-reference for Stories 2.3 / 2.5
- [x] [Review][Defer] NaN / out-of-range `Date` validation at consumer boundary [`src/freshness/state.ts:67-72`] — deferred, cross-reference for Stories 1.10 / 2.3 / 2.5
- [x] [Review][Defer] No `forget(ref)` after `delete_page` success [`src/freshness/state.ts:19-22`] — deferred, already in spec scope-boundaries (lines 470, 484); reaffirm for Story 2.5

## Dev Notes

### Architectural source-of-truth

This is story **#10** in the implementation sequence (`architecture.md:822`, item 10: "**Freshness state** — `Map<Ref, lastReadAt>` with bounded-size policy. Updated only on successful `read_page`."). It depends on:

- Story 1.2's `Ref` (`src/domain/ref.ts`) — the `touch(ref, at)` and `get(ref)` API operates on branded `Ref` values. The factory never validates refs internally (caller boundary discipline per AR10 / `epics.md:117`); the type system is the gate.

It does **NOT** depend on:

- Story 1.5's audit logger — the freshness state produces no audit entries; rejection-on-stale is the consumer handler's responsibility (Story 2.3's `edit_page`, Story 2.5's `delete_page`).
- Story 1.6's `DomainError` — capacity-invariant violations throw plain `Error` (programmer-error class per `architecture.md:1118`); the freshness state has no domain-error surface to project. **Do NOT import `domain/error.ts` from this module.**
- Story 1.7's `RuntimeClient` — the engine consumes nothing from SilverBullet directly. The handler boundary (Stories 1.10 / 2.3 / 2.5) wires `client.exec(pageMetaScript)` to read `lastModified`, which the handler compares against `freshness.get(ref)` — but the freshness state itself is upstream of every SB call.
- Story 1.8's permission engine — orthogonal concern. Permission gating happens before freshness check in the tool-handler shape (`architecture.md:1054-1059`).
- Story 1.10's tool handlers, Story 1.11's startup ladder, Stories 2.x's edit/delete handlers — all downstream consumers.
- The `@modelcontextprotocol/sdk` — the freshness state is fully independent of MCP transport.

**Primary specs (read these first):**

- D2 — Freshness invariant locus: `_bmad-output/planning-artifacts/architecture.md:418-432`. In-memory state, scoped to a single MCP server process lifetime; `lastModified > lastReadAt` as the rejection predicate.
- AR12, NFR4, NFR19, NFR21 in `_bmad-output/planning-artifacts/epics.md:74,99,101,120` — engine purity, bounded growth, offline test suite.
- AR58 — acyclic dependency rule: `_bmad-output/planning-artifacts/epics.md:183`. The pure-domain core (`permissions/`, `edits/`, `domain/`, `freshness/`, `audit/schema`, `audit/digest`) imports from no boundary module.
- Cross-component dependency map: `architecture.md:830-842` — `Freshness state | Ref`.
- Implementation sequence (this story = #10): `architecture.md:822`.
- Tool-handler usage (downstream consumer view): `architecture.md:1054-1077` — `ctx.freshness.get(ref)` vs `meta.lastModified`; `ctx.freshness.touch(ref, ctx.clock.now())` post-successful-write.
- PRD State & Session Model: `prd.md:418-432` — "in-memory, scoped to a single MCP server process lifetime"; "no persistent local state in MVP".
- Architecture testing-pattern note for stateful modules: `architecture.md:1158-1159` — "tested with a fake clock injected through the constructor / context. No real `Date.now()` in tests." For this module specifically, the "fake clock" is the **`at` parameter** the test passes in directly; the state has no internal clock.

### What this story owns (and does NOT own)

**Owns:**

- `src/freshness/state.ts` — `FreshnessState` type, `CreateFreshnessStateOptions` type, `DEFAULT_FRESHNESS_CAPACITY` constant, `createFreshnessState` factory.
- `src/freshness/state.test.ts` — round-trip, recency, LRU eviction, capacity-invariant, isolation tests (≥ 22 cases).

**Does NOT own (these land in later stories):**

- The `read_page` handler calling `ctx.freshness.touch(ref, ctx.clock.now())` post-successful-read — Story 1.10 (FR12 / `epics.md:43`).
- The `edit_page` handler calling `ctx.freshness.get(ref)` and comparing to `meta.lastModified` to reject stale snapshots — Story 2.3 (FR20 / `epics.md:51-52`).
- The `delete_page` handler's freshness check (same logic) — Story 2.5.
- The post-successful-write `freshness.touch` call in `edit_page` — Story 2.3 (`architecture.md:1077`).
- The `freshness_violation` error construction and `details: { lastModified, lastReadAt }` audit projection — Story 2.3 / Story 1.6's existing `freshnessViolationError` constructor (already shipped in `src/domain/error.ts`).
- `HandlerContext` wiring of `ctx.freshness` — Story 1.10's `handler-template.ts`.
- The capacity override at startup (e.g., reading from an env var) — Story 1.11. This story ships a default; production wiring decides whether to override.
- Persistent freshness state across MCP server restarts — explicitly deferred to Growth (`epics.md:209` / AR76 / `architecture.md:1577`).
- Latency cache for permission lookups — D2 deferred (`architecture.md:288`).
- A `freshness/index.ts` barrel re-exporting the surface — AR57 forbids barrel files.

### Files this story creates / modifies / deletes

**NEW:**

- `src/freshness/state.ts`
- `src/freshness/state.test.ts`

**MODIFY:**

- Nothing.

**UNCHANGED (do not touch):**

- All `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/index.ts`, `src/mcp/`, `src/permissions/`, `src/silverbullet/` files.
- `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md`, `package.json`, `package-lock.json` — **no new dependencies.**
- `tests/integration/`, `tests/smoke/`, `scripts/`.
- All `_bmad/`, `.claude/`, `docs/` (this story does not touch documentation; the user-facing freshness explainer lands in Story 1.13's `docs/permissions.md` or `docs/threat-model.md` per AR64 / `epics.md:193`).

**DELETE:**

- Nothing.

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/freshness/state.test.ts` next to `state.ts` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`).
- **Top-level `await test(...)`** for each case (no `describe` blocks — established Stories 1.3-1.8 pattern).
- **No mocks.** The module is a pure factory + closure; tests exercise the implementation directly with hand-crafted fixtures.
- **No real `Date.now()`** in tests — use `new Date(0)`, `new Date(1)`, etc. The state has no internal clock; the `at` parameter is the test's clock.
- **No fs / network side effects** — purity is a contract.
- Assertions:
  - `assert.strictEqual` for primitives (returned `Date | undefined`, the `DEFAULT_FRESHNESS_CAPACITY === 1024` pin).
  - `assert.strictEqual(state.get(ref), date)` — referential equality for the `Date` round-trip per AC2.
  - `assert.equal(state.get(ref)?.getTime(), 42)` for indirect time comparison when comparing different `Date` instances constructed in test scope.
  - `assert.throws(() => createFreshnessState({ capacity: 0 }), /capacity/)` for AC5 invariants.

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + previously-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:47`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; no build step; native `Map` with insertion-order semantics |
| `node:test` | built-in | Test framework |
| `node:assert/strict` | built-in | Assertions |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:**

- `lru-cache`, `quick-lru`, `mnemonist` — adding a dependency for a 30-line factory is overkill. JS `Map` preserves insertion order natively; the LRU idiom is `delete-then-set` + evict-first-key. The architecture's "minimal-deps stance" (D3) and the "small dependency surface" line in `architecture.md:805` apply here.
- `node:timers` / `setTimeout`-driven TTL eviction — out of scope. The freshness state evicts on insertion-time when over cap, never on a timer. A timer-driven sweep would introduce non-deterministic test behavior and add a clock dependency that AC6 forbids.
- `zod` for the `CreateFreshnessStateOptions` shape — overkill for a single optional field. Direct `if (!Number.isInteger(capacity) || capacity < 1)` is clearer and avoids an extra schema-definition site. (`zod` is reserved for `src/config/config.ts`'s env-var boundary — Story 1.4.)
- `@modelcontextprotocol/sdk` — Story 1.10/1.11 territory. No transport surface in this story.
- Property-based testing libraries (`fast-check`, `jsverify`) — restricted to the edit-batch validator per `architecture.md:1161` (Story 2.1). The freshness state's LRU property is verified with hand-crafted fixed sequences (insertion-order tests).

### File-structure requirements

After this story, `src/freshness/` must look like:

```
src/freshness/
├── state.ts             # NEW: createFreshnessState + types + DEFAULT_FRESHNESS_CAPACITY
└── state.test.ts        # NEW: ≥ 22 cases
```

**No barrel files** (AR57 / `architecture.md:999`). Importers in later stories write `from '../freshness/state.ts'` directly.

### Latest tech information (researched 2026-04-30)

- **`Map` insertion-order iteration** is mandated by the ECMAScript spec (ECMA-262 §24.1) — keys iterate in the order they were first inserted. `delete-then-set` of an existing key moves it to the iteration end (because `set` after `delete` is a fresh insertion). This is the LRU idiom this story relies on. Node ≥ 24 / V8 honors this contract.
- **`Map.prototype.keys()` iterator** — `map.keys().next().value` returns the first key in iteration order (LRU). Under `noUncheckedIndexedAccess` (`tsconfig.json:7`), `IteratorResult.value` is typed `Ref | undefined`; the `if (lruKey !== undefined) map.delete(lruKey)` guard satisfies the narrowing without a cast.
- **`as const` for narrowing literal constants** — `DEFAULT_FRESHNESS_CAPACITY = 1024 as const` produces type `1024` (not widened to `number`). Matches Story 1.6's `as const satisfies` pattern (`src/domain/error.ts:27-34`) and Story 1.8's `ACCESS_MODES` (`src/permissions/access-mode.ts:29-34`). For a single literal (not a tuple), `as const` is sufficient.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:10`): `capacity?: number` means callers MAY omit the field OR pass `undefined`. The implementation's `options?.capacity ?? DEFAULT_FRESHNESS_CAPACITY` handles both uniformly. **Do NOT** declare `capacity: number | undefined` (without `?`) — that would FORCE callers to pass the field even if just to set it `undefined`.
- **`erasableSyntaxOnly: true`**: no `enum`, no `namespace`, no constructor parameter properties. The factory returns a closure-bound object literal — the standard pattern in this codebase (`src/audit/audit-logger.ts:230-300`, `src/diagnostic/logger.ts`).
- **`verbatimModuleSyntax: true`**: type-only imports must use `import type` — `import type { Ref } from '../domain/ref.ts'`. Match Stories 1.5 / 1.6 / 1.7 / 1.8 style.
- **`noUncheckedIndexedAccess: true`**: `map.keys().next().value` returns `Ref | undefined`. Guard with `!== undefined`.
- **`Number.isInteger`** rejects `NaN`, `Infinity`, `-Infinity`, `2.5`, `'2'`, `null`, `undefined`. Combined with `< 1` it covers AC5 #16-20 in a single predicate. **`Number.isFinite` is not enough** — `Number.isFinite(2.5) === true` would let a non-integer slip through.
- **`Map.prototype.size`** is the count of entries — `O(1)`. The eviction check `if (map.size > capacity)` is constant-time per `touch`. The full `touch` op is amortized `O(1)` (Map operations are average-O(1); the iterator's `.next()` call is also O(1)).

### Previous story intelligence (from Stories 1.1-1.8)

Distilled patterns to apply:

1. **Top-level `await test(...)`** is the established test pattern (Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7 / 1.8). Do NOT introduce `describe` blocks.
2. **Factory + closure** is the established stateful-module pattern (`src/audit/audit-logger.ts:230-300`, `src/diagnostic/logger.ts`). The factory captures state in closures; the returned object exposes only the public methods. **Do NOT use `class`.**
3. **`as const satisfies T`** is the established literal-narrowing pattern (`src/domain/error.ts:27-34`'s `REASON_CODES`, `src/permissions/access-mode.ts:29-34`'s `ACCESS_MODES`). For a single literal value (not a tuple), bare `as const` is sufficient — `DEFAULT_FRESHNESS_CAPACITY = 1024 as const`.
4. **`assertExhaustive(value: never): never`** — not needed in this story. The freshness state has no discriminated-union switch; its only branching is on `Number.isInteger` and `map.size > capacity`.
5. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../domain/ref.ts'`. `node:` builtins import normally — but this module imports zero `node:*` modules.
6. **No barrel re-exports** (AR57 / `architecture.md:999`). Importers in Stories 1.10 / 1.11 / 2.3 / 2.5 will write `from '../freshness/state.ts'` directly.
7. **`@ts-expect-error` requires inline justification** (AR59 / `architecture.md:1032`). Avoid altogether — every type narrowing in this module is via `Number.isInteger` / `!== undefined` guards.
8. **Story 1.5's `void`-return / fire-and-forget pattern** — not applicable here (all functions are synchronous, return values).
9. **Story 1.5's `createAuditLogger(options)` factory shape** — directly applicable: optional-options object, validated at construction, returns a closure-bound API surface.
10. **Story 1.6's `isPlainObject` and `scrubSecrets` complexity** — NOT applicable; this module has no `unknown` boundary (its only input is the typed `at: Date` and the type-checked `ref: Ref`).
11. **Story 1.7's `RUNTIME_ERROR_CODE` pattern** — NOT applicable; no closed-vocabulary string enum here.
12. **Story 1.8's purity-isolation grep verification** — directly applicable. Run `grep -rE "from '\.\./(silverbullet|audit|diagnostic|config|mcp|permissions|edits)'" src/freshness/` after implementation; should return zero output (AR58).
13. **Story 1.7 / 1.8 dev-notes lesson (`exactOptionalPropertyTypes` traps)** — `capacity?: number` is the right shape. Do NOT use `capacity: number | undefined` (forces explicit pass).

### Git intelligence

Recent commits (`git log --oneline -8`):

- `103e063 feat(permissions): access-mode, block parser, engine (story 1.8)`
- `23ba910 feat(silverbullet): runtime client, envelope, lua templates (story 1.7)`
- `e111c8c feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`

**Expected commit footprint for this story:** 2 new files (1 source + 1 test) under `src/freshness/`. No modifications, no deletions.

**Conventional Commits gate** (`a867ada`). This story's commit message should follow the established pattern:

`feat(freshness): in-memory bounded state with LRU eviction (story 1.9)`

### Critical guardrails (do not rediscover)

1. **The factory is pure-domain** (NFR19 / `epics.md:99`, AR58 / `epics.md:183`). Zero I/O, zero clock reads from inside the module, zero global mutable state. The pure-domain core (`src/freshness/`) imports from `domain/ref.ts` only. **Importing `silverbullet/`, `audit/`, `diagnostic/`, `config/`, `mcp/`, `permissions/`, `edits/`, `node:fs`, `node:net`, `node:os`, `node:crypto`, `globalThis.fetch`, `Date.now`, or `performance.now` in `src/freshness/state.ts` is a code-review block.**

2. **`get` does NOT affect recency** (AC2, AC4). Re-reading the same ref via `get` between touches does not save it from eviction. The LRU policy keys off `touch` only. **Do NOT** implement a "read also bumps" variant — that's a different cache contract (write-through LRU vs write-only LRU); the freshness invariant cares about "was the agent's read recent enough", not "was the timestamp inspected recently".

3. **`touch` overwrites the stored timestamp unconditionally** (AC3). A re-touch with `at` ≤ the prior stored value still replaces. **Do NOT** add a `Math.max(prev, at)` monotonicity guard — production callers pass `clock.now()` (monotonic by contract); the state is a dumb store. A monotonicity guard would mask programmer errors at the call boundary instead of surfacing them.

4. **No defensive `Date` cloning** (AC2 #5). The implementation stores the same `Date` instance the caller passed. Cloning would silently create a hidden contract that callers MAY mutate the `Date` after `touch`. The pinned no-copy contract makes the constraint explicit. (Note: callers DO NOT mutate `Date` instances — they're functionally treated as immutable in this codebase. The test pins the contract so any future "we should defensively copy" PR is a deliberate decision.)

5. **Capacity throws `Error`, not `DomainError`** (AC5). `architecture.md:1118` — "throw only for invariants and infra". A non-positive `capacity` is a programmer error at the construction boundary; the throw escapes to the startup ladder, which fails fast (Story 1.11). **Do NOT** import `domain/error.ts` to dress up the throw — it would couple pure-domain to the error-presentation layer (AR58 forbids).

6. **`Number.isInteger`, NOT `Number.isFinite`** for capacity validation (AC5). `Number.isFinite(2.5) === true` would let `2.5` through; the LRU map only makes sense at integer cap.

7. **`Map.prototype.delete` then `Map.prototype.set` IS the LRU bump** (Task 1, `touch` body). A naive `if (!map.has(ref)) map.set(ref, at); else map.set(ref, at)` does NOT move the entry to the MRU end — `set` of an existing key updates the value but keeps the original insertion position. The `delete` is **load-bearing**; remove it and AC4 #14 fails.

8. **`map.size > capacity`, NOT `map.size >= capacity`** for eviction trigger (Task 1). The state allows exactly `capacity` entries; eviction fires when adding the (capacity + 1)-th. AC4's "capacity = 3 after 3 touches → all three present; the 4th evicts one" pins this off-by-one.

9. **Eviction picks the FIRST iterator key** (Task 1). `Map.prototype.keys().next().value` is the LRU under the delete-then-set discipline. `map.entries()`, `map.values()`, and the for-of iteration share this order — but `keys()` is the cheapest.

10. **`@ts-ignore` and `@ts-expect-error` are forbidden without inline tracked-issue justification** (AR59 / `architecture.md:1032`).

11. **No `enum`, no `namespace`, no constructor parameter properties** (`erasableSyntaxOnly: true`).

12. **No `as` casts outside boundary constructors** (AR59 / `architecture.md:1031`). The `lruKey !== undefined` guard in the eviction path is the architecture-approved alternative to `lruKey as Ref`.

13. **No `class`** — factory + closure is the codebase pattern (`src/audit/audit-logger.ts`, `src/diagnostic/logger.ts`). A `class FreshnessState` would deviate without justification.

14. **`no-floating-promises` is enforced** (`eslint.config.js:19`) — irrelevant here (the module is fully synchronous), but worth noting if a future revision adds an async path.

15. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../domain/ref.ts'`.

16. **Test file naming:** `state.test.ts` adjacent to `state.ts` (`architecture.md:998`). Excluded from pack via `package.json:15`'s `"!src/**/*.test.ts"`.

17. **Tests use `Date` literals, not `Date.now()`** (`architecture.md:1158-1159` testing-pattern note). The architecture's "fake clock" requirement for stateful modules is satisfied by passing fixed `Date(0)`, `Date(1)`, etc. directly to `touch` — the state has no internal clock to fake.

18. **`DEFAULT_FRESHNESS_CAPACITY` is a `1024` literal** — a `const` with `as const` keeps the type narrow. **Do NOT** widen to `number` (e.g., `const X: number = 1024;`) — that would let a downstream re-assignment compile. Although TS `const` can't be reassigned at the binding level, type-narrowing keeps shape-checks tight (e.g., a future `assert.strictEqual(DEFAULT_FRESHNESS_CAPACITY, 1024)` would fail typecheck if the constant is widened and the test value drifts).

### Story scope boundaries (DO NOT include)

- **The `read_page` handler calling `freshness.touch(...)`** — Story 1.10 (FR12).
- **The `edit_page` / `delete_page` handler calling `freshness.get(...)` and rejecting on stale** — Stories 2.3 / 2.5 (FR20, FR25).
- **`HandlerContext` typing** — Story 1.10's `handler-template.ts`.
- **Wiring `createFreshnessState` into `src/index.ts`** — Story 1.11's startup ladder.
- **Reading a capacity from an env var** — Story 1.4's config module already shipped; if `MCP_SILVERBULLET_FRESHNESS_CAPACITY` ever surfaces, the schema lives in `src/config/config.ts`, not here. Out of scope for this story.
- **Persistent freshness state across server restarts** — explicitly deferred to Growth (AR76 / `epics.md:209` / `architecture.md:1577`). Adding persistence would require a path resolver, fs writes, and a startup-time hydrate — all of which contradict AC6's pure-domain isolation.
- **Time-based TTL eviction (e.g., evict entries older than N seconds)** — out of scope. The capacity-based LRU is the only eviction policy this story ships. TTL would require a clock inside the module (AC6 forbids).
- **A `peek(ref)` method that doesn't bump recency** — already the contract for `get` (AC2). No need for a separate method.
- **A `clear()` / `delete(ref)` method** — not requested. The natural lifecycle is "process exits → state vanishes"; explicit clearing is a Growth concern (e.g., for a future "agent disconnect → drop session state" feature).
- **Property-based testing for the LRU monotonicity** — restricted to the edit-batch validator per `architecture.md:1161` (Story 2.1). The fixed-permutation approach in AC7 is the architecture-approved equivalent.
- **A `freshness/index.ts` barrel re-exporting the surface** — AR57 forbids barrel files (`architecture.md:999`).
- **`docs/permissions.md` user-facing documentation about the freshness invariant** — Story 1.13 (AR64 / `epics.md:193`).
- **Logging (`logger.warn(...)`) on eviction events** — currently no diagnostic-logging surface. Eviction is silent. If operator visibility surfaces as a need (e.g., "agent touched 10000+ pages, eviction is happening every call"), revisit in Story 1.13 or as a deferred-work item.
- **A `metrics()` / `size()` introspection method** — not requested. Tests verify eviction by `get(refLRU) === undefined`, not by counting size. Adding `size()` would expose internal state without a load-bearing consumer.

### Deferred-from-this-story candidates (proposed deferred-work entries — review post-implementation)

These should be considered for `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands, IF they feel real after the implementation pass:

1. **Defensive `Date` cloning at the boundary** — currently the stored `Date` is the caller's reference. If a future caller passes a mutable `Date` and then mutates it, the freshness state's stored value silently drifts. Theoretical (the codebase treats `Date` as immutable); revisit if a production bug is traced here.
2. **Eviction-event diagnostic-log signal** — for operator visibility when `capacity` is too small. Currently silent. Revisit when Story 1.13 or operator feedback surfaces a need.
3. **TTL eviction (evict entries older than N seconds)** — explicit out-of-scope per "Story scope boundaries". Revisit if a real deployment shows session-length pages staying touched indefinitely without re-reads, causing eviction churn instead of natural turnover.
4. **`MCP_SILVERBULLET_FRESHNESS_CAPACITY` env var** — currently capacity is hardcoded at `DEFAULT_FRESHNESS_CAPACITY = 1024` with optional override at `createFreshnessState({ capacity })`. If operators report needing larger caps for org-scale spaces, surface via `src/config/config.ts` and wire through the startup ladder.
5. **Persistent freshness state across MCP server restarts** — already in the Growth backlog (AR76 / `architecture.md:1577`). No action needed; this list-entry exists only for cross-reference.
6. **A `peek(ref)` method** — currently `get` is the peek (no recency bump). If a future API needs both bump-on-read and peek-without-bump, revisit. Not anticipated.
7. **`freshness/state.bench.ts` micro-benchmarks** — verify amortized O(1) `touch` and the cost of `delete`-then-`set` vs alternative LRU implementations. Out of scope for MVP; revisit if profiling surfaces freshness-state CPU as a hotspot.

### Project Structure Notes

- **Alignment with unified project structure:** `src/freshness/` matches the architecture's `src/` tree (`architecture.md:961-963`, `1269-1271`) one-to-one. The architecture lists two files (`state.ts`, `state.test.ts`) — this story ships exactly those.
- **Detected variances:** none. The `src/freshness/` directory has been an empty placeholder since Story 1.1's scaffold (`epics.md:298` — "empty subfolders exist for each architectural seam"); this story populates it.
- **No `index.ts` re-export barrel** (AR57 / `architecture.md:999`). Importers in later stories write `from '../freshness/state.ts'` directly.
- **Pure-domain core boundary** (AR58 / `epics.md:183`). The `src/freshness/` directory imports only from `src/domain/` (specifically `ref.ts`, type-only). No imports from `src/silverbullet/`, `src/audit/`, `src/diagnostic/`, `src/config/`, `src/mcp/`, `src/permissions/`, `src/edits/`. Verify via `grep -rE "from '\.\./(silverbullet|audit|diagnostic|config|mcp|permissions|edits)'" src/freshness/` after implementation.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.9] (lines 536-555)
- D2 — Freshness invariant locus and in-memory model: [Source: _bmad-output/planning-artifacts/architecture.md#D2] (lines 418-432)
- Cross-component dependency map (`Freshness state | Ref`): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 838-841)
- Implementation sequence (this story = #10): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 822)
- Source-tree contract for `src/freshness/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 961-963, 1269-1271)
- Naming conventions (`PascalCase` types, `camelCase` functions, `kebab-case.ts` files): [Source: _bmad-output/planning-artifacts/architecture.md#Naming] (lines 882-928)
- Type-safety patterns (no `any`, `as` only at boundaries): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1002-1034)
- Stateful-module testing pattern (fake clock via injection): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1156-1165)
- Tool-handler shape (downstream usage of `ctx.freshness`): [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1054-1077)
- Mandatory rules summary: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1167-1180)
- Anti-patterns (no `class`-on-singletons, no module-level singletons reachable from handlers): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1182-1193)
- Architectural boundaries (`src/freshness/` is pure-domain; no boundary): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1300-1337)
- AR12 — engine purity stance applies to freshness state by extension: [Source: _bmad-output/planning-artifacts/epics.md] (line 120)
- AR53 — handler-context injection (no module-level singletons): [Source: _bmad-output/planning-artifacts/epics.md] (line 176)
- AR57 — no barrel files: [Source: _bmad-output/planning-artifacts/epics.md] (line 182)
- AR58 — acyclic dependency rule: [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 — no `as` outside boundaries; no `@ts-ignore` without justification: [Source: _bmad-output/planning-artifacts/epics.md] (line 186)
- AR76 — persistent freshness state deferred to Growth: [Source: _bmad-output/planning-artifacts/epics.md] (line 209)
- NFR4 — bounded memory: [Source: _bmad-output/planning-artifacts/epics.md] (line 74), [Source: _bmad-output/planning-artifacts/prd.md] (line 514)
- NFR19 — pure-domain core: [Source: _bmad-output/planning-artifacts/epics.md] (line 99)
- NFR21 — offline test suite: [Source: _bmad-output/planning-artifacts/epics.md] (line 101)
- FR12 — `read_page` updates freshness state (consumer side, Story 1.10): [Source: _bmad-output/planning-artifacts/epics.md] (line 43)
- FR16 — append exempt from freshness invariant (consumer side, Story 2.2): [Source: _bmad-output/planning-artifacts/epics.md] (line 46)
- FR20 — freshness check on edit (consumer side, Story 2.3): [Source: _bmad-output/planning-artifacts/epics.md] (line 51-52)
- FR25 — freshness check on delete (consumer side, Story 2.5): [Source: _bmad-output/planning-artifacts/epics.md] (line 59)
- PRD §State & Session Model: [Source: _bmad-output/planning-artifacts/prd.md] (lines 418-432)
- Existing `Ref` primitive (the only in-tree dependency): [Source: src/domain/ref.ts] (lines 8, 117-122)
- Existing `createAuditLogger` factory pattern (architectural precedent for closure-bound state): [Source: src/audit/audit-logger.ts] (lines 230-300)
- Existing `as const` literal-narrowing pattern: [Source: src/permissions/access-mode.ts] (lines 29-34), [Source: src/domain/error.ts] (lines 27-34)
- Tool-handler shape — freshness check between permission and execute: [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1054-1077)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-8-permission-engine-and-mcp-config-block-parser.md], [Source: _bmad-output/implementation-artifacts/1-7-silverbullet-runtime-client-and-latency-baseline.md], [Source: _bmad-output/implementation-artifacts/1-6-domainerror-formatter-and-audit-serializer.md], [Source: _bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md], [Source: _bmad-output/implementation-artifacts/1-4-configuration-module-and-secret-scrubber.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Red phase verification:** initial `node --test src/freshness/state.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `./state.ts` (and TypeScript [2307] diagnostic) — expected before the implementation file existed. Confirms tests are wired to the module surface and would have failed had the green-phase implementation been omitted.
- **`@typescript-eslint/unbound-method` on destructured-methods test:** one test originally destructured `{ get, touch }` from the state instance to indirectly verify closure binding. ESLint flagged the pattern (the `FreshnessState` type uses method-shorthand, which the rule treats as `this`-dependent even when the implementation is a closure). Rewrote the test to perform reads/writes through the `state.touch` / `state.get` reference path; the original "is the closure shared between methods?" intent is preserved (touch then get on the same instance returns the stored value), and the per-instance-isolation guarantee is already pinned by the "two factory instances are independent" test above it.
- **Test count delta:** baseline 367 (post-1.8) → 392 (post-1.9) = +25 new cases, one above the AC7 spec floor of 24 because the round-trip group retained 5 cases and the isolation group retained 2 (the lint-driven test rewrite did not drop the case, only changed its assertion path).
- **Pack manifest verification:** `npm pack --dry-run 2>&1 | tail -5` confirms `total files: 24` post-1.9, matching AC8 (23 baseline + 1 new source file; `state.test.ts` excluded by `package.json:15`'s `"!src/**/*.test.ts"` allowlist negation).
- **Pure-domain isolation grep:** `grep -rE "from '\.\./(silverbullet|audit|diagnostic|config|mcp|permissions|edits)'" src/freshness/` returns nothing — AR58 / `epics.md:183` (acyclic dependency rule) verified at the file-import layer. The only out-of-tree import in `src/freshness/` is `import type { Ref } from '../domain/ref.ts'` (type-only). A second grep for `node:fs|node:os|node:net|node:crypto|node:http|Date\.now|performance\.now|process\.` against `src/freshness/state.ts` also returns nothing — AC6 isolation verified.

### Completion Notes List

- ✅ AC1: `src/freshness/state.ts` exports `type FreshnessState` (`touch(ref, at): void`, `get(ref): Date | undefined`), `type CreateFreshnessStateOptions` (with optional `capacity?: number`), `const DEFAULT_FRESHNESS_CAPACITY = 1024 as const`, and `createFreshnessState(options?)`. Single in-tree import is `import type { Ref } from '../domain/ref.ts'` — type-only per `verbatimModuleSyntax`. Each factory invocation returns an independent instance with a private `Map<Ref, Date>` — no module-level singleton.
- ✅ AC2: `touch(ref, at)` / `get(ref)` round-trip preserved including referential equality (`Object.is(state.get(ref), date) === true`). `get` does not mutate the map; verified by the "get does NOT bump recency" test (capacity = 2; repeated `get(A)` between touches still allows A's eviction when C is inserted).
- ✅ AC3: Re-touch overwrites the stored timestamp (newer or older — no monotonicity guard) AND moves the entry to the MRU end. Pinned by the "capacity = 3, A re-touched, D inserted, B is LRU" case — the trickiest LRU semantics.
- ✅ AC4: LRU eviction policy verified across capacity = 1, 2, 3 with insertion-only patterns AND re-touch-then-insert patterns. Eviction trigger is `entries.size > capacity` (NOT `>=`), so exactly `capacity` entries are allowed; the (capacity + 1)-th touch evicts the LRU.
- ✅ AC5: Capacity invariant rejects `0`, negatives, `NaN`, `Infinity`, and non-integers (`2.5`). Single `Number.isInteger(capacity) || capacity < 1` predicate covers all cases. `DEFAULT_FRESHNESS_CAPACITY === 1024` pinned by a dedicated test. `createFreshnessState()` and `createFreshnessState({})` both default to `1024` without throwing.
- ✅ AC6: Pure-domain isolation verified by grep. No `node:fs|node:os|node:net|node:crypto|node:http`, no `Date.now|performance.now`, no `process.*`, no `globalThis.*`, no `await/async/import()`. The state is fully synchronous; on process exit, the V8 heap is reclaimed and the `Map` vanishes — no persistence by construction.
- ✅ AC7: 24 test cases shipped (≥ 22 floor): 5 round-trip + 4 recency + 5 eviction + 8 capacity-invariant + 2 isolation = 24. All use top-level `await test(...)` (no `describe` blocks). Tests construct `Date` via fixed-millisecond literals (`new Date(0)`, `new Date(1)`, ...) — no `Date.now()` invocations.
- ✅ AC8: Manifest is exactly 24 files (23 baseline + `src/freshness/state.ts`). All four gates green: `npm run typecheck` (exit 0), `npm run lint` (exit 0, zero warnings under `--max-warnings=0` after the destructure-methods rewrite), `npx prettier --check .` (exit 0), `npm test` (392 / 392 passing, +25 from the 367 baseline). Existing test suite continues to pass without modification — story is purely additive.
- **Test-count delta:** 367 → 392 (+25), one above the AC7 floor of 24.
- **Single lint deviation surfaced and resolved:** the `@typescript-eslint/unbound-method` warning on the original destructure-methods test was rewritten to use the `state.*` reference path. The architecture's "method-shorthand on stateful module returns" pattern (matches `audit-logger.ts:20-23`) remains the public contract; tests do not destructure across the API boundary.

### File List

**NEW:**

- `src/freshness/state.ts`
- `src/freshness/state.test.ts`

**MODIFIED:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.9 status transitions (backlog → ready-for-dev → in-progress → review).

### Change Log

| Date       | Change                                                                          | Files                                              |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2026-05-01 | feat(freshness): in-memory bounded state with LRU eviction (story 1.9)         | `src/freshness/**`                                 |
