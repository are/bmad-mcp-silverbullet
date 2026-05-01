# Story 1.10: Read-Side Tool Handlers (`list_pages`, `search_pages`, `read_page`)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As Maya's agent on first connection,
I want to list, search, and read pages in Maya's SilverBullet space — with `none`-mode pages invisible everywhere,
So that the agent can ground its responses in Maya's notes without ever seeing material she has marked off-limits.

## Acceptance Criteria

**AC1 — Canonical `handler-template.ts` at `src/mcp/handler-template.ts`**

**Given** the handler template module at `src/mcp/handler-template.ts`,
**When** I read it,
**Then** it exports the canonical injection type and helpers:

```typescript
import type { Ref } from '../domain/ref.ts';
import type { ConfigBlock } from '../permissions/config-block-parser.ts';
import type { AccessMode } from '../permissions/access-mode.ts';
import type { RuntimeClient } from '../silverbullet/client.ts';
import type { FreshnessState } from '../freshness/state.ts';
import type { AuditLogger } from '../audit/audit-logger.ts';
import type { Logger } from '../diagnostic/logger.ts';
import type { DomainError } from '../domain/error.ts';

export type PermissionEngine = {
  resolve(ref: Ref, blocks: readonly ConfigBlock[]): AccessMode;
};

export type HandlerContext = {
  readonly client: RuntimeClient;
  readonly permissionEngine: PermissionEngine;
  readonly freshness: FreshnessState;
  readonly audit: AuditLogger;
  readonly logger: Logger;
  readonly clock: () => Date;
};

export type ToolResultContent = ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
export type ToolResult =
  | { readonly isError: true; readonly content: ToolResultContent }
  | { readonly content: ToolResultContent };

export const defaultPermissionEngine: PermissionEngine;

export function formatToolError(err: DomainError): ToolResult;
export function formatToolSuccess(text: string): ToolResult;

export type FetchConfigBlocksResult = {
  readonly blocks: readonly ConfigBlock[];
  readonly parseErrors: readonly ConfigBlockParseError[];
};
export function fetchConfigBlocks(client: RuntimeClient): Promise<FetchConfigBlocksResult>;

// Re-exports of the per-reason DomainError constructors (single file, not a barrel —
// AR57 forbids `index.ts` directory re-exports, this is a deliberate API surface).
export {
  permissionDeniedError,
  freshnessViolationError,
  validationError,
  infrastructureError,
  configError,
  notFoundError,
} from '../domain/error.ts';
```

**And** `formatToolError` MAY re-use / re-export `formatToolError` from `src/domain/error.ts` (Story 1.6's implementation already produces the canonical `ToolResult` error shape; the re-export aligns the AC1 vocabulary without duplicating the per-reason renderer). The re-export pattern is permitted here because handler-template.ts is a deliberate facade for handler authors, NOT a barrel re-exporter for the `mcp/` directory.

**And** `formatToolSuccess(text: string)` returns `{ content: [{ type: 'text', text }] }` (NOT `{ isError: false, ... }` — the MCP SDK's `CallToolResult` treats absent / falsy `isError` as success; the union shape above pins this). The function is pure (no I/O, no clock); the same input always produces the same output.

**And** `defaultPermissionEngine` is `{ resolve: resolveAccess }` — a thin object wrapper around `resolveAccess` from `src/permissions/engine.ts`. This is the only construction site needed for production wiring (Story 1.11's startup ladder). Tests inject a hand-rolled `PermissionEngine` when they need to drive specific access-mode outcomes without re-deriving from `ConfigBlock[]`.

**And** `fetchConfigBlocks(client)` performs `client.exec<QueryConfigBlocksResult>(queryConfigBlocksScript)`, then runs `parseConfigBlocks(raw.blocks)` and returns `{ blocks, parseErrors }`. **All three read-side handlers MUST go through `fetchConfigBlocks` (not `client.exec` directly) so the malformed-block warning is emitted exactly once per call from a single code path** — see AC2's `ctx.logger.warn` discipline below. The function never throws — `client.exec` rejections are propagated unchanged for the handler's top-level `catch` to translate into `infrastructure_error`.

**And** the module exports `ConfigBlockParseError` (re-exported from `../permissions/config-block-parser.ts`) for the handlers' diagnostic-log-warning composition.

**And** the module's only side-effect surface is the imports listed above. **No module-level singletons that hold mutable state.** `defaultPermissionEngine` is a frozen object literal; ESLint's `no-floating-promises` and `no-misused-promises` apply.

**AC2 — Canonical try/catch/finally shape in every read handler under `src/mcp/handlers/`**

**Given** every read-side handler under `src/mcp/handlers/{list-pages,search-pages,read-page}.ts`,
**When** I read its source,
**Then** the function signature is:

```typescript
export async function handle<Tool>(
  input: unknown,
  ctx: HandlerContext,
): Promise<ToolResult>;
```

**And** the body strictly follows the `try/catch/finally` shape from `architecture.md:1041-1097`:

1. Capture `startedAt = ctx.clock.now()` and declare `let outcome: AuditOutcome` BEFORE the `try`.
2. Inside `try`: parse input via zod → `makeRef` (where applicable) → `fetchConfigBlocks(ctx.client)` → permission resolve → execute → respond. **Order is non-negotiable.**
3. Each rejection populates `outcome = { decision: 'rejected', error: <DomainError> }` and `return formatToolError(outcome.error)`.
4. The successful path populates `outcome = { decision: 'allowed', responsePayload: ... }` and returns `formatToolSuccess(...)`.
5. The `catch (err)` block translates ANY thrown value to `infrastructureError(err)`, sets `outcome` to that, AND emits exactly one `ctx.logger.error('<tool> handler crashed', err)` (architecture.md:1085) — the operator-side stack lives in the diagnostic stream, the agent gets the scrubbed `details.underlying` (AR45).
6. The `finally` block writes EXACTLY ONE audit entry per the AR53 invariant (`epics.md:176`) by calling `ctx.audit.write({ tool, args: input, ...projectOutcome(outcome), durationMs: ctx.clock.now().getTime() - startedAt.getTime() })`. The `projectOutcome` helper lives in `handler-template.ts` and produces the `{ decision, response, reason?, details?, failedOperation? }` shape from the `outcome` discriminated union; on `'allowed'` it sets `response: outcome.responsePayload`; on `'rejected'` it sets `response: undefined` AND spreads `serializeForAudit(outcome.error)` per `src/domain/error.ts:375`.

**And** zero module-level singletons are reachable from inside the handler body — every dependency arrives through `ctx` (AR53 / `epics.md:176`). Specifically: handlers MUST NOT import the `logger` const from `src/diagnostic/logger.ts` (only the `Logger` type), MUST NOT call `new Date()` / `Date.now()` (only `ctx.clock()`), and MUST NOT touch any audit-logger function other than the one bound on `ctx.audit`.

**And** if `fetchConfigBlocks` returns a non-empty `parseErrors` array, the handler emits a single `ctx.logger.warn(\`#mcp/config block parse errors: \${...}\`)` line summarising each error's `reason` + `page` (per AR50 / `architecture.md:677`). Malformed blocks are excluded from `blocks` by `parseConfigBlocks` itself (NFR11 fail-closed); the engine never sees them. **The malformed-block surfaces ONLY in the diagnostic log for Story 1.10** — emitting a separate `config_error` audit entry (per architecture.md:274's aspirational "recorded in audit") would violate the exactly-one-audit-entry-per-call invariant; story scope-boundaries below cross-reference Story 1.13 / a future story for that mechanism.

**AC3 — `list_pages` handler at `src/mcp/handlers/list-pages.ts`**

**Given** the handler at `src/mcp/handlers/list-pages.ts`,
**When** an agent calls it with `input: {}` and the SB space contains pages with mixed access modes,
**Then** it follows AC2's shape and:

1. Parses `input` via `z.object({}).strict()` → empty args. Any extraneous field rejects with `validationError({ failure: 'list_pages takes no arguments; received unexpected fields: ...' })`.
2. Calls `fetchConfigBlocks(ctx.client)` → `{ blocks, parseErrors }`. Logs malformed blocks per AC2 if any.
3. Calls `ctx.client.exec<ListPagesResult>(listPagesScript)` — no params needed.
4. Re-validates each `page.ref` via `makeRef` defensively (AR10 / `epics.md:117`). Refs failing `makeRef` are dropped from the response AND reported via `ctx.logger.warn(\`list_pages: dropping malformed ref returned by SB: \${...}\`)`. **Dropped refs are NOT included in the audit `response`** (the audit log records the agent-visible result per AR31).
5. Filters the surviving `pages` to those whose `ctx.permissionEngine.resolve(ref, blocks) !== 'none'` (FR8, FR10 / `epics.md:34,36`).
6. Returns `formatToolSuccess(JSON.stringify({ pages: visibleRefs }))` where `visibleRefs: string[]` is the array of survived refs in source order.
7. Audit entry: `{ tool: 'list_pages', args: input, decision: 'allowed', response: { pages: visibleRefs }, durationMs }` — **ref list with no snippets per AR31** (`epics.md:146`). The pre-filter list is NEVER written to audit (NFR6 / `epics.md:78`).

**And** when `client.exec` rejects (SB unreachable, runtime API failure), the catch arm produces `infrastructureError(err)` and the audit entry records `decision: 'rejected'`, `reason: 'infrastructure_error'`, `details.underlying` (already secret-scrubbed by Story 1.6's `infrastructureError`).

**And** when `fetchConfigBlocks` rejects (config-block query failed — D2 strict fail-closed per `architecture.md:284`), the catch arm produces `infrastructureError(err)`. The agent sees an infrastructure error; it does NOT see partial / pre-block-fetch output.

**AC4 — `search_pages` handler at `src/mcp/handlers/search-pages.ts`**

**Given** the handler at `src/mcp/handlers/search-pages.ts`,
**When** an agent calls it with `input: { q: 'kanban' }`,
**Then** it follows AC2's shape and:

1. Parses `input` via `z.object({ q: z.string().min(1, 'query must be non-empty') }).strict()` → `{ q }`. `q` of length 0 / non-string → `validationError({ failure: 'q must be a non-empty string' })`.
2. Calls `fetchConfigBlocks(ctx.client)` → `{ blocks, parseErrors }`.
3. Calls `ctx.client.exec<SearchPagesResult>(searchPagesScript, { q })`. **The Lua script's param key is `q` (NOT `query`)** — `searchPagesScript`'s prelude reserves `_p.query` for the SB integrated-query DSL keyword (`src/silverbullet/scripts/search-pages.lua.ts:21-25`).
4. Re-validates each `hit.ref` via `makeRef` defensively (same drop-and-warn semantics as AC3).
5. Filters surviving hits to those whose access mode is not `'none'` (FR9, FR10 / `epics.md:35,36`).
6. Returns `formatToolSuccess(JSON.stringify({ hits: visibleHits }))` where `visibleHits` is `Array<{ ref: string; score: number }>` in the source order returned by silversearch.
7. Audit entry: `{ tool: 'search_pages', args: input, decision: 'allowed', response: { hits: visibleHits.map(h => ({ ref: h.ref, score: h.score })) }, durationMs }` — refs + scores only, **no snippets and no excerpts** per AR31. The audit projection MUST NOT include any text from the page content even if a future silversearch upgrade returns excerpts (NFR6).

**And** snippet / excerpt fields silversearch may surface in a future version (`content`, `matches`, `excerpts`, `foundWords` per `src/silverbullet/scripts/search-pages.lua.ts:28-34`) NEVER appear in the response NOR the audit log — the Lua script already projects them out at the SB boundary; if a future regression accidentally includes one in `SearchPagesResult`, the handler MUST drop it before calling `formatToolSuccess`.

**And** behaviour on unreachable SB / config fetch failure mirrors AC3 — top-level catch → `infrastructureError`.

**AC5 — `read_page` handler at `src/mcp/handlers/read-page.ts` — happy path with freshness touch**

**Given** the handler at `src/mcp/handlers/read-page.ts`,
**When** an agent calls it with `input: { ref: 'Projects/Foo' }` and the resolved access mode for the ref is `read`, `append`, or `write`,
**Then** it follows AC2's shape and:

1. Parses `input` via `z.object({ ref: z.string().min(1) }).strict()` → `{ ref: rawRef }`.
2. Calls `makeRef(rawRef)` → branded `ref: Ref`. `RefValidationError` → `validationError({ failure: \`ref is not a valid SilverBullet page name: \${err.reason}\` })` — name kept, reason cited; the RAW string is NOT in `ref` because no `Ref` exists yet.
3. Calls `fetchConfigBlocks(ctx.client)` → `{ blocks, parseErrors }`. Logs malformed blocks per AC2.
4. Calls `ctx.permissionEngine.resolve(ref, blocks)` → `access: AccessMode`.
5. **Access gate (FR11 / FR13):**
   - `access === 'none'` → returns `notFoundError(ref)` and audit entry has `reason: 'not_found'`. **No SB read happens** — the page is invisible (FR13). Per AR31, the audit `args` records `ref` verbatim — names yes, content no.
   - `access === 'read' | 'append' | 'write'` → proceed.
6. Calls `ctx.client.exec<ReadPageResult>(readPageScript, { ref })` → `{ content, lastModified }`.
7. **Freshness touch (FR12 / `epics.md:43`):** `ctx.freshness.touch(ref, ctx.clock.now())`. The `at` parameter MUST be the handler's clock (architecture.md:1077), NOT the SB-side `lastModified` — the freshness invariant tracks "when did the agent last read this page", which is anchored to the agent's clock. Tests use a fixed-Date `clock` so this assertion is mechanical.
8. Returns `formatToolSuccess(content)` — the page body as the single text-content block.
9. Audit entry: `{ tool: 'read_page', args: input, decision: 'allowed', response: digest(content), durationMs }` — **content reduced to `{ size, sha256 }` per AR31 / NFR6** (`epics.md:78,146`). The raw page body NEVER reaches the audit log.

**And** the freshness touch happens AFTER the successful SB call but BEFORE the `formatToolSuccess` return — a thrown error from `digest(content)` (theoretically impossible — `digest` is pure and total over `string`) would NOT roll back the touch (the touch is observable to subsequent calls regardless of the response delivery to the agent). This is the documented contract; a partial-fail scenario is bounded by Story 1.5's exactly-one-audit invariant.

**AC6 — `read_page` rejection paths**

**Given** the `read_page` handler called with a `ref` whose resolved access mode is `'none'`,
**When** the handler executes,
**Then** it returns `notFoundError(ref)` (FR13 / `epics.md:42`) — the response is structurally indistinguishable from a missing page (per AR44 / `architecture.md:617-629`),
**And** `ctx.freshness.touch` is NEVER called (the agent must not learn "the page exists, you just don't have access" via timing or freshness side-effects),
**And** `ctx.client.exec(readPageScript, ...)` is NEVER invoked (`none`-mode short-circuits before the SB read; SB never sees the request),
**And** the audit entry records `decision: 'rejected'`, `reason: 'not_found'`, `args: input` (with `ref` verbatim per NFR6 — names yes, content no), `response: undefined`, `details: {}` (per `notFoundError`'s contract).

**Given** the `read_page` handler called with `input` that fails zod validation (e.g., missing `ref`, `ref: ''`, extraneous fields),
**When** the handler executes,
**Then** it returns `validationError({ failure: ... })` with the specific zod issue summarised in `details.failure`,
**And** `fetchConfigBlocks` is NEVER called — validation precedes the SB round-trip,
**And** the audit entry records `reason: 'validation_error'`, `details.failure: <message>`, `response: undefined`.

**Given** the `read_page` handler called with `input: { ref: '..' }` (rejected by `makeRef`),
**When** the handler executes,
**Then** it returns `validationError({ failure: 'ref is not a valid SilverBullet page name: ...' })` — the `ref` field on the DomainError is OMITTED (no valid `Ref` exists; `validationError` accepts an optional `ref` per `src/domain/error.ts:264`),
**And** the audit `args` records the input verbatim (the malformed string is the agent's own intent, logged in full per AR31).

**AC7 — Top-level catch converts thrown SB / runtime client failures to `infrastructure_error` (NFR12)**

**Given** any read handler call,
**When** the SilverBullet runtime API is unreachable mid-call (TCP refused, DNS failure, 5xx, malformed JSON, the client throws via `infrastructureError(err)` per `src/silverbullet/client.ts:165-168`),
**When** the handler's top-level `catch` clause receives the thrown DomainError,
**Then** the catch:

1. Re-uses the thrown value verbatim if it's already a `DomainError` (i.e., has `reason` + `details` shape). Wrapping a `DomainError` in another `infrastructureError` is forbidden — the structural test is `typeof err === 'object' && err !== null && 'reason' in err && typeof err.reason === 'string'`.
2. Otherwise calls `infrastructureError(err)` (which scrubs secrets per AR45 / `src/domain/error.ts:323`).
3. Calls `ctx.logger.error('<tool> handler crashed', err)` — the diagnostic logger is the operator's view of the unhandled exception (architecture.md:1085 + AR50). The agent NEVER sees the stack trace (AR45 #4).
4. Returns `formatToolError(domainErr)`.

**And** the process keeps serving subsequent tool calls (NFR12 / `epics.md:86`) — the catch arm guarantees no thrown value escapes the handler. The audit `finally` runs unconditionally.

**And** **`@typescript-eslint/no-explicit-any` is enforced** (`eslint.config.js:21`) — the catch parameter typing follows the project pattern: `catch (err) { /* err: unknown */ }`. The `'reason' in err` narrowing uses `typeof === 'object'` guards, NOT `as DomainError`.

**AC8 — Test coverage and structural isolation**

**Given** the integration test files at `tests/integration/handler-list-pages.test.ts`, `tests/integration/handler-search-pages.test.ts`, and `tests/integration/handler-read-page.test.ts`,
**When** `npm test` runs,
**Then** the suites cover (≥ **35 cases** across the three files combined; counting each top-level `await test(...)` as one case):

**`handler-list-pages.test.ts` (≥ 9 cases):**

1. Happy path: 3 pages, all permissioned `read` via a global CONFIG block → response `{ pages: ['A','B','C'] }`, audit `decision: 'allowed'`, audit `response.pages` matches.
2. `none`-mode filter: 3 pages where one is `'none'` per a more-specific block → response excludes the `none` ref; audit `response.pages` excludes it; pre-filter list NEVER written.
3. All-`none` space: every page is `'none'` → `response: { pages: [] }`, audit `response: { pages: [] }`, decision still `'allowed'`.
4. Empty SB result: SB returns `{ pages: [] }` → response `{ pages: [] }`, audit matches.
5. Validation error: `input: { extraneous: 1 }` → `validationError`, audit `decision: 'rejected'`, `reason: 'validation_error'`, `response: undefined`.
6. Infrastructure error: mocked client throws on `queryConfigBlocksScript` → `infrastructure_error`, audit matches; `listPagesScript` is NEVER invoked (assert via mock-call-count).
7. Infrastructure error mid-list: query_config succeeds, listPagesScript throws → `infrastructure_error`, audit `details.underlying` includes the scrubbed underlying error.
8. Defensive ref re-validation: SB returns `[{ ref: '..', lastModified }, { ref: 'Foo', lastModified }]` → response includes only `Foo`; `ctx.logger.warn` invoked once with the malformed-ref summary; the `..` ref is NOT in the audit `response.pages`.
9. Audit shape: `args: {}` recorded verbatim; `durationMs` is a non-negative number; `response.pages` is the visible-ref array.

**`handler-search-pages.test.ts` (≥ 9 cases):**

10. Happy path: silversearch returns 3 hits, all `read` → response `{ hits: [...] }` with refs + scores; audit `response.hits` matches.
11. `none`-mode filter: hit-set includes a `'none'` ref → dropped from response and audit.
12. Validation error: `input: { q: '' }` → `validationError({ failure: 'q must be a non-empty string' })`, no SB call.
13. Validation error: `input: { q: 123 }` → validation error, no SB call.
14. Validation error: extraneous fields → strict-mode rejection.
15. Infrastructure error: silversearch throws (e.g., plug missing) → `infrastructure_error`, audit matches.
16. Infrastructure error: queryConfigBlocks throws → `infrastructure_error`, search NEVER invoked.
17. Snippet hygiene: even if mock client returns hits with stray `content` / `excerpts` fields, the response and audit projection contain ONLY `{ ref, score }` (NFR6 belt-and-suspenders).
18. Defensive ref drop: a hit with `ref: '../etc/passwd'` is dropped + warn; remaining hits surface unchanged.

**`handler-read-page.test.ts` (≥ 12 cases):**

19. Happy path with `read` access: mock SB returns `{ content: 'hello', lastModified: '2026-05-01T00:00:00Z' }`; response is `{ content: [{ type: 'text', text: 'hello' }] }`; audit `response: { size: 5, sha256: '<...>' }`; `ctx.freshness.get(ref)` returns the test clock's `Date`.
20. Happy path with `append` access: same as #19 — `read_page` works on `read | append | write`.
21. Happy path with `write` access: same as #19.
22. `none`-mode → `not_found`: blocks resolve `ref` to `'none'`; `notFoundError`; `ctx.freshness.get(ref) === undefined` (touch NEVER called); `ctx.client.exec(readPageScript, ...)` NEVER invoked (assert via mock-call-count).
23. Default-deny → `not_found`: no block matches the ref → resolves `'none'` → `not_found` (default-deny per AR16 / `epics.md:125`).
24. Validation error: missing `ref` → no SB call, no freshness touch.
25. Validation error: extraneous field with `.strict()` → no SB call.
26. Validation error: `ref: ''` → no SB call.
27. RefValidationError: `ref: '..'` → `validationError` with `failure` mentioning `path-traversal` / the underlying `RefValidationError.reason`; no `ref` field on the DomainError; no SB call; no freshness touch.
28. Infrastructure error during `queryConfigBlocksScript`: caught and projected; no `read_page` Lua call; no freshness touch.
29. Infrastructure error during `readPageScript` (post-permission): caught and projected; freshness touch NEVER called (touch is post-success only).
30. Audit `response` digest: for content `'café'`, `audit.response.size === 5` (UTF-8 byte length), `audit.response.sha256` matches `crypto.createHash('sha256').update('café','utf8').digest('hex')`.
31. Freshness `at` is the handler's clock, NOT SB's `lastModified`: with mock SB returning `lastModified: '2020-01-01T00:00:00Z'` and a test clock anchored at `new Date('2026-05-01T12:00:00Z')`, `ctx.freshness.get(ref)?.toISOString()` returns the clock value.
32. NFR12 sequencing: after a thrown SB error, a SECOND call with the same context succeeds end-to-end — proving the catch arm doesn't poison the context.

**`handler-template.test.ts` (adjacent at `src/mcp/handler-template.test.ts`, ≥ 5 cases):**

33. `defaultPermissionEngine.resolve` matches `resolveAccess` over a fixture: same input → same output.
34. `formatToolSuccess('hello')` returns exactly `{ content: [{ type: 'text', text: 'hello' }] }` — no `isError` field.
35. `formatToolError(notFoundError(ref))` returns `{ isError: true, content: [{ type: 'text', text: <not-found template> }] }` (delegates to `src/domain/error.ts`'s renderer).
36. `fetchConfigBlocks(client)` returns `{ blocks, parseErrors }` for a mock client returning a mix of valid + malformed `#mcp/config` rows.
37. `fetchConfigBlocks(client)` propagates `client.exec`'s rejection unchanged (the handler boundary owns the catch, not this helper).

**And** every test is **pure** — no fs / network side effects. `node:test` + `node:assert/strict`. Top-level `await test(...)` for each case (no `describe` blocks — `architecture.md:1158` and prior-story precedent through 1.9).

**And** tests use a `mockClient: RuntimeClient` test double whose `exec` is a `script → Promise<unknown>` map keyed on the script template (matching by `=== queryConfigBlocksScript` etc., NOT by the post-envelope rendered Lua source). `ping` and `probe` are stubbed to never-resolve / unused (these handlers don't call them). The mock client is the ONLY place network behaviour is simulated (NFR21 / `epics.md:101`).

**And** `Date` fixtures use fixed-millisecond literals (`new Date('2026-05-01T12:00:00Z')`) — no `Date.now()` invocations in the test files; `ctx.clock` is `() => fixedDate`.

**And** `Ref` fixtures use `makeRef('TestPage')`, `makeRef('Personal/Notes')`, etc. — NEVER raw strings cast as `Ref`.

**AC9 — File structure, pack manifest, all gates green**

**Given** the project after this story,
**When** I list `src/mcp/`,
**Then** it contains:

```
src/mcp/
├── handler-template.ts          # NEW: HandlerContext, helpers, error-constructor re-exports
├── handler-template.test.ts     # NEW: ≥ 5 cases
└── handlers/
    ├── list-pages.ts            # NEW
    ├── search-pages.ts          # NEW
    └── read-page.ts             # NEW
```

**And** new integration test files exist:

```
tests/integration/
├── handler-list-pages.test.ts   # NEW: ≥ 9 cases
├── handler-search-pages.test.ts # NEW: ≥ 9 cases
└── handler-read-page.test.ts    # NEW: ≥ 12 cases
```

**And** `tests/integration/scaffold.test.ts` is **deleted** — the file's own comment explicitly notes "Remove when the first real integration test lands (story 1.10)" (`tests/integration/scaffold.test.ts:4`). Removing it is intentional, not a regression.

**And** **no other source file in the repo is changed.** In particular:

- `src/audit/*`, `src/config/*`, `src/diagnostic/*`, `src/domain/*`, `src/edits/*`, `src/freshness/*`, `src/index.ts`, `src/permissions/*`, `src/silverbullet/*` — UNCHANGED.
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.prettierrc.json`, `package.json`, `package-lock.json` — UNCHANGED. **No new dependencies.**
- `tests/smoke/*`, `scripts/*` — UNCHANGED.
- No `index.ts` re-export barrel under `src/mcp/` or `src/mcp/handlers/` (AR57 / `architecture.md:999`).

**And** `npm pack --dry-run` manifest grows from **24 files** (post-1.9 baseline) to **28 files** — the four new published files are `src/mcp/handler-template.ts`, `src/mcp/handlers/list-pages.ts`, `src/mcp/handlers/search-pages.ts`, `src/mcp/handlers/read-page.ts`. All `*.test.ts` files (adjacent + integration) are excluded by `package.json:15`'s `"!src/**/*.test.ts"` allowlist negation; integration tests are also out of `src/**/*.ts` so they are excluded twice over.

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint` (`--max-warnings=0` per `package.json:34`'s lint-staged glob), `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`.

**And** `npm test` reports ≥ **+34 net new cases** versus the post-1.9 baseline of **392 tests** (≥ 35 new minus 1 deleted scaffold case = +34 floor; expected total ≥ **426**). The exact delta varies with how the `≥ N` floors above are realised in the test files; AC8's floors are minima, not caps.

**And** the existing test suite continues to pass without modification — this story is purely **additive at the source layer** and adjacent at the test layer; the only deletion is the one-line scaffold integration test.

## Tasks / Subtasks

- [x] **Task 1: Author `src/mcp/handler-template.ts`** (AC: #1, #2, #7)
  - [x] Create the file. Imports follow `verbatimModuleSyntax: true` — types via `import type`, runtime values via plain `import`.
  - [x] Define and export `type PermissionEngine = { resolve(ref, blocks): AccessMode }` per AC1.
  - [x] Define and export `type HandlerContext = { client, permissionEngine, freshness, audit, logger, clock }` per AC1; all fields `readonly`.
  - [x] Define and export `type ToolResultContent` and `type ToolResult` discriminated union per AC1. The union has two arms: `{ isError: true, content }` and `{ content }` — the success arm has NO `isError` field (under `exactOptionalPropertyTypes: true`, omitting is the canonical "false-y" representation; explicit `isError: false` would compile but is non-canonical for the MCP SDK shape).
  - [x] Implement `function formatToolSuccess(text: string): ToolResult`: `return { content: [{ type: 'text', text }] };`. Pure; no clock; no I/O.
  - [x] **Re-export `formatToolError`** from `../domain/error.ts` — it ALREADY produces the canonical `{ isError: true, content: [{ type: 'text', text }] }` shape (`src/domain/error.ts:569-574`); no wrapper needed. Document this in JSDoc — the re-export is deliberate, NOT a barrel pattern (AR57's barrel ban applies to `index.ts` directory re-exports, not to single-file deliberate facades — restate the distinction in the file's header).
  - [x] **Re-export per-reason error constructors** from `../domain/error.ts`: `permissionDeniedError`, `freshnessViolationError`, `validationError`, `infrastructureError`, `configError`, `notFoundError`. Use `export { ... } from '...'` syntax.
  - [x] **Re-export `ConfigBlockParseError` type** from `../permissions/config-block-parser.ts` (for the malformed-block warning composition in AC2).
  - [x] Implement `defaultPermissionEngine`:
    ```typescript
    import { resolveAccess } from '../permissions/engine.ts';
    export const defaultPermissionEngine: PermissionEngine = Object.freeze({ resolve: resolveAccess });
    ```
    The `Object.freeze` is belt-and-suspenders against accidental runtime mutation by tests; the `readonly` `PermissionEngine.resolve` typing is already enforced at compile time.
  - [x] Implement `async function fetchConfigBlocks(client: RuntimeClient): Promise<FetchConfigBlocksResult>`:
    1. `const raw = await client.exec<QueryConfigBlocksResult>(queryConfigBlocksScript);`
    2. `const { blocks, errors: parseErrors } = parseConfigBlocks(raw.blocks);`
    3. `return { blocks, parseErrors };`
    The `await` ensures `client.exec` rejections propagate as Promise rejections; the handler's top-level `catch` translates them to `infrastructure_error`. **Do NOT wrap the rejection in a try/catch here** — that's the handler's job, not this helper's.
  - [x] Define and export the `AuditOutcome` discriminated union plus `projectOutcome(outcome): { decision, response, reason?, details?, failedOperation? }` helper used by every handler's `finally` block:
    ```typescript
    export type AuditOutcome =
      | { readonly decision: 'allowed'; readonly responsePayload: unknown }
      | { readonly decision: 'rejected'; readonly error: DomainError };

    export function projectOutcome(outcome: AuditOutcome): {
      readonly decision: 'allowed' | 'rejected';
      readonly response: unknown;
      readonly reason?: ReasonCode;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly failedOperation?: { readonly index: number; readonly operation: object };
    };
    ```
    Implementation: on `'allowed'` returns `{ decision: 'allowed', response: outcome.responsePayload }`; on `'rejected'` returns `{ decision: 'rejected', response: undefined, ...serializeForAudit(outcome.error) }` (spreads `reason`, `details`, optional `failedOperation`).
  - [x] **Implement `isDomainError(value: unknown): value is DomainError`** for AC7's "is the thrown value already a DomainError?" check. Structural shape only (no `instanceof` — DomainError is an interface, not a class). Used by every handler's catch arm.
  - [x] JSDoc all exports citing the architecture / epic line numbers per the established style. Document the `formatToolSuccess` MCP-SDK shape rationale.
  - [x] **Pure-side-effects audit:** `Object.freeze(defaultPermissionEngine)` and the imports are the ONLY module-level effects. No clock reads, no env reads, no `process.*`.

- [x] **Task 2: Author `src/mcp/handler-template.test.ts`** (AC: #1, #8)
  - [x] Create the test file. Imports: `node:test`, `node:assert/strict`, plus the helpers and types under test.
  - [x] Top-level `await test(...)` for each case.
  - [x] **Helper:** `const ref = (n: string) => makeRef(n);` for fixture brevity.
  - [x] Cover AC8 cases #33-37: `defaultPermissionEngine.resolve` parity with `resolveAccess`; `formatToolSuccess` shape; `formatToolError` delegation; `fetchConfigBlocks` happy + `parseErrors` propagation; `fetchConfigBlocks` rejection propagation.
  - [x] **Mock client construction:** `function makeMockClient(execImpl: <T>(script: string, params?: ...) => Promise<T>): RuntimeClient` — returns `{ exec: execImpl, ping: async () => {}, probe: async () => {} }`. Test files share this helper; consider extracting to a small module under `tests/integration/` if the duplication grows (this story keeps it inline).
  - [x] No `Date.now()` invocations — fixed millis only.

- [x] **Task 3: Author `src/mcp/handlers/list-pages.ts`** (AC: #2, #3, #7)
  - [x] Create the file. Imports follow `verbatimModuleSyntax: true`.
  - [x] Define a private `const ListPagesInputSchema = z.object({}).strict();` at the top of the file (per AR53's "input schemas live with the handler" implication; not a separate types module).
  - [x] Define `const TOOL_NAME = 'list_pages' as const;` for the audit `tool` field — pinned to the MCP convention name (snake_case per AR55 / `epics.md:179`).
  - [x] Implement `export async function handleListPages(input: unknown, ctx: HandlerContext): Promise<ToolResult>`:
    1. `const startedAt = ctx.clock();` — capture the `Date` directly (not `getTime()`, so the audit-write step gets a `Date` to subtract from); test fixtures pass a `Date`-returning clock.
    2. `let outcome: AuditOutcome | undefined = undefined;` — populated on every code path that returns from `try` OR `catch`. The final `finally` asserts `outcome !== undefined` (defensive — a control-flow bug would surface as a clear runtime error, NOT a missing audit entry).
    3. `try { ... } catch (err) { ... } finally { ... }` per AC2.
    4. **Inside `try`**: parse via zod (catch `ZodError` → `validationError({ failure: <issue summary> })`, set outcome, return `formatToolError`). On valid input, call `fetchConfigBlocks(ctx.client)`. Log parseErrors via `ctx.logger.warn`. Call `ctx.client.exec<ListPagesResult>(listPagesScript)`. Re-validate each ref via `makeRef`; drop + warn on `RefValidationError`. Filter out `none`-mode refs via `ctx.permissionEngine.resolve(ref, blocks) !== 'none'`. Build `visibleRefs: string[]`. Set `outcome = { decision: 'allowed', responsePayload: { pages: visibleRefs } }`. Return `formatToolSuccess(JSON.stringify({ pages: visibleRefs }))`.
    5. **Inside `catch (err)`**: if `isDomainError(err)` use it directly; else `infrastructureError(err)`. `ctx.logger.error('list_pages handler crashed', err)`. Set `outcome = { decision: 'rejected', error: domainErr }`. Return `formatToolError(domainErr)`.
    6. **Inside `finally`**: `if (outcome === undefined) outcome = { decision: 'rejected', error: infrastructureError(new Error('handler exited without populating outcome')) };` (defensive — should be unreachable). Then `ctx.audit.write({ tool: TOOL_NAME, args: input, durationMs: ctx.clock().getTime() - startedAt.getTime(), ...projectOutcome(outcome) });`.
  - [x] **Defensive ref re-validation pattern** (used in all three handlers):
    ```typescript
    const validatedPages: string[] = [];
    for (const p of raw.pages) {
      try {
        const r = makeRef(p.ref);
        validatedPages.push(r);
      } catch (refErr) {
        if (refErr instanceof RefValidationError) {
          ctx.logger.warn(`list_pages: dropping malformed ref returned by SB: ${refErr.value} (${refErr.reason})`);
          continue;
        }
        throw refErr;
      }
    }
    ```
  - [x] **No `console.*`, no `process.stdout.write`** anywhere — `ctx.logger` is the sole diagnostic surface.
  - [x] **No module-level singletons reachable from the handler body.** All deps via `ctx`. The handler does NOT import the diagnostic-logger `logger` const, the production audit logger, or `Date.now`.

- [x] **Task 4: Author `src/mcp/handlers/search-pages.ts`** (AC: #2, #4, #7)
  - [x] Same shape as Task 3, with these differences:
    - Input schema: `z.object({ q: z.string().min(1, 'q must be a non-empty string') }).strict();`.
    - `client.exec<SearchPagesResult>(searchPagesScript, { q: args.q });` — params object uses key `q` (matches `_p.q` in the Lua script).
    - Audit `response: { hits: visibleHits.map(h => ({ ref: h.ref, score: h.score })) }` — explicit projection (NOT `...h`) so any future silversearch field that slips through `SearchPagesResult` is structurally dropped.
  - [x] `TOOL_NAME = 'search_pages' as const;`.

- [x] **Task 5: Author `src/mcp/handlers/read-page.ts`** (AC: #2, #5, #6, #7)
  - [x] Input schema: `z.object({ ref: z.string().min(1, 'ref must be a non-empty string') }).strict();`.
  - [x] After zod parse: `let ref: Ref;` then `try { ref = makeRef(args.ref); } catch (refErr) { /* → validationError({ failure: \`ref is not a valid SilverBullet page name: \${refErr.reason}\` }) */ }`. The DomainError MUST NOT carry a `ref` field (no valid Ref exists; `validationError` accepts `ref?` per `src/domain/error.ts:264`).
  - [x] `fetchConfigBlocks(ctx.client)` → log parseErrors per AC2.
  - [x] `const access = ctx.permissionEngine.resolve(ref, blocks);` → branch:
    - `access === 'none'`: `outcome = { decision: 'rejected', error: notFoundError(ref) };` `return formatToolError(notFoundError(ref));`. NO `ctx.client.exec(readPageScript, ...)` call. NO `ctx.freshness.touch`.
    - Otherwise: `client.exec<ReadPageResult>(readPageScript, { ref });` → `{ content, lastModified }`. `ctx.freshness.touch(ref, ctx.clock());`. `outcome = { decision: 'allowed', responsePayload: digest(content) };` `return formatToolSuccess(content);`.
  - [x] **The audit `response` is `digest(content)`, NOT the raw content.** AR31 / NFR6 — the agent gets the body, the audit gets `{ size, sha256 }`.
  - [x] **The freshness touch's `at` parameter is `ctx.clock()`, NOT `new Date(meta.lastModified)`.** Architecture.md:1077 — the freshness invariant tracks "when the agent last read the page", which is anchored to the agent's clock. The SB-side `lastModified` is a different quantity (Story 2.3's `edit_page` will compare it to `freshness.get(ref)`).
  - [x] **Defensive note:** the `lastModified` from the read-page Lua script is NOT consumed by Story 1.10's read handler (only by Story 2.3's edit handler via a separate `pageMetaScript` call). The `ReadPageResult` type still includes it; the read handler simply ignores it. Document this in JSDoc — a future refactor that "optimizes" by reading `lastModified` from `read_page` and storing it in freshness would silently drift the freshness contract toward "last SB modification" instead of "last agent read".
  - [x] `TOOL_NAME = 'read_page' as const;`.
  - [x] **`@typescript-eslint/no-floating-promises` is enforced** (`eslint.config.js:19`) — every `client.exec` call is `await`ed. The audit `write` is fire-and-forget by design (`AuditLogger.write(): void`); no `await` keyword needed and none warranted.

- [x] **Task 6: Author `tests/integration/handler-list-pages.test.ts`** (AC: #3, #7, #8)
  - [x] Imports: `node:test`, `node:assert/strict`, the handler, `makeRef`, the script template constants, the helpers from `handler-template.ts`.
  - [x] **Mock `RuntimeClient` factory:** maps `script: string` to a canned response (or thrown error) per call. Use `===` identity matching against the imported template constants — NOT a string-prefix or regex match.
  - [x] **Mock `AuditLogger` factory:** captures `write(entry)` calls into a `writes: AuditEntryInput[]` array; `close()` is a no-op stub.
  - [x] **Mock `Logger` factory:** captures `info`/`warn`/`error` lines into per-level arrays.
  - [x] **Mock `FreshnessState` factory:** wraps `createFreshnessState({ capacity: 16 })` directly — no I/O, no global state, ALREADY pure per Story 1.9.
  - [x] **Mock `PermissionEngine` factory:** sometimes use `defaultPermissionEngine` against a hand-rolled `ConfigBlock[]`; sometimes inject a stub `{ resolve: (ref) => modeMap.get(ref) ?? 'none' }` for direct access-mode control.
  - [x] **Helper `buildContext(overrides)`:** assembles the `HandlerContext` with default mock implementations + `clock: () => fixedDate`.
  - [x] Implement AC8 cases #1-9 as top-level `await test(...)`.
  - [x] **Audit-shape assertions:** every test that exercises a return path inspects the `audit.writes[0]` entry — `tool`, `args`, `decision`, `response`, `durationMs >= 0`, plus reason/details/failedOperation when rejected.

- [x] **Task 7: Author `tests/integration/handler-search-pages.test.ts`** (AC: #4, #7, #8)
  - [x] Same harness pattern as Task 6.
  - [x] Implement AC8 cases #10-18.
  - [x] **Snippet hygiene test (#17):** mock SearchPagesResult with rogue extra fields (`hits: [{ ref, score, content: 'leak', excerpts: ['leak'] }]`); assert response and audit projection do NOT include `content`/`excerpts`. The handler's explicit `.map(h => ({ ref: h.ref, score: h.score }))` is what makes this safe; the test pins the contract.

- [x] **Task 8: Author `tests/integration/handler-read-page.test.ts`** (AC: #5, #6, #7, #8)
  - [x] Same harness pattern.
  - [x] Implement AC8 cases #19-32.
  - [x] **Freshness assertion (#19, #31):** after a successful call, `freshness.get(ref)?.toISOString()` returns the test clock's fixed value (NOT the SB-side `lastModified`).
  - [x] **Digest assertion (#30):** for content `'café'`, compute the expected sha256 directly in the test (`createHash('sha256').update('café','utf8').digest('hex')`) and assert `audit.writes[0].response.sha256` matches; assert `audit.writes[0].response.size === 5` (UTF-8 byte length of `'café'`).
  - [x] **Touch-not-called assertions:** for `none`-mode and for thrown SB errors, `freshness.get(ref) === undefined`. Use a fresh `createFreshnessState()` per test to avoid cross-test leak.
  - [x] **NFR12 sequencing test (#32):** after a thrown error, the SAME `ctx` (including the SAME freshness state, audit logger, etc.) is used for a second call that succeeds end-to-end. Assert `audit.writes.length === 2`, `[0].decision === 'rejected'`, `[1].decision === 'allowed'`.

- [x] **Task 9: Delete `tests/integration/scaffold.test.ts`** (AC: #9)
  - [x] Remove the file. Its own comment notes the deletion is expected at this story.
  - [x] Verify `npm test` still picks up the integration glob (`tests/integration/**/*.test.ts`) — the three new handler-*.test.ts files satisfy the glob.

- [x] **Task 10: Local verification** (AC: #9)
  - [x] `npm run typecheck` → exit 0, zero TS errors.
  - [x] `npm run lint -- --max-warnings=0` → exit 0. Watch for: `@typescript-eslint/unbound-method` (use `state.foo(...)` reference path, not destructured method calls — Story 1.9's lesson at `1-9-...md:548`), `@typescript-eslint/no-explicit-any` (use `unknown`), `@typescript-eslint/no-floating-promises` (await `client.exec` calls; do NOT await `audit.write`), `@typescript-eslint/no-misused-promises`.
  - [x] `npx prettier --check .` → exit 0.
  - [x] `npm test` → all passing; ≥ 426 total cases (392 baseline + ≥ 35 new − 1 deleted scaffold).
  - [x] `npm pack --dry-run` → manifest is exactly **28 files** (24 baseline + 4 new source files: `src/mcp/handler-template.ts`, `src/mcp/handlers/list-pages.ts`, `src/mcp/handlers/search-pages.ts`, `src/mcp/handlers/read-page.ts`).
  - [x] **Module-isolation grep:**
    - `grep -rE "console\.(log|info|debug)" src/mcp/` → zero output (D7 stream discipline).
    - `grep -rE "process\.stdout\.write" src/mcp/` → zero output.
    - `grep -rE "Date\.now\(\)|performance\.now\(\)|new Date\(\)" src/mcp/` → zero output (handlers use `ctx.clock()`).
    - `grep -rE "from '\.\./diagnostic/logger\.ts'" src/mcp/` → finds at most type-only imports (`import type { Logger }`), never a `import { logger }` value import.
  - [x] **Snippet hygiene grep:** `grep -E "content|excerpts|matches" src/mcp/handlers/search-pages.ts` should find ONLY the AR31 / NFR6 reference comments and the `.map(h => ({ ref: h.ref, score: h.score }))` projection — never a property access like `h.content` / `h.excerpts` / `h.matches`.

- [x] **Task 11: Append deferred-work entries (post-implementation review)** (housekeeping)
  - [x] After implementation, review the candidate list under "Deferred-from-this-story candidates" below. Append entries that feel real — particularly: (a) `not_found` translation for SB-side absent pages (currently `infrastructure_error` per scope-boundaries), (b) per-call `config_error` audit entries for malformed `#mcp/config` blocks, (c) tool-result success structured payload upgrade if the MCP SDK pins a richer shape.
  - [x] Cross-reference Story 1.11 (startup ladder will wire `defaultPermissionEngine`, real `RuntimeClient`, real `FreshnessState`, real `AuditLogger`).

### Review Findings

Code review 2026-05-01 (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Acceptance Auditor: zero AC violations. No `decision-needed` or `patch` findings. Seven `defer` items appended to `deferred-work.md`:

- [x] [Review][Defer] Per-row `makeRef` re-validation only catches `RefValidationError`; non-string `ref` from SB throws `TypeError` that escapes per-row drop and aborts the whole call [src/mcp/handlers/list-pages.ts:101, search-pages.ts:100] — deferred, spec-faithful (Task 3 codified `throw refErr`); tighten alongside AR10 hardening when 2.x handlers land
- [x] [Review][Defer] No top-level shape validation of SB-returned `raw.pages` / `raw.hits`; a malformed payload becomes a generic iterator `TypeError` rather than a labelled "SB returned malformed list-pages payload" [list-pages.ts:91, search-pages.ts:89] — deferred, contract-handled (catch arm correctly converts to `infrastructure_error`)
- [x] [Review][Defer] `q` length is unbounded (`z.string().min(1)` only); a multi-MB query is logged verbatim into audit `args` [search-pages.ts:34] — deferred, audit-log-DoS surface; revisit alongside the audit-args projection design
- [x] [Review][Defer] `JSON.stringify({ pages })` for a 10k-page space produces a multi-MB single-text-block; no size cap [list-pages.ts:116, search-pages.ts:122] — deferred, MCP transport-limit and pagination are Growth-tier concerns
- [x] [Review][Defer] Three near-duplicate `summarizeZodIssues` helpers across handlers [list-pages.ts:40-54, search-pages.ts:37-53, read-page.ts:35-51] — deferred, follows the same "extract on 5+ duplications" rule the spec applied to test helpers
- [x] [Review][Defer] `isDomainError` accepts any object with `reason: string + details: object`; doesn't validate `reason` is a known `ReasonCode` [src/mcp/handler-template.ts:182-189] — deferred, matches AC7's structural test verbatim; revisit if a real bug throws an unknown-reason DomainError
- [x] [Review][Defer] `read_page` gates on `access === 'none'` — robust today (AccessMode is closed) but brittle to future mode additions [read-page.ts:106] — deferred, AC5/AR16 mandate the `=== 'none'` form; any change requires spec update

Sixteen further findings dismissed: spec-mandated behaviour (AR31 `args: input` raw passthrough, AR31 `none`-mode audit-ref retention), contract-handled (AuditLogger/FreshnessState/Logger all wrap their own throws), inherent UTF-8 semantics (digest U+FFFD substitution), and test-fixture noise that does not reflect production paths.

## Dev Notes

### Architectural source-of-truth

This is story **#11** in the implementation sequence (`architecture.md:823`, item 11: "Tool handlers — one per MCP tool. Each handler is a thin orchestrator..."). It composes Stories 1.2 (Ref), 1.3 (Logger), 1.5 (AuditLogger), 1.6 (DomainError + formatter + audit serializer), 1.7 (RuntimeClient + Lua templates), 1.8 (permission engine), 1.9 (FreshnessState) into the first three working tool handlers — the last building blocks before Story 1.11 wires the startup ladder + MCP SDK transport.

It depends on:

- Story 1.2's `Ref` (`src/domain/ref.ts`) — `makeRef` for input boundary + defensive re-validation of SB-returned refs.
- Story 1.3's `Logger` (`src/diagnostic/logger.ts`) — `ctx.logger` for malformed-block / dropped-ref warnings + handler-crash error lines.
- Story 1.5's `AuditLogger` (`src/audit/audit-logger.ts`) — `ctx.audit.write({...})` is the exactly-one-per-call invariant carrier.
- Story 1.5's `digest` (`src/audit/digest.ts`) — `read_page` audit `response` projection per AR31 / NFR6.
- Story 1.6's `DomainError` + `formatToolError` + per-reason constructors + `serializeForAudit` (`src/domain/error.ts`) — the entire error projection pipeline.
- Story 1.7's `RuntimeClient` (`src/silverbullet/client.ts`) and Lua templates (`src/silverbullet/scripts/{list-pages,search-pages,read-page,query-config-blocks}.lua.ts`).
- Story 1.8's `resolveAccess` + `parseConfigBlocks` (`src/permissions/{engine,config-block-parser,access-mode}.ts`) — permission engine + raw-row widening.
- Story 1.9's `createFreshnessState` (`src/freshness/state.ts`) — `ctx.freshness.touch` post-successful-read.

It does **NOT** depend on:

- Story 1.4's `loadConfig` / `wrapConfig` — the handler boundary consumes `RuntimeClient` (which already binds the URL + token); no env access here.
- Story 1.11's startup ladder — `HandlerContext` injection means handlers are testable WITHOUT the MCP transport, the production audit-stream, or any env access. Story 1.11 will compose this story's `defaultPermissionEngine`, real `createRuntimeClient`, real `createFreshnessState`, real `openAuditLogger`, and the real `Logger` into the production `HandlerContext` and register the three handlers with the MCP SDK.
- Stories 2.x's edit/append/create/delete handlers — orthogonal. The freshness touch from `read_page` is the upstream half of the read-before-edit invariant; Story 2.3's `edit_page` is the downstream half (consumes `freshness.get(ref)` to gate edits).
- The `@modelcontextprotocol/sdk` — Story 1.11 territory. Story 1.10's handlers are MCP-shape-agnostic at runtime; they accept `unknown` input + return a `ToolResult` that structurally satisfies the SDK's `CallToolResult`, but no SDK import lives in `src/mcp/handlers/` for this story.

**Primary specs (read these first):**

- AC source: `_bmad-output/planning-artifacts/epics.md:557-603` (Story 1.10 ACs).
- Tool-handler shape (THE pattern this story implements): `architecture.md:1041-1108`.
- Mandatory rules summary: `architecture.md:1167-1180`.
- Anti-patterns explicitly forbidden: `architecture.md:1182-1193`.
- D6 — error response structure (the `formatToolError` contract): `architecture.md:533-641`.
- D4 — audit log: `architecture.md:386-468` (in particular AR29/AR31/AR53 invariants for the `finally` block).
- D7 — stream discipline (`ctx.logger` is the only stderr surface): `architecture.md:642-712`.
- AR53 — exactly-one audit entry per tool call: `epics.md:176`, `architecture.md:1086-1097`.
- AR31 — verbosity policy (refs in audit, no snippets): `epics.md:146`, `architecture.md:438-444`.
- NFR6 — no `none`-mode content in audit: `epics.md:78`.
- NFR12 — per-call failure does not poison the session: `epics.md:86`, AC7 above.
- FR8/FR9/FR10 — none-mode invisibility on common paths: `epics.md:34-36`.
- FR11/FR12/FR13 — read semantics + freshness touch + invisible-not-blocked: `epics.md:41-43`.

### What this story owns (and does NOT own)

**Owns:**

- `src/mcp/handler-template.ts` — `HandlerContext`, `PermissionEngine`, `ToolResult`, `AuditOutcome`, `defaultPermissionEngine`, `formatToolSuccess`, `fetchConfigBlocks`, `projectOutcome`, `isDomainError`, plus error-constructor and `formatToolError` re-exports.
- `src/mcp/handler-template.test.ts` — adjacent unit tests (≥ 5 cases).
- `src/mcp/handlers/list-pages.ts` — `handleListPages(input, ctx)`.
- `src/mcp/handlers/search-pages.ts` — `handleSearchPages(input, ctx)`.
- `src/mcp/handlers/read-page.ts` — `handleReadPage(input, ctx)`.
- `tests/integration/handler-list-pages.test.ts` — ≥ 9 cases.
- `tests/integration/handler-search-pages.test.ts` — ≥ 9 cases.
- `tests/integration/handler-read-page.test.ts` — ≥ 12 cases.
- Deletion of `tests/integration/scaffold.test.ts`.

**Does NOT own (these land in later stories):**

- `src/mcp/registry.ts` — MCP SDK `registerTool` wiring. Story 1.11.
- `src/index.ts` startup ladder — bumping the stub at `src/index.ts:5` to the AR38 ladder. Story 1.11.
- `append_to_page` handler — Story 2.2 (FR14-FR16). The freshness-exempt path is a separate handler.
- `edit_page` handler — Story 2.3 (FR17-FR23). Uses `pageMetaScript` + `ctx.freshness.get(ref)` + the edit-batch validator.
- `create_page` handler — Story 2.4 (FR24).
- `delete_page` handler — Story 2.5 (FR25). Freshness-gated.
- `pageMetaScript` consumer — Story 2.3's `edit_page` calls it BEFORE reading the snapshot to compare `meta.lastModified` against `freshness.get(ref)`. Story 1.10 does NOT call `pageMetaScript`.
- `config_error` audit entries for malformed `#mcp/config` blocks — `architecture.md:274` envisions per-block audit entries; the exactly-one-per-tool-call invariant blocks this. Defer to a separate "audit-events for non-tool-call surfaces" mechanism (Story 1.13 or post-MVP).
- `not_found` translation for SB-side absent pages (genuinely missing, not `none`-mode) — currently surfaces as `infrastructure_error` because the SB Lua surface raises a generic error on missing-page reads. Heuristic message-match is brittle; deferred until SB exposes a typed absence error or a startup probe surfaces the gap.
- A startup health check that the silversearch plug is installed in the target SB space — Story 1.11 territory (cross-referenced in `deferred-work.md:13`).
- HTTP/SSE transport, multi-agent identity, granular permission predicates — explicit Growth backlog (PRD).

### Files this story creates / modifies / deletes

**NEW:**

- `src/mcp/handler-template.ts`
- `src/mcp/handler-template.test.ts`
- `src/mcp/handlers/list-pages.ts`
- `src/mcp/handlers/search-pages.ts`
- `src/mcp/handlers/read-page.ts`
- `tests/integration/handler-list-pages.test.ts`
- `tests/integration/handler-search-pages.test.ts`
- `tests/integration/handler-read-page.test.ts`

**MODIFY:**

- Nothing.

**DELETE:**

- `tests/integration/scaffold.test.ts` — superseded by the three real integration tests; the file's own comment authorises the deletion.

**UNCHANGED (do not touch):**

- All `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/freshness/`, `src/index.ts`, `src/permissions/`, `src/silverbullet/` files.
- `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md`, `package.json`, `package-lock.json` — **no new dependencies.**
- `tests/smoke/`, `scripts/`.
- All `_bmad/`, `.claude/`, `docs/` (this story does not touch documentation; user-facing read-side documentation lands in Story 1.13's `README.md` / `docs/permissions.md`).

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test locations:
  - **Adjacent** for `handler-template.ts` (`src/mcp/handler-template.test.ts`) — pure helpers, unit tests are the right scope.
  - **`tests/integration/`** for the three handlers — multi-module composition is integration by definition; the SB-side mock seam is the only injected fake.
- Test invocation: `npm test` — picks up `'src/**/*.test.ts'` AND `'tests/integration/**/*.test.ts'` per `package.json:22`.
- **Top-level `await test(...)`** for each case (no `describe` blocks — established Stories 1.3-1.9 pattern).
- **Mocks injected through `HandlerContext`:** the SB client is the ONLY mocked seam (NFR21 / `epics.md:101`). `freshness`, `audit`, `logger`, `permissionEngine`, and `clock` are either real (the pure ones) or hand-rolled stubs whose internal state the test inspects.
- **No real `Date.now()` / `process.*` / `globalThis.fetch`** in handler tests. Tests construct `Date` values with fixed millisecond literals and inject `clock: () => fixedDate`.
- **No fs / network side effects** — purity is a contract.
- Assertions:
  - `assert.deepStrictEqual` for response payload + audit-entry shape.
  - `assert.strictEqual` for primitives (`durationMs >= 0`, `audit.writes.length === 1`, etc.).
  - `assert.match` for `ctx.logger.warn` line text containing "dropping malformed ref" / "block parse errors".
  - `assert.rejects` is NOT used at the handler boundary — handlers always RESOLVE (with `ToolResult`), never reject. Mocks that need to simulate SB errors throw INSIDE the mock's `exec` body so the handler's `try/catch` exercises.

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + previously-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:47`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; no build step |
| `node:test` | built-in | Test framework |
| `node:assert/strict` | built-in | Assertions |
| `node:crypto` | built-in | The handler-read-page test imports `createHash` for the digest assertion (#30) |
| `zod` | `^4.4.1` (`package.json:38`) | Input schema validation per story 1.4's precedent (`src/config/config.ts`) |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:**

- `@modelcontextprotocol/sdk` — already a runtime dep (`package.json:37`), but Story 1.10 does NOT import it. The handler signatures are SDK-compatible by construction (`ToolResult` matches `CallToolResult` structurally); Story 1.11 wires `registerTool` and the SDK `Server` instance. **Importing the SDK in this story is out of scope.**
- A property-based testing library (`fast-check`) for the handler tests — restricted to the edit-batch validator per `architecture.md:1161` (Story 2.1). Hand-crafted fixtures cover the AC8 case set adequately.
- A test-helper module for the mock client / mock audit / mock logger — extracting the helpers to `tests/integration/_helpers.ts` (or similar) is tempting, but the per-story-additive convention keeps churn low. Inline helpers per file for Story 1.10; extract to a shared helper if Stories 2.x create more handlers and the duplication grows.
- An MCP-SDK-shape adapter (`adaptToCallToolResult(ToolResult): CallToolResult`) — the union we define IS the SDK's shape (verified at story-1.11 implementation time when the SDK lands; if a mismatch is found, that story handles the adapter, not this one).

### File-structure requirements

After this story, `src/mcp/` must look like:

```
src/mcp/
├── handler-template.ts          # NEW
├── handler-template.test.ts     # NEW
└── handlers/
    ├── list-pages.ts            # NEW
    ├── search-pages.ts          # NEW
    └── read-page.ts             # NEW
```

And `tests/integration/`:

```
tests/integration/
├── handler-list-pages.test.ts   # NEW
├── handler-search-pages.test.ts # NEW
└── handler-read-page.test.ts    # NEW
                                  # scaffold.test.ts deleted
```

**No barrel files** under `src/mcp/` or `src/mcp/handlers/` (AR57 / `architecture.md:999`). Story 1.11's `registry.ts` will import each handler by file directly.

### Latest tech information (researched 2026-05-01)

- **Zod v4 strict mode (`z.object({}).strict()`)** — rejects unknown keys. The error issue's `code` is `'unrecognized_keys'`, with `keys: string[]` listing the offending fields. Story 1.10's handlers map this to `validationError({ failure: \`<tool> received unexpected fields: \${keys.join(', ')}\` })`.
- **Zod v4 `.min(1, 'message')`** — for `string`, returns issue with `code: 'too_small'`, `minimum: 1`. The handler maps this to a `validationError` with `failure: 'q must be a non-empty string'` (or similar).
- **Zod v4 issue-summary helper** — `parsed.error.issues[0].message` is the per-field message; for AC8's tests, `assert.match(audit.writes[0].details.failure, /...)`.
- **MCP `CallToolResult` shape** (per `@modelcontextprotocol/sdk` v1.x): `{ content: Array<TextContent | ImageContent | ...>; isError?: boolean; _meta?: ...; }`. The TS SDK type allows omitting `isError`. Story 1.10's `ToolResult` discriminates by presence/absence of `isError: true`; Story 1.11 will verify the structural fit when the SDK is wired.
- **`Object.freeze(defaultPermissionEngine)` in TS 5.6+** — the frozen literal still satisfies the `PermissionEngine` interface. `Object.freeze` is shallow; `resolve` is a function reference (immutable by default), so the freeze covers the surface.
- **`isDomainError` structural check** — `'reason' in err` requires `err` to be a non-null object; the guard pattern is:
  ```typescript
  function isDomainError(value: unknown): value is DomainError {
    return (
      typeof value === 'object' &&
      value !== null &&
      'reason' in value &&
      typeof (value as { reason: unknown }).reason === 'string' &&
      'details' in value &&
      typeof (value as { details: unknown }).details === 'object' &&
      (value as { details: unknown }).details !== null
    );
  }
  ```
  The cast is INSIDE the guard, narrowed by `'reason' in value`. Per AR59 (`architecture.md:1031`), `as` is permitted at type-narrowing boundaries; the function is the boundary. **A cleaner alternative** if it compiles: `'reason' in value && typeof value.reason === 'string'` (TS narrows `value.reason` after the `in` check).
- **`@typescript-eslint/no-floating-promises`** — every `await` site checks. The `audit.write(entry)` call is `void`-returning by design (AR61 / `epics.md:188`); no warning triggers. The `client.exec(...)` calls MUST be awaited (they return Promises).
- **`erasableSyntaxOnly: true`** — no `enum`, no `namespace`, no constructor parameter properties. Discriminated unions + plain functions only.
- **`verbatimModuleSyntax: true`** — type-only imports use `import type`. The list of types to import this way for Story 1.10: `Ref`, `ConfigBlock`, `ConfigBlockParseError`, `AccessMode`, `RuntimeClient`, `FreshnessState`, `AuditLogger`, `Logger`, `DomainError`, `ReasonCode`, `ListPagesResult`, `SearchPagesResult`, `ReadPageResult`, `QueryConfigBlocksResult`. Runtime imports: `makeRef`, `RefValidationError` (it's a class — runtime), `parseConfigBlocks`, `resolveAccess`, `digest`, the per-reason error constructors, `formatToolError`, `serializeForAudit`, the Lua script template constants, `z` (zod), `createFreshnessState` (only in tests).
- **`noUncheckedIndexedAccess: true`** — `parsed.error.issues[0]` returns `ZodIssue | undefined`. Use `?.` chaining or fall back to a generic message.
- **MCP SDK convention for `q` vs `query` param** — `searchPagesScript`'s envelope (`src/silverbullet/scripts/search-pages.lua.ts:21-25`) reserves `_p.q` because `_p.query` collides with SB's integrated-query DSL keyword. The `search_pages` handler MUST pass `{ q: args.q }`, NOT `{ query: args.q }`. **Pin this in a test (#10) or comment in the handler.**

### Previous story intelligence (from Stories 1.1-1.9)

Distilled patterns to apply:

1. **Top-level `await test(...)`** is the established test pattern (Stories 1.3 / 1.4 / 1.5 / 1.6 / 1.7 / 1.8 / 1.9). Do NOT introduce `describe` blocks.
2. **Factory + closure** is the established stateful-module pattern (`src/audit/audit-logger.ts:230-300`, `src/diagnostic/logger.ts`, `src/freshness/state.ts`). Story 1.10's handlers are FUNCTIONS (not factories) — they consume an injected `HandlerContext` rather than capturing state in closures. The factory pattern surfaces in Story 1.11's `createHandlerContext(...)` composition.
3. **Pure-domain isolation grep** (Story 1.8 lesson) — verify `src/mcp/handlers/` does NOT import the diagnostic-logger `logger` const, `Date.now`, `process.*`, or any module-level singleton from peer handlers.
4. **`assertExhaustive(value: never): never`** — applies in `read_page` if/when an `AccessMode` switch surfaces. Story 1.10 uses `access === 'none'` as the gate; no full `switch` over `AccessMode` is needed. If a future refactor adds one, follow `src/permissions/access-mode.ts:48-53`'s pattern.
5. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../domain/ref.ts'`, `from '../silverbullet/client.ts'`, etc.
6. **No barrel re-exports** (AR57 / `architecture.md:999`). The handler-template.ts re-exports of `formatToolError` + the per-reason constructors are deliberate single-file facades — explicitly NOT barrels (those re-export a directory).
7. **`@ts-expect-error` requires inline justification** (AR59 / `architecture.md:1032`). Avoid altogether — every type narrowing in this story is via zod or structural type guards.
8. **Story 1.5's `void`-return / fire-and-forget pattern for `audit.write`** — directly applicable. The handler's `finally` does `ctx.audit.write(entry);` with NO `await`. ESLint's `no-floating-promises` does NOT trigger because `AuditLogger.write(): void` returns void synchronously.
9. **Story 1.5's `createAuditLogger(options)` factory shape** — Story 1.10 does NOT construct AuditLogger; the handler consumes the already-constructed instance via `ctx.audit`. Story 1.11 wires it.
10. **Story 1.6's `formatToolError` already produces `{ isError: true, content: [{ type: 'text', text }] }`** — Story 1.10's handler-template re-uses it directly. No wrapper.
11. **Story 1.6's `serializeForAudit(error)` returns `{ reason, details, failedOperation? }`** — Story 1.10's `projectOutcome` spreads it on the rejected branch.
12. **Story 1.7's `RuntimeClient.exec<T>` boundary cast** — the caller supplies `T`. Handlers always pass an explicit type parameter: `client.exec<ListPagesResult>(listPagesScript)`, `client.exec<SearchPagesResult>(searchPagesScript, { q })`, `client.exec<ReadPageResult>(readPageScript, { ref })`, `client.exec<QueryConfigBlocksResult>(queryConfigBlocksScript)`. **Never call `client.exec` without the type parameter.**
13. **Story 1.7's `infrastructureError(err)` already scrubs secrets** — the handler's catch arm passes the raw `err` through; no double-scrub needed.
14. **Story 1.8's `parseConfigBlocks` returns `{ blocks, errors }`** — Story 1.10's `fetchConfigBlocks` adapts the field name to `parseErrors` for clarity at the handler call site.
15. **Story 1.8's `resolveAccess(ref, blocks)` is the pure permission engine** — `defaultPermissionEngine.resolve` is a thin wrapper.
16. **Story 1.9's `createFreshnessState` is the pure factory** — handlers consume `ctx.freshness`; the production wiring lives in Story 1.11.
17. **Story 1.9's lesson on `@typescript-eslint/unbound-method`** (`1-9-...md:548`) — do NOT destructure `{ touch, get } = ctx.freshness;` inside the handler. Call through `ctx.freshness.touch(...)` / `ctx.freshness.get(...)`.

### Git intelligence

Recent commits (`git log --oneline -10`):

- `447692f feat(freshness): in-memory bounded state with LRU eviction (story 1.9)`
- `103e063 feat(permissions): access-mode, block parser, engine (story 1.8)`
- `23ba910 feat(silverbullet): runtime client, envelope, lua templates (story 1.7)`
- `e111c8c feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`
- `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`

**Expected commit footprint for this story:** 8 new files (4 source + 4 test), 1 deletion (scaffold.test.ts). Net: +7 files in the working tree. Pack manifest +4 (test files don't ship).

**Conventional Commits gate** (`a867ada`). This story's commit message:

`feat(mcp): read-side handlers (list_pages, search_pages, read_page) (story 1.10)`

### Critical guardrails (do not rediscover)

1. **Exactly-one-audit-entry-per-tool-call** (AR53 / `epics.md:176`, `architecture.md:708-712`). The `finally` block is the only audit-write site in the handler. Writing inside `try` (success path) or duplicating the write across `try` + `catch` is a code-review block. The `outcome` discriminated union is the structural mechanism.

2. **`finally` cannot throw.** If `projectOutcome` or `ctx.audit.write` throws synchronously, the handler's return value is corrupted. Per AR61 fire-and-forget: `audit.write` itself is guaranteed not to throw (Story 1.5's `treatAsErrored` / `serialise` catches every synchronous throw). `projectOutcome` is pure; `serializeForAudit` is pure. Net: `finally` is a safe sink.

3. **Permission gate happens BEFORE freshness check / SB execute.** `parse → permission → freshness → execute → respond` is the architecture-mandated order (`architecture.md:1104`). Story 1.10's read handlers omit the freshness CHECK (read is freshness-update, not freshness-gated) but still gate on permission first.

4. **`ctx.freshness.touch(ref, ctx.clock())` ONLY on successful read** (FR12 / `epics.md:43`, `architecture.md:1077`). NEVER touch on rejection (permission, validation, infrastructure). NEVER touch on `none` (the agent must not learn the page exists).

5. **Audit `response: digest(content)`, NOT raw content** (AR31 / NFR6 / `epics.md:78,146`). The agent gets the body via `formatToolSuccess(content)`; the audit log gets `{ size, sha256 }`. Confusing the two leaks page content to the audit log — DIRECT NFR6 violation.

6. **`none`-mode `read_page` returns `not_found`, NOT `permission_denied`** (FR13 / AR44 / `epics.md:42`, `architecture.md:617-629`). The two errors are deliberately ambiguous so `none` pages stay invisible. The handler MUST NOT call SB for a `none`-mode ref — invisibility includes "no traffic to SB indicating the agent tried".

7. **Default-deny is the resolution algorithm's contract** (AR16 / `epics.md:125`, `src/permissions/engine.ts:161`). A ref unmatched by any block resolves to `'none'`. The handler's filter-on-`!== 'none'` catches both explicit-`none` and unmatched refs.

8. **Defensive ref re-validation** (AR10 / `epics.md:117`, `architecture.md:362-363`). `makeRef(p.ref)` for every ref returned from SB. The cost is one validate-pass per ref; the protection is against a malformed-or-malicious upstream.

9. **`ctx.logger.warn` for malformed `#mcp/config` blocks AND dropped refs** — no audit `config_error` entries in this story. The exactly-one-per-tool-call invariant blocks per-block audit entries; the diagnostic-log warn is the operator surface (AR50 / `architecture.md:677`). Cross-reference deferred-work for the future audit-event mechanism.

10. **Snippet hygiene in `search_pages`** (NFR6 / AR31). Use explicit projection `.map(h => ({ ref: h.ref, score: h.score }))`. Even if `SearchPagesResult` adds `content` / `excerpts` / `matches` in a future revision, the projection drops them. Belt-and-suspenders against snippet leak.

11. **No `console.*`, no `process.stdout.write` outside the MCP SDK** (D7 / AR47 / `architecture.md:646-654`). The handler files import only the diagnostic logger TYPE; the production logger instance arrives via `ctx`. ESLint's `no-console: ['error', { allow: ['error', 'warn'] }]` would catch most accidents, but an inline `console.error('debug', x)` would compile — code review catches.

12. **Top-level catch translates to `infrastructure_error` if-and-only-if the thrown value isn't already a DomainError** (AC7). Wrapping a `freshness_violation` or `permission_denied` from a deeper layer in `infrastructureError(err)` would mask the real reason and bury it under `details.underlying`. The `isDomainError` guard is the structural check.

13. **`ctx.clock()` is the only clock the handler uses.** No `new Date()`, no `Date.now()`. Tests inject a fixed-Date clock; the freshness touch and audit `durationMs` derive from the same clock. **`durationMs` calculation: `ctx.clock().getTime() - startedAt.getTime()`** — `Date - Date` returns a number (millisecond diff) via the `valueOf` coercion, but explicit `.getTime()` is clearer and survives a mock clock that returns a `Date` subclass.

14. **Zod `.strict()` rejects unknown keys.** A future caller passing `{ q: 'kanban', filter: 'archived' }` to `search_pages` gets a `validation_error` with the offending key listed. The MCP spec convention is permissive shapes, but our trust model prefers strict — extraneous fields are a sign of agent misconfiguration. Document in the schema comment.

15. **`Date - Date` calculation uses `.getTime()`** — `valueOf()` coercion is permitted but `@typescript-eslint/restrict-plus-operands` (if enabled — currently not) would flag. Use `.getTime()` for clarity.

16. **`@typescript-eslint/no-explicit-any` is enforced** (`eslint.config.js:21`). The `catch (err)` parameter is implicit-`unknown` (TS strict catch). The narrowing pattern is `if (isDomainError(err))` / `infrastructureError(err)` — no `as any`.

17. **`@typescript-eslint/unbound-method` warning** (Story 1.9's lesson, `1-9-...md:548`). Do NOT destructure `{ touch, get } = ctx.freshness;` inside the handler. Always call through `ctx.freshness.touch(...)` / `ctx.freshness.get(...)`.

18. **`isolatedModules: true`** — every file is independently parseable. Re-exports use `export { ... } from '...'` syntax. `export type { ... } from '...'` is required for type-only re-exports.

19. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../domain/ref.ts'`.

20. **Test file naming:** `<unit>.test.ts` adjacent to `<unit>.ts` for unit tests (handler-template). Excluded from pack via `package.json:15`'s `"!src/**/*.test.ts"`. Integration tests live under `tests/integration/` and are excluded from pack by being outside `src/**/*.ts`.

21. **`HandlerContext` injection: every dep arrives via `ctx`.** No module-level singleton reaches inside a handler body. The handler does NOT import the production `logger` const, the production `audit` instance, the production `freshness` Map, or `Date.now`. Tests verify by inspecting the imports.

22. **Snippets / excerpts MUST NEVER appear in `search_pages` audit `response`** (NFR6 / AR31 / AC4 / AC8 #17). Even a future `SearchPagesResult` upgrade that adds `content` is structurally dropped by the explicit `.map(h => ({ ref: h.ref, score: h.score }))` projection.

23. **`HandlerContext.permissionEngine` is an OBJECT with a `resolve` method, NOT a free function.** Architecture's example uses `ctx.permissionEngine.resolve(ref, blocks)`. The wrapper is `defaultPermissionEngine = { resolve: resolveAccess }`. Tests inject hand-rolled stubs `{ resolve: (ref) => modeMap.get(ref) ?? 'none' }`.

### Story scope boundaries (DO NOT include)

- **The `append_to_page` handler** — Story 2.2 (FR14-FR16). Freshness-exempt, but still permission-gated.
- **The `edit_page` / `create_page` / `delete_page` handlers** — Stories 2.3-2.5.
- **`pageMetaScript` consumption** — Story 2.3's `edit_page` handler (`src/silverbullet/scripts/page-meta.lua.ts` is already shipped from Story 1.7 but this story does not call it).
- **The MCP SDK `registerTool` wiring** — Story 1.11's `src/mcp/registry.ts`.
- **The startup ladder** — Story 1.11's `src/index.ts` rewrite (current stub at `src/index.ts:5` stays as-is for this story).
- **Real `RuntimeClient` instance / real `AuditLogger` instance / real `FreshnessState` instance / real `Logger` instance composition** — all wired in Story 1.11's `createHandlerContext` factory.
- **Per-block `config_error` audit entries for malformed `#mcp/config` blocks** — `architecture.md:274` envisions per-block audit entries, but the exactly-one-per-tool-call invariant (AR53) blocks this. A separate "audit-events for non-tool-call surfaces" mechanism is required and is out of scope for Story 1.10. Story 1.10 emits `ctx.logger.warn(...)` per call; that's the operator-visible surface for now.
- **`not_found` translation for SB-side absent pages** (genuinely missing, not `none`-mode) — currently surfaces as `infrastructure_error` because the SB Lua surface raises a generic error on missing-page reads. Heuristic message-match on the underlying Lua error string is brittle. Deferred until SB exposes a typed absence error or a startup probe surfaces the gap.
- **Caching of `#mcp/config` blocks across calls** — D2 explicitly states "no cache" (`architecture.md:278-288`). Adding an ETag / TTL cache is a Growth concern, deferred until the latency baseline justifies it.
- **A startup health check that the silversearch plug is installed** — Story 1.11 territory (existing entry in `deferred-work.md`).
- **HTTP/SSE transport** — Growth (PRD).
- **A `forget(ref)` or `clear()` method on `FreshnessState`** — Story 1.9's scope-boundaries already deferred; cross-reference for Story 2.5 (`delete_page` success case).
- **Property-based testing of the search-page filter** — restricted to the edit-batch validator (`architecture.md:1161`, Story 2.1).
- **Documentation of the read-side tools** — Story 1.13 (`README.md`, `docs/permissions.md`, `docs/audit-log.md` worked examples).
- **A `_helpers.ts` module under `tests/integration/` consolidating mock client / mock audit / mock logger factories** — defer until Stories 2.x duplicate the helpers across more handler-test files. Story 1.10 inlines per file.
- **An MCP-SDK-shape adapter (`adaptToCallToolResult(ToolResult): CallToolResult`)** — the union is structurally compatible with the SDK's `CallToolResult` shape (verified at story-1.11 implementation time). If a mismatch surfaces, that story owns the adapter, not 1.10.
- **A `void` return type test for `audit.write` to assert fire-and-forget** — Story 1.5 already pins this; no need to re-verify in 1.10.

### Deferred-from-this-story candidates (proposed deferred-work entries — review post-implementation)

Append to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands, IF they feel real after the implementation pass:

1. **`not_found` translation for SB-side absent pages** — SB's `space.readPage(ref)` raises a generic Lua error when a page doesn't exist; the runtime client surfaces this as `infrastructure_error`. FR13 conflates `none`-mode and missing pages; the handler currently distinguishes them (none → not_found, missing → infrastructure_error). Heuristic message-match in the handler's catch arm could translate "page not found" / similar Lua-error messages into `not_found`, but the upstream contract is brittle. Revisit when SB exposes a typed absence error or a startup probe verifies the contract.

2. **Per-call `config_error` audit entries for malformed `#mcp/config` blocks** — `architecture.md:274` aspirationally records per-block parse errors in the audit log; the exactly-one-per-tool-call invariant (AR53) blocks this. A separate "audit-events for non-tool-call surfaces" mechanism is required (perhaps a parallel "operator audit" channel). Story 1.10 emits `ctx.logger.warn(...)` per call; that's the operator surface for now. Revisit when an operator reports needing config-error forensics in the audit log.

3. **A `_helpers.ts` shared mock factory for `tests/integration/`** — once Stories 2.x handler tests duplicate the inline mocks 5+ times, extract to a shared helper. Premature now.

4. **Adapter from `ToolResult` to `@modelcontextprotocol/sdk`'s `CallToolResult`** — if Story 1.11's wiring surfaces a structural mismatch, a small adapter lands there. Currently the union shapes are structurally identical.

5. **A startup-time probe that `silversearch` plug is installed** — already in `deferred-work.md` from Story 1.7. Re-affirm for Story 1.11; if a `search_pages` call in production fails with `attempt to index a nil value`, the handler currently returns `infrastructure_error` (correct, but operationally opaque). A Story 1.11 startup probe that fails fast with "missing prerequisite: silversearch plug" is a better operator experience.

6. **JSON-rendering of complex results** — for `list_pages` / `search_pages`, the response is `JSON.stringify({ pages: [...] })` inside a single text-content block. A future MCP SDK upgrade may support structured tool results (multiple content blocks, JSON content type). Revisit when the SDK ships such a feature; Story 1.10 ships the conservative single-text shape.

7. **A test that verifies `defaultPermissionEngine` parity with `resolveAccess` over the full permission-engine fixture set** — adjacent unit test (#33) covers the trivial wrapper; the full fixture set lives in `src/permissions/engine.test.ts` already. Adding a property-based parity test is overkill; revisit only if the wrapper grows beyond a one-liner.

8. **Bounded-size policy for the `Logger.warn` line on dropped refs / malformed blocks** — currently a long pre-filter list could produce a multi-KB warn line. The diagnostic logger sanitizes `\n` / `\r` to escapes (`src/diagnostic/logger.ts:24-29`); the line is single-record. If a real deployment surfaces > 100 dropped refs / call, batch the warn line to a count + sample.

### Project Structure Notes

- **Alignment with unified project structure:** `src/mcp/` matches the architecture's `src/` tree (`architecture.md:978-988`, `1287-1297`) one-to-one. The architecture lists 7 handler files (`read-page.ts`, `append-to-page.ts`, `edit-page.ts`, `create-page.ts`, `delete-page.ts`, `list-pages.ts`, `search-pages.ts`) plus `registry.ts` plus `handler-template.ts`. Story 1.10 ships 3 handlers + handler-template; the remaining 4 land in Stories 2.x; `registry.ts` lands in Story 1.11.
- **Detected variances:** none. The `src/mcp/` directory has been an empty placeholder (with an empty `handlers/` subdirectory) since Story 1.1's scaffold (`epics.md:298`); this story populates it with the first three handlers and the canonical template.
- **No `index.ts` re-export barrel** under `src/mcp/` or `src/mcp/handlers/` (AR57 / `architecture.md:999`). Story 1.11's `registry.ts` imports each handler by file directly: `import { handleReadPage } from './handlers/read-page.ts';` etc.
- **MCP-layer is a boundary module, NOT pure-domain core** (AR58 / `epics.md:183`). The `src/mcp/` directory imports from boundary modules (`silverbullet/`, `audit/`, `diagnostic/`) AND pure-domain modules (`domain/`, `permissions/`, `freshness/`). This is the architecture-permitted direction; pure-domain modules MUST NOT import from `src/mcp/` (verified by the existing acyclic dependency rule in Story 1.9's verification grep).
- **The `tests/integration/` location** for handler tests is the architecture's mandated shape for "multi-module tests" (`architecture.md:740-743,989-992`). Adjacent unit tests (handler-template) follow the "tests adjacent to the unit they test" rule.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.10] (lines 557-603)
- Tool-handler shape (the load-bearing pattern this story implements): [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1041-1108)
- Mandatory rules summary: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1167-1180)
- Anti-patterns explicitly forbidden: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1182-1193)
- Cross-component dependency map: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 830-844)
- Implementation sequence (this story = #11): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 823)
- D6 — error response structure (the `formatToolError` contract): [Source: _bmad-output/planning-artifacts/architecture.md#D6] (lines 533-641)
- D4 — audit log: [Source: _bmad-output/planning-artifacts/architecture.md#D4] (lines 386-468)
- D7 — stream discipline (`ctx.logger`): [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- D2 — freshness invariant locus: [Source: _bmad-output/planning-artifacts/architecture.md#D2] (lines 418-432)
- D1 — permission declaration mechanism: [Source: _bmad-output/planning-artifacts/architecture.md#D1] (lines 205-276)
- Source-tree contract for `src/mcp/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 978-988, 1287-1297)
- Naming conventions (`PascalCase` types, `camelCase` functions, `kebab-case.ts` files, `snake_case` MCP tool names): [Source: _bmad-output/planning-artifacts/architecture.md#Naming] (lines 882-928)
- Type-safety patterns (no `any`, `as` only at boundaries): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1002-1034)
- Stateful-module testing pattern (mocked-client at the seam): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1156-1165)
- Architectural boundaries (`src/mcp/` is a boundary module): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1300-1337)
- AR10 — `Ref` validation at every MCP arg boundary: [Source: _bmad-output/planning-artifacts/epics.md] (line 117)
- AR12 — pure permission engine: [Source: _bmad-output/planning-artifacts/epics.md] (line 120)
- AR16 — most-specific wins, most-permissive ties: [Source: _bmad-output/planning-artifacts/epics.md] (line 125)
- AR17 — malformed-block fail-closed (NFR11): [Source: _bmad-output/planning-artifacts/epics.md] (line 126)
- AR21 — minimal in-tree client; only network-touching module: [Source: _bmad-output/planning-artifacts/epics.md] (line 134)
- AR22 — base64+JSON envelope: [Source: _bmad-output/planning-artifacts/epics.md] (line 135)
- AR23 — one `.lua.ts` file per Lua template: [Source: _bmad-output/planning-artifacts/epics.md] (line 136)
- AR29 — audit schema v1 required fields: [Source: _bmad-output/planning-artifacts/epics.md] (line 144)
- AR31 — verbosity policy: agent intent in full, user-space content digested: [Source: _bmad-output/planning-artifacts/epics.md] (line 146)
- AR42 — single internal `DomainError` type, two projections: [Source: _bmad-output/planning-artifacts/epics.md] (line 161)
- AR43 — MCP error responses returned as text block via `content`: [Source: _bmad-output/planning-artifacts/epics.md] (line 162)
- AR44 — per-reason recovery template; `not_found` deliberately ambiguous with `permission_denied` for `none` per FR13: [Source: _bmad-output/planning-artifacts/epics.md] (line 163)
- AR45 — information-leak rules in the formatter: [Source: _bmad-output/planning-artifacts/epics.md] (line 164)
- AR47 — stdout reserved for MCP JSON-RPC traffic only; ESLint `no-console`: [Source: _bmad-output/planning-artifacts/epics.md] (line 168)
- AR50 — diagnostic log captures malformed `#mcp/config` blocks: [Source: _bmad-output/planning-artifacts/epics.md] (line 171)
- AR53 — every MCP tool handler follows the same shape; exactly-one audit entry per call: [Source: _bmad-output/planning-artifacts/epics.md] (line 176)
- AR54 — canonical `handler-template.ts` defines `HandlerContext` and helpers: [Source: _bmad-output/planning-artifacts/epics.md] (line 177)
- AR55 — naming: `kebab-case.ts` files, `snake_case` MCP tool names: [Source: _bmad-output/planning-artifacts/epics.md] (line 179)
- AR57 — no barrel files: [Source: _bmad-output/planning-artifacts/epics.md] (line 182)
- AR58 — acyclic dependency rule: [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 — no `any`, `as` outside boundary constructors, no `@ts-ignore` without justification: [Source: _bmad-output/planning-artifacts/epics.md] (line 186)
- AR60 — discriminated unions use `type` as discriminant: [Source: _bmad-output/planning-artifacts/epics.md] (line 187)
- AR61 — async patterns: `void someAsync()` only with inline justification (audit-write is the sanctioned exception): [Source: _bmad-output/planning-artifacts/epics.md] (line 188)
- NFR4 — bounded memory: [Source: _bmad-output/planning-artifacts/epics.md] (line 74)
- NFR6 — no `none`-content in audit; names yes, content no: [Source: _bmad-output/planning-artifacts/epics.md] (line 78)
- NFR8 — no internal state via MCP surface: [Source: _bmad-output/planning-artifacts/epics.md] (line 80)
- NFR11 — fail-closed permission engine: [Source: _bmad-output/planning-artifacts/epics.md] (line 85)
- NFR12 — per-call failure does not poison the session: [Source: _bmad-output/planning-artifacts/epics.md] (line 86)
- NFR16 — versioned audit schema: [Source: _bmad-output/planning-artifacts/epics.md] (line 94)
- NFR17 — non-blocking audit on tool-call path: [Source: _bmad-output/planning-artifacts/epics.md] (line 95)
- NFR21 — offline test suite: [Source: _bmad-output/planning-artifacts/epics.md] (line 101)
- FR8 / FR9 / FR10 — `none`-mode invisibility on common paths: [Source: _bmad-output/planning-artifacts/epics.md] (lines 34-36)
- FR11 / FR12 / FR13 — read semantics + freshness touch + invisible-not-blocked: [Source: _bmad-output/planning-artifacts/epics.md] (lines 41-43)
- FR26 — every rejection returns a structured, actionable error: [Source: _bmad-output/planning-artifacts/epics.md] (line 62)
- PRD §State & Session Model: [Source: _bmad-output/planning-artifacts/prd.md] (lines 416-429)
- PRD §Implementation Considerations / SB client: [Source: _bmad-output/planning-artifacts/prd.md] (lines 442-448)
- Existing `RuntimeClient` interface: [Source: src/silverbullet/client.ts] (lines 70-74)
- Existing `RuntimeErrorCode` constants: [Source: src/silverbullet/client.ts] (lines 29-40)
- Existing `listPagesScript` + `ListPagesResult`: [Source: src/silverbullet/scripts/list-pages.lua.ts] (lines 9-43)
- Existing `searchPagesScript` + `SearchPagesResult`: [Source: src/silverbullet/scripts/search-pages.lua.ts] (lines 9-60)
- Existing `readPageScript` + `ReadPageResult`: [Source: src/silverbullet/scripts/read-page.lua.ts] (lines 10-42)
- Existing `queryConfigBlocksScript` + `QueryConfigBlocksResult`: [Source: src/silverbullet/scripts/query-config-blocks.lua.ts] (lines 11-49)
- Existing `resolveAccess` permission engine: [Source: src/permissions/engine.ts] (lines 120-167)
- Existing `parseConfigBlocks` raw-row widener: [Source: src/permissions/config-block-parser.ts] (lines 96-167)
- Existing `AccessMode` + `accessRank` + `permits`: [Source: src/permissions/access-mode.ts] (lines 18-122)
- Existing `FreshnessState` factory: [Source: src/freshness/state.ts] (lines 19-87)
- Existing `AuditLogger` factory + `AuditEntryInput`: [Source: src/audit/audit-logger.ts] (lines 20-23, 320-482)
- Existing `digest`: [Source: src/audit/digest.ts] (lines 27-32)
- Existing `Logger` interface + `createLogger`: [Source: src/diagnostic/logger.ts] (lines 15-93)
- Existing `DomainError` + per-reason constructors + `formatToolError` + `serializeForAudit`: [Source: src/domain/error.ts] (lines 14-575)
- Existing `MCPToolResult` shape (handler-template generalises it): [Source: src/domain/error.ts] (lines 75-78)
- Existing `Ref` + `makeRef` + `RefValidationError`: [Source: src/domain/ref.ts] (lines 8-122)
- Existing scaffold integration test (to be deleted): [Source: tests/integration/scaffold.test.ts] (lines 1-5)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-9-freshness-state-module.md], [Source: _bmad-output/implementation-artifacts/1-8-permission-engine-and-mcp-config-block-parser.md], [Source: _bmad-output/implementation-artifacts/1-7-silverbullet-runtime-client-and-latency-baseline.md], [Source: _bmad-output/implementation-artifacts/1-6-domainerror-formatter-and-audit-serializer.md], [Source: _bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Transient typecheck flake on first run** — `tsc --noEmit` initially reported `Cannot find module './state.ts'` for `src/freshness/state.test.ts:6` even though the file exists. Re-running `npm run typecheck` immediately afterwards returned clean. Likely an LSP / project-service cache hiccup; not reproducible. No code change.
- **`@typescript-eslint/no-unnecessary-type-assertion` on integration test mocks** — Initial test files used `as QueryConfigBlocksResult` / `as ListPagesResult` etc. on the script-handler return literals. The Map type `Map<string, ScriptHandler<unknown>>` widens the lambda return to `unknown` anyway, so the inner cast added no narrowing the next assertion didn't already do. Stripped via a one-shot `node --eval` regex pass; the type-erased imports were then removed.
- **`@typescript-eslint/only-throw-error` on test-side `throw boom`** — `boom = infrastructureError(new Error(...))` produces a plain `DomainError` object literal (not Error subclass). The runtime client (`src/silverbullet/client.ts:1-11`) has the same pattern with a top-level eslint-disable; mirrored in `src/mcp/handler-template.test.ts` with a justifying comment.
- **`@typescript-eslint/no-unnecessary-type-assertion` on `r as string`** in `list-pages.ts` and `h.ref as string` in `search-pages.ts` — `Ref` extends `string` via the brand, so the cast was a no-op the lint rightly flagged. Replaced with `[...visibleRefs]` (drops the brand structurally via the array spread + the explicit `string[]` annotation) and an explicit `Array<{ ref: string; score: number }>` annotation on the `.map(...)` result.
- **`@typescript-eslint/require-await` on async arrows without `await`** in handler-template.test.ts — Three mock client builders used `async () => { ... }` without an `await` because they returned synchronously. Restructured to plain `() => ...` returning Promises explicitly via `Promise.resolve(...)` or by throwing.
- **Test count delta:** baseline 392 (post-1.9) → 439 (post-1.10) = +47 net new cases (16 handler-template + 9 list + 9 search + 14 read = 48 new, minus 1 deleted scaffold). Above the AC9 floor of +34.
- **Pack manifest verification:** `npm pack --dry-run 2>&1 | tail -1` confirms `total files: 28`, matching AC9 (24 baseline + 4 new source files: handler-template.ts, handlers/{list,search,read}-pages.ts; all `*.test.ts` excluded by `package.json:15`'s `"!src/**/*.test.ts"` allowlist negation; integration tests live outside `src/**/*.ts`).
- **Module-isolation greps green:**
  - `grep -rE "console\.(log|info|debug)" src/mcp/` → zero output.
  - `grep -rE "process\.stdout\.write" src/mcp/` → zero output.
  - `grep -rE "Date\.now\(\)|performance\.now\(\)|new Date\(\)" src/mcp/` → zero output (handlers use `ctx.clock()` exclusively).
  - `grep -rE "from '\.\./diagnostic/logger\.ts'" src/mcp/` → ONLY a type-only `import type { Logger }` in handler-template.ts (no `import { logger }` value import).
  - `grep -E "content|excerpts|matches" src/mcp/handlers/search-pages.ts` → only JSDoc / comment matches; no `h.content` / `h.excerpts` / `h.matches` property access (NFR6 snippet hygiene preserved).

### Completion Notes List

- ✅ AC1: `src/mcp/handler-template.ts` exports `HandlerContext`, `PermissionEngine`, `ToolResult`, `AuditOutcome`, `AuditOutcomeProjection`, `defaultPermissionEngine` (frozen), `formatToolSuccess`, `fetchConfigBlocks`, `projectOutcome`, `isDomainError`, `summarizeParseErrors`, plus single-file-facade re-exports of `formatToolError` and the per-reason error constructors from `domain/error.ts`. The re-export pattern is documented in the file header as deliberate (NOT an AR57-forbidden barrel).
- ✅ AC2: All three handlers follow the canonical try/catch/finally shape — top-level `outcome` declared before the try; `try` populates `outcome` on every successful exit and validation/permission rejection path; `catch` translates non-DomainError throws via `infrastructureError`, then logs `ctx.logger.error('<tool> handler crashed', err)`; `finally` writes EXACTLY one audit entry via `projectOutcome(outcome)` with conditional spread for optional fields (under `exactOptionalPropertyTypes: true`). No module-level singletons reachable from handler bodies — verified by isolation greps.
- ✅ AC3: `handleListPages` parses `{}` strict, fetches blocks, runs `listPagesScript`, defensively re-validates each ref via `makeRef` (drops + warns on `RefValidationError`), filters `none`-mode refs, returns `formatToolSuccess(JSON.stringify({ pages }))`. Audit response is the visible-ref array; pre-filter list never written.
- ✅ AC4: `handleSearchPages` parses `{ q: string.min(1) }` strict, fetches blocks, runs `searchPagesScript` with envelope `{ q }` (NOT `{ query }` — pinned by integration test #10), filters `none`-mode hits, projects to `{ ref, score }` ONLY (snippet hygiene — pinned by integration test #17 even when SearchPagesResult is cast to inject rogue `content` / `excerpts` / `matches` fields).
- ✅ AC5: `handleReadPage` parses `{ ref: string.min(1) }` strict, brands via `makeRef`, fetches blocks, resolves access. On `'read' | 'append' | 'write'` calls `readPageScript`, then `ctx.freshness.touch(ref, ctx.clock())` — the freshness `at` is the agent's clock (NOT SB's `lastModified`, pinned by integration test #13). Audit response is `digest(content)` — `{ size, sha256 }` — never raw body. Verified UTF-8 byte-length semantics with `'café'` → `size: 5` (test #12).
- ✅ AC6: `none`-mode `read_page` short-circuits to `notFoundError(ref)` — no SB call (assert-mock-call-count zero), no freshness touch. Validation errors (missing/empty/extraneous-field/non-string ref + RefValidationError) all reject without any SB call and without `ref` field on the DomainError when no valid Ref existed.
- ✅ AC7: Top-level catch arm uses `isDomainError` structural test to distinguish "client already threw a DomainError" (pass through) from "unexpected throw" (wrap with `infrastructureError`). NFR12 sequencing pinned by read-page integration test #14: a thrown SB error in call N does not poison call N+1; both produce exactly one audit entry; the second succeeds end-to-end.
- ✅ AC8: 48 new test cases shipped (≥ 35 floor): handler-template adjacent unit tests = 16 (covering defaultPermissionEngine parity, formatToolSuccess shape, formatToolError delegation, projectOutcome both arms, isDomainError positive + negative, fetchConfigBlocks happy/parseErrors/rejection-propagation, summarizeParseErrors three cases). Integration: list-pages = 9, search-pages = 9, read-page = 14. All use top-level `await test(...)` (no `describe` blocks) and fixed-millisecond `Date` literals.
- ✅ AC9: All four gates green: `npm run typecheck` (exit 0), `npm run lint -- --max-warnings=0` (exit 0), `npx prettier --check .` (exit 0), `npm test` (439 / 439 passing). Pack manifest = 28 files exactly. `tests/integration/scaffold.test.ts` deleted as authorised by its own comment. No other source file changed; no new dependencies.
- **Test-count delta:** 392 → 439 (+47 net; +48 new cases minus 1 deleted scaffold case).
- **Snippet-hygiene pin:** `search_pages` test #17 injects rogue `content`/`excerpts`/`matches` fields via `as unknown as SearchPagesResult` (hand-rolled cast in the test) and asserts they NEVER reach the response or audit projection. The handler's explicit `.map(h => ({ ref: h.ref, score: h.score }))` is what makes this safe; the test pins the contract so a future "spread-instead-of-project" PR is a deliberate decision, not an accidental NFR6 leak.
- **Single-file facade vs barrel:** the handler-template re-exports `formatToolError` + the per-reason constructors from `domain/error.ts` per AC1. Documented in the file header as a deliberate single-file API surface, NOT an AR57-forbidden directory barrel. AR57's prohibition is on `index.ts` files that re-export an entire directory; a single file with explicit `export { foo } from '...'` lines is convention.

### File List

**NEW:**

- `src/mcp/handler-template.ts`
- `src/mcp/handler-template.test.ts`
- `src/mcp/handlers/list-pages.ts`
- `src/mcp/handlers/search-pages.ts`
- `src/mcp/handlers/read-page.ts`
- `tests/integration/handler-list-pages.test.ts`
- `tests/integration/handler-search-pages.test.ts`
- `tests/integration/handler-read-page.test.ts`

**MODIFIED:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.10 status transitions (backlog → ready-for-dev → in-progress → review).
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended 7 new entries from Story 1.10 dev pass.

**DELETED:**

- `tests/integration/scaffold.test.ts` — superseded by the three new handler integration tests; the file's own comment explicitly authorised the deletion at this story.

### Change Log

| Date       | Change                                                                                  | Files                                  |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| 2026-05-01 | feat(mcp): read-side handlers (list_pages, search_pages, read_page) (story 1.10)         | `src/mcp/**`, `tests/integration/**`   |
