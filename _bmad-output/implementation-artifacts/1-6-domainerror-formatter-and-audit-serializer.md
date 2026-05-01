# Story 1.6: `DomainError`, Formatter & Audit Serializer

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an MCP-using agent receiving an error,
I want every rejected operation to return a structured human-readable text block with category, context, and explicit recovery instructions,
so that I (the agent) can recover automatically — and Maya can correlate the same rejection in the audit log.

## Acceptance Criteria

**AC1 — Closed `ReasonCode` enum at `src/domain/error.ts` matches AR30 / D6 verbatim**

**Given** the domain error module at `src/domain/error.ts`,
**When** I import its public surface,
**Then** it exports `type ReasonCode` as a string literal union containing **exactly six** values, in this order:
- `'permission_denied'`
- `'freshness_violation'`
- `'validation_error'`
- `'infrastructure_error'`
- `'config_error'`
- `'not_found'`

**And** it exports `const REASON_CODES: ReadonlyArray<ReasonCode>` listing the same six values in the same order — runtime-iterable for tests and for the per-reason recovery-template lookup table.

**And** changing this set requires bumping `AUDIT_SCHEMA_VERSION` per NFR16 / AR30 / `epics.md:145`. The JSDoc on `ReasonCode` says so explicitly.

**And** the values match the audit log's `reason` field domain exactly (`architecture.md:548-555`, `epics.md:145`). `serializeForAudit` (AC5) emits these strings verbatim into `AuditEntry.reason`.

**AC2 — Canonical `DomainError` shape at `src/domain/error.ts` per D6**

**Given** the same module,
**When** I import `DomainError`,
**Then** it is the type:
```typescript
export type DomainError = {
  readonly reason: ReasonCode;
  readonly ref?: Ref;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failedOperation?: {
    readonly index: number;
    readonly operation: object;
  };
};
```
exactly per `architecture.md:537-555`.

**And** `details` is **required** — `Readonly<Record<string, unknown>>`. Every `DomainError` carries a (possibly empty) `details` object. This honours the architecture spec ("`details: Record<string, unknown>` — reason-specific structured context") and makes the audit serializer's projection unambiguous.

**And** `ref` is optional and typed `Ref` (imported from `./ref.ts`). Used for permission/freshness/validation/not_found errors that name a page; `infrastructure_error` may omit it.

**And** `failedOperation` is optional and present **only** for batch errors per AR46 / `epics.md:165`. Its shape is locked: `{ index: number; operation: object }` — the 0-based index into `args.edits` and the offending edit object verbatim.

**And** the placeholder `DomainError` shape currently at `src/domain/error.ts:9-12` (`{ reason: string; message: string }`) is **replaced** by this canonical shape. Story 1.4's `ConfigError` is reconciled in AC8.

**AC3 — Per-reason error constructors emit valid `DomainError` values**

**Given** the same module,
**When** I import the per-reason constructors,
**Then** the following named exports exist with these signatures and produce `DomainError` values whose `reason` is the matching `ReasonCode`:

```typescript
export function permissionDeniedError(ref: Ref, required: string, granted: string): DomainError;
export function freshnessViolationError(
  ref: Ref,
  lastModified: Date,
  lastReadAt: Date | undefined,
): DomainError;
export function validationError(opts: {
  ref?: Ref;
  failure: string;
  failedOperation?: { index: number; operation: object; total?: number };
}): DomainError;
export function infrastructureError(err: unknown, ref?: Ref): DomainError;
export function configError(opts: {
  variable: string;
  rule: string;
  message: string;
}): DomainError;
export function notFoundError(ref: Ref): DomainError;
```

**And** each constructor populates `details` with reason-specific context as documented in the per-reason format below (AC4):

| Constructor | `details` shape |
|---|---|
| `permissionDeniedError(ref, required, granted)` | `{ required, granted }` |
| `freshnessViolationError(ref, lastModified, lastReadAt)` | `{ lastModified: lastModified.toISOString(), lastReadAt: lastReadAt?.toISOString() ?? null }` |
| `validationError({ ref, failure, failedOperation })` | `{ failure }` (plus `totalEdits` when `failedOperation.total` is supplied) |
| `infrastructureError(err, ref?)` | `{ underlying: <scrubbed-message>, code?: <scrubbed-error-code> }` (full scrub via AC4) |
| `configError({ variable, rule, message })` | `{ variable, rule, message }` |
| `notFoundError(ref)` | `{}` (deliberately bare per AR45 #2 / `architecture.md:634` — `not_found` carries no body) |

**And** `permissionDeniedError`'s `required` / `granted` parameters are typed `string` (NOT a closed `AccessMode` union) for forward-compatibility with Story 1.8's `AccessMode` union (`architecture.md:1023`, `epics.md:521`). Story 1.8 will tighten by re-typing these parameters once `permissions/access-mode.ts` lands. **Do NOT pre-emptively define `AccessMode` in `src/domain/error.ts`** — the architecture's source-tree contract puts it under `permissions/` (`architecture.md:1261`), and creating a stub here would force a moved-export refactor in 1.8.

**And** `freshnessViolationError`'s `lastReadAt` is `Date | undefined`, not optional-via-`?:`. The constructor coerces `undefined` → `null` inside `details.lastReadAt` so the JSON projection stays explicit (D4 / AR29: optional-via-omission applies to top-level audit fields only; nested `details` shape is reason-specific and may use `null`). The renderer (AC4) treats `null` as "never read" in the human-readable text.

**And** `infrastructureError`'s first argument is `unknown` — handlers' top-level catch hands the caught value verbatim. The constructor extracts a clean message via `err instanceof Error ? err.message : String(err)`, then runs the secret-scrubber over the entire underlying value (AC4) before storing the scrubbed projection in `details`. **Stack traces never enter `details`** (AR45 #4 / `architecture.md:636`); they go to the diagnostic logger via the handler's catch block (Story 1.10's responsibility, not this story's).

**And** the constructors are **pure**: no I/O, no clock reads (the caller passes `Date` instances), no global state. AR58 / `epics.md:183` (pure-domain core).

**AC4 — Centralized `scrubSecrets(value)` removes sensitive fields recursively**

**Given** the centralized scrubber at `src/domain/error.ts`,
**When** I import its public surface,
**Then** `function scrubSecrets(value: unknown): unknown` is exported.

**And** when called on any value, it returns a **new** value (never mutates the input — AR58 pure-domain) where:
- Plain object keys whose name (case-insensitive ASCII compare) matches any of `'authorization'`, `'token'`, `'apikey'`, `'secret'`, `'password'` are replaced with the literal string `'***redacted***'`. AR45 #1 / `architecture.md:633`.
- The match is **whole-key, not substring** — `'mytoken'` is NOT scrubbed; `'Token'` IS. The five names form a closed list (`epics.md:451`).
- Recursion enters every plain-object value and every array element. Stops at non-plain types (`Date`, `Map`, `Set`, `Buffer`, `Error`, class instances) — those are returned via `String(...)` rendering (or `err.message` for `Error`) so a thrown stack trace cannot smuggle a token through. **Tests assert this with adversarial fixtures.**
- `null` and `undefined` are returned as-is.
- Strings, numbers, booleans, bigints are returned as-is — the scrubber is a structural filter, not a content scanner. (Detecting tokens **inside** strings is out of scope; the architecture mandates structural scrubbing only — `architecture.md:633` "fields named token / apiKey / secret / password".)
- Cycles do not crash the scrubber. Implementation: track visited objects in a `WeakSet`; on revisit, return the literal string `'<cycle>'`. AC9 includes a self-referential-object fixture.

**And** the scrubber recognises the case-insensitive variants `'Authorization'` / `'AUTHORIZATION'` / `'authorization'`, `'Token'` / `'TOKEN'` / `'token'`, etc. — HTTP libraries (and the eventual `RuntimeClient` in Story 1.7) use mixed casing. `architecture.md:633`'s example explicitly cites `Authorization` (header-case).

**And** the scrubbed output is `JSON.stringify`-safe — any non-plain value that survived the recursion is rendered to a string before being stored, so the audit-projection's `details` field always serialises (no circular refs, no Date objects, no class instances). Verified by AC9's golden-input round-trip test.

**And** when wrapping `Error` instances (the common case for `infrastructureError`), the scrubber extracts `{ name, message, code? }` (where `code` is from the Node `'EACCES'`-style errno on `NodeJS.ErrnoException`, present on `fs.*` errors) and runs the resulting plain object through the same scrubber. The original `err.stack` is **never** included — AR45 #4. The original `err.cause`, `err.errors` (AggregateError), and other non-standard fields are also **never** included.

**AC5 — `formatToolError(error)` renders the per-reason text block per D6**

**Given** the formatter at `src/domain/error.ts`,
**When** I import its public surface,
**Then** `function formatToolError(error: DomainError): MCPToolResult` is exported, where `MCPToolResult` is the local type:
```typescript
export type MCPToolResult = {
  readonly isError: true;
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
};
```
**Note:** the `@modelcontextprotocol/sdk` dependency is NOT yet installed (Story 1.10 / 1.11 lands the wiring). The local `MCPToolResult` type matches the SDK's shape narrowly enough that Story 1.10 can `satisfies` against it without a re-type. Do NOT add an SDK dependency in this story.

**And** the returned object's `isError` is the literal `true` — agent runtime relies on this to surface the error to the LLM (`architecture.md:560`, AR43 / `epics.md:162`).

**And** the returned object has exactly **one** `content` block, of type `'text'`. The architecture mandates a single text block via `content` (NOT `_meta`) so the LLM sees the recovery instructions (`architecture.md:562-566`, AR43).

**And** the text block's `text` field follows this exact structure for each `ReasonCode`, with literal strings as specified:

**`permission_denied`:**
```
Operation rejected — permission denied.

Page: <ref>
Required: <required>
Granted: <granted>

To recover: this page is not accessible to you. Choose a different page or ask the user to update its access mode.
```

**`freshness_violation`:**
```
Edit rejected — page has changed since last read.

Page: <ref>
Last modified: <iso>
Last read by you: <iso or "never">

To recover: call read_page("<ref>") to refresh, then retry your edit with the updated content in mind.
```
**Note:** the substring `call read_page(<ref>) to refresh, then retry` (with the literal placeholder syntax substituted for the actual ref) MUST appear verbatim. Tests assert this with `assert.match(text, /call read_page\("[^"]+"\) to refresh, then retry/)` (AC2 of epic spec, `epics.md:445`). The recovery line uses double-quotes around the ref (matching D6's worked example at `architecture.md:581`).

**`validation_error`** (single, non-batch — `failedOperation` absent):
```
Operation rejected — input validation failed.

Page: <ref>            ← omitted entirely if details.ref is absent
Failure: <failure>

To recover: verify your input matches the tool's argument schema, then retry.
```

**`validation_error`** (batch — `failedOperation` present):
```
Edit batch rejected — operation <index+1>[ of <total>] failed.

Page: <ref>
Failed operation: <op-summary>
Failure: <failure>

To recover: call read_page("<ref>") to verify current content, then submit a corrected batch. No partial changes were applied.
```
- `<index+1>` renders the 0-based `failedOperation.index` as a 1-indexed human ordinal (`index + 1`). AR46 stores 0-based; this is purely a presentation choice (`architecture.md:587` "operation 2 of 3 failed").
- `[ of <total>]` is rendered only when `details.totalEdits` is supplied (the constructor accepts an optional `failedOperation.total` and stamps `details.totalEdits`). When absent, the line reads `Edit batch rejected — operation 2 failed.` Story 1.10's `edit_page` handler will pass `total = args.edits.length`; this story keeps the formatter graceful when called without it.
- `<op-summary>` is the result of `summarizeOperation(operation)` — a private helper that renders the `operation` object as `<type> { <field>: <jsonValue>, ... }` with values truncated to 80 chars and the same secret-scrubber applied (AC4). Detailed shape contract in Tasks Task 4.

**`infrastructure_error`:**
```
Operation could not be completed — SilverBullet unreachable.

Underlying error: <underlying>

To recover: this is a transient infrastructure issue. Retry shortly. If the problem persists, the user should check that their SilverBullet instance is running.
```
- `<underlying>` is `details.underlying` (already secret-scrubbed by `infrastructureError(err)` per AC4). **Never** a stack trace (AR45 #4).
- The summary line wording is fixed at `Operation could not be completed — SilverBullet unreachable.` even when the actual cause is, e.g., a JSON parse failure on the SB response. Rationale: agents shouldn't introspect the underlying TS-side fault; the recovery instruction (retry) is the same regardless. Detailed cause goes to the diagnostic logger via the handler's catch block.

**`config_error`:**
```
Operation rejected — server configuration is malformed.

Variable: <variable>
Rule: <rule>
Detail: <message>

To recover: configuration on the user's SilverBullet is malformed; user must fix it. The agent should not retry.
```
- All three fields read from `details.variable` / `details.rule` / `details.message` — populated by `configError({ variable, rule, message })` (AC3).

**`not_found`:**
```
Operation rejected — page not found.

Page: <ref>

To recover: page does not exist (or is not accessible) — verify the ref. The agent should not infer page existence from this response.
```
- The wording is **deliberately ambiguous** between "page doesn't exist" and "page is `none`-mode" per FR13 / `architecture.md:629`. Do NOT branch on additional context.

**And** the formatter is **pure**: no I/O, no clock reads, no global state. Same `DomainError` always renders the same text. AR58.

**And** the formatter performs a final defensive `scrubSecrets` pass over the rendered text? **NO** — the secret scrubber is structural (AC4); applying it to the rendered text would be ineffective (the text doesn't have field names). Information-leak protection is achieved by:
1. Constructors populating `details` from already-scrubbed inputs (AC3 / AC4).
2. Templates referencing only specific `details` fields (no spread / no untrusted interpolation).
3. AR45 #3: `details` exposes only the recovery-required fields (e.g., `freshnessViolation` exposes `lastReadAt`, never the engine's internal block-list).

**AC6 — `serializeForAudit(error)` projects the `DomainError` into the audit `reason` + `details` (+ `failedOperation`) shape**

**Given** the audit serializer at `src/domain/error.ts`,
**When** I import `function serializeForAudit(error: DomainError): AuditErrorProjection`,
**Then** the function returns the type:
```typescript
export type AuditErrorProjection = {
  readonly reason: ReasonCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failedOperation?: { readonly index: number; readonly operation: object };
};
```

**And** the function maps `DomainError` fields to audit-projection fields:
- `reason` ← `error.reason` (verbatim — closed enum, no transformation).
- `details` ← `error.details` (verbatim — already scrubbed by the constructors).
- `failedOperation` ← `error.failedOperation` (verbatim) when present; **omitted entirely** from the projection when absent (per `exactOptionalPropertyTypes: true`, build via conditional spread — never `failedOperation: undefined`).

**And** the projection deliberately **does NOT** include `error.ref`. The architecture's audit schema (`architecture.md:548-555`) gives `details` and `failedOperation` as the audit-side fields; `ref` is the formatter's domain (it goes into the human-readable Page line). When handlers want the ref in the audit log, they pass it via `args.ref` (AR31 — agent intent in `args` is logged in full). This keeps `serializeForAudit` aligned with the audit schema's published surface.

**And** the projection is suitable for direct spread into `AuditEntryInput` from `src/audit/schema.ts`:
```typescript
ctx.audit.write({
  tool: 'edit_page',
  args: input,
  decision: 'rejected',
  ...serializeForAudit(error),
  response: undefined,        // handlers populate this on success only
  durationMs: ctx.clock.now() - startedAt,
});
```
The spread surfaces `reason`, `details`, and (conditionally) `failedOperation` — exactly the audit-side projection per D6.

**And** the projection round-trips losslessly through `JSON.stringify` / `JSON.parse` — verified in AC9 with one fixture per `ReasonCode`. The shape uses only JSON-safe types (no `Date`, no `Map`, no class instances) because the constructors already coerced them in AC3.

**AC7 — Information-leak rules in formatter (AR45 enforced)**

**Given** the four AR45 information-leak rules,
**When** I exercise `formatToolError` with adversarial inputs,
**Then** every rule holds:

1. **No bearer token / secret leaks.** The scrubber (AC4) runs **inside** `infrastructureError(err)`'s constructor BEFORE storing the projection in `details`. By the time `formatToolError` reads `details.underlying`, the value is already scrubbed. Adversarial fixtures: HTTP error wrapping `{ headers: { Authorization: 'Bearer SECRET' } }`, error wrapping `{ token: 'SECRET', apiKey: 'SECRET2' }`, error wrapping `{ secret: 'SECRET', password: 'SECRET3' }`. Rendered text MUST NOT contain `'SECRET'`, `'SECRET2'`, or `'SECRET3'` substrings (assertion: `assert.ok(!text.includes('SECRET'))`, `assert.ok(!text.includes('Bearer'))`).

2. **No `none`-mode page content** (NFR6). `not_found` errors carry empty `details` — there is no body field to leak. Tested via the `notFoundError(ref)` constructor producing `details: {}` (exact shape).

3. **No internal MCP-server state.** The formatter never reaches outside `error.details` for context. Tested by inspecting the rendered text for absence of any block-list / freshness-cache / runtime-client diagnostics (e.g., the test passes `permissionDeniedError(ref, 'write', 'none')` and asserts the rendered text contains exactly the documented context lines and no extra debugging info).

4. **No raw stack traces.** `infrastructureError(new Error('boom'))` — the rendered text contains the message `'boom'` but does NOT contain the substring `'at Object.<anonymous>'`, `'at process.processTicksAndRejections'`, or any line starting with whitespace + `'at '`. Stack output goes to the diagnostic logger via the handler's catch (Story 1.10).

**And** unit tests assert each rule against a golden adversarial input set. Minimum 6 adversarial cases (AC9 enumerates).

**AC8 — `ConfigError` (Story 1.4) is reconciled with the new `DomainError` shape**

**Given** the type at `src/config/config.ts:36-41` after this story,
**When** I import `ConfigError`,
**Then** it is structurally compatible with `DomainError` — i.e. `Result<Config, ConfigError>` continues to compile against `Result<T, E extends DomainError = DomainError>` in `src/domain/result.ts`.

**And** `ConfigError`'s shape is migrated to:
```typescript
export type ConfigError = {
  readonly reason: 'config_error';
  readonly details: {
    readonly variable: 'SILVERBULLET_URL' | 'SILVERBULLET_TOKEN' | 'MCP_SILVERBULLET_AUDIT_LOG_PATH';
    readonly rule: ConfigRule;
    readonly message: string;
  };
};
```
Top-level `variable`, `rule`, `message` fields move into `details`. The `reason: 'config_error'` literal is preserved (it's now one of the closed `ReasonCode` values, satisfying `DomainError.reason`). `details` populates with the three fields, satisfying `DomainError.details: Record<string, unknown>`.

**And** `formatConfigError(err: ConfigError): { fatal: string; hint: string }` (`src/config/config.ts:222-254`) is updated to read from `err.details.variable` / `err.details.rule` / `err.details.message` instead of the previous top-level fields. Behaviour is unchanged — the same fatal / hint strings are produced for each `ConfigRule`. AC of Story 1.4 (the AR39 fatal+hint contract at `architecture.md:497-501`) is preserved verbatim.

**And** `issueToConfigError(issue)` (`src/config/config.ts:89-141`) is updated to construct the new shape. The function now returns:
```typescript
{
  reason: 'config_error',
  details: { variable: ENV_KEYS[fieldKey], rule, message },
}
```
The previous logic for picking the `rule` from `issue.code` is unchanged — only the wrapping shape changes.

**And** `pickPrimaryIssue`'s logic (`src/config/config.ts:144-167`) remains unchanged — it still operates on raw zod issues, then hands the chosen issue to `issueToConfigError`.

**And** `config.test.ts` test cases that inspect `error.variable` / `error.rule` / `error.message` are updated to inspect `error.details.variable` / `error.details.rule` / `error.details.message`. **No new test cases are added** — Story 1.4's coverage is sufficient; we're refactoring the shape, not the behaviour. The test count delta from 1.4-related tests is **0**.

**AC9 — Unit tests cover every reason category, golden adversarial inputs, and the ConfigError reconciliation**

**Given** the unit tests at `src/domain/error.test.ts` and the existing `src/config/config.test.ts`,
**When** `npm test` runs,
**Then** every case below passes with **no I/O** (NFR21). All `Date` values come from hand-constructed instances; no real `Date.now()` reads in assertion-bearing tests. No fs / network / clock side effects.

**Cases for `ReasonCode` + `REASON_CODES` (≥ 2):**
1. `assert.deepStrictEqual(REASON_CODES, ['permission_denied', 'freshness_violation', 'validation_error', 'infrastructure_error', 'config_error', 'not_found'])` — locks the enum and order. AC1.
2. Compile-time exhaustiveness: a switch over `ReasonCode` with `default: never` must compile (a tiny `assertExhaustive(reason: never): never { throw new Error(...) }` helper inside the test exercises this — TypeScript will flag any missing case).

**Cases for the per-reason constructors (≥ 7 — one per constructor + one for `validationError` batch mode):**
1. `permissionDeniedError(ref, 'write', 'none')` returns `{ reason: 'permission_denied', ref, details: { required: 'write', granted: 'none' } }` (no `failedOperation`).
2. `freshnessViolationError(ref, lastModified, lastReadAt)` returns `{ reason: 'freshness_violation', ref, details: { lastModified: '<iso>', lastReadAt: '<iso>' } }` for both Date inputs.
3. `freshnessViolationError(ref, lastModified, undefined)` returns `details: { lastModified: '<iso>', lastReadAt: null }` (the `undefined → null` coercion; AC3).
4. `validationError({ ref, failure: 'page name empty' })` (non-batch) returns `{ reason: 'validation_error', ref, details: { failure: 'page name empty' } }` (no `failedOperation`).
5. `validationError({ ref, failure: 'search not found', failedOperation: { index: 1, operation: { type: 'search_and_replace', search: 'TODO' }, total: 3 } })` (batch) returns `failedOperation: { index: 1, operation: { type: 'search_and_replace', search: 'TODO' } }` AND `details: { failure: 'search not found', totalEdits: 3 }`.
6. `infrastructureError(new Error('ECONNREFUSED'))` returns `{ reason: 'infrastructure_error', details: { underlying: 'ECONNREFUSED' } }` — no `ref`. With ref: `infrastructureError(new Error('500'), ref)` carries the ref.
7. `configError({ variable: 'SILVERBULLET_URL', rule: 'must_use_https', message: 'must use https://' })` returns `{ reason: 'config_error', details: { variable: 'SILVERBULLET_URL', rule: 'must_use_https', message: 'must use https://' } }`.
8. `notFoundError(ref)` returns `{ reason: 'not_found', ref, details: {} }` — empty details object (AR45 #2).

**Cases for `scrubSecrets` (≥ 12):**
1. **Plain key match (case-insensitive):** `scrubSecrets({ token: 'X' })` → `{ token: '***redacted***' }`; same for `Token`, `TOKEN`.
2. **All five keys:** `scrubSecrets({ authorization: 'A', token: 'B', apiKey: 'C', secret: 'D', password: 'E' })` → all five values redacted.
3. **Whole-key match only:** `scrubSecrets({ mytoken: 'X' })` → `{ mytoken: 'X' }` (NO redaction; `mytoken` is not a closed-list key).
4. **Recursive into nested objects:** `scrubSecrets({ headers: { Authorization: 'Bearer X' } })` → `{ headers: { Authorization: '***redacted***' } }`.
5. **Recursive into arrays:** `scrubSecrets([{ token: 'X' }, { y: 1 }])` → `[{ token: '***redacted***' }, { y: 1 }]`.
6. **Non-plain values returned via `String(...)`:** `scrubSecrets({ when: new Date('2026-04-30T00:00:00Z') })` → `{ when: '2026-04-30T00:00:00.000Z' }` (or the `Date.toString()` form — pick one and document; `toISOString()` is preferred for audit consistency since it matches D4 timestamp format).
7. **Error instances:** `scrubSecrets(new Error('boom'))` → `'boom'` (the `err.message`, NOT the stack). Adversarial: an `Error` whose `.message` itself contains a token-bearing JSON-like substring is NOT scrubbed (the architecture mandates structural scrubbing only). Document this in JSDoc.
8. **Cycles:** `const a: any = {}; a.self = a; scrubSecrets(a)` → `{ self: '<cycle>' }` (or similar). MUST not infinite-loop.
9. **`null` and `undefined` pass-through:** `scrubSecrets(null)` → `null`; `scrubSecrets(undefined)` → `undefined`.
10. **Primitives pass-through:** `scrubSecrets('hello')` → `'hello'`; `scrubSecrets(42)` → `42`; `scrubSecrets(true)` → `true`; `scrubSecrets(0n)` → `'0n'` or `0n` (BigInt — pick one and document).
11. **Mixed nested:** `scrubSecrets({ outer: { authorization: 'A', payload: [{ password: 'P' }] } })` → recursive nested redaction.
12. **Adversarial — token in unusual locations:** `scrubSecrets({ headers: [{ name: 'authorization', value: 'X' }] })` → the `name: 'authorization'` is not a value-side match; the closed-list keys are field names, not field values. So this returns the input unchanged. Document the limitation in JSDoc — header arrays from libraries like `node-fetch` would need shape-aware scrubbing; the current scrubber is structural-only. (This is an explicit non-goal per AR45 #1's "fields named token / apiKey / secret / password".)

**Cases for `formatToolError` (≥ 9 — one per reason + permission_denied/freshness_violation worded-recovery checks + batch validation + adversarial-secret golden):**
1. **`permission_denied` text:** `formatToolError(permissionDeniedError(ref, 'write', 'none'))` returns `{ isError: true, content: [{ type: 'text', text: '<EXACT_PERMISSION_DENIED_TEMPLATE>' }] }` — assert via `assert.strictEqual(text, expected)` with the full multi-line string. Verifies exact summary, context, and recovery.
2. **`freshness_violation` recovery wording (AC2 of epic spec):** the rendered text matches `/call read_page\("[^"]+"\) to refresh, then retry/` AND contains the literal substring `'call read_page("' + ref + '") to refresh, then retry'`.
3. **`freshness_violation` lastReadAt = null:** `formatToolError(freshnessViolationError(ref, modDate, undefined))` renders `Last read by you: never` — verified by `assert.match(text, /Last read by you: never/)`.
4. **`validation_error` non-batch:** rendered text contains `Failure:` line, no `Failed operation:` line.
5. **`validation_error` batch (with total):** rendered text contains `Edit batch rejected — operation 2 of 3 failed.` (1-indexed for human, `total` shown).
6. **`validation_error` batch (without total):** rendered text contains `Edit batch rejected — operation 2 failed.` (no `of M`).
7. **`infrastructure_error` underlying message:** `formatToolError(infrastructureError(new Error('ECONNREFUSED 127.0.0.1:3000')))` renders text containing `ECONNREFUSED 127.0.0.1:3000` AND containing the recovery line `transient infrastructure issue. Retry shortly.`.
8. **`config_error`:** rendered text has `Variable:`, `Rule:`, `Detail:` lines populated from `details`.
9. **`not_found` deliberate ambiguity:** rendered text contains the literal `page does not exist (or is not accessible)`.

**Cases for `formatToolError` AR45 information-leak rules (≥ 6 — one per AR45 rule + adversarial inputs):**
1. **No `Authorization` header leak:** `formatToolError(infrastructureError({ message: 'fetch failed', headers: { Authorization: 'Bearer SECRET-TOKEN' } }))` — rendered text MUST NOT contain `'SECRET-TOKEN'` or `'Bearer'`. The error is wrapped by `infrastructureError`, which calls `scrubSecrets` first, so `details.underlying` is the scrubbed projection.
2. **No `token` field leak:** `formatToolError(infrastructureError({ message: 'auth failed', token: 'SECRET' }))` — rendered text MUST NOT contain `'SECRET'`.
3. **No `apiKey`, `secret`, `password` leaks:** three separate fixtures, same assertion shape.
4. **No raw stack trace:** `formatToolError(infrastructureError(new Error('boom')))` — rendered text MUST NOT contain `'at Object.<anonymous>'` AND MUST NOT match `/^\s+at\s/m` (no stack-frame line). The text contains `'boom'` (the message) but not the trace.
5. **No internal state leak from permission engine:** `formatToolError(permissionDeniedError(ref, 'write', 'none'))` — rendered text contains the documented context lines (`Page:`, `Required:`, `Granted:`) and no others. Asserted by counting lines and matching expected vs. observed line set.
6. **No `none`-mode body field:** `formatToolError(notFoundError(ref))` — rendered text contains the documented template AND the context block has only the `Page:` line (no other context lines). `details` is empty by AC3.

**Cases for `serializeForAudit` (≥ 7 — one per reason + the round-trip property):**
1. **Round-trip for each reason:** for each of the six `ReasonCode` values, `JSON.parse(JSON.stringify(serializeForAudit(error)))` deep-equals `serializeForAudit(error)` — verifies JSON-safety.
2. **No `ref` in projection:** `serializeForAudit(permissionDeniedError(ref, 'write', 'none'))` returns `{ reason: 'permission_denied', details: { required: 'write', granted: 'none' } }` — no `ref` field (the architecture's audit schema doesn't surface ref directly; handlers log it via `args`).
3. **No `failedOperation` when absent:** `serializeForAudit(notFoundError(ref))` returns `{ reason: 'not_found', details: {} }` — the `failedOperation` key is absent (NOT `failedOperation: undefined`). Verified by `assert.strictEqual('failedOperation' in projection, false)`.
4. **`failedOperation` present for batch:** `serializeForAudit(validationError({ ref, failure: '...', failedOperation: { index: 1, operation: { type: 'search_and_replace' }, total: 3 } }))` returns `{ reason: 'validation_error', details: { failure: '...', totalEdits: 3 }, failedOperation: { index: 1, operation: { type: 'search_and_replace' } } }`.

**Cases for ConfigError reconciliation (≥ 1 type-only + Story 1.4 regression):**
1. **Type-system check:** in a `*.test.ts` (compile-time), `const _: Result<Config, ConfigError> = ok({ ... })` and `const _err: Result<Config, ConfigError> = err({ reason: 'config_error', details: { variable: 'SILVERBULLET_URL', rule: 'missing', message: '...' } })` must compile. (TypeScript-compile-time test; if it compiles, it passes.)
2. **`config.test.ts` regressions:** all existing tests pass after the shape migration (AC8). The previously-asserted `error.variable`, `error.rule`, `error.message` reads become `error.details.variable`, etc.

**AC10 — Module surface, file structure, no new dependencies, edits scoped to `src/domain/error.ts` + `src/config/config.ts` + the two adjacent test files**

**Given** the project after this story,
**When** I list `src/domain/`,
**Then** it contains exactly:
```
src/domain/
├── error.ts           # UPDATED: replaces placeholder; full DomainError + ReasonCode + constructors + scrubSecrets + formatToolError + serializeForAudit
├── error.test.ts      # NEW: ≥ 50 cases per AC9 enumeration (2 enum + 8 constructors + 12 scrub + 9 format + 6 leak + 7 serialize + 6+ misc)
├── ref.test.ts        # UNCHANGED
├── ref.ts             # UNCHANGED
└── result.ts          # UNCHANGED — `<E extends DomainError>` constraint continues to apply via AC8 reconciliation
```

**And** `src/config/config.ts` is **modified** for the AC8 reconciliation only — no new functionality. Side-effect-free refactor; `config.test.ts` updated for the shape change.

**And** **no other source file in the repo is changed**. In particular:
- `src/audit/schema.ts` is **NOT** changed. `AuditEntry.reason: string` stays as the audit-schema type for forward-compat (`AuditEntry.reason` is a structural superset of `ReasonCode`; tightening risks an unnecessary perceived schema bump under NFR16). Story 1.5's dev-notes lines 423-424 explicitly defer this decision: **defer**. Document in dev-notes that `serializeForAudit` emits closed-enum `ReasonCode` values that satisfy the looser `string` field; the on-disk shape is unchanged regardless.
- `src/audit/audit-logger.ts` is **NOT** changed. The audit logger consumes `AuditEntryInput` which has `reason?: string`; `serializeForAudit`'s output (`{ reason: ReasonCode, ... }`) spreads cleanly into `AuditEntryInput` because `ReasonCode` is assignable to `string`.
- `src/diagnostic/logger.ts`, `src/index.ts`, `eslint.config.js`, `tsconfig.json`, `package.json`, `.gitignore` — all unchanged.
- No new directories. No `index.ts` re-export barrels (AR57 / `architecture.md:999`).

**And** **no new dependencies.** The `@modelcontextprotocol/sdk` arrives in Story 1.10 / 1.11 — this story uses a local `MCPToolResult` type (AC5). All needed primitives are TypeScript types and stdlib-free pure functions.

**And** `npm pack --dry-run` manifest is **unchanged** at 13 files. `src/domain/error.ts` was already in the manifest as the placeholder; this story **modifies** it. `src/domain/error.test.ts` is excluded by the `"!src/**/*.test.ts"` allowlist. No additions, no removals.

**AC11 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`,
**And** `npm test` reports the new domain-error cases as passing,
**And** the test count strictly increases vs. the post-1.5 baseline of **164 tests** (Story 1.5 dev-notes line 655 `npm test` 164/164). Conservative floor for this story: **+50 cases** across the AC9 enumeration; expect **214+** post-1.6.
**And** `npm pack --dry-run` manifest stays at exactly **13 files**. No additions (the test file is excluded by `"!src/**/*.test.ts"`); no removals. Pack count: 13 → 13.

## Tasks / Subtasks

- [x] **Task 1: Define `ReasonCode` + `DomainError` in `src/domain/error.ts`** (AC: #1, #2)
  - [x] Replace the placeholder content of `src/domain/error.ts` (currently lines 1-12) with the new module surface. The existing `import` of this file from `src/domain/result.ts:1` continues to work because the export name `DomainError` is preserved.
  - [x] Export `type ReasonCode` as the closed string-literal union of the six values from AC1, in the documented order.
  - [x] Export `const REASON_CODES = ['permission_denied', 'freshness_violation', 'validation_error', 'infrastructure_error', 'config_error', 'not_found'] as const satisfies ReadonlyArray<ReasonCode>`. The `as const satisfies` shape enables both type-narrowness (the array is `readonly ['permission_denied', ...]`, not `string[]`) AND the assignability to `ReadonlyArray<ReasonCode>` (`erasableSyntaxOnly: true` permits `as const` since it's runtime-erasable).
  - [x] Export `type DomainError` per AC2.
  - [x] JSDoc on `ReasonCode`: cite AR30 `epics.md:145`, NFR16 `epics.md:94`, and the schema-bump rule. JSDoc on `DomainError`: cite D6 `architecture.md:537-555` and the two-projections rule (`architecture.md:557-560`).
  - [x] **No `enum`.** `erasableSyntaxOnly: true` (`tsconfig.json:11`) forbids TypeScript `enum`; use the string-literal union + `as const` array pattern.

- [x] **Task 2: Implement `scrubSecrets` in `src/domain/error.ts`** (AC: #4)
  - [x] Define a `const SCRUB_KEYS = new Set(['authorization', 'token', 'apikey', 'secret', 'password'])` — case-folded lowercase. Lookup uses `SCRUB_KEYS.has(key.toLowerCase())`.
  - [x] Define a `const REDACTED = '***redacted***'` — match the convention from `src/config/secret-scrubber.ts:3`.
  - [x] Define a recursive `scrub(value: unknown, seen: WeakSet<object>): unknown` private helper:
    - If `value === null || value === undefined` → return as-is.
    - If `typeof value !== 'object'` → primitive (string / number / boolean / bigint / symbol) → return as-is. (BigInt's `String(x)` would lose the `n` suffix; for AC9 case 10, document the chosen behaviour: pass-through is preferred since BigInt is JSON-unsafe but the audit-projection's downstream `JSON.stringify` would already handle the case by throwing — and the constructors don't put BigInts into `details`.)
    - If `value` is a plain object whose `Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null` → recurse into entries.
    - If `value` is an `Array` → recurse into entries.
    - If `value` is a non-plain object (Date, Error, Map, Set, Buffer, class instance) → return `String(value)` for `Date` (`new Date().toString()`) OR prefer `value.toISOString()` for `Date` to keep audit-shape consistency. For `Error`, return `value.message`. For others, `String(value)`. **Document the type-by-type choice in JSDoc.**
    - For cycles: if `seen.has(value)` → return `'<cycle>'`. Otherwise add to `seen` before recursing.
  - [x] Recurse-into-entries logic for plain objects: build a new object; for each `[key, val]`, if `SCRUB_KEYS.has(key.toLowerCase())` → set redacted; else recurse on `val`.
  - [x] Public `scrubSecrets(value: unknown): unknown` calls the private helper with a fresh `WeakSet`.
  - [x] JSDoc: cite AR45 #1 / `architecture.md:633` and `epics.md:451`. Document case-insensitivity, structural-only (not content-scanning), cycle-handling (`<cycle>` literal), and the BigInt/Symbol pass-through.

- [x] **Task 3: Implement per-reason constructors in `src/domain/error.ts`** (AC: #3)
  - [x] `permissionDeniedError(ref: Ref, required: string, granted: string): DomainError` — populate `{ reason: 'permission_denied', ref, details: { required, granted } }`.
  - [x] `freshnessViolationError(ref: Ref, lastModified: Date, lastReadAt: Date | undefined): DomainError` — populate `details.lastModified = lastModified.toISOString()`. Populate `details.lastReadAt = lastReadAt?.toISOString() ?? null`. Use `?? null` (the `null` is intentional — see AC3).
  - [x] `validationError(opts: { ref?: Ref; failure: string; failedOperation?: { index: number; operation: object; total?: number } }): DomainError` — populate `details: { failure }` (always). When `failedOperation` is supplied, also populate `details.totalEdits = failedOperation.total` if `total !== undefined`. Construct the error with `failedOperation: { index: failedOperation.index, operation: failedOperation.operation }` (strip `total` from the wire shape — `total` lives in `details.totalEdits`, not in `failedOperation` per the architecture's locked shape `{ index, operation }` `architecture.md:542-545`).
  - [x] `infrastructureError(err: unknown, ref?: Ref): DomainError`:
    - Extract a `message`: `err instanceof Error ? err.message : String(err)`.
    - Run `scrubSecrets` over the entire `err` value to extract any other safe context. The scrubbed projection's shape depends on what the err looks like:
      - For `Error`: scrubbed result is `err.message` (Task 2's String(err) rule for Error). Use this as `details.underlying`.
      - For plain objects (e.g., a fetch response shape): scrubbed result is the plain object with sensitive fields redacted. Use this as `details.underlying`.
    - Populate `details: { underlying: scrubbed }`. If the original error had a `code` field (e.g., `'ECONNREFUSED'`), promote it: `details.code = scrubbed.code` (still scrubbed). **Do NOT include the stack** (AR45 #4) — Task 2's String(err) for Error returns only `err.message`, satisfying this by construction.
    - When `ref` is supplied, include it: `{ reason: 'infrastructure_error', ref, details }`. When absent, omit `ref` entirely (conditional spread).
  - [x] `configError(opts: { variable: string; rule: string; message: string }): DomainError` — populate `{ reason: 'config_error', details: { variable, rule, message } }`. No `ref`.
  - [x] `notFoundError(ref: Ref): DomainError` — populate `{ reason: 'not_found', ref, details: {} }`. Empty details object (AR45 #2 — `not_found` carries no body to leak).
  - [x] **Conditional spreads** for optional fields. `exactOptionalPropertyTypes: true` means we never assign `field: undefined`. Use the same pattern as `audit-logger.ts:262-275`'s `buildEntry`:
    ```typescript
    const error: DomainError = (() => {
      const base: Mutable<DomainError> = { reason: 'permission_denied', details: { required, granted } };
      base.ref = ref;
      return base as DomainError;
    })();
    ```
    Or simply use object literals with conditional spreads — pick the pattern that's prettier-friendly. **Reference the Story 1.4 `secret-scrubber.ts:55-104` and Story 1.5 `audit-logger.ts:262-275` patterns.**

- [x] **Task 4: Implement `formatToolError` in `src/domain/error.ts`** (AC: #5, #7)
  - [x] Define the local `MCPToolResult` type per AC5.
  - [x] Define a private `summarizeOperation(op: object): string` helper that renders `{ type: 'search_and_replace', search: 'TODO', replace: 'DONE' }` as `search_and_replace { search: "TODO", replace: "DONE" }`. Implementation:
    - If `op` has a `type: string` field → use it as the prefix (`search_and_replace`).
    - Render remaining fields as `key: <jsonValue>` joined by `, `, wrapped in `{ ... }`.
    - Truncate any string value over 80 chars with `…` suffix. (Defends against agent-supplied massive inputs that would explode the rendered text.)
    - Run `scrubSecrets` over `op` first so any token-shaped fields are masked.
  - [x] Define a private `renderText(error: DomainError): string` helper that produces the multi-line string per AC5's per-reason templates. **Use exact wording verbatim** — tests will assert string equality on whole templates.
    - Switch on `error.reason` with `default: never` exhaustiveness (`assertExhaustive(error.reason)` helper). Compile error if a case is missed (AR60 / `architecture.md:1026`).
    - Per-reason rendering reads from `error.ref`, `error.details`, `error.failedOperation` only — never any global state.
    - Use template-literal interpolation; no `String.prototype.format` library.
    - For `validation_error` batch: `total = (error.details as any).totalEdits as number | undefined` — narrow with `typeof check === 'number'`. Render `[ of <total>]` only when present.
    - For `freshness_violation`: render `Last read by you: never` when `details.lastReadAt === null`; else render the ISO string.
  - [x] `formatToolError(error: DomainError): MCPToolResult` calls `renderText(error)` and wraps:
    ```typescript
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: renderText(error) }],
    };
    ```
  - [x] JSDoc: cite D6 / `architecture.md:533-640`, AR43 / `epics.md:162`, AR44 / `epics.md:163`, AR45 / `epics.md:164`. Document the verbatim recovery wording for `freshness_violation` (AC2 of epic spec).
  - [x] **Defensive note in JSDoc:** the formatter is the **only** sanctioned site that turns a `DomainError` into agent-facing text. Story 1.10's handler-template pattern requires every handler's failure path to call `formatToolError`. Direct string construction by handlers is forbidden.

- [x] **Task 5: Implement `serializeForAudit` in `src/domain/error.ts`** (AC: #6)
  - [x] Export `type AuditErrorProjection` per AC6.
  - [x] `serializeForAudit(error: DomainError): AuditErrorProjection`:
    - Build base: `{ reason: error.reason, details: error.details }`.
    - Conditionally spread `failedOperation` only when present (`exactOptionalPropertyTypes`).
    - Do NOT include `ref` in the projection (AC6 rationale).
  - [x] JSDoc: cite D6 single-source-of-truth principle, the audit-schema field set (D4 / `architecture.md:386-468`), and the spread-into-AuditEntryInput pattern (with a code snippet example).
  - [x] **JSDoc note on schema-version coupling:** "Adding a `ReasonCode` value or changing a per-reason `details` schema requires bumping `AUDIT_SCHEMA_VERSION` in `src/audit/schema.ts` (NFR16 / AR42 `architecture.md:640`). The serializer is the boundary — both projections (this one and `formatToolError`) must update together with a schema bump."

- [x] **Task 6: Reconcile `ConfigError` (Story 1.4) with the new `DomainError`** (AC: #8)
  - [x] Update `src/config/config.ts:36-41` `ConfigError` to the nested-`details` shape:
    ```typescript
    export type ConfigError = {
      readonly reason: 'config_error';
      readonly details: {
        readonly variable: 'SILVERBULLET_URL' | 'SILVERBULLET_TOKEN' | 'MCP_SILVERBULLET_AUDIT_LOG_PATH';
        readonly rule: ConfigRule;
        readonly message: string;
      };
    };
    ```
  - [x] Update `issueToConfigError` (`src/config/config.ts:89-141`) to construct the new shape: `{ reason: 'config_error', details: { variable: ENV_KEYS[fieldKey], rule, message } }`.
  - [x] Update `formatConfigError` (`src/config/config.ts:222-254`) to read from `err.details.variable` / `err.details.rule` / `err.details.message`. The function's output (the `{ fatal, hint }` strings) is unchanged.
  - [x] Update `pickPrimaryIssue`'s post-processing if it inspects the constructed `ConfigError` — review `src/config/config.ts:144-167`. (Likely no change, as it operates on raw zod issues.)
  - [x] Update `loadConfig`'s fallback path (`src/config/config.ts:204-213`) — if the function constructs a `ConfigError` directly (not via `issueToConfigError`), update that construction site too.
  - [x] Update `src/config/config.test.ts`: every assertion on `error.variable` / `error.rule` / `error.message` becomes `error.details.variable` / `error.details.rule` / `error.details.message`. **No new tests; existing coverage is sufficient.**
  - [x] Run `npm run typecheck` after this task — the new `Result<Config, ConfigError>` constraint should compile because `ConfigError`'s `reason: 'config_error'` is a `ReasonCode` literal AND `details: { variable, rule, message }` is structurally a `Record<string, unknown>` (a more-specific type assigns to a less-specific one).

- [x] **Task 7: Write `error.test.ts` covering AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC9** (AC: #9)
  - [x] Create `src/domain/error.test.ts`. Use `node:test` + `node:assert/strict` per the established pattern (Stories 1.1, 1.2, 1.3, 1.4, 1.5).
  - [x] **Top-level `await test(...)` for each case** (no `describe` blocks — Story 1.3 Debug Log line 401 / Story 1.4 dev-notes line 366 / Story 1.5 dev-notes line 455).
  - [x] Build a single test fixture `const ref = makeRef('Projects/Active/Foo')` shared across cases. Other refs (`'Personal/Journal/2026-04-21'`) constructed inline.
  - [x] **Reason-code cases (≥ 2 per AC9).**
  - [x] **Constructor cases (≥ 8 per AC9).**
  - [x] **`scrubSecrets` cases (≥ 12 per AC9).** Include the cycle case (self-referential object), the case-insensitive variants, the recursive nested case, the array case, the Error-instance case (returns `err.message`), the Date case, the primitive pass-through case, the BigInt case (document the chosen behaviour), and the limitation case (header-array structure).
  - [x] **`formatToolError` cases (≥ 9 per AC9).** Include exact-template assertions (use multi-line string literals in the test for the expected text).
  - [x] **AR45 information-leak cases (≥ 6 per AC9).** Include adversarial Bearer-token, token/apiKey/secret/password fields, no-stack-trace, and no-internal-state assertions.
  - [x] **`serializeForAudit` cases (≥ 7 per AC9).** Include the round-trip for each reason and the no-`ref` / no-`failedOperation` assertions.
  - [x] **No fs / network / clock side effects.** All `Date` instances are hand-constructed (`new Date('2026-04-30T14:20:01Z')`).
  - [x] **Assertions:** `assert.deepStrictEqual` for entire object shapes, `assert.strictEqual` for primitives + whole-template strings, `assert.match` for regex shapes (recovery wording, ISO timestamps, alphabet checks), `assert.ok(text.includes(...))` for substring presence and `assert.ok(!text.includes(...))` for absence.

- [x] **Task 8: Local verification** (AC: #11)
  - [x] `npm run typecheck` → exit 0, zero TS errors. Watch for the `<E extends DomainError>` constraint on `Result` interacting with the migrated `ConfigError` (Task 6).
  - [x] `npm run lint` → exit 0, zero rule violations. Watch for `@typescript-eslint/no-explicit-any` (the formatter's `details.totalEdits` narrowing — use `typeof` guards, not `as any`); `@typescript-eslint/no-floating-promises` (none — no async); `no-console` (none — formatter writes no streams).
  - [x] `npx prettier --check .` → all matched files formatted.
  - [x] `npm test` → all tests pass; count increases by ≥ 50 vs. the post-1.5 baseline (164 → ≥ 214 expected).
  - [x] `npm pack --dry-run` → manifest **unchanged** at 13 files (`src/domain/error.ts` is modified, not added; the test file is excluded by `"!src/**/*.test.ts"`).

## Dev Notes

### Architectural source-of-truth

This is story **#6** in the implementation sequence (`architecture.md:818`, item 6: "**`DomainError` + formatter + audit serializer** — single source of truth, two projections. (D6.) Depended on by tool handlers and the runtime client."). It depends on:

- Story 1.2's `Ref` primitive (`src/domain/ref.ts`) — the `DomainError.ref?: Ref` field type and the test fixtures' `makeRef('...')` calls.
- Story 1.2's `Result<T>` (`src/domain/result.ts`) — its `<E extends DomainError>` constraint requires the new shape to be a structural superset of any existing E (e.g., Story 1.4's `ConfigError`); AC8 reconciles.
- Story 1.4's `ConfigError` (`src/config/config.ts:36-41`) — migrated to the new shape in AC8.
- Story 1.5's `AuditEntryInput` (`src/audit/schema.ts:70`) — the audit serializer's projection spreads cleanly into this type because `reason: ReasonCode` is assignable to `reason?: string`.

It does **NOT** depend on:

- Story 1.7's `RuntimeClient` — the client is a downstream **consumer** of `infrastructureError(err)` for HTTP failures; the formatter is wired before the client lands.
- Story 1.8's `AccessMode` (`'none' | 'read' | 'append' | 'write'`) — `permissionDeniedError`'s `required` / `granted` parameters are typed `string` for forward-compat; Story 1.8 will tighten via the `AccessMode` import once `permissions/access-mode.ts` lands.
- Story 1.10's `handler-template.ts` — the handler template **consumes** `formatToolError` and the per-reason constructors; this story owns their definitions.
- The `@modelcontextprotocol/sdk` (Story 1.10/1.11 wiring) — local `MCPToolResult` type stands in until SDK lands.

**Primary specs (read these first):**
- D6 — Error Response Structure: `_bmad-output/planning-artifacts/architecture.md:533-640`. Single internal type, two projections, per-reason text templates, recovery mapping, information-leak rules, implementation seam.
- AR42–AR46 in `_bmad-output/planning-artifacts/epics.md:161-165`.
- FR26 — structured error responses: `_bmad-output/planning-artifacts/epics.md:62`.
- NFR8 — no internal state exposed via tool surface: `_bmad-output/planning-artifacts/epics.md:80`.
- NFR16 — versioned audit schema (any `ReasonCode` change requires a bump): `_bmad-output/planning-artifacts/epics.md:94`.
- AR45 — information-leak rules: `_bmad-output/planning-artifacts/epics.md:164`.
- D4 cross-reference for the audit-projection alignment: `_bmad-output/planning-artifacts/architecture.md:404-425`.

### What this story owns (and does NOT own)

**Owns:**
- `src/domain/error.ts` — `ReasonCode`, `REASON_CODES`, `DomainError`, `MCPToolResult`, `AuditErrorProjection`, all six per-reason constructors, `scrubSecrets`, `formatToolError`, `serializeForAudit`.
- `src/domain/error.test.ts` — exhaustive tests per AC9.
- The migration of `ConfigError` in `src/config/config.ts` to be `DomainError`-compatible (AC8).

**Does NOT own (these land in later stories):**
- The `RuntimeClient` calling `infrastructureError(err)` on HTTP failures — Story 1.7 (AR21–AR25 / `epics.md:134-138`). This story provides the constructor; 1.7 wires the call site.
- The handler `try/catch/finally` shape that calls `formatToolError(error)` from the failure path and `audit.write({ ...serializeForAudit(error), ... })` from the `finally` — Story 1.10's `handler-template.ts` (AR53 / `epics.md:176`, AR54 / `epics.md:177`).
- The permission engine emitting `permissionDeniedError` — Story 1.8.
- The edit-batch validator emitting `validationError({ ..., failedOperation: { index, operation, total } })` — Story 2.1 (`epics.md:625`).
- The `freshness_violation` constructor's call site — Story 2.3 / 2.5 (`epics.md:638`, `epics.md:649`).
- Any move of `permissions/access-mode.ts` types into `domain/` — Story 1.8 owns `AccessMode`.
- Tightening `AuditEntry.reason` from `string` to `ReasonCode` in `src/audit/schema.ts` — **deferred** (see "Deferred from this story" below).

### Files this story creates / modifies / deletes

**MODIFY:**
- `src/domain/error.ts` — replace placeholder content with the full module per AC1–AC7. The existing `import` from `src/domain/result.ts:1` continues to work (export name `DomainError` preserved).
- `src/config/config.ts` — `ConfigError` shape migration (AC8): `variable` / `rule` / `message` → `details: { variable, rule, message }`. `issueToConfigError`, `formatConfigError`, and any direct `ConfigError` construction site updated.
- `src/config/config.test.ts` — assertions on `error.variable` / `error.rule` / `error.message` updated to read from `error.details.*`. **No new tests.**

**NEW:**
- `src/domain/error.test.ts` — adjacent unit tests, ≥ 50 cases per AC9.

**UNCHANGED (do not touch):**
- `src/audit/schema.ts` — `AuditEntry.reason: string` stays. Tightening to `ReasonCode` is a **deferred** decision (Story 1.5 dev-notes line 423-424). The audit logger correctly accepts `serializeForAudit`'s output because `ReasonCode` ⊆ `string`.
- `src/audit/audit-logger.ts`, `src/audit/digest.ts`, `src/audit/audit-logger.test.ts`, `src/audit/digest.test.ts` — Story 1.5 territory; this story doesn't touch them.
- `src/diagnostic/logger.ts`, `src/diagnostic/logger.test.ts` — Story 1.3 territory.
- `src/domain/ref.ts`, `src/domain/ref.test.ts`, `src/domain/result.ts` — unchanged. `result.ts`'s `<E extends DomainError>` constraint continues to apply via the AC8 reconciliation.
- `src/config/secret-scrubber.ts` — orthogonal (it scrubs the `Config` OBJECT for serialization; D6's scrubber is for HTTP error contents). No code overlap.
- `src/index.ts` — startup wiring is Story 1.11.
- `eslint.config.js`, `package.json`, `tsconfig.json`, `.gitignore` — no rule / dep / TS-config changes needed.
- `.github/workflows/`, `tests/` — out of scope.
- All `_bmad/`, `_bmad-output/`, `docs/` — no doc updates in this story (the threat model and `docs/audit-log.md` reference D6 in Story 1.13).

**DELETE:**
- Nothing. (Story 1.5 already removed `src/audit/.gitkeep`; `src/domain/` has no `.gitkeep` to remove since it has had `error.ts` + `result.ts` + `ref.ts` since Story 1.2.)

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/domain/error.test.ts` next to `src/domain/error.ts` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`).
- **No real `Date.now()` reads** in assertion-bearing tests. All Date instances are hand-constructed.
- **Top-level `await test(...)`** for each case (no `describe` blocks).
- **No mocks needed.** The module is pure — no fakes for fs / clock / randomness / network.
- Assertions:
  - `assert.deepStrictEqual` for full DomainError objects and full audit projections.
  - `assert.strictEqual` for primitives and **whole-template multi-line strings** (the `formatToolError` text-block tests use whole-string equality).
  - `assert.match(text, /regex/)` for the recovery-wording substring assertions (AC2 of epic spec).
  - `assert.ok(!text.includes('SECRET'))` / `assert.ok(!text.includes('Bearer'))` for AR45 information-leak negative assertions.
  - `assert.ok('failedOperation' in projection === false)` for absent-key checks (NOT `assert.strictEqual(projection.failedOperation, undefined)` — that's `exactOptionalPropertyTypes`-incompatible per Story 1.5 dev-notes line 506).

### Library / framework requirements

**No new dependencies.** All needed primitives are TypeScript types (closed-union, `as const satisfies`, conditional spreads) and pure JavaScript:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:46`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; no build step |
| `node:test` | built-in | Test framework |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:**
- `@modelcontextprotocol/sdk` — Story 1.10 / 1.11 own this. Local `MCPToolResult` type bridges until then.
- Any string-formatting library (`sprintf-js`, `pupa`, `mustache`, `handlebars`) — template literals are sufficient.
- Any deep-clone library (`lodash.clonedeep`, `clone-deep`) — `scrubSecrets` writes a fresh object on each branch; no clone needed.
- Any DOM-style scrubber (`DOMPurify`, `xss`) — wrong domain (HTML, not JS objects).
- Any structured-clone polyfill — not needed; structuredClone is a Node 17+ built-in but isn't used here.
- Any `enum`-replacement library (`ts-enum-util`) — closed-union + `as const` array satisfies this need.

### File-structure requirements

After this story, `src/domain/` must look like:

```
src/domain/
├── error.test.ts        # NEW: ≥ 50 cases per AC9
├── error.ts             # MODIFIED: replace placeholder; full DomainError module
├── ref.test.ts          # UNCHANGED (Story 1.2)
├── ref.ts               # UNCHANGED (Story 1.2)
└── result.ts            # UNCHANGED — `<E extends DomainError>` constraint applies via AC8
```

`src/config/` is modified for AC8 only — `config.ts` and `config.test.ts`.

**No barrel files** (AR57 / `architecture.md:999`). Importers in later stories write `from '../domain/error.ts'` directly. The audit logger (Story 1.5) doesn't import from `domain/error.ts` — it imports `AuditEntryInput` and the `serializeForAudit` output spreads cleanly into that type.

### Latest tech information (researched 2026-04-30)

- **TS 6 + `as const satisfies` for runtime-iterable closed unions:**
  ```typescript
  export const REASON_CODES = ['permission_denied', /* ... */] as const satisfies ReadonlyArray<ReasonCode>;
  ```
  The `as const` ensures the array literal is `readonly ['permission_denied', ...]`; the `satisfies` clause guarantees structural compatibility with `ReadonlyArray<ReasonCode>` without widening the literal type. `erasableSyntaxOnly: true` (`tsconfig.json:11`) permits `as const` because it's a TypeScript-only annotation that erases at runtime.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:11`): the same trap Stories 1.4 and 1.5 hit. When building a `DomainError`, do NOT assign `ref: undefined` / `failedOperation: undefined` explicitly. Use successive property assignment on a `Record<string, unknown>` accumulator OR conditional spread:
  ```typescript
  const error: DomainError = {
    reason: 'permission_denied',
    details: { required, granted },
    ...(ref !== undefined ? { ref } : {}),
    ...(failedOperation !== undefined ? { failedOperation } : {}),
  };
  ```
  Same pattern as `audit-logger.ts:262-275` and `secret-scrubber.ts:55-104`.
- **`erasableSyntaxOnly: true`:** no `enum`, no `namespace`, no constructor parameter properties. Use plain `type` aliases, `const` literals, `function` declarations.
- **`verbatimModuleSyntax: true`:** `import { type Ref } from './ref.ts'` for type-only imports; `import { type DomainError } from './error.ts'` from `result.ts`. Match Story 1.5's `audit-logger.ts:1-7` style.
- **No `as` outside the brand-constructor exemption** (AR59): the formatter's switch over `error.reason` uses `assertExhaustive(reason: never): never { throw new Error(...) }` for the default arm — TypeScript narrows correctly without an `as`.
- **`@typescript-eslint/no-explicit-any` is enabled** (`eslint.config.js:21`): when narrowing `error.details.totalEdits` from `Record<string, unknown>`, use `typeof` guards or `unknown`-narrowing helpers, NEVER `as number` / `as any`.
- **`Object.getPrototypeOf` for plain-object check:** the standard idiom is `Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null`. Use this in `scrubSecrets`'s recursion to distinguish plain objects from class instances.
- **`WeakSet` for cycle detection:** `WeakSet` allows GC of unreferenced objects (memory-safe); `Set` would pin them. AC4 cycle case verified.
- **`MCPToolResult` shape stub:** the `@modelcontextprotocol/sdk`'s `CallToolResult` shape (looked up via `npm show @modelcontextprotocol/sdk@latest`) has `{ isError?: boolean; content: ContentBlock[]; _meta?: object }`. Our local stub `{ isError: true; content: [...] }` is a structural subset that the SDK type would accept via `satisfies` once Story 1.10 imports it. **Do NOT add the SDK dep in this story.**

### Previous story intelligence (from Stories 1.1, 1.2, 1.3, 1.4, 1.5)

Distilled patterns to apply:

1. **Top-level `await test(...)` is the established test pattern** — Story 1.1 Debug Log line 246, Story 1.2 Task 4, Story 1.3 Debug Log line 401, Story 1.4 dev-notes line 366, Story 1.5 dev-notes line 455. Do **not** introduce `describe` blocks.
2. **`@types/node@^24` is pinned.** No action needed.
3. **No `npm install` should be needed.** No new dependencies.
4. **`npx prettier --check .`** is the format gate. `.prettierignore` already excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep` — new `.ts` files under `src/` ARE checked.
5. **`npm pack --dry-run` baseline after Story 1.5:** 13 files. After this story: **13 files** (modify only, no add to pack).
6. **Pre-push hook** (`tests/smoke/stdout-discipline.test.ts`) does not exist yet (Story 1.12). `git push` will fail until then; that's intentional. AC11 verifies `npm run *` gates only.
7. **`@ts-expect-error` requires inline justification** (AR59 / `architecture.md:1032`). Avoid altogether in production code.
8. **No barrel re-exports** (AR57). Importers write the file path directly.
9. **Story 1.4's secret-scrubber lesson** (`src/config/secret-scrubber.ts`): `JSON.stringify({...wrapped})` (spread bypass) was a real attack surface — defended via non-enumerable getter. The D6 scrubber in this story is structural: it walks the object tree and replaces *named-key* values. Adversarial inputs like `Object.assign({}, { token: 'X' })` are still caught (the spread copies enumerable keys; `token` remains a key, and the walk catches it).
10. **Story 1.5's `exactOptionalPropertyTypes` pattern** (`audit-logger.ts:262-275`): build the entry on a `Record<string, unknown>` accumulator, then assign optional fields via `if (input.x !== undefined) base.x = input.x`. Mirror this in the per-reason constructors when populating `details`.
11. **Story 1.5's `void`-return pattern** for fire-and-forget contracts (AR61). Not applicable here — the formatter and serializer are pure functions returning values. The audit-write call site (Story 1.10) is the consumer.
12. **Diagnostic logger's `error(message, err?)` signature** — this story's `infrastructureError(err)` extracts `err.message` for `details.underlying`; the handler's catch (Story 1.10) calls `ctx.logger.error('handler crashed', err)` separately, sending the FULL stack trace to stderr. The two paths are distinct: the agent gets a clean message; the operator gets the full trace. AR45 #4 / `architecture.md:636`.
13. **Story 1.4's `Result<T, E extends DomainError>` constraint** (`src/domain/result.ts:13`): the constraint is preserved; `ConfigError` is reconciled to the new `DomainError` shape via AC8. **Do NOT loosen the constraint.**

### Git intelligence

Recent commits (`git log --oneline -5`):
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`

**Expected commit footprint for this story:** 1 modified file (`src/domain/error.ts`), 1 new file (`src/domain/error.test.ts`), and 2 modified files in `src/config/` (`config.ts` + `config.test.ts`) for the AC8 reconciliation. No deletions.

**Conventional Commits gate** lands in `a867ada`. This story's commit message should follow: `feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`.

### Critical guardrails (do not rediscover)

1. **The closed `ReasonCode` enum is locked at 6 values.** Adding or removing a value REQUIRES bumping `AUDIT_SCHEMA_VERSION` in `src/audit/schema.ts` per NFR16 / AR42 (`epics.md:94`, `architecture.md:640`). This is a **breaking change with documented migration**. Story 1.6 SETS the enum; subsequent stories MUST NOT extend it without a versioned schema migration story.
2. **Recovery wording for `freshness_violation` is exact.** AC2 of epic spec (`epics.md:445`) requires the literal substring `call read_page(<ref>) to refresh, then retry`. Tests assert with `assert.match`. Do NOT rephrase to "re-fetch" / "reload" / "read again".
3. **Recovery wording for all six reasons** is documented in AC5 with multi-line templates. Whole-template equality is asserted in tests. Do NOT improvise; if the wording feels stilted, file a deferred-work entry — do NOT change the templates without an updated story.
4. **`formatToolError` produces a single `content` text block, NOT `_meta`** (AR43 / `architecture.md:560-566`). Agent runtimes don't pass `_meta` to the LLM, so recovery instructions must live in `content`. **Do not split the block, do not use `_meta`, do not return multiple blocks.**
5. **Information-leak rules (AR45) are non-negotiable.**
   - Bearer token / `token` / `apiKey` / `secret` / `password` fields scrubbed structurally — every adversarial test in AC9 must pass.
   - `none`-mode body content is NEVER in `details` — `not_found` carries `details: {}`, period.
   - Internal MCP-server state (block-list, freshness cache, runtime-client diagnostics) is NEVER in `details` — only the per-reason context schemas defined in AC3.
   - Stack traces are NEVER in agent-facing text — `infrastructureError(err)` extracts `err.message` only; the full trace goes to the diagnostic logger via the handler's catch (Story 1.10).
6. **`ReasonCode` is a string literal union, NOT a TS `enum`** — `erasableSyntaxOnly: true` (`tsconfig.json:11`) forbids enums.
7. **`DomainError` is the single source of truth.** Both projections (`formatToolError`, `serializeForAudit`) read from the same shape. Code-review rule (AR42 / `architecture.md:640`): any change to `details` shape OR a new `ReasonCode` value updates both projections + bumps `AUDIT_SCHEMA_VERSION`. Single-PR change; never one-projection-only.
8. **`exactOptionalPropertyTypes: true`** — when building `DomainError`, NEVER assign `ref: undefined` / `failedOperation: undefined`. Use conditional spreads.
9. **No `as` casts outside boundary constructors** (AR59 / `architecture.md:1031`). The `MCPToolResult` literal `isError: true as const` and `type: 'text' as const` are NOT `as` casts (they're const-assertions). The brand-constructor exemption applies to `Ref` (consumed, not constructed here) and `AuditEntryId` (Story 1.5's territory).
10. **`@ts-ignore` and `@ts-expect-error` are forbidden without inline tracked-issue justification** (AR59 / `architecture.md:1032`).
11. **No `enum`, no `namespace`, no constructor parameter properties** (`erasableSyntaxOnly: true`).
12. **`scrubSecrets` is structural, not content-scanning.** A token embedded in a string literal (e.g., `{ message: 'failed: token=SECRET' }`) is NOT scrubbed. AR45 #1 / `architecture.md:633` mandates structural scrubbing only ("fields named token / apiKey / secret / password"). Document this limitation in the JSDoc on `scrubSecrets` and call out the deferred-work entry below.
13. **No fs / network / clock reads in any function in `src/domain/error.ts`.** Pure-domain core (AR58 / `epics.md:183`). Tests' Date instances are hand-constructed.
14. **`AuditEntry.reason: string` stays.** Story 1.5's deliberate forward-compat (`schema.ts:42-46`) accepts `ReasonCode`-shaped strings. Tightening to `ReasonCode` is **deferred** to a future story — see "Deferred from this story" below.
15. **Imports use `.ts` extension** (`tsconfig.json:14`). `from './ref.ts'`, `from '../diagnostic/logger.ts'`. `node:` builtins import normally (none used in this story — pure module).

### Story scope boundaries (DO NOT include)

- **The `RuntimeClient` calling `infrastructureError(err)` on HTTP failures** — Story 1.7. This story provides the constructor; 1.7 wires it.
- **The handler `try/catch/finally` shape** that calls `formatToolError(error)` from the failure path and `audit.write({ ...serializeForAudit(error), ... })` from `finally` — Story 1.10's `handler-template.ts` (AR53 / `epics.md:176`).
- **The permission engine emitting `permissionDeniedError`** — Story 1.8. The constructor's signature here is the contract; the call site is 1.8.
- **The edit-batch validator emitting `validationError({ ..., failedOperation: { index, operation, total } })`** — Story 2.1 (`epics.md:625`).
- **The `freshness_violation` constructor's call site** — Story 2.3 / 2.5 (`epics.md:638`, `epics.md:649`).
- **Tightening `AuditEntry.reason: string` to `ReasonCode`** — deferred. Risks a perceived schema bump under NFR16 even though the on-disk shape is unchanged. Document in the deferred-work ledger.
- **Moving `permissions/access-mode.ts` types** into `domain/` — Story 1.8 owns `AccessMode`. Story 1.6 uses `string` for `permissionDeniedError`'s `required`/`granted` parameters as forward-compat.
- **Adding the `@modelcontextprotocol/sdk` dependency** — Story 1.10/1.11 owns it. Local `MCPToolResult` stub bridges.
- **Content-scanning scrubber** (regex over string values for token-like patterns) — out-of-scope per architecture's structural-only mandate. Defer if a real exploit surfaces.
- **Recovery template localisation** — MVP is English-only. AR44's recovery mapping (`epics.md:163`) is the closed contract; localisation is a post-MVP feature.
- **Per-reason `details` schema validation at the audit-projection boundary** — the TS types are the contract; runtime validation would be redundant. (Story 1.10 handler-template tests exercise the shapes end-to-end.)
- **`docs/audit-log.md` schema reference + jq examples** — Story 1.13 (AR65 / `epics.md:194`).
- **`docs/threat-model.md` honesty disclosure of token-scrubber's structural limits** — Story 1.13 (AR63 / `epics.md:192`).
- **Pretty-printing the formatter's text output** — JSONL on the audit side, plain-text on the MCP side. Both deterministic.
- **A `_meta`-projection variant of `formatToolError`** — explicitly disallowed by AR43 / `architecture.md:562-566`.

### Deferred from this story (proposed deferred-work entries)

1. **Tighten `AuditEntry.reason` from `string` to `ReasonCode`** — Story 1.5's deliberate forward-compat lives at `src/audit/schema.ts:42-46`. After 1.6 lands, tightening is mechanically safe (the on-disk shape is unchanged), but Story 1.5's dev-notes deferred the decision pending experience with the closed enum across multiple stories. Revisit when Story 1.10 has wired the handler-template, OR if a non-`ReasonCode` value is ever found in an audit entry. (`src/audit/schema.ts:42-46`)
2. **Content-scanning secret scrubber** — `scrubSecrets` is structural-only (AR45 #1 wording). A token embedded in an error message string (`new Error('auth failed: token=SECRET')`) would survive scrubbing. Real-world: HTTP libraries don't typically embed secrets in error messages, but Cloudflare's edge errors and some upstream proxies have done it historically. Revisit if a production audit log surfaces such a leak. Tracked as a known limitation in the JSDoc on `scrubSecrets`.
3. **`MCPToolResult` move to a shared types file** — when Story 1.10 lands `@modelcontextprotocol/sdk`, the local `MCPToolResult` type can be replaced by `import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'`. The migration is mechanical (`MCPToolResult` is a structural subset).
4. **Locking the `DomainError.failedOperation.operation` type to `Edit`** — currently `object`, per architecture's deliberate looseness (`architecture.md:543`). When Story 2.1 lands the `Edit` discriminated union, `failedOperation.operation` could be tightened to `Edit` for type-safety. Revisit when 2.1 lands.
5. **`scrubSecrets` shape-aware variant** for header arrays (e.g., `[{ name: 'authorization', value: 'X' }]`) — current scrubber is field-name-keyed. Many HTTP libraries use array-of-pairs for headers (`undici`, `node-fetch`), and a token would survive in the `value` field. Revisit if `RuntimeClient` (Story 1.7) surfaces this shape.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.6] (lines 429-463)
- D6 — Error Response Structure: [Source: _bmad-output/planning-artifacts/architecture.md#D6] (lines 533-640)
- DomainError type definition: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 537-555)
- Per-reason text templates (verbatim): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 568-617)
- Per-reason recovery template mapping: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 618-629)
- Information-leak rules (AR45): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 631-636)
- Implementation seam (formatter + serializer co-located): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 638-640)
- Two-projections rationale: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 557-566)
- Why text not JSON: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 562-566)
- AR42 (single internal type, two projections): [Source: _bmad-output/planning-artifacts/epics.md] (line 161)
- AR43 (text via `content`, `isError: true`): [Source: _bmad-output/planning-artifacts/epics.md] (line 162)
- AR44 (recovery template per reason): [Source: _bmad-output/planning-artifacts/epics.md] (line 163)
- AR45 (information-leak rules): [Source: _bmad-output/planning-artifacts/epics.md] (line 164)
- AR46 (batch identifies failing op): [Source: _bmad-output/planning-artifacts/epics.md] (line 165)
- AR30 (closed reason vocabulary): [Source: _bmad-output/planning-artifacts/epics.md] (line 145)
- AR58 (acyclic dependency rule, pure-domain core): [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 (no `as` outside boundaries): [Source: _bmad-output/planning-artifacts/epics.md] (line 186), [Source: _bmad-output/planning-artifacts/architecture.md#Type-safety patterns] (lines 1028-1032)
- AR60 (discriminated union exhaustiveness): [Source: _bmad-output/planning-artifacts/epics.md] (line 187)
- FR26 (structured error responses): [Source: _bmad-output/planning-artifacts/epics.md] (line 62)
- NFR8 (no internal state via tool surface): [Source: _bmad-output/planning-artifacts/epics.md] (line 80)
- NFR16 (versioned audit schema): [Source: _bmad-output/planning-artifacts/epics.md] (line 94)
- D4 audit schema (for cross-reference with serializer): [Source: _bmad-output/planning-artifacts/architecture.md#D4] (lines 386-468)
- Implementation sequence (this story = #6): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 818)
- Cross-component dependency map (DomainError + formatter): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 836-837)
- Source-tree contract for `src/domain/error.ts`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (line 1255)
- Tool-handler shape (consumer of formatToolError): [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1036-1108)
- Error-handling discipline: [Source: _bmad-output/planning-artifacts/architecture.md#Error-handling discipline] (lines 1110-1121)
- `formatToolError` invocation site in handler template: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1058, 1066, 1074, 1086)
- Existing placeholder `DomainError`: [Source: src/domain/error.ts] (lines 1-12)
- Existing `Result<T>` constraint: [Source: src/domain/result.ts] (lines 13-15)
- Existing `ConfigError` (target of AC8 migration): [Source: src/config/config.ts] (lines 36-41)
- Existing `formatConfigError`: [Source: src/config/config.ts] (lines 222-254)
- Existing `issueToConfigError`: [Source: src/config/config.ts] (lines 89-141)
- Existing `AuditEntry.reason` (consumer of `serializeForAudit` output): [Source: src/audit/schema.ts] (lines 52-64)
- Existing `AuditEntryInput` (target of `serializeForAudit` spread): [Source: src/audit/schema.ts] (line 70)
- `Ref` primitive (DomainError.ref type): [Source: src/domain/ref.ts] (lines 8, 117-122)
- Story 1.4 secret-scrubber pattern (orthogonal but instructive): [Source: src/config/secret-scrubber.ts]
- Story 1.5 `exactOptionalPropertyTypes` build pattern: [Source: src/audit/audit-logger.ts] (lines 256-275)
- Story 1.5 `treatAsErrored` defensive throw-catch pattern (instructive for `infrastructureError`): [Source: src/audit/audit-logger.ts] (lines 333-345)
- Stream/output discipline (handler-side stack traces go to diagnostic): [Source: _bmad-output/planning-artifacts/architecture.md#Stream/output discipline] (lines 1144-1148)
- Mandatory rules summary: [Source: _bmad-output/planning-artifacts/architecture.md#Mandatory rules] (lines 1167-1180)
- Anti-patterns (catching DomainError to reformat — explicit forbidden): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1188-1193)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md], [Source: _bmad-output/implementation-artifacts/1-4-configuration-module-and-secret-scrubber.md], [Source: _bmad-output/implementation-artifacts/1-3-diagnostic-logger.md], [Source: _bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **`Object.getPrototypeOf(value)` returns `unknown` under TS strict** — flagged by `@typescript-eslint/no-unsafe-*` until I cast to `unknown` and compared to `Object.prototype` / `null`. Inline `as unknown` annotation accepted (boundary inside `isPlainObject`). (`src/domain/error.ts:119`)
- **`scrubSecrets` returns `unknown`** — initial test asserted `.constructor` on the result, which `unknown` doesn't permit. Dropped the redundant assertion; the adjacent `assert.deepStrictEqual` already pins shape. (`src/domain/error.test.ts:233`)
- **`JSON.parse(JSON.stringify(...))` triggers `@typescript-eslint/no-unsafe-assignment`** — `JSON.parse` returns `any`. Annotated `const round: unknown = ...` so the unsafe-`any` rule sees the explicit narrowing. (`src/domain/error.test.ts:551`)
- **Stack-trace negative assertion regex** — `/^\s+at\s/m` matches a multi-line stack frame (whitespace + `at `). Combined with `!text.includes('at Object.<anonymous>')` to catch both Node's typical and Bun's atypical formats.
- **`'failedOperation' in projection === false`** — used the `'key' in obj` form per Story 1.5 dev-notes line 506 because `assert.strictEqual(projection.failedOperation, undefined)` is incompatible with `exactOptionalPropertyTypes: true` (TS rejects assigning `undefined` to an optional property type).
- **`Object.assign(new Error('...'), { code: 'ECONNREFUSED' })` is the canonical fixture** for adding a NodeJS errno to a thrown `Error` — used in the `infrastructureError` errno-promotion test. Avoids `as unknown as { code: string }` casting.
- **Verbatim recovery wording for `freshness_violation`** — the literal substring `'call read_page("' + ref + '") to refresh, then retry'` appears in the rendered text exactly once and matches the `/call read_page\("[^"]+"\) to refresh, then retry/` regex. Tests assert both the regex and the substring (defence-in-depth).
- **Prettier reflowed the test file's long deepStrictEqual lines** and the formatter's switch arms — no semantic change, all files pass `prettier --check`.
- **No new dependencies; no `npm install` run.** Module is pure-domain, depends only on `Ref` from sibling.
- **Pack manifest unchanged at 13 files.** `src/domain/error.ts` was already in the manifest as the placeholder; this story modifies it. `src/domain/error.test.ts` is excluded by `"!src/**/*.test.ts"`.
- **Test count:** 164 → 218 (+54), exceeds the +50 floor. Per-section breakdown: REASON_CODES + exhaustiveness (2), constructors (8), scrubSecrets (14), formatToolError templates (9), AR45 leak rules (6), serializeForAudit (8), MCPToolResult invariants (1), plus existing config.test.ts cases preserved (6 formatConfigError + 8 loadConfig assertions migrated to nested `details.*` shape).
- **Sprint-status transitions:** 1-6 backlog (start) → ready-for-dev (after create-story) → in-progress (start of dev-story) → review (this commit).

### Completion Notes List

- All 11 ACs satisfied; all 8 tasks (with subtasks) ticked. Validation gates: `npm run typecheck` exit 0, `npm run lint` exit 0, `npx prettier --check .` clean, `npm test` 218/218 pass (was 164 → +54 cases), `npm pack --dry-run` 13 files (unchanged from post-1.5; `error.ts` modified in-place, `error.test.ts` excluded).
- **Closed `ReasonCode` enum + `REASON_CODES` runtime tuple (AC1):** Six values in the order documented in D6. `as const satisfies ReadonlyArray<ReasonCode>` guarantees runtime tuple identity AND structural compatibility — `erasableSyntaxOnly: true` permits both annotations (both erase at runtime). Adding a value REQUIRES bumping `AUDIT_SCHEMA_VERSION` per NFR16.
- **Canonical `DomainError` shape (AC2):** `{ reason, ref?, details, failedOperation? }` per `architecture.md:537-555` verbatim. `details` is required (per architecture); `ref` and `failedOperation` are conditional via spread. Replaces the placeholder `{ reason, message }` from Story 1.2.
- **Six per-reason constructors (AC3):** `permissionDeniedError`, `freshnessViolationError`, `validationError`, `infrastructureError`, `configError`, `notFoundError`. Each populates `details` with the reason-specific schema documented in the AC table. `permissionDeniedError`'s `required`/`granted` typed `string` for forward-compat with Story 1.8's `AccessMode` (architecturally located in `permissions/access-mode.ts`, not `domain/`). `infrastructureError` runs `scrubSecrets` over the entire caught value AND promotes NodeJS errno `code` to `details.code` when present.
- **`scrubSecrets` recursive structural redactor (AC4):** Closed key-set `{ authorization, token, apikey, secret, password }` (case-insensitive). Plain objects + arrays recurse. `Error` → `err.message` (never the stack — AR45 #4). `Date` → `toISOString()` (audit-shape consistency). Other class instances → `Object.prototype.toString.call(value)` (safe sentinel like `'[object Map]'`). Cycles → `'<cycle>'` via `WeakSet`. Primitives + null/undefined pass-through. **Structural-only — content-scanning is documented as deferred-work** (`epics.md`-tracked limitation).
- **`formatToolError` per-reason templates (AC5):** Six templates rendered verbatim per D6's worked examples. Each test asserts whole-string equality on the multi-line template OR uses regex/substring assertions for the wording-stable parts. Verbatim recovery for `freshness_violation` matches the `/call read_page\("[^"]+"\) to refresh, then retry/` pattern — non-negotiable per AC2 of epic spec.
- **`MCPToolResult` local stub (AC5):** Structural subset of `@modelcontextprotocol/sdk/types.js#CallToolResult`. Story 1.10/1.11 will swap to the SDK type via `satisfies CallToolResult` — mechanical migration since the local stub is a strict subset.
- **`serializeForAudit` projection (AC6):** `{ reason, details, failedOperation? }` — `ref` is deliberately NOT projected (audit logs the ref via `args` per AR31). Spreads cleanly into `AuditEntryInput` from `src/audit/schema.ts:70` because `ReasonCode` ⊆ `string`.
- **AR45 information-leak rules (AC7):** All four rules verified by adversarial fixtures.
  - **#1 (no token leak):** `Bearer SECRET-TOKEN` in `Authorization` header → rendered text contains neither `'SECRET-TOKEN'` nor `'Bearer'`. Same for `token` / `apiKey` / `secret` / `password` field leaks.
  - **#2 (no none-mode body):** `notFoundError` populates `details: {}` exactly — context block is the `Page:` line only, asserted by line-by-line counting.
  - **#3 (no internal state):** `permissionDeniedError` rendered text contains only the `Page:`, `Required:`, `Granted:` lines — no `block` / `resolution` / `cache` substrings.
  - **#4 (no stack traces):** `infrastructureError(new Error('boom'))` rendered text contains `'boom'` (the message) but NOT `'at Object.<anonymous>'` and NOT any `/^\s+at\s/m` line.
- **`ConfigError` reconciliation (AC8):** Migrated to nested `details: { variable, rule, message }` shape so it satisfies `<E extends DomainError>` structurally. `formatConfigError` reads from `details.*`; the `{ fatal, hint }` output is unchanged (no behavioural drift). `issueToConfigError` simplified via a `makeConfigError` helper. Existing `config.test.ts` assertions migrated from `error.variable` / `error.rule` to `error.details.variable` / `error.details.rule`. **Zero new tests added** — Story 1.4's coverage is sufficient.
- **`AuditEntry.reason: string` left untouched** — Story 1.5's deliberate forward-compat (`schema.ts:42-46`) accepts `serializeForAudit`'s `ReasonCode`-shaped strings without modification. Tightening to `ReasonCode` is **deferred** per the deferred-work entry below.
- **No edits outside `src/domain/error.ts`, `src/domain/error.test.ts`, `src/config/config.ts`, `src/config/config.test.ts`.** No changes to `src/audit/`, `src/diagnostic/`, `src/index.ts`, `eslint.config.js`, `tsconfig.json`, `package.json`, `.gitignore`, or any documentation.
- **No new dependencies.** `@modelcontextprotocol/sdk` arrives in Story 1.10/1.11 — bridged via the local `MCPToolResult` stub.
- **Open questions for review:** none. The `MCPToolResult` local stub, the structural-only scrubber limitation, the `permissionDeniedError` forward-compat string typing, and the `AuditEntry.reason` deferral are all documented in JSDoc and dev-notes "Deferred from this story" section.

### File List

**New:**
- `src/domain/error.test.ts`

**Modified:**
- `src/domain/error.ts` (replaced placeholder with full canonical module)
- `src/config/config.ts` (`ConfigError` shape migrated to nested `details`; `issueToConfigError` factored via `makeConfigError`; `formatConfigError` reads from `details.*`)
- `src/config/config.test.ts` (assertions migrated from `error.variable` / `error.rule` to `error.details.variable` / `error.details.rule`; ConfigError fixtures in `formatConfigError` tests rebuilt with nested-details shape)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: 1-6 backlog → ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/1-6-domainerror-formatter-and-audit-serializer.md` (Tasks/Subtasks ticked; Dev Agent Record / File List / Change Log filled; Status: ready-for-dev → review)

**Deleted:**
- (none)

### Change Log

- 2026-04-30: Initial implementation. Replaced placeholder `DomainError` with the canonical D6 shape; added six per-reason constructors, `scrubSecrets`, `formatToolError`, `serializeForAudit`. Reconciled `ConfigError` to satisfy `<E extends DomainError>`. 218/218 tests pass; all gates green.

### Review Findings

Adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor), 2026-04-30. 5 patches recommended, 8 deferred, 12 dismissed as noise.

- [x] [Review][Patch] `scrubSecrets` mis-flags DAGs as cycles — fixed via try/finally enter-exit semantics on the `seen` WeakSet. Regression test: `scrubSecrets handles DAGs (same object referenced twice) without false cycle`. [src/domain/error.ts:123-184]
- [x] [Review][Patch] Prototype-pollution vector via `__proto__` own key — fixed via `Object.defineProperty` for output assignment, bypassing the inherited `__proto__` setter. Regression test: `scrubSecrets does not pollute output prototype via __proto__ own key`. [src/domain/error.ts:170-178]
- [x] [Review][Patch] `scrubSecrets` crashes on Invalid Date — guarded with `Number.isNaN(value.getTime())`, returning `'<invalid-date>'` sentinel. Regression test: `scrubSecrets renders Invalid Date as <invalid-date> sentinel`. [src/domain/error.ts:148-152]
- [x] [Review][Patch] Batch-validation recovery wording renders gibberish when ref absent — branched the recovery line on ref presence; ref-absent path drops the literal `read_page("...")` example. [src/domain/error.ts:464-475]
- [x] [Review][Patch] AC9 #12 missing test — added `scrubSecrets does NOT scrub header-array structures (AC9 #12 limitation)` test fixture. [src/domain/error.test.ts]
- [x] [Review][Defer] AC5 batch-validation `Page:` line conditional in code, unconditional in spec template — only matters if a future caller omits ref. [src/domain/error.ts:465]
- [x] [Review][Defer] AC4 wording ambiguity — spec says Error returns `{ name, message, code? }` AND `err.message`; impl chose `err.message`. Internally inconsistent spec; impl is defensible.
- [x] [Review][Defer] No length cap on `JSON.stringify(underlying)` in `infrastructure_error` text — multi-MB SilverBullet error body could bloat agent response. [src/domain/error.ts:477-478]
- [x] [Review][Defer] `Ref` containing `"` would break `freshness_violation` / batch-validation recovery template's `read_page("…")` regex match — `Ref` validator does not forbid `"`. Story 1.2 territory; revisit if exploit surfaces. [src/domain/ref.ts:28]
- [x] [Review][Defer] `validationError` accepts negative / NaN / non-integer `index` and `total` without bounds checks — pure-domain trust-the-caller per spec. [src/domain/error.ts:259-276]
- [x] [Review][Defer] `infrastructureError(undefined | null)` renders `Underlying error: undefined` — caller responsibility per `unknown` signature. [src/domain/error.ts:302]
- [x] [Review][Defer] `extractCode` and `Object.entries` could throw if a property getter or Proxy trap throws — extreme upstream-library edge. [src/domain/error.ts:154,278-283]
- [x] [Review][Defer] BigInt and Symbol-keyed properties pass through `scrubSecrets`; BigInt later breaks `JSON.stringify`. Document alongside structural-only caveat. [src/domain/error.ts:124,154]
