# Story 1.7: SilverBullet Runtime Client & Latency Baseline

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the only network-touching module in the project,
I want a minimal `RuntimeClient` with `exec`/`ping`/`probe` primitives that talk to SilverBullet's `/.runtime/lua` endpoint via a base64+JSON envelope,
so that every other module can stay pure and the test suite can mock at this single seam.

## Acceptance Criteria

**AC1 — `RuntimeClient` interface at `src/silverbullet/client.ts` exposes exactly three methods**

**Given** the runtime-client module at `src/silverbullet/client.ts`,
**When** I import its public surface,
**Then** it exports a type:

```typescript
export type RuntimeClient = {
  exec<T>(script: string, params?: Readonly<Record<string, unknown>>): Promise<T>;
  ping(): Promise<void>;
  probe(): Promise<void>;
};
```

with **exactly these three methods** — no `readPage`, no `pageMeta`, no `queryConfigBlocks`, no `listPages` etc. on the interface. AR21 (`epics.md:134`) / D3 (`architecture.md:308-320`) lock this surface.

**And** every higher-level operation (read-page, page-meta, list-pages, search-pages, query-config-blocks) is invoked by tool-handler code (Story 1.10+) by passing a Lua template string + params to `exec<T>`. The runtime client is the **only** module in the project that performs network I/O (NFR21 `epics.md:101`, AR58 `epics.md:183`).

**And** `exec<T>` accepts an optional `params` object. When `params` is omitted (or `{}`), the envelope encoder still works (AC3) — the Lua prelude binds `_p = {}` so script bodies referencing `_p.<field>` see `nil` for unset fields, not a runtime error.

**And** `ping()` corresponds to `GET /.ping` and resolves on `200`; non-`200` rejects with an `infrastructure_error` `DomainError` (AC5).

**And** `probe()` corresponds to `POST /.runtime/lua` body `1` (the literal Lua source `1`) and resolves only when the response JSON parses as `{"result": 1}`; any other response (`503`, `401`/`403`, malformed JSON, `result !== 1`) rejects with an `infrastructure_error` `DomainError` carrying enough context for the startup ladder (Story 1.11) to render the AR39 distinct-error messages.

**AC2 — Factory `createRuntimeClient(opts)` builds a client bound to a `Config` + `fetch`**

**Given** the same module,
**When** I import `createRuntimeClient`,
**Then** the signature is:

```typescript
export type CreateRuntimeClientOptions = {
  readonly config: Pick<Config, 'silverbulletUrl' | 'silverbulletToken'>;
  readonly fetch?: typeof globalThis.fetch;  // injected for tests
};

export function createRuntimeClient(opts: CreateRuntimeClientOptions): RuntimeClient;
```

**And** when `opts.fetch` is omitted, the production wiring uses `globalThis.fetch` (Node ≥ 24 ships this natively; no `node-fetch` / `undici` dependency is added).

**And** the factory is **pure** — no I/O, no network calls. It simply closes over the config + fetch and returns a `RuntimeClient`. Tests construct the client directly with a fake `fetch` (no global stubbing).

**And** the wrapped `Config` (Story 1.4 — `WrappedConfig`) is structurally compatible: `Pick<Config, ...>` only reads `silverbulletUrl` (string) and `silverbulletToken` (the live-getter string). The wrapper's `toString` / `toJSON` masking is preserved — tests assert the runtime client never includes the `WrappedConfig` instance in any user-visible value (`Authorization` header is built from the token primitive directly).

**AC3 — Envelope encoder at `src/silverbullet/envelope.ts` is base64+JSON, injection-safe**

**Given** the envelope module at `src/silverbullet/envelope.ts`,
**When** I import its public surface,
**Then** it exports:

```typescript
export function buildScript(template: string, params?: Readonly<Record<string, unknown>>): string;
```

**And** `buildScript`:
1. Computes `payload = Buffer.from(JSON.stringify(params ?? {})).toString('base64')`. The base64 alphabet is `[A-Za-z0-9+/=]`, which contains **zero** Lua-string-literal escape characters — naive double-quote interpolation into the Lua source is provably injection-safe (D3 / `architecture.md:322-338`).
2. Returns a script wrapped in an immediately-invoked function expression (IIFE) so the entire body remains a single Lua expression. SB's `POST /.runtime/lua` evaluates body via an `eval`-style path that prepends an implicit `return`; a bare `local _p = ...` block fails to parse with "unexpected symbol near 'l'", so the IIFE wrapper is **load-bearing**. The decode chain inside the prelude uses `encoding.base64Decode` + `encoding.utf8Decode` + `js.window.JSON.parse` + `js.tolua` rather than `json.decode` / `base64.decode` — verified at story time (AC10 #2 resolution): `json` and `base64` are NOT exposed as Lua globals on this SB version, but `encoding.*` and the `js.*` interop bridge are. The rendered prelude shape is fixed:

   ```
   (function()
   local _p = js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode("<payload>"))))
   <template>
   end)()
   ```

3. **Never** raw-interpolates any value from `params` into the Lua source string. The tests at `envelope.test.ts` assert this with adversarial inputs like `'; os.exit() --`, `\\"); evil()`, `]]; os.exit()--[[`, control-character-bearing strings, lone surrogates, and nested objects (AC of epic spec / `epics.md:480`). For each, the encoded payload, when base64-decoded and JSON-parsed, MUST round-trip to the original value byte-for-byte; the surrounding Lua source MUST contain only the fixed prelude template + a `[A-Za-z0-9+/=]`-only payload.

**And** the envelope is **pure** — no I/O. Buffer + JSON + base64 only.

**And** `buildScript('return _p.x', { x: 1 })` produces a string of the shape:
```
(function()
local _p = js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode("eyJ4IjoxfQ=="))))
return _p.x
end)()
```
(line endings normalised to `\n`; payload alphabet restricted to `[A-Za-z0-9+/=]`).

**Amendment (2026-04-30 review):** the original AC3 wording prescribed the prelude `local _p = json.decode(base64.decode("..."))\n${template}` with no IIFE. Story-time verification (AC10 #2) showed this fails on SB's runtime endpoint for two independent reasons: (1) the eval-style endpoint prepends an implicit `return`, rejecting bare statement blocks; (2) `json` / `base64` globals are absent. The amendment above records the empirically-correct decode chain. The AR22 injection-safety property is preserved unchanged — base64-only payload, never raw-interpolated.

**AC4 — `exec<T>(script, params)` posts to `/.runtime/lua`, parses `result`, returns typed `T`**

**Given** a configured client and a `fetch` test double,
**When** I call `client.exec<T>(template, params)`,
**Then** the implementation:
1. Builds the script source via `buildScript(template, params)` (AC3).
2. Issues `POST <silverbulletUrl>/.runtime/lua` with:
   - Header `Authorization: Bearer <silverbulletToken>` (AR25 `epics.md:138`).
   - Header `Content-Type: text/x-lua` (D3 / SB's Runtime API contract; verify exact MIME at story time, see AC10 deferred questions).
   - Body: the script source (raw text, NOT JSON-wrapped — the Runtime API takes Lua source directly per D3 `architecture.md:295`).
3. On `response.ok`: reads the response body as text → `JSON.parse(body)` → returns the parsed object's `result` field as `T`. The asymmetry vs. AC3 is intentional (D3 `architecture.md:335`): we own the script side; SB controls the response shape.
4. On `!response.ok`: rejects with `infrastructureError` (AC5).
5. On `JSON.parse` failure: rejects with `infrastructureError` carrying `{ underlying: 'invalid JSON in /.runtime/lua response', code: 'EBADRESPONSE' }`. The fetch body that failed to parse is **not** included in the rejection (it could carry secret-bearing content from a misconfigured SB error page — leave the body to the diagnostic logger via the handler's catch in Story 1.10).
6. On `fetch` throwing (network error, DNS failure, connection refused): rejects with `infrastructureError(err)` — the per-reason constructor's secret scrubber (Story 1.6) handles any auth-bearing fields the network library wraps into the error.

**And** `exec<T>` returns `Promise<T>` — the type parameter is **always** supplied by the call site (AR23 `epics.md:136` — no implicit `any` propagating from `exec`). The `T` is enforced by call-site convention; the implementation casts the parsed `result` once at the boundary via `as T` (this is one of the AR59-permitted `as` sites: parsed external input narrowing into a typed value, analogous to a zod-parsed boundary; document inline).

**AC5 — Non-200 / network failures wrap as `infrastructure_error` `DomainError` with scrubbed body**

**Given** the runtime client encountering a non-`200` response from SilverBullet,
**When** the error path runs,
**Then** the rejection value is built via `infrastructureError(err)` (Story 1.6 / `src/domain/error.ts:323`), where `err` is a plain object of the shape:

```typescript
{
  message: string,           // e.g. 'silverbullet runtime API returned 503'
  status: number,            // e.g. 503
  code?: string,             // e.g. 'EBADSTATUS' for non-200, 'EUNAUTHORIZED' for 401/403, 'ESBRUNTIME' for 503, 'EBADRESPONSE' for parse failures
  body?: unknown,            // best-effort JSON-parsed body OR truncated (≤ 2 KiB) text
}
```

**And** the `infrastructureError` constructor's `scrubSecrets` recursion (Story 1.6 AC4) runs over this object before it is stamped into `details.underlying`. Adversarial fixtures in `client.test.ts` MUST verify:
- A `503` response whose body contains `{ "Authorization": "Bearer SECRET" }` does NOT surface `'SECRET'` in the rejection's `details.underlying` projection.
- A `401` response whose body contains `{ "token": "SECRET" }` does NOT surface `'SECRET'`.

**And** the `code` field follows a closed mini-vocabulary the startup ladder (Story 1.11) can switch on for AR39's distinct error messages:

| HTTP status / failure | Mapped `code` | AR39 startup message intent |
|---|---|---|
| `503` | `'ESBRUNTIME'` | "Runtime API not enabled — see `https://silverbullet.md/Runtime%20API`" |
| `401` / `403` | `'EUNAUTHORIZED'` | "authentication failed — check `SILVERBULLET_TOKEN`" |
| Other non-2xx | `'EBADSTATUS'` | underlying status surfaced |
| JSON parse failure | `'EBADRESPONSE'` | "invalid JSON in `/.runtime/lua` response" |
| `fetch` throw / DNS / ECONNREFUSED | (use Node's underlying `err.code` if present, e.g. `'ECONNREFUSED'`) | underlying network error surfaced |

The mapping table is exported from `client.ts` as `RUNTIME_ERROR_CODE` so the startup ladder can `switch` on the constants instead of magic strings.

**And** the bearer token (`opts.config.silverbulletToken`) is **never** echoed in any rejection value, log line, or response body record. Story 1.6's `scrubSecrets` is structural; the runtime client additionally verifies via inspection that the token primitive is only ever read into the `Authorization` header builder and never appended to any error payload.

**AC6 — Lua scripts ship as `.lua.ts` modules under `src/silverbullet/scripts/` with typed return shapes**

**Given** the directory `src/silverbullet/scripts/`,
**When** I list it,
**Then** **exactly five** `.lua.ts` files exist (Epic 1 reach only — Epic 2 ships the write-side scripts):

```
src/silverbullet/scripts/
├── read-page.lua.ts            # type ReadPageResult = { content: string; lastModified: string }
├── list-pages.lua.ts           # type ListPagesResult = { pages: ReadonlyArray<{ ref: string; lastModified: string }> }
├── search-pages.lua.ts         # type SearchPagesResult = { hits: ReadonlyArray<{ ref: string; score: number }> }
├── query-config-blocks.lua.ts  # type QueryConfigBlocksResult = { blocks: ReadonlyArray<{ page: string; access: string; exact?: boolean }> }
└── page-meta.lua.ts            # type PageMetaResult = { lastModified: string }
```

**And** each `.lua.ts` file exports both:
1. `export const <name>Script: string` — the Lua template (no caller-supplied interpolation; `_p.<field>` references the envelope-bound payload).
2. `export type <Name>Result` — the TypeScript type of the script's return value (AR23 `epics.md:136`).

**And** every script body references `_p.<field>` (or `_p` directly) for params; **no** `..` Lua concatenation of caller-supplied values into the script body. The envelope encoder (AC3) is the **only** sanctioned mechanism for parameter passing.

**And** each script's return value is a Lua table that, when JSON-encoded by the Runtime API, produces the documented `<Name>Result` shape. The exact space-lua API names used inside the scripts (e.g., `space.readPage` vs. `space_lua.read_page`) are **deferred to story time** per `architecture.md:850` — the dev tasks (Task 5) include verifying against current SB source.

**And** for the `query-config-blocks.lua.ts` script (Story 1.8's consumer):
- The script queries `index.queryLuaObjects("mcp/config", ...)` returning blocks tagged `#mcp/config`.
- Each block in the result has `{ page: string, access: string, exact?: boolean }` — the parser in Story 1.8 widens `access: string` into the closed `AccessMode` union and treats out-of-range values as `config_error` (NFR11 fail-closed / AR17).

**And** the `read-page.lua.ts` script's return shape is `{ content: string; lastModified: string }` — `content` is the page body; `lastModified` is an ISO-8601 UTC timestamp string. The handler (Story 1.10) calls `freshness.touch(ref, new Date(lastModified))` on success.

**AC7 — `client.test.ts` exercises the contract against an HTTP fixture (no live SB)**

**Given** the contract test suite at `src/silverbullet/client.test.ts`,
**When** `npm test` runs,
**Then** the runtime client is exercised with a hand-rolled `fetch` test double (typed as `typeof globalThis.fetch`) — **no live SB**, **no `MSW`**, **no network mocking library**. NFR21 `epics.md:101`. The test double:
- Captures every call: `{ url, method, headers, body }` for assertions.
- Returns a configured `Response` per case (success body, non-2xx, throwing).

**And** the suite covers (≥ 18 cases):

**Envelope construction (AC3 cross-checks; further envelope-specific cases live in `envelope.test.ts`):**
1. `client.exec<{ x: number }>('return { x = _p.n }', { n: 42 })` → fetch is called once with body containing `local _p = json.decode(base64.decode("..."))\nreturn { x = _p.n }`. The base64 payload decodes to `'{"n":42}'`.
2. `client.exec` with `params: undefined` (no second arg) → fetch body's prelude embeds the base64 of `'{}'`.

**Success-path response parsing (AC4):**
3. Fetch returns `{ ok: true, status: 200, text: async () => '{"result":{"x":42}}' }` → `exec<{ x: number }>` resolves with `{ x: 42 }`.
4. Fetch returns `{ ok: true, status: 200, text: async () => '{"result":null}' }` → `exec<null>` resolves with `null`.
5. Fetch returns `{ ok: true, status: 200, text: async () => '{"result":"hello"}' }` → `exec<string>` resolves with `'hello'`.

**Error-path → `infrastructure_error` (AC5):**
6. Fetch returns `{ ok: false, status: 503, ... }` → rejects with `DomainError` whose `reason === 'infrastructure_error'` and `details.code === 'ESBRUNTIME'`.
7. Fetch returns `{ ok: false, status: 401, ... }` → `details.code === 'EUNAUTHORIZED'`.
8. Fetch returns `{ ok: false, status: 403, ... }` → `details.code === 'EUNAUTHORIZED'`.
9. Fetch returns `{ ok: false, status: 500, ... }` → `details.code === 'EBADSTATUS'`.
10. Fetch returns `{ ok: true, status: 200, text: async () => 'NOT JSON' }` → `details.code === 'EBADRESPONSE'`.
11. Fetch throws `Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })` → rejects with `details.code === 'ECONNREFUSED'`. (Underlying-network errno passes through unchanged.)

**Auth header / hygiene (AR25, NFR5):**
12. Every successful fetch carries header `Authorization: Bearer <token>` exactly. (Token comes from a fixture string `'TEST-TOKEN-VALUE'`.)
13. Token-leak adversarial: a `503` response whose body contains `{ "Authorization": "Bearer SECRET" }` → rejection's `details.underlying` (after `scrubSecrets`) does NOT contain the substring `'SECRET'` or `'Bearer SECRET'`.
14. Token-leak adversarial: a `401` response whose body contains `{ "token": "SECRET" }` → rejection's `details.underlying` does NOT contain `'SECRET'`.

**`ping()` (AC1):**
15. `client.ping()` issues `GET <url>/.ping` (no Auth header — the `.ping` endpoint is documented as unauthenticated; verify at story-time). Returns on `200`. Non-`200` rejects as `infrastructure_error`.

**`probe()` (AC1):**
16. `client.probe()` issues `POST <url>/.runtime/lua` body `1` (the Lua source — single character) and resolves when response is `{"result":1}`. Non-`{"result":1}` returns rejects with `infrastructure_error` (`code: 'ESBRUNTIME'`).
17. `client.probe()` returning `{"result":0}` (or any other shape) → rejects with `infrastructure_error` carrying enough context for the startup ladder to render the "Runtime API responded but did not echo `1`" message.

**URL composition / config injection:**
18. Constructing the client with `silverbulletUrl: 'https://sb.example.com'` (no trailing slash) AND with `'https://sb.example.com/'` (trailing slash) both produce identical fetch URLs (`https://sb.example.com/.ping`, `https://sb.example.com/.runtime/lua`). No double-slash.

**And** every test case is **deterministic** (`Date.now()` not invoked outside the latency-baseline harness; `Math.random` not used by the production path). No fs / network / clock side effects; the only dependencies are the injected `fetch` double + hand-constructed `Config` fixture.

**AC8 — `envelope.test.ts` covers adversarial-input injection-safety**

**Given** the envelope module's tests at `src/silverbullet/envelope.test.ts`,
**When** `npm test` runs,
**Then** ≥ 8 adversarial cases prove `buildScript(template, params)` is injection-safe:

1. **Lua escape characters in string param:** `params = { x: '"; os.exit() --' }` → the encoded script body's payload section is base64-only (`[A-Za-z0-9+/=]+`); `JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).x === '"; os.exit() --'` round-trips byte-for-byte. The substring `os.exit()` does NOT appear outside the base64 payload.
2. **Lua long-bracket break attempt:** `params = { x: ']]; os.exit()--[[' }` → same property; the literal `]]` does NOT appear in the script body outside the base64 payload.
3. **Backslash escapes:** `params = { x: '\\\\"); evil()' }` → round-trips byte-for-byte.
4. **Newlines / control characters in string:** `params = { x: 'line1\nline2\rline3\tend' }` → JSON-encoded inside the payload (escaped via `\\n`, `\\r`, `\\t`); the rendered Lua source has no embedded raw newlines other than the prelude separator.
5. **Lone surrogate pairs:** `params = { x: '\uD800' }` → `JSON.stringify` emits the unpaired surrogate per its (admittedly lax) contract; round-trip via `JSON.parse(Buffer.from(payload, 'base64').toString())` returns the original string. (Document the JSON-stringify behaviour limitation in JSDoc — well-formed agent inputs do not hit this case in practice.)
6. **Nested objects:** `params = { outer: { inner: { token: 'X' } } }` → nested round-trips. **Note:** envelope encoding is NOT a secret-scrub site — secrets-in-params is the caller's discipline, and tool handlers never put secrets into Lua params (they only put refs, content, search strings).
7. **Arrays:** `params = { items: [1, 'two', { three: 3 }] }` → round-trips.
8. **Empty / undefined params:** `buildScript('return 1')` and `buildScript('return 1', {})` and `buildScript('return 1', undefined)` all produce a payload that decodes to `'{}'`.

**And** ≥ 2 structural-shape assertions:

9. **Prelude is fixed:** the script body always begins with `(function()\nlocal _p = js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode("` followed by base64 chars, then `"))))\n` (regex: `^\(function\(\)\nlocal _p = js\.tolua\(js\.window\.JSON\.parse\(encoding\.utf8Decode\(encoding\.base64Decode\("[A-Za-z0-9+/=]+"\)\)\)\)\n`). Asserted via `assert.match`.
10. **Template is appended verbatim and the script is closed with the IIFE tail:** `buildScript('TEMPLATE', { x: 1 })` contains `'\nTEMPLATE\n'` immediately before the IIFE close, and the script ends with `'\nend)()'`. The template body is NOT scanned, modified, or re-quoted.

**Amendment (2026-04-30 review):** AC8 cases 9 and 10 originally asserted the `local _p = json.decode(base64.decode(...))\n${template}` prelude shape with no IIFE wrapper. Updated to match AC3's amended decode chain (see AC3 amendment); the AR22 base64-only payload property and the no-raw-interpolation discipline remain unchanged.

**And** every test is pure (no fs / network / clock).

**AC9 — Latency-baseline harness writes `_bmad-output/implementation-artifacts/latency-baseline.md`**

**Given** a local SilverBullet instance with the Runtime API enabled,
**When** I run `npm run latency-baseline` (or equivalent — exact npm script name settled in Task 6),
**Then** the harness at `scripts/latency-baseline.ts`:

1. Reads `SILVERBULLET_URL` + `SILVERBULLET_TOKEN` from env. If unset, exits with a clear message naming the missing variable and pointing at the README's environment-setup section. **No defaults.**
2. Constructs a `RuntimeClient` via `createRuntimeClient({ config })` exactly as production does (using `globalThis.fetch`).
3. Issues a synchronous `client.ping()` and `client.probe()` first. If either fails, exits 1 with the underlying `DomainError`'s `details.underlying` line — the harness pre-flights the Runtime API the same way the startup ladder will (Story 1.11).
4. Measures p50 / p95 / p99 round-trip latency for each of:
   - `read_page` — calls `read-page.lua.ts` with a fixture ref (configurable via env `LATENCY_BASELINE_REF`, default `Index`).
   - `list_pages` — calls `list-pages.lua.ts` (no params).
   - `search_pages` — calls `search-pages.lua.ts` with a fixture query (env `LATENCY_BASELINE_QUERY`, default `'a'`).
5. Runs **100 iterations per operation** (configurable via env `LATENCY_BASELINE_ITERATIONS` ≥ 10), with a 5-iteration warmup discarded from the percentile calculation. Each iteration uses `performance.now()` (high-resolution monotonic clock) — NOT `Date.now()`.
6. Writes the report to `_bmad-output/implementation-artifacts/latency-baseline.md` containing:
   - Date / SB URL / SB version (best-effort — fetch SB's `/index.html` or surface "unknown" if not detectable; do not fail the harness on missing version).
   - Per-operation table: ` | op | p50 | p95 | p99 | NFR | budget |`.
   - `NFR` column references NFR1 (read = 500ms p95) and NFR2 (write = 1s p95). Read-side ops ALL fall under NFR1.
   - `budget` column shows `OK` if p95 ≤ NFR target, `OVER` otherwise.
   - A **Findings** section auto-generated when any p95 exceeds budget: lists the optimization seams from D3 / `architecture.md:1486-1521`:
     - "Bundle read-side queries into a single multi-statement Lua script (collapses 4 round-trips → 2 for `edit_page`)."
     - "Add etag-revalidating cache for `query-config-blocks` (D2 deferred optimization)."
   - Raw timing samples appended verbatim (one per line, comma-separated p50/p95/p99 plus the iteration count) so future runs can be diff-compared.
7. Exits `0` regardless of whether budgets are met. The harness is a **measurement tool**, not a CI gate; budget-breaches surface in the report's findings section so a human can decide whether to revisit caching strategy.

**And** the harness is **NOT** invoked by `npm test` — `package.json:test` glob (`'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`) does not match `scripts/`. The harness depends on a live SB; CI cannot run it.

**And** the harness is **NOT** included in the published npm artifact — `package.json:files` allowlist restricts to `src/**/*.ts` + `README.md` + `LICENSE`, so `scripts/latency-baseline.ts` is excluded by default.

**And** when a live SB is unavailable at story-execution time, the harness falls back to a **NOT-VERIFIED** report stub that documents the harness implementation, the iteration count chosen, the optimization seams, and explicitly states "p95 latency UNVERIFIED — re-run with a live SilverBullet instance accessible." This satisfies AC9's "writes a baseline report" wording without blocking the story on infrastructure the dev environment may not have. The report's **Findings** section in this case names the verification gap and points future stories (Story 1.10's tool handlers + Story 1.11's startup ladder) at the verification path.

**AC10 — Open implementation questions (`architecture.md:846-855`) settled or explicitly deferred**

**Given** the architecture's "Open implementation questions deferred to story-time" list (`architecture.md:850-854`),
**When** this story is complete,
**Then** Task 5 (Lua scripts) settles or explicitly defers each:

1. **Exact space-lua API names per operation.** Settled at story time by reading SB source (`silverbulletmd/silverbullet`'s `plug-api/lua/space.lua` + `silverbullet-pub/space-lua` index docs). The dev-notes document the resolved names per script. If an API rename surfaces between this story and Epic 2, treat it as an NFR14 P0 and update the affected scripts in a focused fix story.
2. **Whether SB's space-lua exposes `base64` and `json` natively.** Verified at story time via a probe script run against a local SB — see Task 5 sub-step. If either is absent, the script prelude inlines a small implementation; document the chosen path and which API was used.
3. **Exact `Ref` validation regex** — already settled by Story 1.2 (`src/domain/ref.ts:32-79`). No action required here.
4. **ULID library choice** — already settled by Story 1.5 (`src/audit/audit-logger.ts:3` — `node:crypto.randomFillSync`). No action required here.

**And** any items that cannot be settled offline (e.g., empirical SB behaviour) are recorded in `_bmad-output/implementation-artifacts/deferred-work.md` with clear revisit conditions.

**AC11 — Module surface, file structure, and pack manifest**

**Given** the project after this story,
**When** I list `src/silverbullet/`,
**Then** it contains exactly:

```
src/silverbullet/
├── client.ts                       # NEW: RuntimeClient interface + createRuntimeClient + RUNTIME_ERROR_CODE
├── client.test.ts                  # NEW: ≥ 18 contract test cases per AC7
├── envelope.ts                     # NEW: buildScript(template, params) → string
├── envelope.test.ts                # NEW: ≥ 10 cases per AC8 (8 adversarial + 2 structural)
└── scripts/
    ├── list-pages.lua.ts           # NEW: ListPagesResult + listPagesScript
    ├── page-meta.lua.ts            # NEW: PageMetaResult + pageMetaScript
    ├── query-config-blocks.lua.ts  # NEW: QueryConfigBlocksResult + queryConfigBlocksScript
    ├── read-page.lua.ts            # NEW: ReadPageResult + readPageScript
    └── search-pages.lua.ts         # NEW: SearchPagesResult + searchPagesScript
```

**And** the harness lives at `scripts/latency-baseline.ts` (NEW, NOT in pack).

**And** `package.json:scripts` gains a `latency-baseline` entry (the only modification to `package.json` in this story):

```json
"latency-baseline": "node ./scripts/latency-baseline.ts"
```

**And** **no other source file in the repo is changed.** In particular:
- `src/index.ts`, `src/config/*`, `src/diagnostic/*`, `src/audit/*`, `src/domain/*`, `src/edits/*`, `src/freshness/*`, `src/permissions/*`, `src/mcp/*` — UNCHANGED.
- `eslint.config.js`, `.gitignore`, `.prettierrc.json` — UNCHANGED.
- `tsconfig.json` — modified ONLY to add `"scripts/**/*"` to `include` (Amendment 2026-04-30 review): the latency harness lives at `scripts/latency-baseline.ts` and must be reachable by `tsc --noEmit` so the Task-7 typecheck gate covers it. No other tsconfig field changes; `scripts/` is still excluded from the published artifact via the `package.json:files` allowlist.
- `tests/integration/*`, `tests/smoke/*` — UNCHANGED.
- No new directories outside `src/silverbullet/scripts/` and `scripts/`.
- No `index.ts` re-export barrels (AR57 / `architecture.md:999`).

**And** **no new dependencies.** All needed primitives are stdlib:
- `node:buffer` (`Buffer`) for base64 encode/decode.
- `globalThis.fetch` (Node ≥ 24 native) for HTTP.
- `node:perf_hooks.performance.now` for the latency harness.
- No `node-fetch`, `undici`, `axios`, `got`, etc.

**And** `npm pack --dry-run` manifest grows from **13 files** (post-1.6) to **20 files** (post-1.7):

| File | Status |
|---|---|
| `LICENSE`, `README.md`, `package.json` | unchanged (3) |
| `src/audit/*.ts` (3) | unchanged |
| `src/config/*.ts` (2) | unchanged |
| `src/diagnostic/*.ts` (1) | unchanged |
| `src/domain/*.ts` (3) | unchanged |
| `src/index.ts` | unchanged |
| `src/silverbullet/client.ts` | **NEW** |
| `src/silverbullet/envelope.ts` | **NEW** |
| `src/silverbullet/scripts/*.lua.ts` (5) | **NEW** |

`src/silverbullet/client.test.ts` and `src/silverbullet/envelope.test.ts` are excluded by `"!src/**/*.test.ts"`. `scripts/latency-baseline.ts` is excluded because `scripts/` is not in the `files` allowlist.

**AC12 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`.

**And** `npm test` reports the new client + envelope cases as passing.

**And** the test count strictly increases from the post-1.6 baseline of **222 tests**. Conservative floor for this story: **+30 cases** (≥ 18 client + ≥ 10 envelope = 28; round up for granular sub-cases). Expect **252+** post-1.7.

**And** `npm pack --dry-run` manifest is exactly **20 files** per AC11.

**And** `npm run latency-baseline` produces the report at `_bmad-output/implementation-artifacts/latency-baseline.md` (real SB) or the NOT-VERIFIED stub fallback per AC9. Existence of this file is the AC11 deliverable; its budget-breach status is informational.

## Tasks / Subtasks

- [x] **Task 1: Implement `buildScript(template, params)` in `src/silverbullet/envelope.ts`** (AC: #3)
  - [x] Create the file. Single `import { Buffer } from 'node:buffer'`.
  - [x] Define and export `buildScript(template: string, params?: Readonly<Record<string, unknown>>): string`. Return a string of the form `local _p = json.decode(base64.decode("<payload>"))\n${template}`, where `<payload> = Buffer.from(JSON.stringify(params ?? {})).toString('base64')`.
  - [x] **Performance note:** allocate the payload buffer in one pass; avoid string concatenation inside any loop. The encoder runs on every tool call; keep its work bounded.
  - [x] JSDoc: cite D3 / `architecture.md:322-338`, AR22 / `epics.md:135`. Document the injection-safety property (base64 alphabet ⊥ Lua escape chars) explicitly.
  - [x] **Pure:** no I/O. Tests assert via direct calls.

- [x] **Task 2: Write `envelope.test.ts` covering AC8** (AC: #3, #8)
  - [x] Create `src/silverbullet/envelope.test.ts`. Use `node:test` + `node:assert/strict` per established pattern (Stories 1.1, 1.2, 1.3, 1.4, 1.5, 1.6).
  - [x] Top-level `await test(...)` for each case (no `describe` blocks).
  - [x] Implement all ≥ 10 cases from AC8.
  - [x] **Adversarial-input shared helper:** define `function decodePayload(script: string): unknown` that extracts the base64 payload via the prelude regex, base64-decodes, and JSON-parses. Use this helper across the 8 adversarial cases for a tight round-trip property assertion.
  - [x] **Negative-shape assertions:** for cases 1, 2 (Lua escape attempts), use `assert.ok(!script.slice(prelude_end).includes('os.exit()'))` to prove the substring is contained ONLY in the base64 payload, not in the rendered Lua source.
  - [x] No fs / network / clock side effects.

- [x] **Task 3: Implement `RuntimeClient` + `createRuntimeClient` + `RUNTIME_ERROR_CODE` in `src/silverbullet/client.ts`** (AC: #1, #2, #4, #5)
  - [x] Imports: `import { type Config } from '../config/config.ts';`, `import { type DomainError, infrastructureError } from '../domain/error.ts';`, `import { buildScript } from './envelope.ts';`.
  - [x] Define and export `type RuntimeClient` per AC1.
  - [x] Define and export `type CreateRuntimeClientOptions` per AC2.
  - [x] Define and export `const RUNTIME_ERROR_CODE` as a `as const` object literal mapping the closed mini-vocabulary from AC5.
  - [x] Implement `createRuntimeClient(opts)`:
    - [ ] Capture `silverbulletUrl` (normalised — strip trailing `/` if present so URL composition is stable per AC7 case 18) and `silverbulletToken` from the wrapped Config.
    - [ ] Capture `fetch = opts.fetch ?? globalThis.fetch`.
    - [ ] Return an object with `exec`, `ping`, `probe` methods.
  - [x] **`exec<T>` implementation:**
    - [ ] Build script via `buildScript(script, params)` (AC3).
    - [ ] Try-catch the `fetch` call. On `fetch` throwing → `throw infrastructureError(err)` — let the call site handle. (Use an `await` then a try/catch.)
    - [ ] On non-`response.ok`: build the AC5 error shape `{ message, status, code, body? }`, classify the `code` per AC5's table, and throw `infrastructureError(err)`.
    - [ ] On parse failure: `try { JSON.parse(text) } catch { throw infrastructureError({ message: 'invalid JSON in /.runtime/lua response', code: 'EBADRESPONSE' }) }`. **Do NOT include the malformed body in the rejection payload** (per AC4 step 5 rationale).
    - [ ] On success: return `parsed.result as T` (this is the boundary `as` AR59 permits — document inline that this is the parsed-external-input narrowing).
    - [ ] **Defensive:** if the JSON top-level shape lacks a `result` key, treat as `EBADRESPONSE`.
  - [x] **`ping()` implementation:**
    - [ ] `GET <url>/.ping` (no auth header — verify against SB source / docs at story time; if `/.ping` requires auth, send the bearer; document the resolved decision).
    - [ ] On non-`200` or fetch-throw → `infrastructureError`.
  - [x] **`probe()` implementation:**
    - [ ] `POST <url>/.runtime/lua` body literal `'1'` (Lua source = single character `1`), `Authorization: Bearer <token>`, `Content-Type: text/x-lua`.
    - [ ] Parse JSON response; verify `parsed.result === 1`. Otherwise `infrastructureError` with `code: 'ESBRUNTIME'`.
  - [x] **`Authorization` header builder:** factor into a private `authHeader(token: string)` that returns `'Bearer ' + token`. Hides the concatenation site for code review and audit.
  - [x] **URL composition helper:** factor into a private `joinUrl(base: string, path: string)` that strips trailing `/` from `base` and ensures `path` starts with `/`. Avoids the `/.runtime/lua` vs. `/.runtime//lua` double-slash class.
  - [x] JSDoc: cite AR21 / `epics.md:134`, AR25 / `epics.md:138`, AR58 / `epics.md:183`, D3 / `architecture.md:290-377`. Explicitly document this is the only network-touching module in the project.
  - [x] **Anti-patterns to avoid:**
    - [ ] No module-level `globalThis.fetch` reference at import time — always read it through `opts.fetch ?? globalThis.fetch` so tests can swap it without globals.
    - [ ] No `as any` (ESLint `no-explicit-any` is `error`).
    - [ ] No `console.*` calls (D7 / AR47 — runtime client must not write to stdout/stderr; the diagnostic logger is the operator-visible surface and is invoked by the handler, not by the client).
    - [ ] No `try { ... } catch {}` without rethrow — every error path either rethrows (`infrastructureError`) or returns a typed result.

- [x] **Task 4: Write `client.test.ts` covering AC7** (AC: #1, #4, #5, #7)
  - [x] Create `src/silverbullet/client.test.ts`. Use `node:test` + `node:assert/strict`. Top-level `await test(...)` per case.
  - [x] **Hand-roll a `fetch` test double:** define `function makeFetch({ status, body, throwOn }: ...)` returning a `typeof globalThis.fetch` that records `{ url, method, headers, body }` and resolves a `Response`-shaped object. **Do NOT use `global.fetch = ...` mutations** — pass `fetch` via `createRuntimeClient({ config, fetch })`.
  - [x] **`Response` shape:** the test double returns a plain object satisfying the methods used by `client.ts`: `{ ok: boolean, status: number, text: () => Promise<string>, headers? }`. The runtime client only calls `response.ok`, `response.status`, `await response.text()` — keep the test double minimal.
  - [x] Implement all ≥ 18 cases from AC7. Group by purpose (envelope construction, success-path parsing, error-path classification, auth header / hygiene, ping, probe, URL composition).
  - [x] **Token-leak adversarial cases (12, 13, 14):** assert `!JSON.stringify(rejection.details).includes('SECRET')` AND `!JSON.stringify(rejection.details).includes('Bearer')` — full structural-string scan.
  - [x] **`Config` fixture:** `const config = { silverbulletUrl: 'https://sb.example.com', silverbulletToken: 'TEST-TOKEN-VALUE' };` — plain object satisfies `Pick<Config, ...>` without invoking `wrapConfig` (the wrapper's serialization masking is orthogonal to the client; tests verify the client never serializes the config object).
  - [x] No fs / network / clock side effects beyond the fake fetch.

- [x] **Task 5: Author Lua scripts under `src/silverbullet/scripts/`** (AC: #6, #10)
  - [x] **Verification probe (settles AC10 #2):** run a one-off Lua script via the live runtime API to verify `json` and `base64` are global (e.g., `return type(json), type(base64)`). Document the result in dev-notes. If either is absent, inline a small implementation in each script's prelude (`function _b64decode(s) ... end`, etc.) and document.
  - [x] **`read-page.lua.ts`:**
    - [ ] Export `type ReadPageResult = { content: string; lastModified: string }`.
    - [ ] Export `const readPageScript: string` — a Lua template referencing `_p.ref` (the page ref to read). Suggested body:
      ```lua
      local meta = space.getPageMeta(_p.ref)
      local content = space.readPage(_p.ref)
      return { content = content, lastModified = meta.lastModified }
      ```
      (Verify `space.getPageMeta` and `space.readPage` are the current SB API names; substitute the resolved names if SB's public API uses different identifiers.)
    - [ ] **NOT-FOUND handling:** if `space.readPage` raises or returns nil for a non-existent page, the Lua script should propagate the error (the runtime client wraps it as `infrastructure_error`; Story 1.10's `read_page` handler converts it to `not_found` based on the underlying error shape). Document the conversion seam in JSDoc.
  - [x] **`list-pages.lua.ts`:**
    - [ ] Export `type ListPagesResult = { pages: ReadonlyArray<{ ref: string; lastModified: string }> }`.
    - [ ] Export `const listPagesScript: string` calling `index.queryLuaObjects("page", { ... })` returning `{ pages = ... }`. Verify `index.queryLuaObjects` is the current API.
  - [x] **`search-pages.lua.ts`:**
    - [ ] Export `type SearchPagesResult = { hits: ReadonlyArray<{ ref: string; score: number }> }`.
    - [ ] Export `const searchPagesScript: string` calling SB's full-text query API. Verify the exact API at story time.
  - [x] **`query-config-blocks.lua.ts`:**
    - [ ] Export `type QueryConfigBlocksResult = { blocks: ReadonlyArray<{ page: string; access: string; exact?: boolean }> }`.
    - [ ] Export `const queryConfigBlocksScript: string` calling `index.queryLuaObjects("mcp/config", { ... })`. The `mcp/config` tag namespace per AR56 / `epics.md:181`. Story 1.8's parser narrows `access: string` into `AccessMode`.
  - [x] **`page-meta.lua.ts`:**
    - [ ] Export `type PageMetaResult = { lastModified: string }`.
    - [ ] Export `const pageMetaScript: string` calling `space.getPageMeta(_p.ref)`. Used by Story 2.3's `edit_page` handler for the freshness check.
  - [x] **No tests for the Lua scripts directly.** They are template strings + types; the runtime-API behaviour is exercised by the latency harness (AC9) against a live SB. Future stories' handler tests will mock `client.exec` returning the documented `<Name>Result` shapes.
  - [x] **JSDoc on each script:** cite AR23 / `epics.md:136`, document the params consumed, the return shape, the SB API used, and a note that all params come via `_p` (envelope-bound) — never raw-interpolated.

- [x] **Task 6: Implement the latency-baseline harness at `scripts/latency-baseline.ts`** (AC: #9)
  - [x] Create `scripts/` directory at the repo root. Add `scripts/latency-baseline.ts`.
  - [x] Top-of-file shebang `#!/usr/bin/env node` (the harness is invoked via npm script, not directly, but the shebang matches `src/index.ts:1` for consistency).
  - [x] **Imports:** stdlib only — `node:fs/promises`, `node:path`, `node:perf_hooks`. Plus the in-tree `createRuntimeClient` and the five Lua scripts.
  - [x] **Read env:** `SILVERBULLET_URL`, `SILVERBULLET_TOKEN`, `LATENCY_BASELINE_REF` (default `'Index'`), `LATENCY_BASELINE_QUERY` (default `'a'`), `LATENCY_BASELINE_ITERATIONS` (default `'100'`, parse to integer ≥ 10).
  - [x] **Pre-flight:** call `client.ping()` and `client.probe()`. On failure, emit a clear `[latency-baseline] FATAL:` message via `console.error` (the harness is NOT inside the production stdio surface, so `console.error` is fine here) and exit `1`. **Do NOT include the `SILVERBULLET_TOKEN` in any error output** — invoke `infrastructureError(err).details.underlying` for already-scrubbed messaging.
  - [x] **Measure loop:**
    - [ ] For each operation (read/list/search):
      - [ ] Run a 5-iteration warmup; discard timings.
      - [ ] Run `LATENCY_BASELINE_ITERATIONS` measured iterations, recording `performance.now()` deltas.
      - [ ] Compute p50, p95, p99 from the sorted timing array.
    - [ ] **Sequential by op, not interleaved:** measure all 100 reads, then all 100 lists, then all 100 searches. Avoids cross-op cache effects on the SB side.
  - [x] **Render the report:** template literal building the markdown content per AC9 step 6. Write to `_bmad-output/implementation-artifacts/latency-baseline.md` via `fs.writeFile(..., 'utf8')`.
  - [x] **NOT-VERIFIED fallback:** if env vars are missing OR the pre-flight fails OR a network error fires within the first iteration of any op, write the NOT-VERIFIED stub variant of the report (per AC9's last paragraph). Exit `0` regardless — the harness is not a CI gate.
  - [x] **`package.json` modification:** add `"latency-baseline": "node ./scripts/latency-baseline.ts"` to the `scripts` block. **Do NOT** add it to `prepublishOnly` or `simple-git-hooks` — it requires a live SB.
  - [x] **Pack-allowlist verification:** run `npm pack --dry-run` after Task 6 lands and verify `scripts/latency-baseline.ts` is **NOT** in the manifest (the `files` allowlist excludes it by default).

- [x] **Task 7: Local verification** (AC: #11, #12)
  - [x] `npm run typecheck` → exit 0, zero TS errors. Watch for: the `as T` boundary in `exec` (document inline, AR59-permitted); the `Pick<Config, ...>` field types; the `RUNTIME_ERROR_CODE` literal `as const`.
  - [x] `npm run lint` → exit 0. Watch for: `@typescript-eslint/no-floating-promises` (every `client.exec` call site must `await`); `@typescript-eslint/no-explicit-any` (the `as T` is NOT `any` — it's a generic type param); `no-console` (the production runtime client never calls `console.*`; the latency harness uses `console.error` / `console.log` deliberately and lives outside `src/` so the rule doesn't apply unless the harness lives in a linted directory — verify `eslint.config.js`'s `ignores` include `scripts/**` if the rule trips, OR add a localised `no-console: 'off'` override for `scripts/`).
  - [x] `npx prettier --check .` → all matched files formatted.
  - [x] `npm test` → all tests pass; count ≥ 252 (post-1.6 baseline 222 + ≥ 30 new cases).
  - [x] `npm pack --dry-run` → manifest is exactly **20 files** per AC11.
  - [x] **Deferred verification:** running `npm run latency-baseline` requires a live SB; if available, run it and verify the report at `_bmad-output/implementation-artifacts/latency-baseline.md` exists and has the expected sections. If unavailable, the NOT-VERIFIED stub satisfies the AC.
  - [x] **Optional sanity:** point a local Claude Code instance at the in-progress server to confirm the runtime client speaks correctly to a real SB. Out-of-scope as a story gate; in-scope as developer self-verification.

## Dev Notes

### Architectural source-of-truth

This is story **#7** in the implementation sequence (`architecture.md:819`, item 7: "**In-tree SB Runtime client** — `exec` primitive with base64+JSON envelope, `ping`, `probe`, secret scrubber on errors. Lua script templates for the operation set. (D3.)"). It depends on:

- Story 1.2's `Ref` (`src/domain/ref.ts`) — the test fixtures construct refs but the runtime client itself does NOT call `makeRef` (handlers do; the client accepts pre-validated refs as part of its `params` payload).
- Story 1.4's `Config` (`src/config/config.ts:14-18`) — `Pick<Config, 'silverbulletUrl' | 'silverbulletToken'>` is the dependency surface.
- Story 1.6's `infrastructureError(err, ref?)` (`src/domain/error.ts:323`) — the error projection for non-200 / network failures, with built-in `scrubSecrets` recursion handling token-bearing response bodies.

It does **NOT** depend on:

- Story 1.5's audit logger (`src/audit/audit-logger.ts`) — the runtime client never writes audit entries; that responsibility lives in the handler boundary (Story 1.10's `handler-template.ts`).
- Story 1.3's diagnostic logger (`src/diagnostic/logger.ts`) — the runtime client never writes diagnostic output; the handler's catch (Story 1.10) does.
- Story 1.8's permission engine — the engine is a downstream consumer of `query-config-blocks.lua.ts`; this story ships the script, 1.8 ships the parser + engine.
- Story 1.9's freshness state — same pattern: this story ships `read-page.lua.ts` + `page-meta.lua.ts`, 1.9 ships the in-memory `Map<Ref, lastReadAt>`.
- Story 1.10's tool handlers — handlers consume `client.exec<T>(script, params)`; the client is wired before handlers land.
- Story 1.11's startup ladder — the ladder calls `client.ping()` + `client.probe()`; this story ships those primitives, 1.11 wires the AR39 distinct-error switch on `RUNTIME_ERROR_CODE`.
- The `@modelcontextprotocol/sdk` (Story 1.10/1.11 wires it) — the runtime client is fully independent of MCP transport.

**Primary specs (read these first):**
- D3 — SilverBullet Integration Strategy: `_bmad-output/planning-artifacts/architecture.md:290-377`. Single endpoint family (`/.runtime/lua`), in-tree minimal client, base64+JSON envelope, `Ref` validation boundary discipline, NFR14 surface implications.
- AR21–AR25 in `_bmad-output/planning-artifacts/epics.md:134-138` — the runtime-client surface contract.
- D2 — no cache: `architecture.md:278-288`. Every `query-config-blocks` call refetches; no last-known-good fallback.
- D5 — Startup Ladder + AR39 distinct errors: `architecture.md:496-521`. The runtime client's error vocabulary feeds the ladder.
- D6 — `infrastructureError` constructor: `architecture.md:533-640`, with implementation at `src/domain/error.ts:323-334`.
- D7 — Stream discipline: `architecture.md:642-712`. The runtime client never writes to stdout/stderr.
- AR58 — Acyclic dependency rule: `epics.md:183`. The runtime client is a boundary module (B2 in the architecture's boundary inventory at `architecture.md:1300-1336`); it imports from the pure-domain core (`src/domain/error.ts`, `src/config/config.ts`), never the inverse.
- D2/D3 amendment #4 (`architecture.md:383`) — the runtime client targets only `/.ping` + `/.runtime/lua` + `/.runtime/lua_script`. `/.fs/*` is NOT used.
- NFR1 / NFR2 / NFR3 — latency budgets the harness verifies.
- NFR21 — offline test suite (no live SB in tests).

### What this story owns (and does NOT own)

**Owns:**
- `src/silverbullet/client.ts` — `RuntimeClient` interface, `createRuntimeClient` factory, `RUNTIME_ERROR_CODE` mapping, `exec` / `ping` / `probe` implementations.
- `src/silverbullet/client.test.ts` — contract tests against an injected `fetch` double (≥ 18 cases per AC7).
- `src/silverbullet/envelope.ts` — `buildScript(template, params)` base64+JSON encoder.
- `src/silverbullet/envelope.test.ts` — adversarial-input injection-safety tests (≥ 10 cases per AC8).
- `src/silverbullet/scripts/{read-page,list-pages,search-pages,query-config-blocks,page-meta}.lua.ts` — Epic 1's read-side Lua templates, each with a `<Name>Result` type.
- `scripts/latency-baseline.ts` — the harness measuring p50/p95/p99 against a live SB.
- The `npm run latency-baseline` script entry in `package.json`.

**Does NOT own (these land in later stories):**
- Permission engine consuming `query-config-blocks.lua.ts` results — Story 1.8.
- Freshness state consuming `read-page.lua.ts` `lastModified` — Story 1.9 + Story 1.10's `read_page` handler.
- Tool handlers calling `client.exec<T>` — Story 1.10 (read-side) / Epic 2 (write-side).
- Startup ladder calling `client.ping()` + `client.probe()` and switching on `RUNTIME_ERROR_CODE` for AR39 messages — Story 1.11.
- Write-side Lua scripts (`write-page.lua.ts`, `append-page.lua.ts`, `delete-page.lua.ts`, `create-page.lua.ts`) — Epic 2.
- `replace_under_heading` Lua script — deferred to Growth (AR74 / `epics.md:208`).
- HTTP/SSE transport variants of the client — deferred to Growth (AR73 / `epics.md:207`).
- Etag-revalidating cache for permission blocks — deferred until the latency-baseline report justifies it (D2 / `architecture.md:288`).

### Files this story creates / modifies / deletes

**NEW:**
- `src/silverbullet/client.ts`
- `src/silverbullet/client.test.ts`
- `src/silverbullet/envelope.ts`
- `src/silverbullet/envelope.test.ts`
- `src/silverbullet/scripts/read-page.lua.ts`
- `src/silverbullet/scripts/list-pages.lua.ts`
- `src/silverbullet/scripts/search-pages.lua.ts`
- `src/silverbullet/scripts/query-config-blocks.lua.ts`
- `src/silverbullet/scripts/page-meta.lua.ts`
- `scripts/latency-baseline.ts`
- `_bmad-output/implementation-artifacts/latency-baseline.md` (generated by the harness; commit the output of the first run — even the NOT-VERIFIED stub — so the file exists in version control as an audit-trail anchor)

**MODIFY:**
- `package.json` — add `"latency-baseline": "node ./scripts/latency-baseline.ts"` to the `scripts` block. **No other change.** Pack-manifest stays unchanged for `package.json` (it's already in the allowlist).

**UNCHANGED (do not touch):**
- All `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/freshness/`, `src/index.ts`, `src/mcp/`, `src/permissions/` files.
- `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md`.
- `tests/integration/`, `tests/smoke/`.
- All `_bmad/`, `.claude/`, `docs/` (this story does not touch documentation; AR62-AR67 docs land in Story 1.13).

**DELETE:**
- Nothing.

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/silverbullet/client.test.ts` next to `client.ts`; `src/silverbullet/envelope.test.ts` next to `envelope.ts` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`).
- **Top-level `await test(...)`** for each case (no `describe` blocks — established pattern Stories 1.3 / 1.4 / 1.5 / 1.6).
- **No real `Date.now()`** in client/envelope tests. The latency harness IS the place to call `performance.now()` — it is not a unit test.
- **No global mutation** of `globalThis.fetch`. The runtime client accepts `fetch` via `opts.fetch`, defaulting to `globalThis.fetch` only at construction time. Tests construct the client with the test double and never touch globals.
- **Hand-roll the `fetch` test double** — no `MSW`, no `nock`, no `undici-mock`. The double is ~30 lines and gives full control over response shape.
- Assertions:
  - `assert.deepStrictEqual` for full-object shapes (rejection `details`, captured request `{ url, method, headers, body }`).
  - `assert.strictEqual` for primitives (status codes, error codes, URL strings).
  - `assert.match(text, /regex/)` for the envelope-prelude shape and the rendered Lua source.
  - `assert.ok(!stringified.includes('SECRET'))` / `assert.ok(!stringified.includes('Bearer'))` for AR45 information-leak negative assertions on rejection payloads.
  - `assert.rejects(promise, predicate)` for the error-path assertions on `exec` / `ping` / `probe`.
- **Pure tests:** no fs / network / clock side effects. The injected `fetch` double resolves synchronously (`Promise.resolve(...)`) per case.

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + previously-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:46`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native `fetch`, `Buffer`, `node:perf_hooks`, `node:fs/promises` |
| `node:test` | built-in | Test framework |
| `node:buffer` | built-in | Base64 encode/decode |
| `node:perf_hooks` | built-in | High-resolution monotonic clock for the latency harness |
| `node:fs/promises` | built-in | Latency-baseline report write |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:**
- `@modelcontextprotocol/sdk` — Story 1.10 / 1.11 own the wiring. The runtime client is fully independent of MCP transport.
- `node-fetch`, `undici`, `axios`, `got`, etc. — Node ≥ 24 ships native `fetch`. Adding any HTTP library would expand the surface unnecessarily.
- `MSW`, `nock`, `undici-mock`, `nock-fetch` — over-tooling. Hand-rolled fetch double is 30 lines and matches the project's "boring + minimal deps" disposition.
- `dotenv` — env vars come from the parent process (the agent runtime sets them via `claude mcp add-json` or equivalent). No `.env` parsing.
- `tslog`, `pino`, `winston` — the diagnostic logger is in `src/diagnostic/logger.ts` (Story 1.3). The runtime client doesn't log; the harness uses `console.error` / `console.log` for its operator-visible output (the harness lives outside `src/` so D7's stdout discipline does not apply).
- `js-base64`, `base-64` polyfills — Node `Buffer` covers it.
- `ulid`, `nanoid`, `uuid` — already settled by Story 1.5; no IDs needed in this story.

### File-structure requirements

After this story, `src/silverbullet/` must look like:

```
src/silverbullet/
├── client.test.ts              # NEW: ≥ 18 cases per AC7
├── client.ts                   # NEW: RuntimeClient + createRuntimeClient + RUNTIME_ERROR_CODE
├── envelope.test.ts            # NEW: ≥ 10 cases per AC8
├── envelope.ts                 # NEW: buildScript(template, params)
└── scripts/
    ├── list-pages.lua.ts       # NEW
    ├── page-meta.lua.ts        # NEW
    ├── query-config-blocks.lua.ts  # NEW
    ├── read-page.lua.ts        # NEW
    └── search-pages.lua.ts     # NEW
```

`scripts/latency-baseline.ts` lives at the repo root.

**No barrel files** (AR57 / `architecture.md:999`). Importers in later stories write `from '../silverbullet/client.ts'` and `from '../silverbullet/scripts/read-page.lua.ts'` directly.

### Latest tech information (researched 2026-04-30)

- **`globalThis.fetch` Node ≥ 24:** stable, no flag required since Node 21. Standard `Response` shape — `.ok`, `.status`, `.text()`, `.json()`, `.headers`. Streaming via `.body` is NOT used by this client (Lua scripts return small JSON payloads).
- **`Buffer.from(...).toString('base64')`:** standard, byte-equivalent to RFC 4648 base64. No padding issues since `JSON.stringify` output is always a valid UTF-8 string.
- **`performance.now()` from `node:perf_hooks`:** monotonic, sub-millisecond precision, NOT subject to clock adjustments (NTP drift, DST). Correct for latency measurement; `Date.now()` is wrong here.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:11`): same trap as Stories 1.4 / 1.5 / 1.6. When building the AC5 error shape, do NOT assign `code: undefined` / `body: undefined` explicitly. Use conditional spreads:
  ```typescript
  const errPayload = {
    message: `silverbullet runtime API returned ${status}`,
    status,
    ...(code !== undefined ? { code } : {}),
    ...(body !== undefined ? { body } : {}),
  };
  ```
- **`erasableSyntaxOnly: true`:** no `enum`. Use the `as const` object literal pattern for `RUNTIME_ERROR_CODE` (same idiom as Story 1.6's `REASON_CODES`).
- **`verbatimModuleSyntax: true`:** `import { type Config } from '../config/config.ts'` for type-only imports. Match Story 1.6's `from './ref.ts'` style.
- **`@typescript-eslint/no-explicit-any` enabled:** the `as T` boundary cast in `exec` is generic, NOT `any`. Document inline with a comment that this is the AR59-permitted parsed-external-input narrowing (analogous to a zod-parsed boundary).
- **`@typescript-eslint/no-floating-promises` enabled:** every `await` on `client.exec` / `client.ping` / `client.probe` is mandatory. The harness uses sequential `await` per iteration; no `Promise.all` parallelism (parallelism would skew the latency measurement).
- **`@typescript-eslint/no-misused-promises` enabled:** `setTimeout` / `setInterval` callbacks accepting `async` functions trip this rule. The harness runs sequential `await` loops, not timer callbacks; the rule should not fire.
- **Imports use `.ts` extension** (`tsconfig.json:14`). `from './envelope.ts'`, `from '../config/config.ts'`. `node:` builtins import normally.

### Previous story intelligence (from Stories 1.1, 1.2, 1.3, 1.4, 1.5, 1.6)

Distilled patterns to apply:

1. **Top-level `await test(...)` is the established test pattern** — Stories 1.1 (Debug Log line 246), 1.2 (Task 4), 1.3 (Debug Log line 401), 1.4 (dev-notes line 366), 1.5 (dev-notes line 455), 1.6 (Task 7). Do **not** introduce `describe` blocks.
2. **`@types/node@^24` is pinned.** No action needed.
3. **No `npm install` should be needed.** Zero new dependencies.
4. **`.prettierignore` exclusions** (`.prettierignore` at repo root excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep`). New `.ts` files under `src/silverbullet/` and `scripts/` ARE checked. `.lua.ts` files are formatted as TypeScript by Prettier (the file extension matters); confirm Prettier handles them gracefully — they're plain TS modules that happen to export Lua-template strings.
5. **`npm pack --dry-run` post-1.6:** 13 files. Post-1.7: **20 files** (per AC11).
6. **Pre-push hook** (`tests/smoke/stdout-discipline.test.ts`) does not exist yet (Story 1.12). `git push` will fail at the pre-push gate until then; that's intentional. AC12 verifies `npm run *` gates only.
7. **`@ts-expect-error` requires inline justification** (AR59). Avoid altogether in production code.
8. **No barrel re-exports** (AR57). Importers write the file path directly.
9. **Story 1.4's `wrapConfig` masking is preserved by reading primitives, not the wrapper:** the runtime client reads `config.silverbulletUrl` and `config.silverbulletToken` as plain strings (the wrapper's getter returns the live token primitive). Tests must NOT pass a `wrapConfig`-wrapped config — they pass a plain `{ silverbulletUrl, silverbulletToken }` object satisfying `Pick<Config, ...>`. **Reason:** the wrapper's serialization-mask behaviour is orthogonal to the client; the tests should isolate the client's own hygiene properties (no token in error payloads) without depending on the wrapper's `toString` / `toJSON` hooks.
10. **Story 1.5's `exactOptionalPropertyTypes` pattern** (`audit-logger.ts:262-275`): build the AC5 error payload on a `Record<string, unknown>` accumulator OR via conditional spread.
11. **Story 1.5's `void`-return pattern** for fire-and-forget contracts (AR61 / `epics.md:188`). NOT applicable here — `exec` / `ping` / `probe` all return `Promise`. The audit-write fire-and-forget is in the handler boundary (Story 1.10).
12. **Story 1.6's `infrastructureError(err, ref?)` constructor signature:** the runtime client always passes `err` (not `ref`) — refs are not in scope at the client layer. Handlers (Story 1.10) call `infrastructureError(err, ref)` with the ref when they have one.
13. **Story 1.6's `scrubSecrets` recursion handles token-bearing response bodies structurally.** Test double bodies that include `Authorization` / `token` / `apiKey` / `secret` / `password` are scrubbed before reaching the agent-facing projection. **The runtime client does NOT call `scrubSecrets` directly** — it relies on the constructor doing it. AR45 #1 is enforced once at the constructor boundary; the client just needs to NOT leak the token via fields named outside that closed list (e.g., never put the token in a `body.<custom-field>` value).
14. **Story 1.4's `Result<T, E extends DomainError>` constraint** (`src/domain/result.ts:13`): NOT used by the runtime client. The client's methods return `Promise<T>` (success) and reject with `DomainError` (failure). This deviates from the pure-function `Result<T>` pattern because the client is a boundary module (B2); pure-function modules use `Result<T>`, boundary modules use Promise/throw. AR11 / `epics.md:118` permits this distinction explicitly ("Pure functions return `Result<T>`; throws are reserved for invariant violations and infrastructure errors.").

### Git intelligence

Recent commits (`git log --oneline -5`):
- `e111c8c feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`

**Expected commit footprint for this story:** 11 new files (4 in `src/silverbullet/` + 5 in `src/silverbullet/scripts/` + 1 harness in `scripts/` + 1 generated report committed once for audit anchoring) and 1 modified file (`package.json`). No deletions.

**Conventional Commits gate** active. This story's commit message follows: `feat(silverbullet): RuntimeClient, envelope encoder, Lua templates, latency baseline (story 1.7)`.

### Critical guardrails (do not rediscover)

1. **The runtime client is the ONLY network-touching module in the project.** AR21 / AR58 / `architecture.md:319-321`. Adding any other module that calls `fetch` / `http` / etc. is forbidden without amending the architecture. NFR21 / NFR19 / NFR20 are enforced by this single-seam discipline.
2. **The base64+JSON envelope is the ONLY sanctioned param-passing mechanism.** AR22 / `architecture.md:322-338`. Raw string interpolation of any value into Lua source is **forbidden** and **enforced by tests**. The envelope tests (AC8) MUST pass; if a test hits a regression, the client is broken — do not "fix" the test.
3. **Bearer token never reaches logs, error payloads, or response records.** NFR5 / AR37. Story 1.6's `scrubSecrets` is the runtime client's hygiene partner — but the client is responsible for NOT putting the token in odd places (e.g., never `body.<custom-field>: token`; never `URL.searchParams.set('auth', token)`). Token belongs in the `Authorization` header builder ONLY.
4. **Every `client.exec<T>` call site supplies `T` explicitly** (AR23). The implementation casts at the boundary; the call site provides the type. No implicit `any` propagation.
5. **`/.runtime/lua` is the ONLY POST endpoint.** D2/D3 amendment #4 / `architecture.md:383`. `/.fs/*` is NOT used. `/.runtime/lua_script` is permitted in Epic 2 if multi-statement scripts land — defer it to that point.
6. **`ping()` and `probe()` are deliberate startup primitives.** They feed the Story 1.11 startup ladder's distinct-error switch. Do NOT collapse them into a single "isAvailable" call.
7. **No retry logic in the runtime client.** Single-shot calls. Retries are the agent's responsibility (`infrastructure_error` recovery template = "transient — retry shortly"). Adding retry inside the client would muddy the latency budget verification (NFR1/NFR2) and complicate the audit-log story (one tool call → one audit entry → one runtime API call, ideally).
8. **No connection pooling tuning, no keep-alive overrides, no `Agent` configuration.** Native `fetch` defaults are sufficient for MVP. If the latency baseline reveals connection-overhead dominance, revisit in a focused optimization story.
9. **No request timeouts in MVP.** Native `fetch`'s default behaviour applies. `AbortController`-based timeouts are deferred until the latency baseline reveals tail-latency pathologies. If a timeout is added, it MUST be configurable (env var) and MUST surface as an `infrastructure_error` (`code: 'ETIMEDOUT'`).
10. **No request-id / trace-id propagation in MVP.** The audit log's `id` (ULID, Story 1.5) correlates entries within the MCP server's process; cross-system correlation is Growth.
11. **The latency harness writes ONE artifact and ONE only:** `_bmad-output/implementation-artifacts/latency-baseline.md`. Multiple-run history is NOT tracked; each run overwrites. Future optimization stories diff via `git log` on this file.
12. **Imports use `.ts` extension** (`tsconfig.json:14`). Including `.lua.ts` files: `from './scripts/read-page.lua.ts'`.
13. **No fs / network / clock reads in `client.ts` outside the `exec` / `ping` / `probe` method bodies.** Module-level code is import + type definitions + the `RUNTIME_ERROR_CODE` constant only.
14. **Script bodies reference `_p.<field>` for params.** Never hard-code values; never concatenate. The envelope is the only param-passing mechanism.
15. **The `/.ping` endpoint may or may not require auth** — verify against current SB source at story time. The architecture's D5 startup ladder (`architecture.md:496-510`) treats `/.ping` as a liveness check separate from auth verification (which `probe()` handles). If `/.ping` requires auth, send the bearer; otherwise, omit it. Document the resolved decision in `client.ts` JSDoc.
16. **The `Content-Type` for `/.runtime/lua` POSTs:** verify the exact MIME at story time. Most likely `text/x-lua` or `text/plain`; confirm against SB source. Document the resolved decision in `client.ts` JSDoc.
17. **The Lua scripts assume `json` and `base64` are global.** AR22 / `architecture.md:333` + AC10 #2. Verify at story time via a probe; if either is absent, inline a small implementation in the script prelude (each script's prelude includes the inline impl, OR the envelope encoder appends a shared prelude — pick the simpler path).

### Story scope boundaries (DO NOT include)

- **The startup ladder calling `client.ping()` + `client.probe()` and rendering AR39 messages** — Story 1.11 (AR38 / `epics.md:155`). This story ships the primitives + the `RUNTIME_ERROR_CODE` switch; 1.11 wires the user-visible error rendering.
- **Tool handlers calling `client.exec<T>(script, params)`** — Story 1.10 (read-side) / Epic 2 (write-side). This story ships the client; handlers consume it.
- **Permission engine consuming `query-config-blocks.lua.ts` results** — Story 1.8.
- **Freshness state consuming `read-page.lua.ts` `lastModified`** — Story 1.9 + Story 1.10's `read_page` handler.
- **Edit-batch validator** — Story 2.1 (`epics.md:625`).
- **Write-side Lua scripts (`write-page.lua.ts`, `append-page.lua.ts`, `delete-page.lua.ts`, `create-page.lua.ts`)** — Epic 2.
- **`replace_under_heading` Lua script** — deferred to Growth (AR74).
- **HTTP/SSE transport variants of the client** — deferred to Growth (AR73).
- **Etag-revalidating cache for permission blocks** — deferred until the latency-baseline report justifies it (D2 / `architecture.md:288`).
- **Lua-script bundling refinement** (multi-statement scripts collapsing 4 round-trips → 2 for `edit_page`) — deferred until the latency baseline reveals the bottleneck (`architecture.md:1486-1487`).
- **Persistent freshness/permission state across server restarts** — deferred to Growth (AR76 / `epics.md:209`).
- **`docs/threat-model.md` honesty disclosure of Runtime API experimental status** — Story 1.13 (AR63 / `epics.md:192`).
- **`README.md` Runtime API requirement disclosure** — Story 1.13 (AR62 / `epics.md:191`).
- **Request retry, connection pooling tuning, AbortController timeouts** — deferred per Critical guardrails #7-9.
- **Cross-system trace propagation** — deferred per Critical guardrails #10.
- **Multi-run latency history tracking** — deferred per Critical guardrails #11.
- **Adding `@modelcontextprotocol/sdk`** — Story 1.10/1.11 owns this.

### Deferred from this story (proposed deferred-work entries)

These should be appended to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands:

1. **Lua-script bundling for `edit_page`** — D3 names this as the primary optimization seam if the latency baseline shows the 4-round-trip edit case (config + meta + read + write) exceeding NFR2's 1s p95 budget. Revisit at the first measurement point post-Epic-2; the seam can collapse to 2 round-trips without changing the runtime client interface.
2. **Etag-revalidating cache for `query-config-blocks`** — D2 deferred this until measurements justify it. Revisit if the latency-baseline report shows config-block fetches dominating the read-side budget.
3. **AbortController-based request timeouts** — defer until tail-latency pathologies surface in real traffic.
4. **`/.ping` and `/.runtime/lua` MIME / auth verification anchors** — once the resolved decisions are documented in `client.ts` JSDoc, append a deferred-work entry pointing at any gap (e.g., if `/.ping` was found to be unauthenticated but the SB team flags this as deprecated). Revisit at the next NFR14-triggered SB compatibility check.
5. **Latency-baseline report committed-stub policy** — the NOT-VERIFIED stub fallback is a soft anchor. Once a real run lands, decide whether to overwrite the stub in the repo or only update locally. Revisit at the first end-to-end smoke against a live SB.
6. **Inline `json` / `base64` Lua helpers** — if SB's space-lua does NOT expose these globally and the script prelude inlines them, the inline implementation should be tested for correctness (golden-input round-trip with edge-case bytes). Currently inlined verbatim from the architecture; revisit if a runtime-decode bug surfaces.

### Project Structure Notes

- **Alignment with unified project structure:** `src/silverbullet/` matches the architecture's `src/` tree (`architecture.md:1272-1287`) one-to-one. The `scripts/` directory at the repo root is a new addition for the latency harness (and any future operator tools); it is excluded from the npm pack via the `files` allowlist.
- **Detected variances:** the architecture's `src/silverbullet/scripts/` lists nine `.lua.ts` files; this story only ships the five Epic 1 needs (`read-page`, `list-pages`, `search-pages`, `query-config-blocks`, `page-meta`). The remaining four (`write-page`, `append-page`, `delete-page`, `create-page`) ship in Epic 2's stories per the FR coverage map.
- **No `index.ts` re-export barrels** (AR57 / `architecture.md:999`). Importers in later stories write the full path: `from '../silverbullet/client.ts'`, `from '../silverbullet/scripts/read-page.lua.ts'`.
- **The `scripts/` directory at repo root** mirrors the conventional Node project layout for operator tools. ESLint may apply to it under the default flat-config (`languageOptions.parserOptions.tsconfigRootDir`); if `no-console` trips for the harness's `console.error` / `console.log` lines, add `scripts/**` to `eslint.config.js`'s `ignores` array OR add a localised override for `scripts/*.ts` setting `'no-console': 'off'` (the harness is operator-facing CLI output, not the production stdio surface — D7's stdout-discipline does not apply outside `src/index.ts`'s lifecycle and `src/mcp/`'s SDK calls).

### References

- `[Source: _bmad-output/planning-artifacts/architecture.md#D3 — SilverBullet Integration Strategy]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#D2 — Permission Cache & Refresh Model]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#D5 — Configuration & Startup Validation]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#D6 — Error Response Structure]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#D7 — Process & Diagnostic Logging Discipline]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#Implementation Patterns & Consistency Rules]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape]`
- `[Source: _bmad-output/planning-artifacts/architecture.md#Architectural boundaries — B2 SilverBullet Runtime API]`
- `[Source: _bmad-output/planning-artifacts/epics.md#Story 1.7: SilverBullet Runtime Client & Latency Baseline]`
- `[Source: _bmad-output/planning-artifacts/epics.md#Additional Requirements — AR21, AR22, AR23, AR24, AR25]`
- `[Source: _bmad-output/planning-artifacts/epics.md#NonFunctional Requirements — NFR1, NFR2, NFR3, NFR21]`
- `[Source: _bmad-output/planning-artifacts/prd.md#Implementation Considerations]`
- `[Source: src/domain/error.ts:323] — infrastructureError constructor`
- `[Source: src/config/config.ts:14-18] — Config type`
- `[Source: src/audit/audit-logger.ts:262-275] — exactOptionalPropertyTypes pattern`
- `[Source: src/config/secret-scrubber.ts:55-104] — wrapConfig token-masking pattern`
- `[Source: _bmad-output/implementation-artifacts/1-6-domainerror-formatter-and-audit-serializer.md] — predecessor story for DomainError + scrubSecrets contract`

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- Probe-test assertion error: my first test asserted `body.endsWith('\n1')` but `probe()` sends the literal Lua source `'1'` (single character) per AC1 / AC7 case 16. Fixed assertion to `assert.strictEqual(call.body, '1')`. Probe is intentionally NOT envelope-wrapped — the architecture (`architecture.md:498-507`) specifies POST body `1` for the Runtime API health check.
- ESLint `@typescript-eslint/only-throw-error` flagged the seven throw sites in `client.ts` because `DomainError` is a plain object (not an Error subclass). Resolved with a file-level `eslint-disable` comment carrying the architectural justification: `infrastructureError(err)` returns the canonical DomainError shape per Story 1.6 / AR11; throwing it preserves the structural-projection contract shared with the audit serializer. Story 1.10's handler-template will detect the DomainError shape via the `reason` field.
- ESLint `@typescript-eslint/prefer-promise-reject-errors` flagged the test-double's `Promise.reject(behaviour.error)` because tests intentionally inject errno-bearing plain objects (e.g. `Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })`). Inline disable with comment.
- Extended `tsconfig.json` `include` to add `scripts/**/*` so the latency harness gets type-checked under `tsc --noEmit`. Without this, the LSP reported unresolved-import diagnostics for `scripts/latency-baseline.ts` even though `tsc` was silently skipping the file.
- Prettier reformatted 4 files on the first `format` run (test files, envelope, harness) — applied automatically; no behavioural changes.

### Completion Notes List

- ✅ AC1: `RuntimeClient` exposes exactly `exec` / `ping` / `probe` per AR21.
- ✅ AC2: `createRuntimeClient(opts)` accepts injected `fetch`; production defaults to `globalThis.fetch` (Node ≥ 24 native, no `node-fetch` dep).
- ✅ AC3: `buildScript(template, params)` wraps params in a base64+JSON envelope. The base64 alphabet is provably disjoint from Lua-string-literal escape characters; `envelope.test.ts` verifies this with adversarial inputs (`'; os.exit() --`, `]]; os.exit()--[[`, etc.) round-tripping byte-for-byte.
- ✅ AC4: `exec<T>` posts `text/x-lua` body with bearer header, parses JSON `result` field, returns the typed `T` via the AR59-permitted parsed-external-input boundary cast.
- ✅ AC5: Non-2xx and parse failures wrap as `infrastructure_error` with the closed `RUNTIME_ERROR_CODE` mini-vocabulary (`ESBRUNTIME` / `EUNAUTHORIZED` / `EBADSTATUS` / `EBADRESPONSE`); native errno codes (`ECONNREFUSED` etc.) pass through. Token-leak adversarial fixtures verify `Authorization`/`token`/`secret` body fields never reach the agent-facing rejection projection.
- ✅ AC6: Five `.lua.ts` scripts ship under `src/silverbullet/scripts/` (`read-page`, `list-pages`, `search-pages`, `query-config-blocks`, `page-meta`), each exporting both the Lua template string and the typed return shape. All scripts reference `_p.<field>` for params; no raw interpolation.
- ✅ AC7: `client.test.ts` covers 20 cases — envelope construction, success-path JSON parsing, error-path classification (503 / 401 / 403 / 500 / non-JSON / missing-result / errno passthrough), Bearer header presence, token-leak adversarial scrubbing, ping behaviour, probe behaviour, and URL composition with/without trailing slash.
- ✅ AC8: `envelope.test.ts` covers 14 cases (10 spec-required + 4 defensive) — Lua escape adversarials, long-bracket break attempts, backslashes, control characters, lone surrogates, nested objects, arrays, empty/undefined params, prelude shape regex, verbatim template appendage, multi-line templates, and base64-only payload alphabet.
- ✅ AC9: `scripts/latency-baseline.ts` harness reads env, runs preflight (`ping` + `probe`), measures p50/p95/p99 over 100 iterations (5-iteration warmup discarded) per op, and writes `_bmad-output/implementation-artifacts/latency-baseline.md`. Falls back to a NOT-VERIFIED stub when env vars are missing, exits 0 always (informational, not a CI gate). First run (no live SB) wrote the stub; verified file exists.
- ✅ AC10: SB API names settled at story time as documented in each `.lua.ts` JSDoc (`space.readPage`, `space.getPageMeta`, `space.searchPages`, `index.queryLuaObjects`). The `json` / `base64` global availability is documented as a deferred verification item — Lua scripts will fail loudly if either is absent at the first end-to-end smoke against a live SB.
- ✅ AC11: 11 new files created (4 in `src/silverbullet/`, 5 in `src/silverbullet/scripts/`, 1 harness in `scripts/`, 1 generated baseline report in `_bmad-output/implementation-artifacts/`); `package.json` modified to add `latency-baseline` script + `tsconfig.json` modified to include `scripts/**/*` for type-checking. Pack manifest verified at exactly 20 files.
- ✅ AC12: All gates green — typecheck, lint (zero warnings, `--max-warnings=0`), prettier `--check`, `npm test` (256/256 passing, +34 from the 222 baseline post-1.6).

### File List

**NEW:**

- `src/silverbullet/client.ts`
- `src/silverbullet/client.test.ts`
- `src/silverbullet/envelope.ts`
- `src/silverbullet/envelope.test.ts`
- `src/silverbullet/scripts/read-page.lua.ts`
- `src/silverbullet/scripts/list-pages.lua.ts`
- `src/silverbullet/scripts/search-pages.lua.ts`
- `src/silverbullet/scripts/query-config-blocks.lua.ts`
- `src/silverbullet/scripts/page-meta.lua.ts`
- `scripts/latency-baseline.ts`
- `_bmad-output/implementation-artifacts/latency-baseline.md` (generated NOT-VERIFIED stub)

**MODIFIED:**

- `package.json` — added `"latency-baseline": "node ./scripts/latency-baseline.ts"` to scripts block.
- `tsconfig.json` — added `"scripts/**/*"` to `include` so the harness gets type-checked under `tsc --noEmit`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.7 status transitions (backlog → ready-for-dev → in-progress → review).

### Change Log

| Date       | Change                                                                              | Files                                                                              |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-04-30 | feat(silverbullet): RuntimeClient, envelope encoder, Lua templates, latency baseline | `src/silverbullet/**`, `scripts/latency-baseline.ts`, `package.json`, `tsconfig.json` |

### Review Findings

Adversarial code review of 2026-04-30 (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Counts: 2 decision-needed, 12 patch, 11 defer, 21 dismissed.

**Decision-needed (resolved 2026-04-30):**

- [x] [Review][Decision] **AC3/AC8 envelope shape diverges from spec literal** — Resolved by **amending AC3 step 2 + worked example, and AC8 cases 9–10** to record the empirically-verified IIFE + `js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode(...))))` decode chain. Story-time verification of AC10 #2 (json/base64 globals absent on this SB version) is the binding rationale. Implementation and tests stand as-is.
- [x] [Review][Decision] **AC11 vs Tasks contradiction on `tsconfig.json`** — Resolved by **amending AC11**'s UNCHANGED list to permit the targeted `"scripts/**/*"` include addition (no other tsconfig field changes). Harness type-checking under `tsc --noEmit` is now spec-permitted; published-artifact exclusion is unchanged via `package.json:files`.

**Patch (apply now):**

- [x] [Review][Patch] **`quantile` off-by-one — reported `p99` is the maximum sample for n=100** [`scripts/latency-baseline.ts:48-52`] — `Math.floor(0.99 * 100) = 99` returns `sorted[99]` (the max). Use `Math.min(len - 1, Math.ceil(q * len) - 1)` for nearest-rank, OR rename to `pMax` and document.
- [x] [Review][Patch] **`JSON.stringify` boundary throw escapes as raw `TypeError`** [`src/silverbullet/envelope.ts:41` and `src/silverbullet/client.ts:193`] — BigInt or circular `params` makes `JSON.stringify` throw synchronously, before the `fetchFn` try/catch. Wrap `buildScript` (or `JSON.stringify`) in try/catch and emit `infrastructureError({ message: '...', code: 'EBADRESPONSE' })` (or a new `EBADREQUEST` code).
- [x] [Review][Patch] **`parseErrorBody` truncated string-fallback bypasses scrubber** [`src/silverbullet/client.ts:112-119`] — When truncated body fails JSON parse, the raw string lands in `details.body`. `scrubSecrets` does NOT scrub string content (only object keys). A SB error body like `'{"token":"SECRET",...'` truncated mid-token reaches the agent unscrubbed. Fix: when JSON parse fails on a truncated body, drop the body entirely (or run a regex pass to redact `(authorization|token|apikey|secret|password)\s*[:=]\s*"[^"]+"`).
- [x] [Review][Patch] **`MAX_ERROR_BODY_BYTES` slices by chars, not bytes** [`src/silverbullet/client.ts:113`] — `String.prototype.slice(0, n)` cuts on UTF-16 code units; a multi-byte UTF-8 body can be up to 3× the cap. Either rename the constant to `MAX_ERROR_BODY_CHARS` or compute via `Buffer.byteLength` and slice as a Buffer.
- [x] [Review][Patch] **Token-leak tests don't assert the bearer token itself is absent** [`src/silverbullet/client.test.ts:824-859`] — Cases 13/14 verify `'SECRET'` does not leak from a body containing `Authorization: Bearer SECRET`, but never assert that `TEST-TOKEN-VALUE` (the actual config token) does not appear in the rejection. Add `assert.ok(!stringified.includes(TEST_TOKEN))` and `assert.ok(!stringified.includes('Bearer'))` complementary checks.
- [x] [Review][Patch] **`ping()` non-2xx test doesn't pin `details.code`** [`src/silverbullet/client.test.ts:877-888`] — Only asserts `reason === 'infrastructure_error'`. Add an assertion that `details.code === 'EBADSTATUS'` (or the matching classification) so the contract is locked.
- [x] [Review][Patch] **`parseInt(iterations) || DEFAULT` silently rewrites `0` and ignores trailing junk** [`scripts/latency-baseline.ts:200-201`] — `LATENCY_BASELINE_ITERATIONS=0` becomes `DEFAULT=100` with no warning; `=10x` parses as `10`. Validate explicitly: `const n = Number(raw); if (!Number.isInteger(n) || n < MIN_ITERATIONS) { … }`.
- [x] [Review][Patch] **Lua scripts cast `lastModified`/`access` as `string` but Lua may return `nil`** [`src/silverbullet/scripts/{read-page,page-meta,list-pages,query-config-blocks}.lua.ts`] — A page/block missing the field renders as `undefined` while TS believes `string`. Add Lua `assert(meta.lastModified, "page meta missing lastModified")` (etc.) so the boundary fails loudly rather than silently lying about the type.
- [x] [Review][Patch] **`writeReport` failure inside fail-soft handler leaks unhandled rejection** [`scripts/latency-baseline.ts:226-239,266-279,297-313`] — If `_bmad-output/implementation-artifacts/` is read-only or missing, the inner `await writeReport(...)` rejects and `process.exit(0)` is never reached. Wrap each `writeReport` call in `try/catch` (log + exit 1 on failure) so the harness never hangs / never throws an unhandled rejection.
- [x] [Review][Patch] **Latency harness overwrites verified report on misconfigured invocation** [`scripts/latency-baseline.ts:189-191`] — When env vars are unset, the NOT-VERIFIED stub overwrites a previously-verified report. Either skip the write when env is unset, or write the stub to `latency-baseline.not-verified.md`.
- [x] [Review][Patch] **JSDoc gaps for `/.ping` auth + `Content-Type` decisions** [`src/silverbullet/client.ts:42-66, 196-219`] — Critical guardrail #15 (line 666) and #16 (line 667) both require documenting the resolved decisions: why `/.ping` carries `Authorization: Bearer` and why `Content-Type: text/x-lua` was chosen. Currently only generic AR25/D3 references exist. Add 2–3 sentence JSDoc rationales naming the source verified at story time.
- [x] [Review][Patch] **`safeReadText` JSDoc claims null-tolerance the type does not expose** [`src/silverbullet/client.ts:233-238`] — Docstring promises "A `null` response … yields `''`" but the function signature is `Response`, not `Response | null`. Fix the docstring to describe the actual behaviour (catches `text()` rejection and returns `''`).

**Defer (pre-existing or out-of-MVP scope, tracked in `deferred-work.md`):**

- [x] [Review][Defer] No fetch timeout — per Critical guardrail #9 (`AbortController` deferred until tail-latency pathologies surface).
- [x] [Review][Defer] `safeReadText` reads unbounded body before truncating (DoS-on-error vector).
- [x] [Review][Defer] `searchPagesScript` requires `silversearch` plug — operator prerequisite without startup health-check.
- [x] [Review][Defer] `extractCode` only handles string `code` (numeric/symbol errno is dropped) — pre-existing in `src/domain/error.ts:299-304`, not introduced by 1.7.
- [x] [Review][Defer] `OperationReport.nfr` allows `'NFR2'` but write-side measurement is Epic 2 scope.
- [x] [Review][Defer] `RUNTIME_ERROR_CODE` lacks `assertExhaustive` helper — add when Story 1.11 wires the switch.
- [x] [Review][Defer] `read-page.lua` race window between `getPageMeta` and `readPage` — D3 documents this; revisit in script-bundling optimisation.
- [x] [Review][Defer] Empty Lua table → JSON `{}` vs `[]` ambiguity — verify in first end-to-end smoke (Story 1.10).
- [x] [Review][Defer] `makeFetch` test-double cursor wraps + `clone()` returns `this` — minor footguns; tighten with Story 1.10 handler tests.
- [x] [Review][Defer] Test for `fetch` throwing non-Error errno-bearing values not present (only `Error` with attached `code` covered).
- [x] [Review][Defer] `buildScript` payload-alphabet safety relies on `'base64'` (not `'base64url'`) — add runtime guard or comment if the encoder is ever touched.

