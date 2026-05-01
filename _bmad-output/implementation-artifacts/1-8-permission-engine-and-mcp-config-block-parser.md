# Story 1.8: Permission Engine & `#mcp/config` Block Parser

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As Maya declaring permissions inside SilverBullet,
I want my `#mcp/config` YAML fence blocks to be discovered and resolved into a per-page access mode by a deterministic, pure-function engine,
So that the trust contract is auditable, testable in isolation, and obviously fail-closed.

## Acceptance Criteria

**AC1 — `AccessMode` total order at `src/permissions/access-mode.ts`**

**Given** the access-mode module at `src/permissions/access-mode.ts`,
**When** I import its public surface,
**Then** it exports:

```typescript
export type AccessMode = 'none' | 'read' | 'append' | 'write';
export const ACCESS_MODES: readonly ['none', 'read', 'append', 'write'];
export function isAccessMode(value: unknown): value is AccessMode;
export function accessRank(mode: AccessMode): 0 | 1 | 2 | 3;
export function maxAccess(a: AccessMode, b: AccessMode): AccessMode;

export type AccessOperation =
  | 'read'
  | 'list'
  | 'search'
  | 'append'
  | 'edit'
  | 'delete'
  | 'create';
export function permits(mode: AccessMode, operation: AccessOperation): boolean;
```

**And** the rank ordering is fixed (D1 / `architecture.md:209-215`): `none = 0 < read = 1 < append = 2 < write = 3`. `maxAccess` returns the higher-rank input (used by the engine's tie-break — AR16 / `epics.md:125`).

**And** `permits(mode, operation)` returns `true` exactly when `mode`'s rank ≥ the minimum rank required by `operation`. The required-rank table is fixed (D1 / `architecture.md:215`):

| Operation | Minimum required mode | Rank |
|---|---|---|
| `read`, `list`, `search` | `read` | 1 |
| `append` | `append` | 2 |
| `edit`, `delete`, `create` | `write` | 3 |

`permits('none', _)` is always `false` for every `AccessOperation`. `permits(mode, op)` for an out-of-domain `op` is unreachable by construction (the parameter type forbids it); the implementation MUST use a `switch (operation)` with an `assertExhaustive(_: never): never` default arm, mirroring `src/domain/error.ts:423-428`.

**And** `isAccessMode` accepts only the four literal strings — case-sensitive (`'NONE'`, `'Read'`, `'  write  '` etc. all return `false`). The function is the closed-vocabulary boundary used by the parser (AC2) to widen the upstream `access: string` field into `AccessMode`.

**And** the module is **pure** — no I/O, no clock reads, no global state. Imports limited to: nothing (no in-tree imports — this module sits at the bottom of the dependency graph, consumed by `engine.ts` and downstream by Story 1.10 handlers).

**AC2 — `parseConfigBlock` at `src/permissions/config-block-parser.ts` widens the runtime-client output and fails closed**

**Given** the parser module at `src/permissions/config-block-parser.ts`,
**When** I import its public surface,
**Then** it exports:

```typescript
import type { Ref } from '../domain/ref.ts';
import type { AccessMode } from './access-mode.ts';

export type ConfigBlock = {
  readonly page: Ref;
  readonly access: AccessMode;
  readonly exact: boolean;
};

export type ConfigBlockParseError = {
  readonly raw: { readonly page?: unknown; readonly access?: unknown; readonly exact?: unknown };
  readonly reason:
    | 'page_missing'
    | 'page_invalid'
    | 'access_missing'
    | 'access_invalid'
    | 'exact_invalid';
  readonly message: string;
};

export type ConfigBlockParseResult = {
  readonly blocks: readonly ConfigBlock[];
  readonly errors: readonly ConfigBlockParseError[];
};

export function parseConfigBlocks(
  raw: ReadonlyArray<{
    readonly page?: unknown;
    readonly access?: unknown;
    readonly exact?: unknown;
  }>,
): ConfigBlockParseResult;
```

**And** the upstream contract is `QueryConfigBlocksResult.blocks` from `src/silverbullet/scripts/query-config-blocks.lua.ts` — Lua-table → JSON projection has already happened, so YAML parsing is **not** in this parser's scope. The parser receives an array of `{ page?, access?, exact? }` shape with each field typed `unknown` (defensive narrowing — Story 1.7 typed them as `string`/`boolean` but the runtime data may diverge per Story 1.7 deferred-work item "empty Lua table → JSON `{}` vs `[]` ambiguity" and the type-truth-trust principle from AR59).

**And** `parseConfigBlocks` validates each input block independently:

1. `page` MUST be present, a string, and pass `makeRef(page)` without throwing → narrowed to `Ref`. Otherwise the block is rejected with `reason: 'page_missing'` (when `page === undefined` or non-string) or `'page_invalid'` (when `makeRef` throws).
2. `access` MUST be present, a string, and pass `isAccessMode(access)` → narrowed to `AccessMode`. Otherwise `reason: 'access_missing'` or `'access_invalid'`.
3. `exact` is optional. If absent (`undefined` / key missing), defaults to `false`. If present, MUST be `true` or `false` exactly (no truthy / falsy coercion — `'true'`, `1`, `0`, `null` all rejected with `reason: 'exact_invalid'`). The default-on-absent rule matches AR14 / `epics.md:123` (`optional: <bool> defaulting to false`).

**And** rejected blocks land in `result.errors`; valid blocks land in `result.blocks`. The function NEVER throws on bad input — fail-closed at the field level (AR17 / NFR11 / `epics.md:85,126`). The caller (Story 1.10 read-side handlers) audit-logs each `ConfigBlockParseError` as `category: config_error` per AR17.

**And** the function is **pure** — no I/O, no clock reads, no global state. Imports limited to: `makeRef` from `../domain/ref.ts`, `isAccessMode` from `./access-mode.ts`. **Does NOT** import `RefValidationError`, `DomainError`, or any error constructor — the parser produces a structural value, not a `DomainError`. The handler surface (Story 1.10) projects the errors into `configError(...)` / audit entries; this story stops at the structural value.

**And** the `raw` field on `ConfigBlockParseError` carries the offending input verbatim (after a defensive shallow copy via `{ page: r.page, access: r.access, exact: r.exact }`) so downstream audit entries can record the malformed block's location-ish context. **No deep cloning** — the upstream value comes from `JSON.parse` so it has no class instances; structural-only retention is sufficient.

**AC3 — `resolveAccess(ref, blocks)` engine at `src/permissions/engine.ts` implements the D1 algorithm**

**Given** the pure engine at `src/permissions/engine.ts`,
**When** I import its public surface,
**Then** it exports:

```typescript
import type { Ref } from '../domain/ref.ts';
import type { AccessMode } from './access-mode.ts';
import type { ConfigBlock } from './config-block-parser.ts';

export const CONFIG_PAGE: Ref;  // the literal Ref `'CONFIG'`, brand-validated once at module load
export function resolveAccess(ref: Ref, blocks: readonly ConfigBlock[]): AccessMode;
```

**And** `resolveAccess` implements the algorithm verbatim from `architecture.md:231-265` (reproduced inline for the dev's reference; **this is the contract, do NOT improvise**):

```
resolveAccess(ref, blocks) -> AccessMode:
  bestSpecificity = null     // tag: 'global' | 'scope' | 'exact'
  bestScopeLength = 0        // only meaningful when tag === 'scope'
  matchingModes  = empty set // AccessModes that won at the current best specificity

  for block in blocks:
    root = block.page

    if root === CONFIG_PAGE:
      spec = ('global', 0)
      matches = true
    elif block.exact:
      spec = ('exact',  root.length)
      matches = (ref === root)
    else:
      spec = ('scope',  root.length)
      matches = (ref === root) OR ref.startsWith(root + '/')

    if not matches: continue

    // Specificity ordering: exact > scope-by-longer-root > global.
    // Within 'scope', longer root wins.
    if bestSpecificity is null
       OR rank(spec) > rank(bestSpecificity)
       OR (spec.tag === bestSpecificity.tag === 'scope' AND spec.length > bestSpecificity.length):
      bestSpecificity = spec
      matchingModes  = { block.access }
    elif spec is structurally equal to bestSpecificity:   // same tag AND (for 'scope') same length
      matchingModes.add(block.access)

  if matchingModes is empty:
    return 'none'                 // default-deny (D1 / AR16 / NFR11)

  return reduce(matchingModes, maxAccess)   // most-permissive wins within same specificity
```

Where `rank` is: `'global' → 0`, `'scope' → 1`, `'exact' → 2`. (Within `'scope'`, longer root is more specific — handled by the secondary length comparison.)

**And** scope matching uses **prefix-with-segment-boundary**: `ref === root` OR `ref.startsWith(root + '/')`. A block on `Personal` matches `Personal` (the host page itself) and `Personal/Notes`, but NOT `PersonalAssistant` (no `/` boundary). This is the AR15 / `epics.md:124` rule.

**And** `CONFIG_PAGE` is the literal `makeRef('CONFIG')` evaluated once at module load. Block scope detection is `block.page === CONFIG_PAGE` (string equality on the brand-erased value).

**And** the function is **pure** — zero I/O (NFR19 / `epics.md:99`). Imports limited to: `type Ref` from `../domain/ref.ts`, `makeRef` (for `CONFIG_PAGE`), `type AccessMode` and `maxAccess` from `./access-mode.ts`, `type ConfigBlock` from `./config-block-parser.ts`. **Does NOT** import the runtime client, the audit logger, the diagnostic logger, or any I/O-touching module.

**And** the algorithm is single-pass over `blocks` (O(n)) with constant additional state (the `bestSpecificity` + `matchingModes` accumulator). No allocation per iteration except `matchingModes` array growth on ties.

**AC4 — Specificity ordering: more-specific overrides regardless of permissiveness (security boundary)**

**Given** a global block on the `CONFIG` page declaring `access: 'write'`,
**When** a more-specific block on `Personal` (without `exact`) declares `access: 'none'`,
**Then** `resolveAccess(makeRef('Personal'), blocks)` returns `'none'`,
**And** `resolveAccess(makeRef('Personal/Diary'), blocks)` returns `'none'`,
**And** `resolveAccess(makeRef('Personal/2026/04'), blocks)` returns `'none'`,
**And** `resolveAccess(makeRef('Work/Q2'), blocks)` returns `'write'` (no more-specific match → falls back to the global),
**And** `resolveAccess(makeRef('Index'), blocks)` returns `'write'` (no scope match → global wins).

**And** an `exact: true` block beats a non-exact block on the same root: a block on `Personal` with `access: 'write'` and `exact: true` makes `resolveAccess(makeRef('Personal'), blocks) === 'write'` even when a non-exact block on `Personal` declares `'none'`.

**And** within `scope` specificity, longer root wins: a block on `Projects` declaring `'read'` is overridden for `resolveAccess(makeRef('Projects/Active/Q2'), blocks)` by a block on `Projects/Active` declaring `'none'` → resolves to `'none'`. (Even though `'read'` is more permissive, `Projects/Active` is more specific.)

**AC5 — Tie-break: equally-specific blocks compose as most-permissive (OR-of-intents)**

**Given** two equally-specific blocks both applying to `Projects/Active` (same root, both non-exact),
one with `access: 'read'` and one with `access: 'write'`,
**When** the engine resolves `Projects/Active/Q2`,
**Then** the result is `'write'` (most-permissive wins within same specificity per AR16 / `epics.md:125`).

**And** the same property holds for two `exact: true` blocks on the same page: `'append'` + `'read'` → `'append'`.

**And** the same property holds for two `CONFIG` blocks: a global `'read'` and a global `'write'` → `'write'` for any ref not matched by a more-specific rule.

**And** three-way ties resolve correctly: three `scope` blocks on `Foo` with `'none'`, `'read'`, `'append'` → `'append'`. The reduction is `maxAccess`-monotonic regardless of input order.

**AC6 — Default-deny when no block matches**

**Given** an empty `blocks` array,
**When** `resolveAccess(makeRef('AnyPage'), [])` is called,
**Then** it returns `'none'`.

**And** the same holds when `blocks` contains entries but none match: e.g., a single `scope` block on `Personal` does not match `Work/Q2` → `resolveAccess(makeRef('Work/Q2'), [{ page: makeRef('Personal'), access: 'write', exact: false }]) === 'none'`.

**And** a single `exact: true` block on `Personal` does NOT match `Personal/Diary` → returns `'none'` (the `exact` flag blocks descendant scoping).

**And** a `scope` block on `Personal` does NOT match `PersonalAssistant` (no `/` segment boundary) → returns `'none'`.

**AC7 — `engine.test.ts` and `config-block-parser.test.ts` cover specificity, tie-break, default-deny, fail-closed, and `exact` boundaries**

**Given** the unit tests at `src/permissions/engine.test.ts`,
**When** `npm test` runs,
**Then** the suite covers (≥ 30 cases — counting each top-level `await test(...)` as one case):

**Specificity ordering (AC4):**
1. Global `'write'` + scope `'none'` on `Personal` → `Personal` resolves `'none'`; `Personal/Diary` resolves `'none'`; `Work` resolves `'write'`.
2. Two scope blocks (`Projects` `'read'`, `Projects/Active` `'none'`) → `Projects/Active/Q2` resolves `'none'`; `Projects/Other` resolves `'read'`.
3. `exact: true` `'write'` on `Personal` + non-exact `'none'` on `Personal` → `Personal` resolves `'write'`; `Personal/Diary` resolves `'none'`.
4. `exact: true` block does NOT match descendants — non-exact block on `Personal` `'read'` + exact block on `Personal/Public` `'write'` → `Personal/Public` resolves `'write'`; `Personal/Public/Sub` resolves `'read'` (the exact block does NOT extend).
5. Cross-specificity: global `'append'` + exact `'write'` on `Index` → `Index` resolves `'write'`; any other ref resolves `'append'`.

**Tie-break / OR-of-intents (AC5):**
6. Two scope blocks on `Foo` with `'read'` and `'write'` → `Foo/Bar` resolves `'write'`.
7. Three scope blocks on `Foo` with `'none'`, `'read'`, `'append'` → `'append'`.
8. Two exact blocks on the same page with `'read'` and `'write'` → `'write'` (host page only).
9. Two CONFIG-page (global) blocks with `'read'` and `'write'` → unmatched ref resolves `'write'`.
10. Reordering the inputs of any tie does not change the result (commutativity property).

**Default-deny (AC6):**
11. Empty blocks → any ref → `'none'`.
12. Single scope block on `Personal` `'write'`; query `Work/Q2` → `'none'`.
13. `exact: true` block on `Personal` `'write'`; query `Personal/Diary` → `'none'`.
14. Scope block on `Personal` `'write'`; query `PersonalAssistant` → `'none'` (segment-boundary rule).
15. CONFIG block doesn't exist; scope block on `Personal` `'write'`; query `Index` → `'none'`.

**Boundary cases (segment matching, equal-length roots):**
16. Scope block on `Foo` `'write'`; query `Foo` → `'write'` (host-page itself matches).
17. Scope block on `Foo` `'write'`; query `Foo/` would NOT be a valid `Ref` per `makeRef` rules; test that the ref-construction at the call boundary is the gate (not engine internals).
18. Two scope blocks of equal-length roots on disjoint paths (`Foo` `'read'`, `Bar` `'write'`); query `Foo/x` → `'read'`; query `Bar/x` → `'write'`.
19. Scope blocks at multiple depths (`A` `'write'`, `A/B` `'read'`, `A/B/C` `'none'`) → `A/B/C/D` resolves `'none'`; `A/B/X` resolves `'read'`; `A/X` resolves `'write'`.
20. CONFIG-page block coexisting with a same-name `Personal` non-exact block — only the literal `CONFIG` page is global; a `Personal` block has its own scope. Test: blocks `[{ page: 'CONFIG', access: 'write', exact: false }, { page: 'Personal', access: 'none', exact: false }]` → `Personal` → `'none'`; `Index` → `'write'`.

**Pure-function properties:**
21. Calling `resolveAccess` twice with the same arguments returns the same `AccessMode` (referential transparency).
22. Mutating the input `blocks` array AFTER the call does not change the result of the call (the function does not retain a reference).

**Given** the unit tests at `src/permissions/config-block-parser.test.ts`,
**When** `npm test` runs,
**Then** the suite covers (≥ 22 cases):

**Happy path:**
23. Empty input array → `{ blocks: [], errors: [] }`.
24. Single valid block `{ page: 'Personal', access: 'write', exact: false }` → blocks length 1 with `page` branded as `Ref`, errors empty.
25. Valid block with `exact: undefined` → `exact: false` defaulted.
26. Valid block with `exact` key absent → `exact: false` defaulted.
27. Valid block with `exact: true` → preserved.
28. CONFIG-page block (`page: 'CONFIG'`) → valid (CONFIG is a valid Ref).
29. Multiple valid blocks → all in `blocks`, errors empty.
30. Mixed valid + invalid → only valid in `blocks`, invalids in `errors`.

**Fail-closed at field level:**
31. `page` missing (key absent or `undefined`) → `errors[0].reason === 'page_missing'`.
32. `page` is a number → `errors[0].reason === 'page_missing'` (non-string is treated as missing per the `unknown` narrowing — alternatively `'page_invalid'`; pick one and document; suggested: `'page_missing'` to match `access` parallelism).
33. `page` is `''` (empty string) → `'page_invalid'` (`makeRef('')` throws).
34. `page` is `'  Foo  '` (whitespace-padded) → `'page_invalid'`.
35. `page` is `'../etc/passwd'` → `'page_invalid'`.
36. `page` is `'Personal'` (valid) but `access` missing → `errors[0].reason === 'access_missing'`.
37. `access` is a number → `'access_missing'` (non-string).
38. `access` is `'WRITE'` (uppercase) → `'access_invalid'` (case-sensitive).
39. `access` is `'readonly'` (legacy PRD term, NOT in the closed enum) → `'access_invalid'`.
40. `access` is `''` → `'access_invalid'`.
41. `exact` is the string `'true'` → `'exact_invalid'` (no coercion).
42. `exact` is `1` → `'exact_invalid'`.
43. `exact` is `null` → `'exact_invalid'`.
44. The `errors[i].raw` field carries the offending input verbatim (shape `{ page, access, exact }`).

**Pure-function properties:**
45. The function never throws on any input — confirmed by exhaustive adversarial fixtures (object with `__proto__`, frozen object, object with throwing getters wrapped via `try/catch` at the field-read site if needed; but since the upstream is `JSON.parse` output, throwing getters are not realistic — verify this assumption explicitly with one defensive case).

**And** every test is **pure** — no fs / network / clock side effects. `node:test` + `node:assert/strict` per established pattern. Top-level `await test(...)` for each case (no `describe` blocks).

**AC8 — Module surface, file structure, and pack manifest**

**Given** the project after this story,
**When** I list `src/permissions/`,
**Then** it contains exactly:

```
src/permissions/
├── access-mode.ts                # NEW: AccessMode + ACCESS_MODES + isAccessMode + accessRank + maxAccess + permits
├── access-mode.test.ts           # NEW: ≥ 18 cases covering the type predicates + permits matrix
├── config-block-parser.ts        # NEW: parseConfigBlocks(raw) + ConfigBlock + ConfigBlockParseError
├── config-block-parser.test.ts   # NEW: ≥ 22 cases per AC7
├── engine.ts                     # NEW: resolveAccess + CONFIG_PAGE
└── engine.test.ts                # NEW: ≥ 22 cases per AC7
```

**And** **no other source file in the repo is changed.** In particular:
- `src/index.ts`, `src/config/*`, `src/diagnostic/*`, `src/audit/*`, `src/domain/*`, `src/edits/*`, `src/freshness/*`, `src/silverbullet/*`, `src/mcp/*` — UNCHANGED.
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.prettierrc.json`, `package.json` — UNCHANGED. **No new dependencies.**
- `tests/integration/*`, `tests/smoke/*` — UNCHANGED.
- No new directories outside `src/permissions/`.
- No `index.ts` re-export barrels (AR57 / `architecture.md:999`).

**And** **no new dependencies.** All needed primitives are stdlib + previously-locked tooling:
- `makeRef` from `../domain/ref.ts` (Story 1.2).
- `node:test` + `node:assert/strict` for tests.
- TypeScript / ESLint / Prettier — already locked.
- **No YAML library** — YAML parsing happens server-side via `index.queryLuaObjects("mcp/config", {})` (Story 1.7's `query-config-blocks.lua.ts:39`); this story consumes the already-parsed structural projection.

**And** `npm pack --dry-run` manifest grows from **20 files** (post-1.7) to **23 files** (post-1.8). The three new files in the published artifact are `src/permissions/{access-mode,config-block-parser,engine}.ts`. The three test files (`*.test.ts`) are excluded by the existing `"!src/**/*.test.ts"` allowlist negation in `package.json:15`.

| File | Status |
|---|---|
| Post-1.7 baseline (20 files) | unchanged |
| `src/permissions/access-mode.ts` | **NEW** |
| `src/permissions/config-block-parser.ts` | **NEW** |
| `src/permissions/engine.ts` | **NEW** |

**AC9 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`.

**And** `npm test` reports the new permissions cases as passing.

**And** the test count strictly increases from the post-1.7 baseline of **256 tests**. Conservative floor for this story: **+60 cases** (≥ 18 access-mode + ≥ 22 parser + ≥ 22 engine = 62; round to a floor of **60**). Expect **316+** post-1.8.

**And** `npm pack --dry-run` manifest is exactly **23 files** per AC8.

**And** the existing test suite (256 tests from Stories 1.1-1.7) continues to pass without modification — this story is purely **additive**.

## Tasks / Subtasks

- [x] **Task 1: Implement `src/permissions/access-mode.ts`** (AC: #1)
  - [x] Create the file. Imports: none (zero in-tree imports — bottom of dependency graph).
  - [x] Define and export `type AccessMode = 'none' | 'read' | 'append' | 'write'`.
  - [x] Define and export `const ACCESS_MODES = ['none', 'read', 'append', 'write'] as const satisfies ReadonlyArray<AccessMode>`. The runtime-iterable closed-vocabulary lock-in pattern from Story 1.6's `REASON_CODES` (`src/domain/error.ts:27-34`).
  - [x] Define and export `isAccessMode(value: unknown): value is AccessMode`. Implementation: `return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value);`. **No regex, no toLowerCase** — case-sensitive.
  - [x] Define and export `accessRank(mode: AccessMode): 0 | 1 | 2 | 3`. Implementation: `switch (mode) { case 'none': return 0; case 'read': return 1; case 'append': return 2; case 'write': return 3; default: return assertExhaustive(mode); }`. The `assertExhaustive(value: never): never` helper mirrors `src/domain/error.ts:423-428` — define a private function in this module, do NOT re-export.
  - [x] Define and export `maxAccess(a: AccessMode, b: AccessMode): AccessMode`. Implementation: `return accessRank(a) >= accessRank(b) ? a : b;`. Used by the engine's tie-break.
  - [x] Define and export `type AccessOperation = 'read' | 'list' | 'search' | 'append' | 'edit' | 'delete' | 'create'`.
  - [x] Define and export `permits(mode: AccessMode, operation: AccessOperation): boolean`. Implementation: `switch (operation) { case 'read': case 'list': case 'search': return accessRank(mode) >= 1; case 'append': return accessRank(mode) >= 2; case 'edit': case 'delete': case 'create': return accessRank(mode) >= 3; default: return assertExhaustive(operation); }`. **AC1 contract:** `permits('none', _)` ⇒ `false` for every operation. The exhaustiveness arm is required for AR60 / `epics.md:187`.
  - [x] JSDoc: cite D1 / `architecture.md:209-215`, AR16 / `epics.md:125`, AR60. Document the rank ordering and the per-operation rank table.
  - [x] **Pure:** no I/O, no clock reads, no global state. Tests assert via direct calls.
  - [x] **Anti-patterns to avoid:** no `as` casts (the rank-table is a `switch`, not a lookup object cast); no `enum` (`erasableSyntaxOnly: true` per Story 1.6); no `console.*`; no nullish coalescing `?? 0` defaults — every input is exhaustively narrowed.

- [x] **Task 2: Write `src/permissions/access-mode.test.ts` covering AC1** (AC: #1, #7)
  - [x] Create the test file. `import test from 'node:test'; import assert from 'node:assert/strict';` per established pattern.
  - [x] Top-level `await test(...)` for each case (no `describe` blocks — Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7 pattern).
  - [x] Cases (≥ 18):
    - **`isAccessMode`:** valid: `'none'`, `'read'`, `'append'`, `'write'` → `true` (4 cases). Invalid: `'NONE'`, `'Read'`, `'  write  '`, `'readonly'`, `''`, `null`, `undefined`, `42`, `{}`, `[]` → `false` (10 cases).
    - **`accessRank`:** `accessRank('none') === 0`, `accessRank('read') === 1`, `accessRank('append') === 2`, `accessRank('write') === 3` (4 cases).
    - **`maxAccess`:** `maxAccess('read', 'write') === 'write'`, `maxAccess('append', 'read') === 'append'`, `maxAccess('none', 'none') === 'none'`, `maxAccess('write', 'write') === 'write'`, `maxAccess('append', 'write') === 'write'` (5 cases).
    - **`permits` happy paths:** `permits('write', 'edit')`, `permits('write', 'append')`, `permits('write', 'read')`, `permits('append', 'append')`, `permits('append', 'read')`, `permits('read', 'list')`, `permits('read', 'search')` → `true` (7 cases).
    - **`permits` rejection paths:** `permits('none', 'read')`, `permits('none', 'list')`, `permits('none', 'search')`, `permits('none', 'append')`, `permits('none', 'edit')`, `permits('none', 'delete')`, `permits('none', 'create')`, `permits('read', 'append')`, `permits('read', 'edit')`, `permits('append', 'edit')`, `permits('append', 'delete')`, `permits('append', 'create')` → `false` (12 cases).
    - **`ACCESS_MODES` ordering and identity:** `ACCESS_MODES.length === 4`; `ACCESS_MODES[0] === 'none'`; `ACCESS_MODES[3] === 'write'`; `ACCESS_MODES.every(isAccessMode)`.
  - [x] No fs / network / clock side effects.

- [x] **Task 3: Implement `src/permissions/config-block-parser.ts`** (AC: #2)
  - [x] Create the file. Imports: `import { type Ref, makeRef, RefValidationError } from '../domain/ref.ts'; import { isAccessMode, type AccessMode } from './access-mode.ts';`.
  - [x] Define and export `type ConfigBlock = { readonly page: Ref; readonly access: AccessMode; readonly exact: boolean }`.
  - [x] Define and export `type ConfigBlockParseError` per AC2.
  - [x] Define and export `type ConfigBlockParseResult` per AC2.
  - [x] Implement `parseConfigBlocks(raw)`:
    - Initialise mutable accumulator `blocks: ConfigBlock[] = [], errors: ConfigBlockParseError[] = []`.
    - For each entry `r` in `raw`:
      - **Page narrowing:** if `r.page === undefined` OR `typeof r.page !== 'string'` → push `ConfigBlockParseError` with `reason: 'page_missing'`, message `'page field missing or not a string'`, raw shape, and `continue`.
      - **Page brand:** wrap `makeRef(r.page)` in `try/catch(RefValidationError)` → on throw, push error with `reason: 'page_invalid'`, message `'page is not a valid SilverBullet ref: ' + (caught error's reason)'`, and `continue`. **Do NOT catch generic `Error`** — `makeRef` only throws `RefValidationError`; let any other throw escape (it would be a programmer error).
      - **Access narrowing:** if `r.access === undefined` OR `typeof r.access !== 'string'` → push `'access_missing'`, message `'access field missing or not a string'`, `continue`.
      - **Access enum check:** if `!isAccessMode(r.access)` → push `'access_invalid'`, message `'access value not in {none, read, append, write}: ' + JSON.stringify(r.access)'`, `continue`.
      - **Exact narrowing:** if `r.exact === undefined` → `exact = false`. Else if `r.exact === true || r.exact === false` → `exact = r.exact`. Else → push `'exact_invalid'`, message `'exact field must be boolean if present, got ' + typeof r.exact`, `continue`.
      - All checks passed → push `{ page, access: r.access, exact }` to `blocks`.
    - Return `{ blocks, errors }` as a frozen `ConfigBlockParseResult`. **Do NOT use `Object.freeze`** — the `readonly` modifier on the type is the contract; runtime freezing is non-idiomatic in this codebase (Stories 1.4-1.7 don't freeze).
  - [x] **Defensive shallow copy in `raw`:** the error path constructs `raw: { page: r.page, access: r.access, exact: r.exact }` — pulls only the three relevant fields. **Do NOT** spread `...r` (might capture extraneous keys from a future schema, leaking them into the audit log).
  - [x] JSDoc: cite AR14 / AR15 / AR17 / `epics.md:123-126`, NFR11 / `epics.md:85`, D1 / `architecture.md:205-276`. Document the upstream contract (`QueryConfigBlocksResult.blocks`) and the fail-closed-at-field-level discipline.
  - [x] **Pure:** no I/O, no clock reads, no global state.
  - [x] **Anti-patterns to avoid:** no `any` (use `unknown` for the input field types); no `as` casts (every narrowing is via type guard); no nullish coalescing for the `exact` default (use explicit `if (r.exact === undefined)` so a value of `0` or `''` would NOT be silently coerced to `false` — they go to `'exact_invalid'`); no `try/catch` around the entire loop (only around `makeRef` per the field-level fail-closed rule); no `console.*`.

- [x] **Task 4: Write `src/permissions/config-block-parser.test.ts` covering AC2** (AC: #2, #7)
  - [x] Create the test file. Imports: `node:test`, `node:assert/strict`, the parser, and `makeRef` (only for assertion-side ref construction in fixtures).
  - [x] Top-level `await test(...)` for each case.
  - [x] Cases (≥ 22 per AC7 #23-44): see AC7. Group by purpose (happy path, page validation, access validation, exact validation, mixed valid+invalid, raw-field preservation, pure-function properties).
  - [x] **Page-missing vs page-invalid distinction:** explicitly test the boundary. `{ page: undefined, ... }` → `page_missing`. `{ page: 42, ... }` → `page_missing` (non-string treated as missing). `{ page: '', ... }` → `page_invalid` (string but `makeRef` rejects). `{ page: '../etc', ... }` → `page_invalid`. `{ page: 'Personal', ... }` (valid Ref but `access` missing) → `access_missing` (page validates, access fails).
  - [x] **`raw` preservation:** assert `errors[0].raw.access === 'WRITE'` (the original casing) for the case where `access: 'WRITE'` triggers `access_invalid`. Also assert that extraneous keys on the input object are NOT preserved into `raw` (the parser pulls only `{ page, access, exact }`).
  - [x] **Defensive case for AC2 "function never throws":** pass an input array containing `Object.create(null)` with no fields → `errors[0].reason === 'page_missing'`, function returns normally. Pass `JSON.parse('{"__proto__": "evil"}')` as the input (per Story 1.6's prototype-pollution defense pattern) → property `__proto__` is treated as data; the parser does not recurse into nested objects so this is structurally a `page_missing` case.
  - [x] No fs / network / clock side effects.

- [x] **Task 5: Implement `src/permissions/engine.ts`** (AC: #3, #4, #5, #6)
  - [x] Create the file. Imports: `import { makeRef, type Ref } from '../domain/ref.ts'; import { type AccessMode, maxAccess } from './access-mode.ts'; import { type ConfigBlock } from './config-block-parser.ts';`.
  - [x] Define and export `const CONFIG_PAGE: Ref = makeRef('CONFIG');`. **Module-load-time validation** — if `'CONFIG'` ever fails Ref validation (it won't given Story 1.2's rules), the import would throw, surfacing the bug at server startup rather than first tool call.
  - [x] Define a private `Specificity` discriminated union internal to the module:
    ```typescript
    type Specificity =
      | { readonly tag: 'global' }
      | { readonly tag: 'scope'; readonly length: number }
      | { readonly tag: 'exact'; readonly length: number };
    ```
    `length` for `'global'` is implicit (always 0 in rank-only comparisons); the discriminant + tag-rank function are the comparison primitives.
  - [x] Define a private `specificityRank({ tag }: Specificity): 0 | 1 | 2`: `'global' → 0`, `'scope' → 1`, `'exact' → 2`. Use a `switch` with `assertExhaustive(_: never): never` default arm.
  - [x] Define a private `compareSpecificity(a: Specificity, b: Specificity): -1 | 0 | 1` that:
    - Compares `specificityRank(a)` vs `specificityRank(b)` — return `-1` / `0` / `1` accordingly.
    - When ranks are equal AND `a.tag === b.tag === 'scope'`, compare `a.length` vs `b.length`.
    - Equal-rank `'global' === 'global'` and equal-rank-equal-length `'exact'` and `'scope'` return `0` (a tie that triggers tie-break in the main loop).
    - **Note on `'exact'` ties:** two `exact: true` blocks on different pages ALWAYS resolve via `matches` first — they only tie when on the same root, in which case `length` equality holds trivially.
  - [x] Implement `resolveAccess(ref, blocks)`:
    - `let bestSpec: Specificity | null = null; let matchingModes: AccessMode[] = [];`
    - For each `block` in `blocks`:
      - Compute `spec` and `matches` per the algorithm:
        - `block.page === CONFIG_PAGE` → `spec = { tag: 'global' }`, `matches = true`.
        - else if `block.exact === true` → `spec = { tag: 'exact', length: block.page.length }`, `matches = (ref === block.page)`.
        - else → `spec = { tag: 'scope', length: block.page.length }`, `matches = (ref === block.page) || ref.startsWith(block.page + '/')`.
      - If `!matches`, `continue`.
      - If `bestSpec === null` OR `compareSpecificity(spec, bestSpec) === 1` → `bestSpec = spec; matchingModes = [block.access];`
      - Else if `compareSpecificity(spec, bestSpec) === 0` → `matchingModes.push(block.access);`
      - Else (`spec` is less specific) → `continue`.
    - If `matchingModes.length === 0` → `return 'none'`.
    - `return matchingModes.reduce(maxAccess);` (typed `(prev: AccessMode, curr: AccessMode) => AccessMode`; non-empty array makes `reduce` without initial value safe).
  - [x] **Single pass, O(n)**, no per-iteration allocation other than the conditional `matchingModes.push` on tie — verify by inspecting the final implementation.
  - [x] JSDoc: cite D1 / `architecture.md:205-276`, AR12 / `epics.md:120`, AR16 / `epics.md:125`, NFR11 / `epics.md:85`, NFR19 / `epics.md:99`, AR58 / `epics.md:183`. **Reproduce the algorithm pseudocode inline** (per the contract — story instruction #3 of AC3).
  - [x] **Pure:** no I/O, no clock reads, no global state. The only module-level state is `CONFIG_PAGE` (immutable).
  - [x] **Anti-patterns to avoid:** no `any`; no `as` casts; no early-exit cleverness that could mask the algorithm; no closures over module-level mutable state; no `console.*`; do NOT memoise — each call is O(n) and consumed once per tool invocation per D2 (`architecture.md:278-288`); memoisation would require cache-invalidation logic which D2 explicitly punts.

- [x] **Task 6: Write `src/permissions/engine.test.ts` covering AC3-AC6** (AC: #3, #4, #5, #6, #7)
  - [x] Create the test file. Imports: `node:test`, `node:assert/strict`, `resolveAccess`, `CONFIG_PAGE`, `makeRef`, `type ConfigBlock`.
  - [x] Top-level `await test(...)` for each case.
  - [x] **Helper for fixture construction:** define a private `block(page: string, access: AccessMode, exact = false): ConfigBlock` that returns `{ page: makeRef(page), access, exact }`. Reduces boilerplate across the ≥ 22 cases.
  - [x] Cases (≥ 22 per AC7 #1-22): see AC7.
  - [x] **Determinism / property-style tests:** for the tie-break commutativity case (AC7 #10 / AC5), use a small fixed permutation set (e.g., for three blocks A, B, C: 6 orderings) — not full property-based tooling. The architecture's testing patterns (`architecture.md:1156-1165`) restrict property-based testing to the edit-batch validator (Story 2.1).
  - [x] **Reference-non-retention property:** AC7 #22. Construct `blocks: ConfigBlock[]`, call `resolveAccess(ref, blocks)`, then mutate `blocks` (e.g., push a new entry, reverse the array), call again with the SAME mutated reference but assert the FIRST result was based on the original input. Implementation pattern: capture the result, then call `resolveAccess(ref, [...originalBlocks])` — the engine's purity means the second call resolves identically.
  - [x] No fs / network / clock side effects.

- [x] **Task 7: Local verification** (AC: #8, #9)
  - [x] `npm run typecheck` → exit 0, zero TS errors. Watch for: the `assertExhaustive(_: never): never` exhaustiveness checks; the `as const satisfies` on `ACCESS_MODES`; the `Specificity` discriminated union narrowing inside `compareSpecificity`; the `block.access` literal-string narrowing into `AccessMode`.
  - [x] `npm run lint` → exit 0 with `--max-warnings=0`. Watch for: `@typescript-eslint/no-explicit-any` (none present); `@typescript-eslint/no-unsafe-*` (the `unknown`-narrowing in the parser is via `typeof` guards, not casts — safe); `no-console` (production permissions modules NEVER call `console.*`).
  - [x] `npx prettier --check .` → all matched files formatted. Run `npm run format` first to normalise; `--check` should then pass.
  - [x] `npm test` → all tests pass; count ≥ 316 (post-1.7 baseline 256 + ≥ 60 new cases).
  - [x] `npm pack --dry-run` → manifest is exactly **23 files** per AC8. Run `npm pack --dry-run 2>&1 | grep -c 'src/'` and confirm 23 source/asset entries (or count `Tarball Contents` lines per Story 1.7's verification).
  - [x] **Optional sanity:** importing the new modules from a scratch script confirms tree-shaking-friendly exports (no module side effects beyond `CONFIG_PAGE` evaluation).

### Review Findings

Code review run 2026-04-30 — three reviewers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 21 raw findings; after triage: 0 decision-needed, 2 patch, 0 defer, 19 dismissed (per-spec, by-design, or speculative).

- [x] [Review][Patch] Pin `CONFIG` + `exact: true` semantics with a test [`src/permissions/engine.test.ts`] — algorithm spec line 132 routes `CONFIG`-page blocks through the global branch *before* the `exact` check, so `{ page: 'CONFIG', exact: true, access: ... }` is treated as global. The behavior matches AC3 verbatim, but no test pins it. A regression that swaps the branch order would silently shrink the global rule's reach. **Resolved:** added boundary-cases assertion in `engine.test.ts` covering `CONFIG` block with `exact: true` against three refs (host, descendant, unrelated) — all resolve `'write'`.
- [x] [Review][Patch] Drop the `as AccessMode` cast in the ordering check [`src/permissions/access-mode.test.ts:216`] — `ACCESS_MODES[i] as AccessMode` widens past `noUncheckedIndexedAccess` and re-introduces an `as` cast in test code (Task 1 anti-pattern). **Resolved:** rewrote the loop as `for (const [i, mode] of ACCESS_MODES.entries())` and removed the now-unused `AccessMode` import.

## Dev Notes

### Architectural source-of-truth

This is story **#8** in the implementation sequence (`architecture.md:820`, item 8: "**Permission engine** — pure function `(Ref, ConfigBlock[]) → AccessMode` with the resolution algorithm from D1. Tests cover specificity ordering, tie-breaking, malformed-block fail-closed."). It depends on:

- Story 1.2's `Ref` (`src/domain/ref.ts`) — every `ConfigBlock.page` and the `ref` argument to `resolveAccess` is a branded `Ref`. The engine never calls `makeRef` on inputs (caller boundary discipline per AR10 / `epics.md:117`); only `CONFIG_PAGE = makeRef('CONFIG')` is constructed at module load.
- Story 1.7's `query-config-blocks.lua.ts` (`src/silverbullet/scripts/query-config-blocks.lua.ts`) — the upstream of `parseConfigBlocks`. The Lua script returns `QueryConfigBlocksResult.blocks: ReadonlyArray<{ page: string; access: string; exact?: boolean }>`; this story widens that into `ConfigBlock[]`.

It does **NOT** depend on:

- Story 1.5's audit logger — the parser produces a structural `ConfigBlockParseError`; the handler boundary (Story 1.10) projects errors into `audit.write({ category: 'config_error', ... })`. This story stops at the structural value.
- Story 1.6's `DomainError` — the parser produces `ConfigBlockParseError`, NOT `DomainError`. Conversion to `configError(...)` happens at the handler boundary (Story 1.10) where the rich audit context (block location, full error list) is available. **Do NOT import `domain/error.ts` from this module** — it would add a dependency the pure-domain core does not need (AR58 / `epics.md:183`).
- Story 1.7's `RuntimeClient` — the engine consumes parsed `ConfigBlock[]`, not the raw `client.exec` result. The handler in Story 1.10 wires `client.exec<QueryConfigBlocksResult>(queryConfigBlocksScript)` → `parseConfigBlocks(raw.blocks)` → `resolveAccess(ref, parsed.blocks)`.
- Story 1.9's freshness state, Story 1.10's tool handlers, Story 1.11's startup ladder — all downstream consumers.
- The `@modelcontextprotocol/sdk` — the engine is fully independent of MCP transport.

**Primary specs (read these first):**
- D1 — Permission Declaration Mechanism: `_bmad-output/planning-artifacts/architecture.md:205-276`. Block format, scope rules, resolution algorithm, ordering semantics, malformed-block fail-closed.
- AR12, AR14–AR17 in `_bmad-output/planning-artifacts/epics.md:120,123-126` — engine purity, block format, scope rules, resolution rules, malformed-block fail-closed.
- AR58 — acyclic dependency rule: `_bmad-output/planning-artifacts/epics.md:183`. The pure-domain core (`permissions/`, `edits/`, `domain/`, `freshness/`, `audit/schema`, `audit/digest`) imports from no boundary module.
- NFR11 — fail-closed: `_bmad-output/planning-artifacts/epics.md:85`. If a permission decision cannot be made conclusively (malformed declaration), reject as if `none`.
- NFR19 — engine purity: `_bmad-output/planning-artifacts/epics.md:99`. Pure function; no I/O.
- NFR21 — offline test suite: `_bmad-output/planning-artifacts/epics.md:101`. No live SB; tests run with stdlib only.
- AR60 — discriminated-union exhaustiveness via `default: never`: `_bmad-output/planning-artifacts/epics.md:187`.
- D2 — no cache: `architecture.md:278-288`. Every tool call refetches; this story's engine processes a fresh `ConfigBlock[]` per call.
- Cross-component dependency map: `architecture.md:830-842` — `Permission engine | Ref, ConfigBlock parser`.

### What this story owns (and does NOT own)

**Owns:**
- `src/permissions/access-mode.ts` — `AccessMode` union, `ACCESS_MODES`, `isAccessMode`, `accessRank`, `maxAccess`, `AccessOperation`, `permits`.
- `src/permissions/access-mode.test.ts` — exhaustive type-predicate + permits-matrix tests (≥ 18 cases).
- `src/permissions/config-block-parser.ts` — `ConfigBlock`, `ConfigBlockParseError`, `ConfigBlockParseResult`, `parseConfigBlocks`.
- `src/permissions/config-block-parser.test.ts` — happy-path + fail-closed + raw-preservation tests (≥ 22 cases).
- `src/permissions/engine.ts` — `CONFIG_PAGE` constant, `resolveAccess` pure function, internal `Specificity`/comparison helpers.
- `src/permissions/engine.test.ts` — specificity, tie-break, default-deny, segment-boundary, purity tests (≥ 22 cases).

**Does NOT own (these land in later stories):**
- The `read_page` / `list_pages` / `search_pages` handlers calling `parseConfigBlocks` + `resolveAccess` to gate their tool responses — Story 1.10.
- The `audit.write({ category: 'config_error', ... })` projection of `ConfigBlockParseError[]` — Story 1.10's handler-template will own the audit-write site (the parser produces the structural value; handlers project it into audit entries).
- The MCP tool handlers calling `permits(mode, 'read')` / `permits(mode, 'edit')` etc. — Story 1.10 (read-side) and Epic 2 stories 2.1-2.5 (write-side).
- The `permissionDeniedError(ref, required, granted)` constructor — already lives in `src/domain/error.ts:228-234` (Story 1.6); call sites land in Story 1.10 / Epic 2.
- Tightening `permissionDeniedError`'s `required: string` / `granted: string` parameters into `AccessMode` — Story 1.6's deferred-work; can be done mechanically once this story lands `AccessMode`. Out-of-scope for THIS story to keep the scope tight; landing it would touch `src/domain/error.ts` which is otherwise unchanged here.
- The `query_config_blocks` tool-side caller (refetch-per-call discipline per D2) — Story 1.10's read-side handlers.
- Etag-revalidating cache for `query_config_blocks` — D2 deferred until measurements justify (`architecture.md:288`).
- A YAML-block parser (the `#mcp/config` YAML body is parsed server-side by SB's index; never reaches our parser as raw YAML).
- `docs/permissions.md` user-facing documentation — Story 1.13 (AR64 / `epics.md:193`).

### Files this story creates / modifies / deletes

**NEW:**
- `src/permissions/access-mode.ts`
- `src/permissions/access-mode.test.ts`
- `src/permissions/config-block-parser.ts`
- `src/permissions/config-block-parser.test.ts`
- `src/permissions/engine.ts`
- `src/permissions/engine.test.ts`

**MODIFY:**
- Nothing.

**UNCHANGED (do not touch):**
- All `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/freshness/`, `src/index.ts`, `src/mcp/`, `src/silverbullet/` files.
- `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md`.
- `package.json`, `package-lock.json` — **no new dependencies.**
- `tests/integration/`, `tests/smoke/`, `scripts/`.
- All `_bmad/`, `.claude/`, `docs/` (this story does not touch documentation; AR64 lands in Story 1.13).

**DELETE:**
- Nothing.

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/permissions/access-mode.test.ts` next to `access-mode.ts`; same for `config-block-parser` and `engine` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`).
- **Top-level `await test(...)`** for each case (no `describe` blocks — established Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7 pattern).
- **No mocks.** Every module is pure; tests exercise the implementation directly with hand-crafted fixtures.
- **No real `Date.now()`** in any test — none of these modules read the clock.
- **No fs / network side effects** — purity is a contract.
- Assertions:
  - `assert.strictEqual` for primitives (returned `AccessMode`, boolean from `permits`, number from `accessRank`).
  - `assert.deepStrictEqual` for full structural shapes (the `ConfigBlockParseResult` `{ blocks, errors }` object; individual `ConfigBlock` and `ConfigBlockParseError` records).
  - Use `assert.equal(parser(...).errors[0]?.reason, 'page_invalid')` for chained reads where `noUncheckedIndexedAccess` is satisfied via `?.`.
  - `assert.ok(Array.isArray(result.blocks))` and `assert.ok(Array.isArray(result.errors))` for return-shape sanity.
- **Fixture construction discipline:** in `engine.test.ts`, define a local `block(page, access, exact?)` helper to keep call sites dense. Do NOT export the helper — keep test-only utility scoped to the file.

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + previously-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:47`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; no build step |
| `node:test` | built-in | Test framework |
| `node:assert/strict` | built-in | Assertions |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:**
- `js-yaml`, `yaml`, `@iarna/toml`, `dotenv` — YAML parsing is **server-side** (SB's `index.queryLuaObjects("mcp/config", {})` already returns parsed Lua tables). The runtime client surfaces them as JSON objects; we widen those, not raw YAML strings.
- `zod` for the parser's input — overkill for a 3-field shape with `unknown` narrowing. Hand-written `typeof` guards are clearer and avoid an extra schema-definition site. (zod is reserved for `src/config/config.ts`'s env-var boundary — Story 1.4.)
- `lodash`, `ramda`, `effect` — pure-function combinators (`maxAccess` reduce, specificity comparison) are 3-line helpers in stdlib JS.
- Any property-based testing library (`fast-check`, `jsverify`) — restricted to the edit-batch validator per `architecture.md:1161` (Story 2.1). The engine's commutativity property is verified with a fixed-permutation set.
- `@modelcontextprotocol/sdk` — Story 1.10/1.11 territory. No transport surface in this story.

### File-structure requirements

After this story, `src/permissions/` must look like:

```
src/permissions/
├── access-mode.test.ts             # NEW: ≥ 18 cases
├── access-mode.ts                  # NEW: AccessMode + ACCESS_MODES + isAccessMode + accessRank + maxAccess + AccessOperation + permits
├── config-block-parser.test.ts     # NEW: ≥ 22 cases
├── config-block-parser.ts          # NEW: ConfigBlock + ConfigBlockParseError + parseConfigBlocks
├── engine.test.ts                  # NEW: ≥ 22 cases
└── engine.ts                       # NEW: CONFIG_PAGE + resolveAccess
```

**No barrel files** (AR57 / `architecture.md:999`). Importers in later stories write `from '../permissions/access-mode.ts'`, `from '../permissions/config-block-parser.ts'`, `from '../permissions/engine.ts'` directly.

### Latest tech information (researched 2026-04-30)

- **`as const satisfies` for runtime-iterable closed unions** — same pattern as Story 1.6's `REASON_CODES`:
  ```typescript
  export const ACCESS_MODES = ['none', 'read', 'append', 'write'] as const satisfies ReadonlyArray<AccessMode>;
  ```
  The `as const` makes the tuple `readonly ['none', 'read', 'append', 'write']`; the `satisfies` clause guarantees structural compatibility with `ReadonlyArray<AccessMode>` without widening.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:11`): the `ConfigBlock.exact: boolean` field is **required** (always present in the parser's output, defaulted to `false` on absent input). Do NOT make it `exact?: boolean` — that would push the default-on-absent rule into call sites.
- **`erasableSyntaxOnly: true`**: no `enum` for `AccessMode` or `ReasonCode` — closed string-literal unions only (Story 1.6 dev-notes line 668).
- **`verbatimModuleSyntax: true`**: type-only imports must use `import { type Foo }` — `import { type Ref } from '../domain/ref.ts'`, `import { type AccessMode, maxAccess } from './access-mode.ts'`. Match Stories 1.5 / 1.6 / 1.7 style.
- **`noUncheckedIndexedAccess: true`**: array indexing returns `T | undefined` — `matchingModes[0]` is `AccessMode | undefined`. The `reduce` call without initial value is safe because the `length === 0` guard precedes it; for tests, use `errors[0]?.reason` (optional-chain) instead of `errors[0].reason`.
- **`noFallthroughCasesInSwitch: true`**: every `case` in `accessRank` and `permits` either returns or breaks. The `assertExhaustive(_: never): never` default arm satisfies the exhaustiveness checker.
- **`assertExhaustive(value: never): never` helper** — pattern from `src/domain/error.ts:423-428`. Define inline (private) in each module that needs it; do NOT extract to a shared `utils` module (AR57 forbids `utils` catchalls).
- **`String.prototype.startsWith`** (Node ≥ 24, ES2015+) — used for the scope match `ref.startsWith(block.page + '/')`. The `+ '/'` separator is the segment-boundary enforcement (AR15) — without it, a block on `Personal` would match `PersonalAssistant` (the deferred-work candidate `architecture.md:850-855` does not include this case; AR15 is the contract).
- **`Array.prototype.reduce` without initial value** is safe iff `array.length >= 1`. Guard `matchingModes.length === 0 → return 'none'` precedes the reduce.

### Previous story intelligence (from Stories 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7)

Distilled patterns to apply:

1. **Top-level `await test(...)` is the established test pattern** — Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7. Do **not** introduce `describe` blocks.
2. **`@types/node@^24` is pinned.** No action needed.
3. **No `npm install` should be needed.** No new dependencies.
4. **`npx prettier --check .`** is the format gate. `.prettierignore` already excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep` — new `.ts` files under `src/` ARE checked.
5. **`npm pack --dry-run` baseline after Story 1.7:** 20 files. After this story: **23 files** (3 new source files; 3 test files excluded by `!src/**/*.test.ts`).
6. **`@ts-expect-error` requires inline justification** (AR59 / `architecture.md:1032`). Avoid altogether in production code.
7. **No barrel re-exports** (AR57). Importers write the file path directly.
8. **Story 1.6's `assertExhaustive` pattern** (`src/domain/error.ts:423-428`) — copy the idea, not the function. Each new module defines its own private helper. (Sharing across modules creates a `utils` catchall, forbidden by AR57.)
9. **Story 1.6's `as const satisfies ReadonlyArray<...>` pattern** (`src/domain/error.ts:27-34`) — directly applicable to `ACCESS_MODES`.
10. **Story 1.7's `RUNTIME_ERROR_CODE` pattern** (`src/silverbullet/client.ts:29-38`) — uses `as const satisfies Record<string, string>` for the closed-vocabulary lock-in. `ACCESS_MODES` is a tuple-shaped variant: `as const satisfies ReadonlyArray<AccessMode>`.
11. **Story 1.4's `loadConfig` boundary discipline** — defensive `unknown`-narrowing at the input boundary (env vars). The parser in this story applies the same discipline to `query_config_blocks` output.
12. **Story 1.5's `void`-return / fire-and-forget pattern** — not applicable here (all functions are sync, return values).
13. **Story 1.6's `isPlainObject` and `scrubSecrets` complexity** — overkill for this story. The parser walks a flat array of records with three `unknown` fields; no recursion needed. The runtime client (Story 1.7) already scrubs HTTP response bodies before they reach this parser.
14. **Story 1.7 dev-notes lesson (`exactOptionalPropertyTypes` traps)** — when constructing `ConfigBlockParseError` errors with an optional field, use the conditional-spread pattern, NOT `{ ..., field: undefined }`. Example: `{ raw: { ...(r.page !== undefined ? { page: r.page } : {}), ... }, reason, message }`. **Refinement:** AC2 specifies the `raw` shape as `{ page?: unknown; access?: unknown; exact?: unknown }` — all three fields optional but typed `unknown`. The cleanest construction is `{ raw: { page: r.page, access: r.access, exact: r.exact }, reason, message }` — directly pass the values; `undefined` slots are permitted by `?: unknown`. Verify against `exactOptionalPropertyTypes` at `npm run typecheck`; if it complains, switch to conditional spreads.
15. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../domain/ref.ts'`, `from './access-mode.ts'`, `from './config-block-parser.ts'`. `node:` builtins import normally.

### Git intelligence

Recent commits (`git log --oneline -8`):
- `23ba910 feat(silverbullet): runtime client, envelope, lua templates (story 1.7)`
- `e111c8c feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`
- `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`

**Expected commit footprint for this story:** 6 new files (3 source + 3 tests) under `src/permissions/`. No modifications, no deletions.

**Conventional Commits gate** (a867ada). This story's commit message should follow:
`feat(permissions): access-mode, config-block-parser, resolveAccess engine (story 1.8)`

### Critical guardrails (do not rediscover)

1. **The engine is pure (NFR19 / `epics.md:99`).** Zero I/O, zero clock, zero global state. The pure-domain core (`src/permissions/`) imports from no boundary module (AR58 / `epics.md:183`). **Importing `silverbullet/client.ts`, `audit/audit-logger.ts`, `diagnostic/logger.ts`, `config/config.ts`, `node:fs`, `node:net`, `globalThis.fetch`, or `Date.now`/`performance.now` in any of the three new source files is a code-review block.**
2. **The parser MUST NOT throw on bad input** (AC2 / NFR11). Field-level fail-closed: each malformed field surfaces as a `ConfigBlockParseError` in the `errors` array; the function always returns a `ConfigBlockParseResult`. The only sanctioned `try/catch` is around `makeRef(r.page)` to convert `RefValidationError` into a structural error.
3. **YAML parsing is upstream — not in this story.** SB's `index.queryLuaObjects("mcp/config", {})` returns already-parsed objects (Story 1.7's `query-config-blocks.lua.ts`). The parser's input is `ReadonlyArray<{ page?: unknown; access?: unknown; exact?: unknown }>`. **Do NOT add a YAML library; do NOT parse YAML strings.** The AC1 wording "an unparseable YAML body" maps to "any field on the input record fails type/range validation" — SB has already filtered out blocks whose YAML body fails to parse server-side.
4. **Default-deny is the contract (AR16 / NFR11 / `epics.md:85,125`).** Empty `blocks`, no matching block, all-malformed blocks → `'none'`. **Do not** add fallback rules (e.g., "if no blocks, default to `read` for the user's own pages"). The user explicitly declares access; absence is denial.
5. **Specificity ordering is `exact > scope > global`, with `scope` ordered by length** (D1 / `architecture.md:253`). **Within the same specificity, most-permissive wins** (AR16). These two rules combine: more specificity ALWAYS wins regardless of permissiveness; ties resolve by most-permissive. **Do not** invert this — a less-specific `'write'` does not override a more-specific `'none'` (security boundary).
6. **Scope match uses segment boundary** (`ref === root || ref.startsWith(root + '/')`) — AR15 / `epics.md:124`. **Do not** use bare `ref.startsWith(root)` — that would match `PersonalAssistant` against a `Personal` block.
7. **`CONFIG_PAGE` is the literal `makeRef('CONFIG')`** — case-sensitive (D1 / `architecture.md:228`). A block on a page named `Config`, `config`, or `CONFIG_v2` is **not** global; only the exact ref `'CONFIG'` is.
8. **`exact: true` on a block scopes it to the host page only** (AR15). A block on `Personal` with `exact: true` does NOT match `Personal/Diary`. **Do not** apply specificity-by-length to `exact` blocks against descendants — the `matches` check returns `false`, full stop.
9. **`exactOptionalPropertyTypes: true`** — when constructing `ConfigBlockParseError` errors with the conditional `raw.exact?: unknown` field present-or-absent, use direct assignment (`raw: { page: r.page, access: r.access, exact: r.exact }`) — `unknown` accepts `undefined` directly. **Do NOT** assign `field: undefined` explicitly to a `field?: T` slot in `ConfigBlock` — there is no such slot in the SUCCESS shape; `exact: boolean` is required.
10. **`@ts-ignore` and `@ts-expect-error` are forbidden without inline tracked-issue justification** (AR59 / `architecture.md:1032`).
11. **No `enum`, no `namespace`, no constructor parameter properties** (`erasableSyntaxOnly: true`).
12. **No `as` casts outside boundary constructors** (AR59 / `architecture.md:1031`). The `assertExhaustive(value: never): never` default arms in switches are NOT casts — they're intersection narrowing. The `block.page === CONFIG_PAGE` brand-equality check uses string comparison on the underlying value (TS sees this as `Ref === Ref`); no cast needed.
13. **`no-floating-promises` is enforced** (`eslint.config.js:19`) — irrelevant here (all permissions code is synchronous), but tests must `await test(...)`.
14. **Imports use `.ts` extension** (`tsconfig.json:14`).
15. **Test file naming:** `*.test.ts` adjacent to the unit (`architecture.md:998`). Excluded from pack via `package.json:15`'s `"!src/**/*.test.ts"`.
16. **`AccessMode` ordering in the type union — `'none' | 'read' | 'append' | 'write'`** — this is the documented order (D1 / `architecture.md:212`). Match it in the `ACCESS_MODES` tuple, in the `accessRank` switch, and in the docs/JSDoc. Tests assert ordering (AC7 last bullet under access-mode).
17. **The parser's `errors` array is NOT a `DomainError[]`** — it's a structural `ConfigBlockParseError[]`. The handler boundary (Story 1.10) projects each error into a `configError(...)` audit entry. Importing `domain/error.ts` from this module would couple the pure-domain core to the error-presentation layer; AR58 forbids this.
18. **Single-pass over `blocks`** in `resolveAccess` — O(n) with constant per-iteration state. Do NOT sort `blocks` upfront (would defeat the single-pass property and add O(n log n)); do NOT stream or chunk. The expected `blocks.length` is in the dozens, not millions.

### Story scope boundaries (DO NOT include)

- **Tightening `permissionDeniedError(ref, required: string, granted: string)` in `src/domain/error.ts:228-234` to use `AccessMode`** — Story 1.6's deferred-work item. Mechanically safe to land alongside this story, but adding it expands the scope and forces a re-test of `src/domain/error.test.ts`. **Defer to a focused follow-up.**
- **The `read_page` / `list_pages` / `search_pages` handlers calling `resolveAccess`** — Story 1.10. The handler-template (`src/mcp/handler-template.ts`) and the per-tool handlers consume `parseConfigBlocks` + `resolveAccess`; this story stops at the pure-function boundary.
- **The `audit.write({ category: 'config_error', ... })` projection of `ConfigBlockParseError[]`** — Story 1.10's handler-template. The parser produces the structural value; handlers project.
- **Etag-revalidating cache for `query_config_blocks`** — D2 deferred (`architecture.md:288`). Adding it now would require cache-invalidation logic D2 explicitly punts.
- **A YAML library or YAML parsing** — out of scope; SB's index parses YAML server-side.
- **Per-segment validation rules in `Ref`** — Story 1.2's deferred-work (`deferred-work.md:30-31`). The parser uses `makeRef` as-is.
- **Localising the `ConfigBlockParseError.message` strings** — MVP is English-only (Story 1.6's deferral pattern).
- **A `permissions/index.ts` barrel re-exporting all three modules** — AR57 forbids barrel files (`architecture.md:999`). Each consumer imports from the specific file.
- **`docs/permissions.md` user-facing documentation** — Story 1.13 (AR64 / `epics.md:193`).
- **The `permissions/handlers.test.ts` integration test** wiring engine + parser + a fake runtime client — Story 1.10 territory (the handler tests will exercise this composition). Adding it here would cross the boundary AR58 establishes.
- **Property-based testing for the engine's commutativity / monotonicity** — restricted to the edit-batch validator per `architecture.md:1161`. Use a fixed permutation set instead.
- **A `resolveAccessForOperation(ref, blocks, operation): boolean` convenience that combines `resolveAccess` + `permits`** — handlers compose these two calls explicitly per the architecture's tool-handler shape (`architecture.md:1054-1059`). Adding the convenience would obscure the audit-logging seam (the handler audit-logs the resolved `AccessMode` even on rejection — both pieces of information are needed).

### Deferred from this story (proposed deferred-work entries)

These should be appended to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands:

1. **Tightening `permissionDeniedError`'s parameter types from `string` to `AccessMode`** — Story 1.6's deferred-work. Mechanically safe once this story lands `AccessMode`; revisit alongside the first Story 1.10 handler that calls `permissionDeniedError`.
2. **The `errors[i].raw` shape's prototype-pollution defense** — the parser pulls only `{ page, access, exact }` from each input record, but the AC2 / Story 1.6 prototype-pollution lesson (`src/domain/error.ts:165-178`) suggests a `Object.defineProperty` write could be needed if the upstream `JSON.parse` ever produces `__proto__`-bearing keys. Currently irrelevant (the upstream is `query_config_blocks` returning `{ page, access, exact? }`-only objects), but revisit if the script ever returns richer block metadata.
3. **A potential `permits(mode, operation, { strict?: boolean })` flag** — currently rejects `permits('append', 'edit')`. The `append`-mode contract is "read + atomic append" (D1 / `architecture.md:215`); an `edit` requires `write`. If a future story needs a more nuanced policy (e.g., "append also permits `replace_all` when the page has only ever been written by the same agent"), a strict-mode flag could land. Out of scope for MVP — the four-mode total order is sufficient.
4. **`resolveAccess` performance characterisation** — single-pass O(n) is sufficient for the dozens-of-blocks scale typical of a personal SilverBullet space. If a real deployment surfaces blocks in the thousands (an organisation-wide CONFIG page), revisit with profiling and consider a precomputed trie keyed by ref-prefix.
5. **`ConfigBlockParseError` structured-event signal for the diagnostic logger** — currently the handler-template (Story 1.10) will WARN on each `config_error`. A future iteration could batch parse errors per tool call into a single diagnostic entry to reduce stderr volume on misconfigured spaces. Revisit with operator feedback.
6. **A `validateConfigBlock(block: ConfigBlock): boolean` defensive re-validator** — for the case where a `ConfigBlock` value is constructed manually (e.g., in tests) and bypasses the parser. Currently the type system + brand contract on `Ref` is sufficient; revisit only if a `ConfigBlock` ever arrives via an untrusted boundary.
7. **An `engine.test.ts` property-based suite** — restricted to the edit-batch validator per architecture. If the commutativity / monotonicity properties surface as hand-crafted-test gaps, revisit. The fixed-permutation approach in this story is the architecture-approved equivalent.

### Project Structure Notes

- **Alignment with unified project structure:** `src/permissions/` matches the architecture's `src/` tree (`architecture.md:1258-1263`) one-to-one. The architecture lists four files (`engine.ts`, `engine.test.ts`, `access-mode.ts`, `config-block-parser.ts`, `config-block-parser.test.ts`) — this story ships those plus an additional `access-mode.test.ts` (the architecture omits the test pairing for `access-mode.ts`, but tests-adjacent-to-unit is mandatory per `architecture.md:998`; adding the file is the correct interpretation).
- **Detected variances:** none. The `src/permissions/` directory has been an empty placeholder since Story 1.1's scaffold (`epics.md:298` — "empty subfolders exist for each architectural seam"); this story populates it.
- **No `index.ts` re-export barrels** (AR57 / `architecture.md:999`). Importers in later stories write the full path: `from '../permissions/access-mode.ts'`, `from '../permissions/config-block-parser.ts'`, `from '../permissions/engine.ts'`.
- **Pure-domain core boundary** (AR58 / `epics.md:183`). The `src/permissions/` directory imports only from `src/domain/` (specifically `ref.ts`). No imports from `src/silverbullet/`, `src/audit/`, `src/diagnostic/`, `src/config/`, `src/mcp/`, or `src/index.ts`. Verify via `grep` after implementation: `grep -r "from '\.\./silverbullet" src/permissions/` should return nothing; same for `audit`, `diagnostic`, `config`, `mcp`.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.8] (lines 501-534)
- D1 — Permission Declaration Mechanism: [Source: _bmad-output/planning-artifacts/architecture.md#D1] (lines 205-276)
- Permission resolution algorithm (verbatim): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 231-272)
- AccessMode total order: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 209-215)
- Block format (`#mcp/config` YAML fence): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 217-224)
- Scope rules (CONFIG global, host-page-and-descendants, exact): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 226-229)
- Two ordering rules (across-specificity, within-specificity): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 267-270)
- Default-deny: [Source: _bmad-output/planning-artifacts/architecture.md] (line 272)
- Malformed-block fail-closed (NFR11): [Source: _bmad-output/planning-artifacts/architecture.md] (line 274)
- Engine purity: [Source: _bmad-output/planning-artifacts/architecture.md] (line 276)
- D2 — no cache rationale (engine consumes fresh blocks per call): [Source: _bmad-output/planning-artifacts/architecture.md#D2] (lines 278-288)
- Implementation sequence (this story = #8): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 820)
- Cross-component dependency map: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 838-841)
- Source-tree contract for `src/permissions/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 1258-1263)
- Naming conventions (`AccessMode`, `ConfigBlock`, snake-case reason codes): [Source: _bmad-output/planning-artifacts/architecture.md#Naming] (lines 882-928)
- Type-safety patterns (`AccessMode` as discriminated string union): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1014-1024)
- Error-handling discipline (return `Result<T>` for expected failures, throw for invariants): [Source: _bmad-output/planning-artifacts/architecture.md#Error-handling discipline] (lines 1110-1121)
- Mandatory rules summary (audit-schema bumps, no `as` outside boundaries, exhaustive switches): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1167-1180)
- Anti-patterns (no permission checks duplicated outside engine, no module-level singletons reachable from handlers): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1182-1193)
- Architectural boundaries (`src/permissions/` is pure-domain; no boundary): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1300-1337)
- AR12 — engine as pure function: [Source: _bmad-output/planning-artifacts/epics.md] (line 120)
- AR14 — `#mcp/config` block format with optional `exact` defaulting false: [Source: _bmad-output/planning-artifacts/epics.md] (line 123)
- AR15 — block scope rules (global on `CONFIG`, host-and-descendants otherwise, `exact: true` host-only): [Source: _bmad-output/planning-artifacts/epics.md] (line 124)
- AR16 — resolution: most-specific across, most-permissive within, default-deny: [Source: _bmad-output/planning-artifacts/epics.md] (line 125)
- AR17 — malformed-block fail-closed, audit `category: config_error`, scope falls through: [Source: _bmad-output/planning-artifacts/epics.md] (line 126)
- AR56 — `#mcp/<name>` tag namespace: [Source: _bmad-output/planning-artifacts/epics.md] (line 181)
- AR57 — no barrel files: [Source: _bmad-output/planning-artifacts/epics.md] (line 182)
- AR58 — acyclic dependency rule: [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 — no `as` outside boundaries: [Source: _bmad-output/planning-artifacts/epics.md] (line 186)
- AR60 — discriminated-union exhaustiveness: [Source: _bmad-output/planning-artifacts/epics.md] (line 187)
- NFR11 — engine fails closed: [Source: _bmad-output/planning-artifacts/epics.md] (line 85)
- NFR19 — engine is pure: [Source: _bmad-output/planning-artifacts/epics.md] (line 99)
- NFR21 — offline test suite: [Source: _bmad-output/planning-artifacts/epics.md] (line 101)
- FR4 — user can declare per-page access mode (`none|read|append|write`): [Source: _bmad-output/planning-artifacts/epics.md] (line 28)
- FR5 — declarations authored from inside SB: [Source: _bmad-output/planning-artifacts/epics.md] (line 29)
- FR6 — default-deny on unknown pages: [Source: _bmad-output/planning-artifacts/epics.md] (line 30)
- FR7 — changes take effect on next operation: [Source: _bmad-output/planning-artifacts/epics.md] (line 31)
- Existing `Ref` primitive (parser dependency): [Source: src/domain/ref.ts] (lines 8, 117-122)
- Existing `RefValidationError` (parser catches this): [Source: src/domain/ref.ts] (lines 15-25)
- Existing `permissionDeniedError` constructor (Story 1.6, downstream of this story's `AccessMode`): [Source: src/domain/error.ts] (lines 228-234)
- Existing `assertExhaustive` pattern (mirror in new modules): [Source: src/domain/error.ts] (lines 423-428)
- Existing `REASON_CODES` `as const satisfies` pattern: [Source: src/domain/error.ts] (lines 27-34)
- Existing `query-config-blocks.lua.ts` (upstream of `parseConfigBlocks`): [Source: src/silverbullet/scripts/query-config-blocks.lua.ts] (lines 11-49)
- Existing `QueryConfigBlocksResult` type (parser input shape): [Source: src/silverbullet/scripts/query-config-blocks.lua.ts] (lines 11-17)
- Existing `RuntimeClient.exec` boundary (the engine's upstream caller in Story 1.10): [Source: src/silverbullet/client.ts] (lines 70-74)
- Tool-handler shape — permission resolution between parse and freshness check: [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1054-1059)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-7-silverbullet-runtime-client-and-latency-baseline.md], [Source: _bmad-output/implementation-artifacts/1-6-domainerror-formatter-and-audit-serializer.md], [Source: _bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md], [Source: _bmad-output/implementation-artifacts/1-4-configuration-module-and-secret-scrubber.md], [Source: _bmad-output/implementation-artifacts/1-3-diagnostic-logger.md], [Source: _bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Pack-manifest verification:** `npm pack --dry-run 2>&1 | tail -2` confirms `total files: 23` post-1.8, matching the AC8 contract (20 baseline + 3 new source files; 3 test files excluded by `package.json:15`'s `"!src/**/*.test.ts"` allowlist negation).
- **Pure-domain isolation grep:** `grep -r "from '\.\./silverbullet|\.\./audit|\.\./diagnostic|\.\./config|\.\./mcp" src/permissions/` returns nothing — AR58 / `epics.md:183` (acyclic dependency rule) verified at the file-import layer. The only out-of-tree import in `src/permissions/` is `from '../domain/ref.ts'`.
- **Prettier auto-format on `access-mode.ts`:** the `as const satisfies ReadonlyArray<AccessMode>` literal originally fit on a single line; Prettier reformatted into a multi-line tuple. Behavioural shape unchanged. No code review concern.
- **`@typescript-eslint/no-unsafe-assignment` on `access` narrowing:** initial implementation pulled `r.access` into a local `string` after `isAccessMode` narrowed it; ESLint flagged the redundant string→AccessMode assignment as unsafe. Fixed by typing the local as `AccessMode` directly (`const access: AccessMode = r.access;`) — the type guard already widened the operand.
- **AccessMode test count exceeded floor:** spec floor was 18 cases for `access-mode.test.ts`; final count is 49 (the `permits('none', op)` matrix expanded into 7 individual cases via a fixture loop, and the `ACCESS_MODES` ordering check separated the four positional asserts plus an `every`-loop assert). Net = +107 new tests (49 + 27 + 31), well above the AC9 floor of +60.

### Completion Notes List

- ✅ AC1: `src/permissions/access-mode.ts` exports `AccessMode` (closed `'none' | 'read' | 'append' | 'write'` union), `ACCESS_MODES` tuple via `as const satisfies ReadonlyArray<AccessMode>`, `isAccessMode` (case-sensitive type predicate), `accessRank` (0..3), `maxAccess` (most-permissive picker for tie-break), `AccessOperation` (closed 7-value union), and `permits` (per-operation rank matrix). Internal `assertExhaustive(_: never): never` enforces AR60 exhaustiveness.
- ✅ AC2: `src/permissions/config-block-parser.ts` exports `ConfigBlock`, `ConfigBlockParseError`, `ConfigBlockParseResult`, and `parseConfigBlocks(raw)`. Field-level fail-closed: bad `page` → `page_missing` / `page_invalid`; bad `access` → `access_missing` / `access_invalid`; bad `exact` → `exact_invalid`. The function never throws on any input — verified with `Object.create(null)` and `JSON.parse('{"__proto__":...}')` adversarial fixtures. The `errors[i].raw` shape pulls only `{page, access, exact}` defensively (no spread of extraneous keys).
- ✅ AC3: `src/permissions/engine.ts` implements the D1 algorithm verbatim. `CONFIG_PAGE = makeRef('CONFIG')` is constructed once at module load. Internal `Specificity` discriminated union (`'global'` < `'scope'` (by length) < `'exact'`) drives the `compareSpecificity` cmp function. Single-pass O(n) loop with constant per-iteration state.
- ✅ AC4: Specificity-ordering tests cover global/scope, scope/scope-by-length, exact/scope-on-same-root, exact-does-not-match-descendants, and global+exact cross-tier — all 5 fixture sets pass.
- ✅ AC5: Tie-break tests cover scope/scope, exact/exact, global/global, three-way scope ties, and the 6-permutation commutativity property — `maxAccess` reduce always converges to the most-permissive mode regardless of input order.
- ✅ AC6: Default-deny tests cover empty blocks, no-matching-block, exact-block-doesn't-match-descendant, and the segment-boundary rule (`Personal` block does NOT match `PersonalAssistant`).
- ✅ AC7: Test file counts: `access-mode.test.ts` = 49 cases; `config-block-parser.test.ts` = 27 cases; `engine.test.ts` = 31 cases. Total +107 (AC7 spec floor 30 + 22 + 22 = 74; achieved +107).
- ✅ AC8: `src/permissions/` contains exactly 6 files (3 source + 3 tests). `npm pack --dry-run` confirms 23 total files. No other source file in the repo modified; no new dependencies.
- ✅ AC9: All four gates green — `npm run typecheck` (exit 0), `npm run lint` (exit 0, zero warnings under `--max-warnings=0`), `npx prettier --check .` (exit 0), `npm test` (367/367 passing, +107 from the 260 baseline).
- **Test-count baseline reconciliation:** the story's stated post-1.7 baseline of "256 tests" turned out to be 260 on the actual run. Net delta is +107 (367 - 260), well above the AC9 +60 floor. The discrepancy is informational; no behaviour change.
- **AR58 isolation verified:** no imports from `silverbullet/`, `audit/`, `diagnostic/`, `config/`, or `mcp/` in any `src/permissions/*.ts` file. Pure-domain core preserved.

### File List

**NEW:**

- `src/permissions/access-mode.ts`
- `src/permissions/access-mode.test.ts`
- `src/permissions/config-block-parser.ts`
- `src/permissions/config-block-parser.test.ts`
- `src/permissions/engine.ts`
- `src/permissions/engine.test.ts`

**MODIFIED:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.8 status transitions (backlog → ready-for-dev → in-progress → review).

### Change Log

| Date       | Change                                                                                                  | Files                                              |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2026-04-30 | feat(permissions): access-mode, config-block-parser, resolveAccess engine (story 1.8)                  | `src/permissions/**`                               |
| 2026-04-30 | review: pin CONFIG+exact:true semantics; drop `as AccessMode` cast in test ordering check               | `src/permissions/{access-mode,engine}.test.ts`     |
