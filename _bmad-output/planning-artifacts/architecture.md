---
stepsCompleted:
  - step-01-init
  - step-02-context
  - step-03-starter
  - step-04-decisions
  - step-05-patterns
  - step-06-structure
  - step-07-validation
  - step-08-complete
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
workflowType: 'architecture'
project_name: 'bmad-silverbullet-mcp'
user_name: 'Are'
date: '2026-04-30'
status: 'complete'
lastStep: 8
completedAt: '2026-04-30'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:** 28 FRs across 9 groups. The bulk of the architectural
weight sits in three groups: Permission Declaration (FR4–FR7), Page Edit/Batch
(FR17–FR23), and Audit & Observability (FR27–FR28). The other groups are
relatively conventional CRUD against the SilverBullet HTTP API gated by the
permission engine.

**Non-Functional Requirements:** 21 NFRs. The architecturally load-bearing ones:

- **Performance** — p95 ≤ 500ms reads / ≤ 1s writes (NFR1, NFR2); 3s cold start (NFR3); bounded memory growth (NFR4).
- **Security** — bearer-token never logged or echoed (NFR5); audit log records page *names* but not `none`-mode *content* (NFR6); HTTPS required except localhost (NFR7); no internal state leaks via the MCP surface (NFR8).
- **Reliability** — clean shutdown ≤ 1s on stdio close (NFR9); writes are atomic — full success or no observable change (NFR10); permission engine fails closed on ambiguity (NFR11); per-call failures don't poison the session (NFR12).
- **Compatibility** — Node ≥ 20.x LTS, no native modules (NFR13); SB compatibility breakage is P0 (NFR14); use the official MCP SDK rather than rolling protocol logic (NFR15).
- **Observability** — versioned audit log schema (NFR16); audit writes non-blocking on the tool-call path (NFR17); audit log human-readable when the server is offline (NFR18).
- **Testability** — permission engine and edit-batch validator are *pure functions* with no I/O (NFR19, NFR20); the entire test suite runs offline with no SilverBullet, no agent, no network (NFR21).

**Scale & Complexity:**

- Primary domain: stdio-MCP server / TypeScript backend tool
- Complexity level: low–medium overall, with medium–high logical density in two pure-function cores (permission engine, edit-batch validator)
- Estimated architectural components: ~6 (MCP protocol adapter, SilverBullet HTTP client, permission engine, freshness state, edit-batch validator, audit logger) plus a thin tool-handler layer composing them

### Technical Constraints & Dependencies

- **Language/runtime:** TypeScript on Node.js ≥ 20.x LTS, no native compilation (NFR13).
- **Distribution:** single npm package, invoked via `npx`. No Docker image, no native binaries in MVP.
- **Transport:** stdio only in MVP — HTTP/SSE deferred to Growth.
- **Authentication:** bearer token to SilverBullet only — no HTTP basic auth in MVP.
- **Protocol:** `@modelcontextprotocol/sdk` for MCP — no in-tree protocol implementation.
- **Upstream:** SilverBullet HTTP API; the SB client is the *only* component that does network I/O.
- **State:** zero persistent local state in MVP. All freshness tracking is in-memory and dies with the process.

### Cross-Cutting Concerns Identified

1. **Permission gating** — every tool handler funnels through the permission engine. Default-deny on unmarked pages (FR6), fail-closed on malformed declarations (NFR11).
2. **Freshness invariant** — every non-append write checks `lastModified > lastReadAt`. Atomic with the write itself.
3. **Audit logging** — every tool invocation, including rejected ones. Off the hot path (NFR17), human-readable offline (NFR18), no `none`-content leakage (NFR6).
4. **Structured error responses** — FR26 requires every rejection to be agent-actionable: category, failing operation identifier, and recovery guidance.
5. **Secret hygiene** — `SILVERBULLET_TOKEN` never reaches logs, errors, audit entries, or stdout/stderr (NFR5).
6. **Process lifecycle** — clean shutdown on stdio close ≤ 1s, no orphaned children (NFR9).
7. **Internal-state isolation** — last-read map, snapshots, and partial permission decisions never leak through MCP tool responses (NFR8).

## Starter Template Evaluation

### Primary Technology Domain

Stdio-MCP server / TypeScript backend tool, distributed as a single npm package
runnable via `npx`. Functionally narrow (~7 MCP tools wrapping one upstream HTTP API),
logically dense in two pure-function cores (permission engine, edit-batch validator).

### Starter Options Considered

1. **`@modelcontextprotocol/create-typescript-server`** (official Anthropic scaffolder)
   — `npx @modelcontextprotocol/create-server my-server`. Generates a minimal layout:
   `@modelcontextprotocol/sdk` + `zod`, a stub `src/index.ts` with one `registerTool`
   call, a tsconfig targeting ES2022/Node16, and a `tsc`-based build script. No test
   runner, no linter, no formatter included.

2. **Community starter `TheSethRose/MCP-Server-Starter`** — more opinionated. Adds
   tooling but is third-party, smaller audience, and ships choices that conflict with
   the decisions made here (build pipeline, test framework).

3. **Hand-rolled scaffold** — ~30 lines of `package.json`, ~15 lines of `tsconfig.json`,
   one `src/index.ts`, one `eslint.config.js`, one `.prettierrc.json`. No external
   scaffolder.

### Selected Starter: Hand-rolled scaffold

**Rationale for Selection:**

The official scaffolder is the natural starting point but adds little net value here:
its build script (`tsc`) gets deleted (we use Node-native type stripping); its tsconfig
gets adjusted (Node 24+ floor, NodeNext); it includes no test runner, no lint, and no
formatter, so we'd be adding all of those manually anyway. The community starter brings
opinionated tooling that conflicts with the decisions already made (e.g., `node:test`
over `vitest`, no bundler). Hand-rolling produces a smaller, more legible config that
matches the project's "boring + minimal deps" disposition exactly.

The scaffold is small enough to be the first implementation story rather than a
generated artifact.

### Architectural Decisions Provided by the Scaffold

**Language & Runtime:**

- TypeScript on Node.js **≥ 24.x** (supersedes PRD NFR13's "≥ 20.x" floor; rationale:
  enables native TS type stripping, removes the build step entirely, simplifies
  distribution and stack traces).
- ESM-only. `package.json` declares `"type": "module"`. No CJS dual-build.
- TS source files (`.ts`) are the published artifact. No compiled `dist/`.

**Build Tooling:**

- **No build step.** The published bin entry is `node ./src/index.ts`; Node strips
  types natively at load time (unflagged from Node 23.6 onward).
- `tsc --noEmit` runs in CI as the type-check gate. Type stripping is *not* type
  checking; bugs in types must be caught at CI time, not at runtime.
- No bundler. The npm package ships the `src/` tree and lets Node resolve it.

**Testing Framework:**

- `node:test` (built-in, zero runtime dep).
- Tests live next to the code under test (`src/permissions/engine.test.ts` next to
  `src/permissions/engine.ts`), invoked by `node --test 'src/**/*.test.ts'`.
- The test suite imports pure-function cores directly and never touches network or
  SilverBullet. Satisfies NFR19, NFR20, NFR21.

**Code Organization:**

- Single-package npm project. No monorepo, no workspaces.
- `src/` layout follows the architectural seams identified in Step 2:
  - `src/mcp/` — MCP SDK adapter and tool-handler layer (the MCP-protocol-facing edge)
  - `src/silverbullet/` — SilverBullet HTTP client (the only component that does network I/O)
  - `src/permissions/` — pure-function permission engine
  - `src/edits/` — pure-function edit-batch validator
  - `src/freshness/` — in-memory last-read state
  - `src/audit/` — audit logger
  - `src/config/` — env-var loading and validation (zod-parsed at startup)
  - `src/index.ts` — wiring and process lifecycle
- This file layout *is* the architecture seam list. Each directory is the home of one
  cross-cutting concern from Step 2.

**Lint / Format:**

- ESLint (flat config, `eslint.config.js`) + Prettier.
- Lint/format gate runs in CI alongside `tsc --noEmit` and `node --test`.

**Package Manager:**

- npm. Single `package-lock.json`. No pnpm, no bun.

**Development Experience:**

- `npm run dev` → `node --watch ./src/index.ts` (Node-native watch, no `tsx`).
- `npm run typecheck` → `tsc --noEmit`.
- `npm test` → `node --test 'src/**/*.test.ts'`.
- `npm run lint` → `eslint .`.
- `npm run format` → `prettier --write .`.

**Dependencies (initial set):**

- Runtime: `@modelcontextprotocol/sdk` (verify v1.x vs v2 at implementation time —
  v2 is anticipated Q1 2026; lock to whichever is stable when the first story lands),
  `zod` (input-schema validation, env-var parsing).
- Dev: `typescript`, `@types/node`, `eslint`, `prettier`, `@eslint/js`,
  `typescript-eslint`. Nothing else.

### Supersession of PRD NFR13

PRD NFR13 specifies "Node.js ≥ 20.x (active LTS at time of v1)". This architecture
narrows that floor to **Node.js ≥ 24.x** to enable native TypeScript type stripping
and eliminate the build step. The PRD should be amended to reflect this when the
PRD-edit pass runs alongside architecture sign-off.

**Note:** Project initialization using the hand-rolled scaffold (writing
`package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, the empty
`src/` tree, and the README skeleton) should be the first implementation story.

## Core Architectural Decisions

### Decision priority

**Critical (block implementation):**
- D1 — Permission declaration mechanism
- D2 — Permission cache & refresh model
- D3 — SilverBullet integration strategy

**Important (shape architecture significantly):**
- D4 — Audit log format & sink
- D5 — Configuration & startup validation
- D6 — Error response structure (FR26 contract)
- D7 — Process & diagnostic logging discipline

**Nice-to-have / can defer:**
- D8 — CI/CD & quality gates

### D1 — Permission Declaration Mechanism

**Mechanism:** SilverBullet `#mcp/config` tagged YAML fence blocks, queried via SB's tag index.

**Access modes:** total order by permissiveness:

```
none < read < append < write
```

`read` = list/read/search allowed. `append` = read + atomic append. `write` = read + append + edit + delete.

**Block format:**

````markdown
```yaml #mcp/config
access: write          # one of: none | read | append | write
exact: false           # optional, default false
```
````

**Scope of a block:**

- A block on the `CONFIG` page is **global** — applies to any page not matched by a more-specific rule.
- Any other block applies to its **host page and all descendants** (page-ref prefix match), unless `exact: true`, in which case it applies only to the host page.

**Resolution algorithm:**

```
resolve(pageRef, indexed_blocks) -> AccessMode:
  best_specificity = null
  matching_modes   = ∅

  for block in indexed_blocks:           # tag = "#mcp/config"
      root = block.page                   # the ref of the page hosting the block

      if root == "CONFIG":
          spec    = ("global",)
          matches = true
      elif block.exact:
          spec    = ("exact", root)
          matches = (pageRef == root)
      else:
          spec    = ("scope", len(root))
          matches = (pageRef == root) or pageRef.startsWith(root + "/")

      if not matches: continue

      # specificity ordering: exact > scope-by-longer-root > global
      if best_specificity is null or spec > best_specificity:
          best_specificity = spec
          matching_modes   = { block.access }
      elif spec == best_specificity:
          matching_modes.add(block.access)

  if matching_modes is empty:
      return "none"                       # default-deny

  # Tie-break within same specificity: most-permissive wins (OR-of-intents)
  return max(matching_modes, by permissiveness rank)
```

**Two ordering rules:**

1. **Across specificities** — most specific wins, regardless of permissiveness. A more-specific `none` overrides a less-specific `write`. (Security boundary preserved.)
2. **Within the same specificity** — least-restrictive wins. Multiple equally-specific blocks compose as a permission union.

**Default-deny:** any page not matched by any block resolves to `none`.

**Malformed-block handling (NFR11 fail-closed):** unparseable YAML or an `access` value not in the enum → the block is ignored entirely, recorded in the audit log with `category: config_error` (location of block included), and the scope falls through to the next-most-specific rule (or default-deny).

**Engine purity:** input is `(pageRef: Ref, blocks: ConfigBlock[]) → AccessMode`. Zero I/O. Satisfies NFR19 directly.

### D2 — Permission Cache & Refresh Model

**Strategy:** **No cache.** Every MCP tool invocation queries SilverBullet for current `#mcp/config` blocks before invoking the permission engine. The query is a single `POST /.runtime/lua` call against SB's index — sub-50ms typical, well within NFR1's 500ms read budget.

**Rationale:** simplest correct implementation. FR7 ("changes take effect on the next agent operation") is trivially satisfied because every operation refetches. No invalidation logic, no TTL constants, no stale-state branch in the engine.

**Failure mode — strict fail-closed:** if the index query fails for any reason (SB unreachable, Runtime API errors, malformed response), the tool call is rejected with a structured `infrastructure` error category (per FR26). The MCP server does not maintain a last-known-good cache and does not fall back to stale state. The audit log records the failed permission resolution with the underlying SB error.

**Memory profile:** each fetch's result is consumed and discarded. No persistent state — NFR4 satisfied trivially.

**Future optimization:** if profiling on a remote-WAN deployment shows the round-trip is the bottleneck, an etag-revalidating cache can be added without changing the engine's interface. Deferred until measurements justify it.

### D3 — SilverBullet Integration Strategy

**Single endpoint family:** all SilverBullet operations flow through `POST /.runtime/lua` (and `/.runtime/lua_script` where multi-statement scripts are needed). The MCP server does **not** use `/.fs/*` or any other SB HTTP surface beyond `GET /.ping` for liveness.

**Operation → space-lua mapping** (illustrative; exact API names settled at story time):

| MCP tool | space-lua approach |
|---|---|
| `read_page` | space-lua read returning `{ content, lastModified }` |
| `append_to_page` | space-lua atomic append |
| `edit_page` | read snapshot → resolve batch (pure validator) → write resolved content via space-lua |
| `create_page` | space-lua create |
| `delete_page` | space-lua delete |
| `list_pages` | `index.queryLuaObjects("page", …)` |
| `search_pages` | space-lua full-text query |
| Permission resolution (D1/D2) | `index.queryLuaObjects("mcp/config", …)` |
| Page metadata for freshness | space-lua page-meta lookup |

#### In-tree minimal client

There is no maintained community TypeScript client for SilverBullet. The project owns a small in-tree module with a single primitive:

```typescript
interface RuntimeClient {
  exec<T>(script: string, params?: Record<string, unknown>): Promise<T>
  ping(): Promise<void>           // GET /.ping
  probe(): Promise<void>          // POST /.runtime/lua "1"
}
```

This is the **only** module in the project that performs network I/O. All other modules accept parsed inputs and return pure outputs — satisfies NFR21 (test suite runs without a live SB).

#### Parameter passing across the TS ↔ Lua boundary

**Rule:** all values passed from TS to Lua are conveyed as a **base64-encoded JSON envelope**, decoded inside the Lua script. The base64 alphabet (`[A-Za-z0-9+/=]`) contains no Lua-string-literal escape characters, so naive interpolation into a Lua source string is provably injection-safe.

```typescript
function buildScript(template: string, params: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(params)).toString('base64')
  return `local _p = json.decode(base64.decode("${payload}"))\n${template}`
}
```

Lua-side decoding uses SB's built-in JSON / base64 utilities (exact API names confirmed at story time; if any are unavailable, a small inline helper ships as part of the script prelude).

**Asymmetry:** the return path doesn't need an envelope — the SB Runtime API JSON-encodes Lua return values into the response's `result` field, which we `JSON.parse` directly. We control the script side; SB controls the response side. The asymmetry is intentional.

**Forbidden:** raw string interpolation of any value into Lua source. Enforced by code review and by a unit test that asserts the encoder produces injection-safe output for adversarial inputs (e.g., `'; os.exit() --`).

#### Domain primitive: `Ref`

SilverBullet pages are addressed by **refs** (filesystem-shaped paths), not bare names. The codebase models this as a branded TypeScript primitive:

```typescript
type Ref = string & { readonly __brand: 'Ref' }

function makeRef(value: string): Ref {
  if (!isValidRef(value)) throw new RefValidationError(value)
  return value as Ref
}
```

**Validation rules** (refined at story time, minimally):

- Filesystem-safe characters only (no null bytes, no control characters)
- No `..` path-traversal segments
- No empty segments (`Foo//Bar` invalid)
- No leading/trailing whitespace
- Aligned with SB's accepted page-naming conventions

**Validation boundary:** every MCP tool argument naming a page is converted via `makeRef()` *before any other logic*. Invalid → structured `category: validation` error (FR26) returned to the agent immediately. Internal modules — permission engine, freshness state, edit-batch validator, audit logger, SB client — accept `Ref`, not `string`. The TypeScript type system enforces the discipline.

**Refs returned from SB** (e.g., the `page` field on a config block or search hit) are re-validated through `makeRef()` defensively. A malformed ref returned from SB is treated as a config error per NFR11 fail-closed.

#### Implications worth pinning explicitly

1. **NFR14 surface is now 100% Runtime API.** The Runtime API is marked `#maturity/experimental` in SB docs ("Not recommended for production"). Using it for MVP is a deliberate accepted risk — no other HTTP surface exposes SB's index, search, or atomic page operations. Documented prominently in the README; treated as P0 per the existing NFR14 stance.

2. **Latency exposure unverified.** Every operation pays the headless-Chrome round-trip. NFR1 (500ms reads) and NFR2 (1s writes) are *targets to verify* against the Runtime API as the first integration measurement. **The first implementation story includes a latency-baseline task.** If p95 round-trip exceeds budget, revisit (e.g., add etag revalidation, batch operations).

3. **Startup probe.** MCP server begins with `POST /.runtime/lua` of `1`. If response ≠ `{"result":1}`, server fails fast with a clear error pointing the user at SB-side Runtime API enable instructions (Chrome installed, `SB_RUNTIME_API` not disabled, Docker `-runtime-api` variant). Strict fail-closed, consistent with D2.

4. **Append atomicity** is delegated to SB's space-lua atomic append API. No read-modify-write on the MCP side, so no race against concurrent human edits.

5. **At-rest "edit" is always a full-page write.** The structured edit types (`replace_all`, `search_and_replace`, `replace_lines`, `insert_at_line`) are the agent-facing surface; under the hood, the pure edit-batch validator resolves them into a final page body, written via a single space-lua call.

6. **Auth.** Same `SILVERBULLET_TOKEN` bearer token is sent on every `/.runtime/*` request. If at implementation time this turns out to be wrong (Runtime API has its own auth model), surface a clear startup error — never fall through silently.

### D2/D3 PRD amendments to track

These accumulate alongside the Step 3 amendments (Node ≥ 24, mode-name renames):

3. **PRD §"State & Session Model"** uses "in-memory state, scoped to a single MCP server process lifetime" *for the freshness invariant*. Architecture extends the same in-memory-and-discarded principle to permission state — every tool call refetches; nothing persists across calls. The PRD wording is consistent but should be tightened to reflect that permission resolution is *also* scoped this way.
4. **PRD §"Implementation Considerations"** suggests a "maintained TypeScript HTTP client for SilverBullet if one exists in the community; otherwise, a minimal in-tree client targeting only the endpoints the tool surface needs." Architecture confirms: no community client exists; in-tree minimal client built. Endpoints the client targets are reduced to `/.ping` + `/.runtime/lua` + `/.runtime/lua_script` only — `/.fs/*` is not used.
5. **PRD MCP tool table** should reflect that page identifiers are **refs** (filesystem paths), not free-form names. Tool signatures: `read_page(ref)`, `append_to_page(ref, content)`, `edit_page(ref, edits[])`, etc.

### D4 — Audit Log Format & Sink

**Format:** JSON Lines (`.jsonl`). One JSON object per line, append-only, schema versioned via the `v` field.

**Sink:** single append-only file. **No rotation in MVP** — user manages size externally if needed.

**Default path** (platform-appropriate state directory):

- Unix/Linux/macOS: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl`, falling back to `~/.local/state/mcp-silverbullet/audit.jsonl`.
- Windows: `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl`.

**Override:** `MCP_SILVERBULLET_AUDIT_LOG_PATH` env var (absolute path).

**Directory bootstrap:** parent directory is created recursively (mode `0700`) at startup if missing. If creation fails (permissions, read-only filesystem), the server fails fast with a clear startup error.

**Why a file, not write-into-SilverBullet:** the PRD floats writing audit entries as SB pages as an option. Architecture decision: file-based for MVP. Reasons: (a) recursive coupling — the audit module would depend on the SB client it audits; (b) every tool call would generate page churn in the user's space; (c) if SB is down, audits would fail or stall, conflicting with NFR17. Write-into-SB is a clean Growth feature.

#### Schema (v1)

Required on every entry: `v`, `t`, `id`, `tool`, `args`, `decision`. Conditional: `reason` + `details` when `decision == "rejected"`. `response` always present (digest form).

```json
{
  "v": 1,
  "t": "2026-04-30T14:23:51.123Z",
  "id": "01HV7K5EQXY...",
  "tool": "edit_page",
  "args": {
    "ref": "Projects/Active/Foo",
    "edits": [
      { "type": "search_and_replace", "search": "TODO", "replace": "DONE" }
    ]
  },
  "decision": "rejected",
  "reason": "freshness_violation",
  "details": { "lastModified": "2026-04-30T14:20:01Z", "lastReadAt": "2026-04-30T13:45:00Z" },
  "response": { "error": "page_modified_since_read", "message": "..." },
  "durationMs": 87
}
```

**`id`** — ULID per call, lets log readers correlate related entries.

**Reason vocabulary** (closed set; new values require a schema version bump per NFR16):

- `permission_denied` — D1 resolved `none` or insufficient mode for the requested op.
- `freshness_violation` — non-append edit attempted on a page modified since `lastReadAt`.
- `validation_error` — input invalid (bad ref, batch overlap, unknown edit type, etc.).
- `infrastructure_error` — SB unreachable / Runtime API failure.
- `config_error` — malformed `#mcp/config` block, or other declaration parsing failure.
- `not_found` — page doesn't exist (or is `none` and indistinguishable from absent per FR13).

#### Verbosity policy: digest-only, with one principled split

- **`response` field (data flowing back to the agent):** content is recorded as `{ size, sha256 }`, never as bodies. For search results: ref list with scores, no snippets. For listings: ref list. NFR6 (no `none`-mode content) holds trivially because nothing user-derived is logged in full.
- **`args` field (data flowing in from the agent):** agent-authored values are recorded **in full** — including `search_and_replace` strings, content the agent wants to insert, etc. This is agent intent, not user data, and is essential for J3 forensics ("what would the agent have written?").

**Rule of thumb:** *content from the user's space is digested; content from the agent is logged in full.*

#### Non-blocking write path (NFR17)

```typescript
const stream = fs.createWriteStream(path, { flags: 'a' })
// per entry:
const ok = stream.write(JSON.stringify(entry) + '\n')
// no await — tool-call response path never waits on flush
// if !ok, queue subsequent entries in a small in-memory buffer until 'drain'
```

**Audit-write failure policy:** non-blocking-and-continue. If the stream errors (disk full, permissions revoked mid-session), the audit module logs a warning to the diagnostic stream (stderr — D7's domain) and keeps serving tool calls. The trade-off: forensic completeness can degrade silently relative to served traffic. Mitigation: warning is loud enough on stderr that the user notices.

**Shutdown discipline (NFR9):** on stdio close, drain the queue and `stream.end()` before process exit, well within the 1s NFR9 budget.

#### What the audit log does NOT contain

- The bearer token, ever (NFR5).
- Internal state — last-read map, freshness deltas beyond what `details` exposes for one call, partial permission decisions (NFR8).
- User page content beyond digest hashes (the rule above).
- Diagnostic / debugging output (those go to stderr — D7).

#### PRD amendment to track

6. **PRD §"Implementation Considerations"** says "audit log writes to stderr by default ... optionally to a file via configuration." Architecture inverts this: **audit log writes to a file by default** (FR28/NFR18 require a durable, post-mortem-readable sink); **stderr is reserved for diagnostic output** (D7). Update PRD to match.

### D5 — Configuration & Startup Validation

#### Configuration surface (env vars only — no config files)

| Variable | Required? | Description |
|---|---|---|
| `SILVERBULLET_URL` | yes | Endpoint of the user's self-hosted SilverBullet instance. Must be `https://` unless host is `localhost` or `127.0.0.1` (NFR7). |
| `SILVERBULLET_TOKEN` | yes | Bearer token. Never logged, echoed, or audited (NFR5). |
| `MCP_SILVERBULLET_AUDIT_LOG_PATH` | no | Absolute path overriding the default audit file location (D4). |

**No config file in MVP.** Env vars only — matches MCP convention (env block in `claude mcp add-json`) and keeps the install path single-artifact (J1 requirement). **No verbosity / log-level knob in MVP.**

#### Schema validation (zod)

zod is already pulled in for MCP tool input schemas; reusing it here for env-var validation costs nothing.

```typescript
const ConfigSchema = z.object({
  silverbulletUrl: z.string().url().refine(isHttpsOrLocalhost, {
    message: "SILVERBULLET_URL must use https:// (localhost/127.0.0.1 exempt)"
  }),
  silverbulletToken: z.string().min(1),
  auditLogPath: z.string().optional()  // absolute-path validation in code
})
```

#### Startup sequence (deterministic, fail-fast)

1. **Read env vars.** Missing required → exit 1, stderr names the missing var.
2. **Validate config (zod).** Failure → exit 1 with the zod issue list, **values redacted** (never echo the token, even if zod would happily include it).
3. **Resolve audit log path.** Create parent directory recursively (mode 0700) if missing. Failure → exit 1.
4. **Open audit log stream.** Errors → exit 1.
5. **Probe SB liveness:** `GET /.ping`. Failure → exit 1 with URL + underlying network error.
6. **Probe Runtime API + auth:** `POST /.runtime/lua` body `1` with bearer token.
   - `503` (API not enabled / no browser) → exit 1 pointing at SB Runtime API enable docs.
   - `401`/`403` → exit 1 with "authentication failed — check `SILVERBULLET_TOKEN`" (token value never echoed).
   - Other failures → exit 1 with underlying error.
   - `{"result":1}` → proceed.
7. **Connect MCP stdio transport** and start serving.

Steps 1–6 complete well within NFR3's 3s cold-start budget on a healthy SB.

#### Startup error format

Every fatal startup failure emits a single-line summary plus a one-line hint to stderr:

```
[mcp-silverbullet] FATAL: SilverBullet Runtime API not enabled (HTTP 503)
[mcp-silverbullet] hint: see https://silverbullet.md/Runtime%20API — Chrome/Chromium must be installed, or use the -runtime-api Docker variant
```

Exit code `1` for all startup failures in MVP. Distinct codes per failure category is a Growth concern.

#### No hot-reload

Config read once at startup. To pick up a changed env var or token, restart the MCP server (sub-3s per NFR3). MCP-client UIs restart MCP servers cleanly on config changes — no in-process reload mechanism needed.

#### Secret hygiene (NFR5) — three rules

1. **Never log the token value.** The diagnostic and audit modules receive a config wrapper whose `toString()`, `JSON.stringify`, and any custom serializer mask `silverbulletToken` as `***redacted***`.
2. **Never include the token in error messages.** Startup-failure messages above name only variable names and URLs.
3. **Never expose config state via the MCP tool surface (NFR8).**

### D6 — Error Response Structure (FR26 contract)

#### Single internal error type, two projections

```typescript
interface DomainError {
  reason: ReasonCode               // closed vocab; same value as audit log's `reason`
  ref?: Ref                        // page involved, when applicable
  details: Record<string, unknown> // reason-specific structured context
  failedOperation?: {              // batch errors: which entry failed (FR26)
    index: number                  //   0-based index into args.edits
    operation: object              //   the offending edit object
  }
}

type ReasonCode =
  | "permission_denied"
  | "freshness_violation"
  | "validation_error"
  | "infrastructure_error"
  | "config_error"
  | "not_found"
```

The same `DomainError` is consumed by:

- **Audit-log projection** → JSON-serialized into the JSONL entry's `reason` + `details` (+ `failedOperation` when present), per D4 schema.
- **MCP-response projection** → formatted into a single human-readable text block, returned via MCP SDK tool-result with `isError: true`.

#### Why a text block (not structured JSON) on the wire

MCP clients pass `content` blocks through to the LLM; `_meta` typically does not reach the model. For the agent to recover (read-then-retry, fix input, etc.), the guidance must be in `content` where the LLM will read it. Plain text formatted from the structured object is the most reliable shape.

The structured form lives in the audit log; the MCP response is the LLM-ready rendering of the same source object. Single source of truth, two projections.

#### Text format

Pure functions of the `DomainError`. Consistent shape per reason: one-line summary, context block, explicit recovery instruction.

**`freshness_violation` (matches J3 narrative verbatim):**

```
Edit rejected — page has changed since last read.

Page: Projects/Active/Foo
Last modified: 2026-04-30T14:20:01Z
Last read by you: 2026-04-30T13:45:00Z

To recover: call read_page("Projects/Active/Foo") to refresh, then retry your edit with the updated content in mind.
```

**`validation_error` in a batch (FR26 specifically requires identifying the failing op):**

```
Edit batch rejected — operation 2 of 3 failed.

Page: Projects/Active/Foo
Failed operation: search_and_replace { search: "TODO", replace: "DONE" }
Failure: search string "TODO" not found in page

To recover: call read_page("Projects/Active/Foo") to verify current content, then submit a corrected batch. No partial changes were applied.
```

**`permission_denied`:**

```
Operation rejected — permission denied.

Page: Personal/Journal/2026-04-21
Required: write
Granted: none

To recover: this page is not accessible to you. Choose a different page or ask the user to update its access mode.
```

**`infrastructure_error`:**

```
Operation could not be completed — SilverBullet unreachable.

Underlying error: ECONNREFUSED 127.0.0.1:3000

To recover: this is a transient infrastructure issue. Retry shortly. If the problem persists, the user should check that their SilverBullet instance is running.
```

#### Recovery template per reason (closed mapping; FR26 mandate)

| Reason | Recovery template |
|---|---|
| `permission_denied` | "this page is not accessible to you" — agent should not retry on the same ref |
| `freshness_violation` | "call read_page(<ref>) to refresh, then retry" — explicit re-read instruction |
| `validation_error` | "verify current content / fix the input, then retry" — points at what's wrong |
| `infrastructure_error` | "transient — retry shortly" — agent retry is acceptable |
| `config_error` | "configuration on the user's SilverBullet is malformed; user must fix it" — agent should not retry |
| `not_found` | "page does not exist (or is not accessible) — verify the ref" — interchangeable with `permission_denied` for `none` pages per FR13 |

`not_found` is deliberately ambiguous between "page doesn't exist" and "page is `none`-mode" — FR13 mandates this conflation so `none` pages are *invisible*, not advertised-but-blocked.

#### Information-leak rules (enforced in the formatter)

1. **Never include the bearer token.** When wrapping an underlying network/HTTP error, the formatter scrubs `Authorization` headers and any field named `token` / `apiKey` / `secret` / `password` before serializing. Centralized scrubber, unit-tested against a golden adversarial input set.
2. **Never include `none`-mode page content** (NFR6). `not_found` errors carry no body — trivially safe.
3. **Never expose internal MCP-server state** beyond what's strictly needed for recovery (NFR8). E.g., `freshness_violation.details` exposes `lastReadAt` (recovery requires understanding the read went stale); the permission engine's internal block-list is *not* exposed.
4. **No raw stack traces in agent-facing errors.** Stack traces go to the diagnostic stream (D7); the agent gets a clean human-readable message.

#### Implementation seam

Error formatter and audit serializer live in the same module (or sibling modules) and share the `ReasonCode` enum + per-reason `details` schemas. **Code-review rule:** any new reason or change to `details` shape requires updating both projections and bumping the audit schema version (NFR16).

### D7 — Process & Diagnostic Logging Discipline

#### The load-bearing stream rule

**stdout is reserved for MCP JSON-RPC traffic only.** Any non-protocol bytes on stdout corrupt framing and break the agent connection. This is the single most important runtime rule in the codebase.

**All diagnostic output goes to stderr.** Audit log goes to its file (D4). These are the only legitimate output destinations.

#### Defense-in-depth enforcement

1. **Lint:** ESLint `no-console` configured to allow only `console.error` and `console.warn`. `console.log` / `console.info` are errors. Direct `process.stdout.write` outside the MCP SDK is also flagged.
2. **Single approved API:** a diagnostic logger module is the only sanctioned writer to stderr. Other modules import the logger; nobody else touches streams directly.
3. **CI smoke test:** spin the server with a fake stdio peer, run a sequence of tool calls, assert every line on stdout is parseable JSON-RPC. Non-JSON on stdout fails the build.

#### Diagnostic log format

Plain text, single line per event, prefixed. No JSONL for diagnostics in MVP — these are for humans tailing stderr.

```
[mcp-silverbullet] INFO  starting up (silverbullet=https://example.com)
[mcp-silverbullet] INFO  connected — runtime API ok
[mcp-silverbullet] INFO  ready (transport=stdio, audit=/Users/are/.local/state/mcp-silverbullet/audit.jsonl)
[mcp-silverbullet] WARN  audit write failed: ENOSPC; continuing
[mcp-silverbullet] ERROR unhandled exception in tool handler: <message> (id=01HV...)
[mcp-silverbullet] INFO  stdio closed; flushing
[mcp-silverbullet] INFO  shutdown complete
```

**Levels (closed set, MVP):** `INFO`, `WARN`, `ERROR`. No `DEBUG` / `TRACE` in MVP. Adding levels later is purely additive.

**No log-level env var in MVP.** Everything is emitted unconditionally; volume is low (lifecycle + warnings + errors only).

#### What the diagnostic log contains

- **Lifecycle:** startup banner, ready signal, shutdown notice. Lines name relevant config (URL, audit path) but never the token.
- **Warnings:** audit-write failures (D4); permission engine encountering a malformed `#mcp/config` block (D1 — also recorded in audit as `config_error`); Runtime API returning unexpected response shapes the client tolerated; etc.
- **Errors:** unhandled exceptions in tool handlers (caught at the MCP boundary), stack traces from infrastructure failures (the *agent* gets a clean message per D6; the *operator* gets the full trace here).
- **Shutdown:** stdio close received, audit flush, runtime client teardown, exit.

#### What the diagnostic log does NOT contain

- Bearer token (NFR5) — same scrubber as D6.
- Per-tool-call traces / debug output. Audit log is the operational record (D4).
- Page content. (Would never reach diagnostics by design — stating it explicitly.)
- Internal state dumps (NFR8).

#### Process discipline (NFR9)

**Shutdown signals (cooperative):**

- `stdin` close (parent MCP client disconnects) → graceful shutdown.
- `SIGINT`, `SIGTERM` → graceful shutdown.

**Shutdown sequence (target ≤ 1s):**

1. Mark server "draining" — new tool calls rejected with `infrastructure_error` ("server shutting down").
2. Await in-flight tool calls (bounded by their own timeouts).
3. Flush audit stream and `stream.end()`.
4. Close the runtime HTTP client.
5. Close the MCP transport.
6. `process.exit(0)`.

**Hard stop:** if shutdown doesn't complete within ~900ms, force-exit anyway. Better to lose a few trailing log lines than to leave an orphan Node process around (the "stale Node from poorly-handled stdio exits" failure mode the PRD calls out).

**Unhandled exceptions / promise rejections** are caught by top-level handlers, logged at `ERROR`, and converted to a clean `infrastructure_error` for the in-flight tool call (if any). They do NOT crash the process — NFR12 (per-call failures don't poison the session) is load-bearing.

#### Exactly-one-audit-entry-per-tool-call invariant

Every tool invocation produces **exactly one audit-log entry** at the MCP boundary, regardless of internal control flow. If a handler throws halfway through, the boundary catch logs an `infrastructure_error` audit entry. This invariant makes the audit log a complete record of agent activity — there is no failure mode where a tool call leaves no trace.

The diagnostic log may emit zero-or-many lines per call; the audit log is exactly-one. They're decoupled.

### D8 — CI/CD & Quality Gates

#### CI provider

**GitHub Actions.** Default for npm/GitHub projects, free for public repos, no separate billing surface. No alternatives evaluated for MVP.

#### Workflow file: a single `ci.yml`

Triggers: push to `main`, pull request to `main`. Matrix on Node `24.x` (the floor set in Step 3). Optionally adds `25.x` to track current.

#### Quality gates (sequential; any failure fails the build)

| Gate | Command | Why it matters |
|---|---|---|
| Install | `npm ci` | Reproducible install from `package-lock.json` |
| Type check | `npm run typecheck` (= `tsc --noEmit`) | Native type stripping does not type-check at runtime; CI is the only place type errors are caught |
| Format check | `npx prettier --check .` | Cheap; catches drift |
| Lint | `npm run lint` (= `eslint .`) | Includes the `no-console` rule from D7 — stream-discipline statically enforced |
| Unit tests | `npm test` (= `node --test 'src/**/*.test.ts'`) | Pure tests; no SB, no network — NFR21 |
| Stdio smoke test | `node --test tests/smoke/stdout-discipline.test.ts` | Spins the server with a fake stdio peer; asserts every line on stdout is parseable JSON-RPC. Catches stream-discipline regressions D7's lint rule can't (e.g., a transitive dep printing to stdout) |

**No coverage gate in MVP.** `node:test` has built-in coverage (`--experimental-test-coverage`); enable later if a number turns out to be useful. Premature coverage gating incentivizes bad tests.

#### Test layout

- Pure-function tests adjacent to source: `src/permissions/engine.test.ts` next to `src/permissions/engine.ts`.
- Multi-module integration tests (still no SB) in `tests/integration/`.
- Process-level smoke tests (fake stdio) in `tests/smoke/`.

All three picked up via `node --test` globs. No separate runners.

#### Local git hooks (agent verification gates)

**Purpose:** verify every commit produced by an agent passes the same gates CI runs, *before* the commit is recorded. CI is canonical; hooks are fast local feedback while the agent still has full context to fix problems.

**Hook runner: `simple-git-hooks`** (~5KB, declared inline in `package.json`):

```json
{
  "simple-git-hooks": {
    "pre-commit": "npx lint-staged && npm run typecheck && npm test",
    "pre-push": "node --test tests/smoke/stdout-discipline.test.ts"
  },
  "lint-staged": {
    "*.{ts,js,json,md}": "prettier --check",
    "*.ts": "eslint"
  }
}
```

`husky` is a defensible alternative (more popular, convention-laden). Chosen against on minimal-deps grounds.

**Hook contents:**

- **`pre-commit`** — `lint-staged` (prettier + eslint on staged files) → `tsc --noEmit` (full) → `node --test` (full). Sub-5s on this codebase.
- **`pre-push`** — stdout-discipline smoke test. Heavier; warranted only on the boundary into shared history.

**Installation:** `simple-git-hooks` is a devDependency. Hooks activate via `npx simple-git-hooks` once after `npm install`. **No `postinstall` script** (security: postinstall is a known npm-supply-chain concern and can be bypassed with `--ignore-scripts`). Activation is the first step in CONTRIBUTING.md after clone.

**Bypass discipline:** agents are forbidden from using `--no-verify`. Stated explicitly in CLAUDE.md / agent instructions and CONTRIBUTING.md. If a hook fails, the agent investigates and fixes — bypassing is treated as a failed iteration. The hook is the project's most direct guardrail against agent regressions in the daily build cadence.

#### Release process

**Manual for MVP.** Steps:

1. Bump: `npm version <patch|minor|major>`.
2. Push commit + tag.
3. CI builds + tests against the tag.
4. Maintainer runs `npm publish` from a clean checkout.
5. Create a GitHub Release at the tag with a changelog excerpt.

Automated tag-triggered publish is a Growth concern (needs `NPM_TOKEN` secret + provenance config + release workflow). Not worth the surface in MVP.

#### Versioning policy

**Semver, starting at `0.1.0`.** The pre-1.0 prefix signals: "depends on SilverBullet's experimental Runtime API; itself MVP; minor versions may change compatibility."

Move to `1.0.0` when the SB Runtime API graduates from `#maturity/experimental` *or* the thesis is sufficiently proven on real day-to-day use (per PRD Innovation Validation criteria).

#### Published artifact

Because the project ships TS source (no build step — Step 3), `package.json` `files` lists exactly:

```json
"files": ["src/**/*.ts", "README.md", "LICENSE"]
```

Tests, configs, and `tsconfig.json` are excluded. Smaller install for `npx` consumers.

#### Supply chain

**Dependabot enabled** for npm + GitHub Actions on a weekly cadence. Auto-PR for patch/minor; manual review for major. The dependency surface is small (D3 minimal-deps stance) so noise is bounded.

### Decision Impact Analysis

#### Implementation sequence (suggested order for stories)

The decisions imply a layered build order. Each layer depends only on the ones above it.

1. **Project scaffold** — `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `simple-git-hooks` config, `src/` tree, `tests/` skeleton. (Step 3 + D8.)
2. **`Ref` domain primitive** — branded type + `makeRef` + validation rules + tests. (D3.)
3. **Diagnostic logger** — stderr-bound logger module, no-console lint rule active. (D7.) Depended on by everything else.
4. **Configuration module** — env-var parsing, zod schema, secret-scrubber wrapper, startup error format. (D5.)
5. **Audit logger** — JSONL stream module, ULID generator, schema-v1 writer, drain handling, shutdown flush. (D4.)
6. **`DomainError` + formatter + audit serializer** — single source of truth, two projections. (D6.) Depended on by tool handlers and the runtime client.
7. **In-tree SB Runtime client** — `exec` primitive with base64+JSON envelope, `ping`, `probe`, secret scrubber on errors. Lua script templates for the operation set. (D3.)
8. **Permission engine** — pure function `(Ref, ConfigBlock[]) → AccessMode` with the resolution algorithm from D1. Tests cover specificity ordering, tie-breaking, malformed-block fail-closed.
9. **Edit-batch validator** — pure function `(snapshot, edits[]) → resolvedContent | DomainError`. Tests for overlap, snapshot-relative resolution, atomicity, all four edit op types.
10. **Freshness state** — `Map<Ref, lastReadAt>` with bounded-size policy. Updated only on successful `read_page`.
11. **Tool handlers** — one per MCP tool. Each handler is a thin orchestrator: input validation → permission resolve → freshness check (where applicable) → SB call → response → audit log entry. The exactly-one-audit-entry invariant is enforced here.
12. **Startup sequence + lifecycle** — wires steps 1–11; runs the D5 startup ladder; installs SIGINT/SIGTERM handlers and the D7 shutdown sequence.
13. **CI smoke test for stdout discipline** — fake-stdio harness in `tests/smoke/`.
14. **CI workflow + Dependabot config** — `.github/workflows/ci.yml`, `.github/dependabot.yml`.

#### Cross-component dependency map

| Component | Depends on |
|---|---|
| `Ref` | — |
| Diagnostic logger | — |
| Configuration | (Diagnostic logger for startup errors) |
| Audit logger | Configuration (for path), `DomainError` (for serialization) |
| `DomainError` + formatter | `Ref`, `ReasonCode` enum |
| SB Runtime client | Configuration, `DomainError` (for infra errors), `Ref` |
| Permission engine | `Ref`, `ConfigBlock` parser |
| Edit-batch validator | `Ref`, edit-op types |
| Freshness state | `Ref` |
| Tool handlers | All of the above |
| Startup / lifecycle | All of the above |

The dependency graph is layered and acyclic. Pure-function cores (permission engine, edit-batch validator) depend only on domain primitives, satisfying NFR19/NFR20 by construction. The SB client is the only component that performs network I/O, satisfying NFR21 — the entire test suite mocks at this single seam.

#### Open implementation questions deferred to story-time

These are deliberately not architecture-level decisions; flagged so the first stories don't miss them:

- Exact space-lua API names for each operation (D3) — settle by reading SB source / docs at implementation time.
- Whether SB's space-lua exposes built-in `base64` and `json` helpers, or whether the script prelude needs an inline implementation (D3).
- Exact `Ref` validation regex (D3) — needs verification against SB's accepted page-naming rules.
- ULID library choice for audit-entry IDs (D4) — pick a small zero-dep one.
- Latency baseline measurement against a real Runtime API (D3) — first story includes this; if p95 is over budget, revisit caching strategy in D2.

### PRD amendments accumulated through Step 4

For back-feeding into a PRD-edit pass:

1. **NFR13:** Node ≥ 20.x → Node ≥ 24.x (Step 3).
2. **Permission mode names:** `read-only` / `append-only` / `read-write` → `read` / `append` / `write` (D1).
3. **State & Session Model:** add note that permission state, like freshness state, is in-memory and discarded between calls; no persistence in MVP (D2).
4. **Implementation Considerations / SB client:** confirm in-tree minimal client (no community library exists). Endpoints used: `/.ping` + `/.runtime/lua` + `/.runtime/lua_script` only — `/.fs/*` not used (D3).
5. **MCP tool table:** page identifiers are **refs** (filesystem paths), not free-form names. Tool signatures: `read_page(ref)`, `append_to_page(ref, content)`, etc. (D3).
6. **Implementation Considerations / Logging:** audit log writes to a **file** by default; stderr is reserved for diagnostic output. Inverts current PRD wording (D4).
7. **NFR14 surface:** explicitly include the SilverBullet Runtime API (currently `#maturity/experimental`) as in-scope for the P0 compatibility stance (D3).

## Implementation Patterns & Consistency Rules

These patterns prevent multiple AI agents (and human contributors) from diverging on choices the architecture leaves implicit. They are mandatory rules, not suggestions — deviations require documenting *why* in code review, not just code.

Categories from the workflow template that **do not apply** to this project (and why):

- ❌ Database naming — no DB.
- ❌ REST endpoint conventions — MCP is JSON-RPC over stdio.
- ❌ Frontend state management — no UI.
- ❌ Static asset organization — no assets.
- ❌ HTTP route conventions — single upstream (SB Runtime API), client surface is one method.

Categories that **do** apply are covered below.

### Naming

**Files and directories:**

- TypeScript files: `kebab-case.ts` (e.g., `permission-engine.ts`, `edit-batch-validator.ts`).
- Test files: same name as the unit under test, suffixed `.test.ts` (e.g., `permission-engine.test.ts`).
- Directory names: lowercase, hyphenated where multi-word.
- Lua script files: `kebab-case.lua.ts` — TypeScript module exporting a Lua template string and its return type. The `.lua.ts` suffix makes "Lua content shipped from TS" greppable.

**TypeScript identifiers:**

- Types and interfaces: `PascalCase` (`DomainError`, `RuntimeClient`, `ConfigBlock`).
- Functions and variables: `camelCase` (`resolveAccess`, `lastReadAt`).
- Module-level constants: `camelCase` for computed values; `SCREAMING_SNAKE_CASE` only for true compile-time literals.
- Discriminant fields on tagged unions: `type` (e.g., `Edit.type === "search_and_replace"`).

**Environment variables:**

- `SCREAMING_SNAKE_CASE`.
- Project-specific vars carry the `MCP_SILVERBULLET_` prefix (e.g., `MCP_SILVERBULLET_AUDIT_LOG_PATH`).
- SB-pass-through vars (`SILVERBULLET_URL`, `SILVERBULLET_TOKEN`) match the upstream's convention exactly to reduce confusion.

**MCP tool names:**

- `snake_case` per MCP convention (e.g., `read_page`, `edit_page`, `search_pages`). Agent-facing names — never invented or shortened in the codebase.

**Reason codes (DomainError + audit log):**

- `snake_case` (e.g., `permission_denied`, `freshness_violation`). Closed enum — adding a value requires bumping the audit schema version (NFR16).

**Audit log field names:**

- `camelCase` (e.g., `lastModified`, `failedOperation`). Default `JSON.stringify` form — no field-name transformation. Top-level fields exactly as defined in D4.

**Date and time:**

- All timestamps stored and serialized as ISO 8601 UTC strings (`Date.toISOString()` output).
- Comparisons internal to the engine use `Date.parse(...)` or epoch milliseconds.
- Never local-zone times anywhere — the audit log spans sessions and machines.

**Refs:**

- Refs are SB page paths, validated by `makeRef`. Never invent display-name conversions. Audit log records the ref string verbatim; the agent receives the ref string verbatim.

**SB tag namespace:**

- `#mcp/config` for permission declaration blocks (D1). Future tags in this namespace use the same `#mcp/<name>` form. Never bare `#config` or `#mcpconfig`.

### Structure

**Top-level layout** (extends Step 3):

```
src/
  index.ts                          # entry point: startup ladder + MCP transport wiring
  config/                           # env-var loading, zod schema, secret-scrubber wrapper
    config.ts
    config.test.ts
  diagnostic/                       # stderr logger module (D7)
    logger.ts
    logger.test.ts
  audit/                            # JSONL audit log (D4)
    audit-logger.ts
    audit-logger.test.ts
    schema.ts                       # schema v1 type definitions
  domain/                           # value objects shared across modules
    ref.ts                          # branded Ref + makeRef
    ref.test.ts
    error.ts                        # DomainError + ReasonCode + formatter (D6)
    error.test.ts
  permissions/                      # pure permission engine (D1)
    engine.ts
    engine.test.ts
    config-block-parser.ts          # YAML-fence-block parser
    config-block-parser.test.ts
  edits/                            # pure edit-batch validator (FR17–23)
    validator.ts
    validator.test.ts
    types.ts                        # Edit discriminated union
  freshness/                        # in-memory last-read state
    state.ts
    state.test.ts
  silverbullet/                     # SB Runtime client + Lua templates
    client.ts                       # the RuntimeClient interface + impl
    client.test.ts
    envelope.ts                     # base64+JSON parameter encoder
    envelope.test.ts
    scripts/                        # one .lua.ts file per Lua template
      read-page.lua.ts
      write-page.lua.ts
      append-page.lua.ts
      delete-page.lua.ts
      list-pages.lua.ts
      search-pages.lua.ts
      query-config-blocks.lua.ts
      page-meta.lua.ts
  mcp/                              # MCP tool registration + handlers
    registry.ts                     # registers all tools with the SDK
    handlers/                       # one file per tool handler
      read-page.ts
      append-to-page.ts
      edit-page.ts
      create-page.ts
      delete-page.ts
      list-pages.ts
      search-pages.ts
    handler-template.ts             # canonical handler shape (helper / type)
tests/
  integration/                      # multi-module tests, no SB
  smoke/
    stdout-discipline.test.ts       # the CI smoke test from D7/D8
```

**Rules:**

- One unit per file. A "unit" is a coherent abstraction (a single class/function/type plus its closely-coupled helpers).
- Tests adjacent to the unit they test. Multi-unit tests live under `tests/integration/`.
- **No `index.ts` re-export barrels.** Imports name the file directly — avoids subtle cycle-introducing re-exports and keeps `tsc` fast.
- **No "utils" or "helpers" catchalls.** If something doesn't fit an existing module, it needs a new module with a name describing its actual purpose.

### Type-safety patterns

**Branded primitives for domain values.** `Ref` is the model. Add new branded types when a string or number has a meaning the type system should distinguish:

```typescript
type ReasonCode = "permission_denied" | "freshness_violation" | "..."  // string union, not branded — values are literals
type Ref = string & { readonly __brand: "Ref" }
type AuditEntryId = string & { readonly __brand: "AuditEntryId" }      // ULID
```

Constructors validate at the boundary. Internal code never re-validates.

**Discriminated unions for variants.** All variant types use `type` as the discriminant:

```typescript
type Edit =
  | { type: "replace_all"; content: string }
  | { type: "search_and_replace"; search: string; replace: string; occurrence?: number | "all" }
  | { type: "replace_lines"; from_line: number; to_line: number; content: string }
  | { type: "insert_at_line"; line: number; content: string; position?: "before" | "after" }

type AccessMode = "none" | "read" | "append" | "write"
```

Switch statements over discriminated unions are exhaustive: TypeScript's `never` check makes missed cases compile errors. `default: never` clauses are the rule.

**No `any`. No `as` outside boundaries. No `@ts-ignore`.**

- `unknown` is the right type for parsed external input (env vars, JSON, Lua return values). Narrow with type guards or zod.
- `as` is permitted only inside a brand constructor or zod-parsed boundary.
- `@ts-ignore` and `@ts-expect-error` are forbidden without an inline justification comment naming a tracked issue. ESLint enforces.

**No nullish-coalescing as a substitute for default values from validation.** Defaults belong in zod schemas (or explicit constructor logic), not scattered as `?? default` at use sites.

### Tool-handler shape (the load-bearing pattern)

Every MCP tool handler is the **same shape**. Deviation is a code-review block.

```typescript
export async function handleEditPage(
  input: unknown,
  ctx: HandlerContext     // injects: client, permissionEngine, freshnessState, audit, logger, clock
): Promise<MCPToolResult> {
  const startedAt = ctx.clock.now()
  let outcome: AuditOutcome   // populated on every path

  try {
    // 1. Parse + validate (zod schema → typed args). Failure → validation_error.
    const args = EditPageInputSchema.parse(input)
    const ref = makeRef(args.ref)

    // 2. Fetch current permission state (D2: every call refetches).
    const blocks = await ctx.client.queryConfigBlocks()
    const access = ctx.permissionEngine.resolve(ref, blocks)
    if (access !== "write") {
      outcome = { decision: "rejected", error: permissionDeniedError(ref, "write", access) }
      return formatToolError(outcome.error)
    }

    // 3. Freshness check (D2 read-before-edit).
    const lastReadAt = ctx.freshness.get(ref)
    const meta = await ctx.client.pageMeta(ref)
    if (!lastReadAt || meta.lastModified > lastReadAt) {
      outcome = { decision: "rejected", error: freshnessViolation(ref, meta.lastModified, lastReadAt) }
      return formatToolError(outcome.error)
    }

    // 4. Read snapshot, run pure validator, write resolved content.
    const snapshot = await ctx.client.readPage(ref)
    const result = applyEdits(snapshot.content, args.edits)
    if (result.kind === "error") {
      outcome = { decision: "rejected", error: result.error }
      return formatToolError(outcome.error)
    }
    await ctx.client.writePage(ref, result.content)
    ctx.freshness.touch(ref, ctx.clock.now())   // post-successful-write

    outcome = { decision: "allowed", responseDigest: digest(result.content) }
    return formatToolSuccess(outcome.responseDigest)

  } catch (err) {
    // Top-level catch → infrastructure_error. Logs full trace to diagnostic.
    ctx.logger.error("edit_page handler crashed", err)
    outcome = { decision: "rejected", error: infrastructureError(err) }
    return formatToolError(outcome.error)

  } finally {
    // Exactly-one audit entry per call, always (D7 invariant).
    ctx.audit.write({
      tool: "edit_page",
      args: input,                  // raw input; agent intent in full per D4
      outcome,
      durationMs: ctx.clock.now() - startedAt
    })
  }
}
```

**Required structural elements (every handler):**

1. Top-level `try / catch / finally`.
2. The `finally` writes exactly one audit entry — never inside `try`, never duplicated.
3. The order of checks: parse → permission → freshness (if applicable) → execute → respond.
4. Failures return early with a `formatToolError`. They never throw past the `finally`.
5. `ctx` injection — no module-level singletons reached from inside a handler.

The `handler-template.ts` file in `src/mcp/` defines `HandlerContext` and helper functions (`formatToolError`, `formatToolSuccess`, `permissionDeniedError`, etc.). New handlers are authored by copying the template and filling in the body.

### Error-handling discipline

- **Return `DomainError`, do not throw it.** `DomainError` is an *expected* outcome of the domain logic. Throwing reserves a higher cost (control-flow disruption, stack-trace allocation) for invariant violations and infrastructure failures.
- **Throw only for invariant violations and at boundaries you control.** `assert(...)`, unparseable internal data (a bug if it happens), unhandled async errors at the top-level catch.
- **The `Result<T>` shape used in the validator and elsewhere:**
  ```typescript
  type Result<T> = { kind: "ok"; value: T } | { kind: "error"; error: DomainError }
  ```
  Pure functions return `Result<T>`. Handlers and async code use try/catch only for `infrastructure_error` capture.
- **Top-of-handler catch always converts to `infrastructure_error`.** Internal logic errors are still presented to the agent as actionable infrastructure errors with the underlying `err.message` (after secret-scrubbing).
- **Never swallow errors.** A bare `catch {}` is forbidden. ESLint enforces.

### Lua-script organization

- One `.lua.ts` file per Lua template under `src/silverbullet/scripts/`.
- Each file exports the template string *and* the TypeScript type of the script's return value:

  ```typescript
  // src/silverbullet/scripts/read-page.lua.ts
  export type ReadPageResult = { content: string; lastModified: string }
  export const readPageScript = `
    local meta = space.getPageMeta(_p.ref)
    local content = space.readPage(_p.ref)
    return { content = content, lastModified = meta.lastModified }
  `
  ```

- Parameters always pass through the base64+JSON envelope (`_p`). **Never** raw-interpolate agent input or any value into a Lua template (D3).
- `client.exec<T>(script, params)` is invoked with the explicit return type:
  ```typescript
  const result = await client.exec<ReadPageResult>(readPageScript, { ref })
  ```
  No implicit `any` propagating from `exec`.

### Stream/output discipline (D7 codified)

- **`console.log` is forbidden** (`no-console: ["error", { allow: ["error", "warn"] }]`).
- **`process.stdout.write` is forbidden outside the MCP SDK invocation paths.** ESLint custom rule (or pre-commit grep check).
- All non-protocol output flows through `src/diagnostic/logger.ts`. Importing it is the single sanctioned entry for stderr writes.

### Async patterns

- All I/O is `async/await`. No callback-style APIs except where Node forces them (`stream.on('drain', ...)` etc.), wrapped immediately into a Promise inside the audit module.
- `no-floating-promises` ESLint rule enforced. `void someAsync()` is permitted only with an inline comment explaining why fire-and-forget is correct (the audit-write path is the only sanctioned use).
- `no-misused-promises` enforced — async functions cannot be passed where a sync callback is expected.

### Testing patterns

- **Pure-function modules** (permission engine, edit-batch validator, error formatter, ref validation, audit serialization, envelope encoder): tested with direct imports. No mocks, no DI, no fixtures beyond inline values.
- **Stateful modules** (freshness state, audit logger): tested with a fake clock injected through the constructor / context. No real `Date.now()` in tests.
- **The SB client is the only mocked seam.** Handler tests inject a `RuntimeClient` test double that returns canned responses. The real client itself has separate contract tests against an HTTP test fixture (no live SB needed) — these verify the base64 envelope, response parsing, and error paths.
- **Property-based tests for the edit-batch validator** (PRD risk-mitigation explicit call-out). Properties to verify:
  - Atomicity: a rejected batch returns the input snapshot unchanged.
  - Snapshot-relative resolution: line numbers always reference the original.
  - Overlap detection: any two ops touching the same region → reject.
  - Atomic apply equals sequential-with-rollback: applying [A, B] is equivalent to applying A then B if both succeed against an immutable snapshot.

### Mandatory rules summary (for agent self-checks)

Every agent contributing code MUST:

1. Place new files in the correct module directory; never put logic in a "utils" file.
2. Follow the tool-handler shape exactly (try/catch/finally + exactly-one audit entry).
3. Pass all parameters to Lua via the base64+JSON envelope; never interpolate.
4. Validate inputs at module boundaries with zod or `makeRef`/equivalent constructor; never re-validate inside.
5. Return `DomainError` for expected failures; throw only for invariants and infra.
6. Never write to stdout outside the MCP SDK. Only `console.error` / `console.warn` permitted, and only via the diagnostic logger module.
7. Bump the audit schema version (NFR16) when changing the audit entry shape.
8. Add tests adjacent to the unit. Pure tests for pure modules; mocked-client tests for handlers.
9. Run `npm run typecheck && npm test && npm run lint` before claiming a task is done (the pre-commit hooks enforce this on commit, but the agent should verify before the commit).
10. Never use `--no-verify` (D8 hook bypass).

### Anti-patterns explicitly forbidden

- `any` types or implicit-any function parameters.
- Module-level singletons reached from handler bodies (use `HandlerContext` injection).
- String interpolation of any value into a Lua script body.
- `console.log` / `console.info`.
- `// @ts-ignore` without a tracked-issue justification.
- Audit entries written outside the handler's `finally`.
- Permission checks duplicated across modules (engine is the only place).
- Catching `DomainError` to reformat it (it's already in its final shape — pass through).
- Re-export barrel files (`index.ts` that re-exports a directory).
- Date math using local-time `Date` methods (`getHours`, etc.).

## Project Structure & Boundaries

### Complete repository layout

```
bmad-silverbullet-mcp/
├── package.json                     # deps, scripts, simple-git-hooks config, files allowlist
├── package-lock.json
├── tsconfig.json                    # ES2022 / NodeNext / strict; noEmit-only (no build)
├── eslint.config.js                 # flat config; no-console; no-floating-promises; etc.
├── .prettierrc.json
├── .editorconfig
├── .gitignore                       # node_modules, .env*, audit logs in CWD, OS junk
├── .npmignore                       # backstop; the `files` field in package.json is primary
├── LICENSE                          # open-source, license to be chosen at first publish
├── README.md                        # install + configure + usage; prominently calls out
│                                    #   the SB Runtime API requirement (D3 + NFR14)
├── CONTRIBUTING.md                  # setup steps; first command after clone is
│                                    #   `npx simple-git-hooks` (D8); no --no-verify rule
├── CLAUDE.md                        # agent guardrails: pattern rules from Step 5,
│                                    #   no-bypass discipline, audit invariant
├── CHANGELOG.md                     # keep-a-changelog format; per release
├── .github/
│   ├── workflows/
│   │   └── ci.yml                   # D8 gates: install → typecheck → format → lint → test → smoke
│   ├── dependabot.yml               # weekly npm + actions, auto-PR patch/minor (D8)
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       └── feature_request.md
├── docs/
│   ├── architecture.md              # symlink or pointer to this document
│   ├── threat-model.md              # honest disclosure: `none`-mode is best-effort,
│   │                                #   Runtime API is experimental (NFR6 spirit + PRD)
│   ├── permissions.md               # how to author #mcp/config blocks, examples
│   ├── audit-log.md                 # schema reference; example jq queries
│   └── starter-template.md          # paste-ready CONFIG snippets for typical layouts
├── src/                             # — see expanded tree below —
└── tests/
    ├── integration/                 # multi-module tests; no SB; no network
    │   └── handler-edit-page.test.ts # exercises permission + freshness + validator paths
    └── smoke/
        └── stdout-discipline.test.ts # D7/D8 invariant gate

src/
├── index.ts                         # entry point: startup ladder + MCP transport wiring
├── config/                          # FR1–FR3, NFR5, NFR7
│   ├── config.ts                    #   env-var parsing, zod schema, https-or-localhost check
│   ├── config.test.ts
│   └── secret-scrubber.ts           #   wraps the config object, masks token in serializers
├── diagnostic/                      # D7
│   ├── logger.ts                    #   stderr-only logger; INFO/WARN/ERROR; structured prefix
│   └── logger.test.ts
├── audit/                           # FR27, FR28, NFR6, NFR16, NFR17, NFR18
│   ├── audit-logger.ts              #   JSONL writer; createWriteStream; drain handling
│   ├── audit-logger.test.ts
│   ├── schema.ts                    #   v1 type definitions: Entry, Outcome, ReasonCode export
│   └── digest.ts                    #   { size, sha256 } digest helper for response field
├── domain/                          # value objects across modules
│   ├── ref.ts                       #   branded Ref + makeRef + RefValidationError
│   ├── ref.test.ts
│   ├── error.ts                     #   DomainError, ReasonCode enum, formatter (D6)
│   ├── error.test.ts
│   └── result.ts                    #   Result<T> = { kind: "ok", value } | { kind: "error", error }
├── permissions/                     # FR4–FR10 (D1, NFR11, NFR19)
│   ├── engine.ts                    #   pure resolve(ref, blocks) → AccessMode
│   ├── engine.test.ts
│   ├── access-mode.ts               #   "none" | "read" | "append" | "write" + permissiveness rank
│   ├── config-block-parser.ts       #   YAML-fence parser; fail-closed on malformed
│   └── config-block-parser.test.ts
├── edits/                           # FR17–FR23 (NFR20)
│   ├── validator.ts                 #   pure applyEdits(snapshot, edits) → Result<string>
│   ├── validator.test.ts            #   includes property-based tests
│   ├── types.ts                     #   Edit discriminated union
│   └── overlap.ts                   #   region overlap detection helper
├── freshness/                       # supports FR20 (D3)
│   ├── state.ts                     #   Map<Ref, lastReadAt> with bounded-size policy
│   └── state.test.ts
├── silverbullet/                    # the only network-touching module (D3)
│   ├── client.ts                    #   RuntimeClient impl; exec/ping/probe; bearer auth
│   ├── client.test.ts               #   contract tests against HTTP fixture
│   ├── envelope.ts                  #   buildScript(template, params) → base64+JSON wrap
│   ├── envelope.test.ts             #   adversarial-input safety tests
│   └── scripts/                     #   one .lua.ts module per Lua template
│       ├── read-page.lua.ts
│       ├── write-page.lua.ts
│       ├── append-page.lua.ts
│       ├── delete-page.lua.ts
│       ├── create-page.lua.ts
│       ├── list-pages.lua.ts
│       ├── search-pages.lua.ts
│       ├── query-config-blocks.lua.ts
│       └── page-meta.lua.ts
└── mcp/                             # MCP SDK adapter + handlers
    ├── registry.ts                  #   registers tools with @modelcontextprotocol/sdk
    ├── handler-template.ts          #   HandlerContext type, formatToolError/Success helpers
    └── handlers/                    #   one file per MCP tool
        ├── read-page.ts             # FR11–FR13
        ├── append-to-page.ts        # FR14–FR16
        ├── edit-page.ts             # FR17–FR23
        ├── create-page.ts           # FR24
        ├── delete-page.ts           # FR25
        ├── list-pages.ts            # FR8, FR10
        └── search-pages.ts          # FR9, FR10
```

### Architectural boundaries

The system has exactly **five external boundaries.** Every byte of I/O passes through one of them; everything else is pure.

```
                    ┌────────────────────────────────────────────────────────┐
   stdin / stdout   │                                                        │   stderr
   (JSON-RPC)  ───► │         src/index.ts (process lifecycle)               │ ──► (diagnostics)
                    │              │                                         │
                    │              ▼                                         │
                    │         src/mcp/  (SDK adapter + handlers)             │
                    │              │                                         │
                    │              │ ── ctx.audit.write ────────────────►    │   audit.jsonl
                    │              │                                         │ ──► (file)
                    │              │ ── ctx.client.exec ────►                │
                    │              ▼                            │            │
                    │   ┌────────────────────────┐  HTTPS POST /.runtime/    │
                    │   │ pure domain core:      │       │                   │
                    │   │  permissions/  edits/  │       ▼                   │
                    │   │  domain/  freshness/   │  src/silverbullet/client  │ ──► SilverBullet
                    │   │  audit/(serialize)     │  (only network-touching)  │     Runtime API
                    │   └────────────────────────┘                           │
                    │                                                        │
                    │   ◄── env vars at startup (config/) ───                │ ◄── process.env
                    └────────────────────────────────────────────────────────┘
```

**Boundary inventory:**

| # | Boundary | Direction | Owner module | Concerns |
|---|---|---|---|---|
| B1 | MCP transport (stdio) | bidirectional | `src/index.ts` + `@modelcontextprotocol/sdk` | NFR15 (delegated); D7 (stdout discipline) |
| B2 | SilverBullet Runtime API (HTTPS) | outbound | `src/silverbullet/client.ts` | NFR14 (P0 on breakage); NFR5 (bearer hygiene); D3 (single seam) |
| B3 | Audit log (file) | outbound | `src/audit/audit-logger.ts` | FR27, FR28, NFR16–18; D4 |
| B4 | Diagnostic log (stderr) | outbound | `src/diagnostic/logger.ts` | D7; NFR5 (no token) |
| B5 | Configuration (env vars) | inbound at startup | `src/config/config.ts` | FR1–FR3, NFR5, NFR7, D5 |

**Acyclic dependency rule:** the pure-domain core (`permissions/`, `edits/`, `domain/`, `freshness/`, `audit/schema`, `audit/digest`) depends on **no boundary module**. The boundary modules depend on the core for types and pure logic, never the inverse. This is the structural form of NFR19 / NFR20 / NFR21.

### Functional Requirements → Files

| FR group | Requirements | Implementation locus |
|---|---|---|
| Connection & Config | FR1, FR2, FR3 | `src/config/`, `src/index.ts` (startup ladder), `src/silverbullet/client.ts` (probe) |
| Permission Declaration | FR4–FR7 | `src/permissions/config-block-parser.ts`, `src/permissions/engine.ts`; user authors `#mcp/config` blocks in their SB space |
| Page Discovery | FR8–FR10 | `src/mcp/handlers/list-pages.ts`, `search-pages.ts`; filtering done via `src/permissions/engine.ts` |
| Page Reading | FR11–FR13 | `src/mcp/handlers/read-page.ts`; updates `src/freshness/state.ts` |
| Page Append | FR14–FR16 | `src/mcp/handlers/append-to-page.ts`; SB-side atomic via `silverbullet/scripts/append-page.lua.ts` (FR15) |
| Page Edit (Batch) | FR17–FR23 | `src/mcp/handlers/edit-page.ts`; `src/edits/validator.ts` (pure resolution + overlap detection); freshness check before SB write |
| Page Lifecycle | FR24, FR25 | `src/mcp/handlers/create-page.ts`, `delete-page.ts`; freshness check on delete |
| Error Responses | FR26 | `src/domain/error.ts` (DomainError + formatter) |
| Audit & Observability | FR27, FR28 | `src/audit/*` |

### Non-Functional Requirements → Files

| NFR | Implementation locus |
|---|---|
| NFR1, NFR2 (latency) | Distributed; budget owned by handlers; first-story measurement task in `src/silverbullet/client.ts` |
| NFR3 (cold start ≤ 3s) | `src/index.ts` (startup ladder); minimal-deps stance throughout |
| NFR4 (bounded memory) | `src/freshness/state.ts` (bounded map); audit stream uses on-disk file |
| NFR5 (token hygiene) | `src/config/secret-scrubber.ts`; enforced in error formatter (`src/domain/error.ts`) and audit serializer (`src/audit/audit-logger.ts`) |
| NFR6 (no `none`-content in audit) | `src/audit/digest.ts` + audit serializer; digest-only stance |
| NFR7 (HTTPS-or-localhost) | `src/config/config.ts` URL validator |
| NFR8 (no state via MCP) | Enforced in handlers (response shapes) and `src/domain/error.ts` (no internal-state leakage in error details) |
| NFR9 (≤ 1s shutdown) | `src/index.ts` shutdown sequence; audit drain; force-exit hard stop |
| NFR10 (atomic writes) | SB-side guarantee via space-lua atomic ops; `src/edits/validator.ts` resolves to final content before write |
| NFR11 (fail-closed permission) | `src/permissions/config-block-parser.ts` (malformed-block path); `src/permissions/engine.ts` (default-deny) |
| NFR12 (per-call failures don't poison) | `src/mcp/handler-template.ts` (top-level catch converts to `infrastructure_error`) |
| NFR13 (Node ≥ 24) | `package.json` `engines`; tsconfig target |
| NFR14 (SB compat P0) | README; startup probe in `src/silverbullet/client.ts`; clean error on protocol mismatch |
| NFR15 (use MCP SDK) | `src/mcp/registry.ts` |
| NFR16 (versioned audit schema) | `src/audit/schema.ts` (`v: 1` field; export schema constants) |
| NFR17 (non-blocking audit) | `src/audit/audit-logger.ts` (createWriteStream + drain handling) |
| NFR18 (audit human-readable offline) | JSONL format; `docs/audit-log.md` includes example `jq` queries |
| NFR19 (pure permission engine) | `src/permissions/engine.ts` is `(Ref, ConfigBlock[]) → AccessMode`; no imports from boundary modules |
| NFR20 (pure edit validator) | `src/edits/validator.ts` is `(string, Edit[]) → Result<string>`; no imports from boundary modules |
| NFR21 (offline test suite) | `tests/integration/` mocks the RuntimeClient; pure-module tests use direct imports |

### Data flow walkthrough — canonical successful `edit_page` call

1. **MCP client → stdin (B1).** A JSON-RPC `tools/call` arrives.
2. `@modelcontextprotocol/sdk` parses it and dispatches to the registered handler in `src/mcp/handlers/edit-page.ts`.
3. Handler enters its `try` block. Records `startedAt = ctx.clock.now()`.
4. Zod parses input into typed `args`. `makeRef(args.ref)` → `Ref`.
5. `ctx.client.queryConfigBlocks()` fires a `POST /.runtime/lua` (B2) — base64+JSON envelope built in `src/silverbullet/envelope.ts`. Response JSON-decoded. Returns `ConfigBlock[]`.
6. `ctx.permissionEngine.resolve(ref, blocks)` → pure call. Returns `"write"`.
7. `ctx.client.pageMeta(ref)` → another B2 call, returns `lastModified`.
8. `ctx.freshness.get(ref)` → in-memory map lookup. Returns `lastReadAt`.
9. `lastModified ≤ lastReadAt` → freshness OK.
10. `ctx.client.readPage(ref)` → B2 call, returns `{ content, lastModified }`.
11. `applyEdits(snapshot.content, args.edits)` → pure call. Returns `{ kind: "ok", value: resolvedContent }`.
12. `ctx.client.writePage(ref, resolvedContent)` → B2 call, succeeds.
13. `ctx.freshness.touch(ref, ctx.clock.now())` updates the in-memory state.
14. `formatToolSuccess(digest(resolvedContent))` builds the MCP tool response.
15. `finally` runs: `ctx.audit.write({...})` produces one JSONL entry to B3. Non-blocking; handler returns immediately.
16. SDK serializes the tool response → stdout (B1) as JSON-RPC.

Boundary touches in the happy-path edit: **4 SB calls (B2)**, **1 audit write (B3)**, **2 stdio events (B1)**, **0 diagnostic writes (B4)**.

### Configuration files reference

**`package.json` (skeleton):**

```json
{
  "name": "@are/mcp-silverbullet",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "mcp-silverbullet": "./src/index.ts" },
  "files": ["src/**/*.ts", "README.md", "LICENSE"],
  "scripts": {
    "dev": "node --watch ./src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "simple-git-hooks": {
    "pre-commit": "npx lint-staged && npm run typecheck && npm test",
    "pre-push": "node --test tests/smoke/stdout-discipline.test.ts"
  },
  "lint-staged": {
    "*.{ts,js,json,md}": "prettier --check",
    "*.ts": "eslint"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^?.?.?",
    "zod": "^?.?.?"
  },
  "devDependencies": {
    "typescript": "^?.?.?",
    "@types/node": "^?.?.?",
    "eslint": "^?.?.?",
    "@eslint/js": "^?.?.?",
    "typescript-eslint": "^?.?.?",
    "prettier": "^?.?.?",
    "simple-git-hooks": "^?.?.?",
    "lint-staged": "^?.?.?"
  }
}
```

Versions deliberately marked `?.?.?` here — the first implementation story locks them against a specific date's npm registry state.

**`tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

`noEmit: true` because we ship `.ts` source — `tsc` is purely the type-check gate (D8).

### Development workflow

- **First-time setup** (per CONTRIBUTING.md): clone → `npm install` → `npx simple-git-hooks` → ready.
- **Inner loop:** edit → save → `npm run dev` (Node `--watch` reloads). Pre-commit hooks gate the commit.
- **Pre-publish dry run:** `npm pack` produces a tarball; inspect the file list to verify only `src/**/*.ts`, `README.md`, `LICENSE` are included (no tests, no configs).
- **Local end-to-end test:** point a Claude Code or Claude Desktop instance at the local `node ./src/index.ts` invocation with a real SilverBullet instance to verify the integration. (No automated equivalent in MVP — Growth concern.)

## Architecture Validation Results

### Coherence ✅

**Decision compatibility:** All technology choices compose without conflict. TypeScript on Node 24 + native type stripping + ESM-only + node:test + ESLint flat config + simple-git-hooks form a self-consistent stack. The MCP SDK + zod combination is the de-facto pairing per current Anthropic guidance. The single-network-seam design (SB Runtime API only) eliminates integration ambiguity — there's only one upstream to mock and only one place network errors come from.

**Pattern consistency:** The naming conventions, tool-handler shape, error-handling discipline, Lua-script organization, and stream-output rules are mutually reinforcing. The acyclic dependency rule (pure core never imports boundary modules) is the structural form of NFR19 / NFR20 / NFR21 — patterns and constraints align.

**Structure alignment:** The `src/` tree mirrors the architectural boundaries one-to-one. Each module is the home of one cross-cutting concern from Step 2; each FR group has a clear locus. Tests are colocated with units; integration tests live separately and mock at the single B2 seam.

**Coherence concern surfaced:** D2's no-cache stance combined with D3's Runtime-API-only stance produces up to 4 sequential headless-Chrome round-trips for an `edit_page` call (config + meta + read + write). This is within NFR2's 1s budget at 200ms per round-trip but tight at 300ms+. Mitigation is known and doesn't require seam changes: bundle the read-side queries into a single multi-statement Lua script. Recorded as a first-story latency-measurement-then-decide item.

### Requirements coverage ✅

**Functional Requirements (28/28):** every FR mapped to specific implementation files in the FR-to-Files table in Project Structure. No FR lacks an architectural home.

**Non-Functional Requirements (21/21):** every NFR mapped in the NFR-to-Files table. Three NFRs (NFR1, NFR2, NFR3 — performance budgets) are *targets*, not architectural constructs; first-story measurement validates them. The architecture provides the optimization seams (Lua-script bundling, cache reintroduction) needed if measurements fall short.

**Cross-cutting concerns:** all seven cross-cutting concerns identified in Step 2 (permission gating, freshness invariant, audit logging, structured errors, secret hygiene, process lifecycle, internal-state isolation) have explicit implementation loci and are enforced through the tool-handler shape rather than scattered through modules.

### Implementation readiness ✅

**Decision completeness:** D1–D8 each carry rationale, options considered, and chosen path. Pattern rules (Step 5) codify the implications. Project structure (Step 6) makes them concrete.

**Structure completeness:** complete repo tree including root config, CI, docs, src/, tests/. All seven MCP tool handlers mapped to files. Configuration file skeletons provided for `package.json` and `tsconfig.json`.

**Pattern completeness:** naming, structure, type-safety, tool-handler shape, error handling, Lua organization, stream discipline, async patterns, testing patterns, mandatory rules summary, and explicit anti-patterns list.

**Story-time deferrals (deliberate, not gaps):**

- Exact npm dependency versions (locked at scaffolding story).
- Exact space-lua API names per operation (verified against SB source at story time).
- Whether SB's space-lua exposes `base64` and `json` natively, or whether the script prelude needs a small inline helper.
- Exact `Ref` validation regex against SB's accepted page-naming conventions.
- ULID library choice (any small zero-dep one).

These are *implementation details that depend on real-world state at implementation time*. Pinning them in the architecture would be premature.

### Gap analysis

**Critical gaps:** none. Implementation can begin against this architecture as-is.

**Important findings (non-blocking):**

1. **Latency baseline unverified.** First-story task: measure round-trip p50/p95 through the Runtime API against the author's reference SB deployment. If over NFR1 (500ms reads) / NFR2 (1s writes) budget, pivot to the bundled-script refinement.
2. **Lua-script bundling refinement available if measurements demand it.** Single multi-statement scripts can collapse the 4-round-trip edit case to 2. No seam changes required.
3. **Documentation files outlined but not drafted.** README.md, CONTRIBUTING.md, CLAUDE.md, and `docs/*` are first-implementation-phase deliverables — they require the implemented behavior to write accurately.
4. **Dependency versions unpinned in this document.** Locked at the scaffolding story.
5. **SB Runtime API auth model unconfirmed.** Architecture assumes the same bearer token used for `/.fs/*` works for `/.runtime/*`. First-story validation. Clear startup error if it diverges.

**Deferred by design (Growth, not gaps):** HTTP/SSE transport, plug-based audit, custom-rendered SB surfaces, multi-agent identity, granular permission predicates, in-SB approval workflow, audit log rotation, automated CI publish, coverage gates, persistent freshness state across MCP server restarts, latency cache.

### Architecture Completeness Checklist

**Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**Architectural Decisions**

- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed

**Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status:** **READY FOR IMPLEMENTATION**

All 16 checklist items confirmed. No critical gaps. Performance targets are tracked explicitly as first-story validation work; the architecture provides the mechanisms to address them if measurements fall short, with no seam changes required.

**Confidence Level:** High. The architecture has narrow scope (a single MCP server wrapping one upstream API), a small number of decisions, a single dominant network seam, and a pure-domain core that can be exhaustively tested independently. Risks are named openly (Runtime API experimental status, latency unverified, SB compatibility P0 stance) rather than papered over.

**Key Strengths:**

- **Single network seam.** All SB I/O routes through `src/silverbullet/client.ts`. One mock for tests; one place errors come from; one place to wrap auth and parameter encoding safely. Reduces integration cognitive load.
- **Pure-domain core.** Permission engine, edit-batch validator, error formatter, ref validator, audit serializer, and envelope encoder are all pure functions. NFR21 is satisfied by construction; the offline test suite is fast and deterministic.
- **Trust-contract framing carried through every decision.** Permission gating → freshness gating → audit recording → structured errors → secret hygiene — each layer enforces its piece without depending on agent good behavior. The thesis ("agents earn the right to write") is materially supported by the architecture, not just the README.
- **Patterns explicit enough for agent self-verification.** The mandatory-rules checklist + anti-patterns list + tool-handler-shape template + git-hook gates form a closed verification loop that catches the failure modes most likely from agent-written code (stream discipline, audit invariant, parameter envelope, error shape).
- **Risks named openly.** Runtime API experimental status, latency unverified, NFR14 P0 surface — all documented at the point of accepting them rather than discovered later.

**Areas for Future Enhancement:**

- Lua-script bundling for fewer Runtime API round-trips per tool call (data-driven introduction once measured).
- Persistent freshness state across MCP server restarts (Growth — currently in-memory only).
- Automated end-to-end test harness against a real SilverBullet instance (Growth).
- Audit log rotation (Growth — currently single file, user manages externally).
- HTTP/SSE transport for remote-agent compatibility (PRD Growth).

### Implementation Handoff

**Agent guidelines (mandatory):**

- Follow the tool-handler shape exactly (try/catch/finally + exactly-one audit entry).
- Pass all parameters to Lua via the base64+JSON envelope; never raw-interpolate.
- Validate inputs at module boundaries with zod or `makeRef`; never re-validate inside.
- Return `DomainError` for expected failures; throw only for invariants and infrastructure.
- Never write to stdout outside the MCP SDK.
- Run `npm run typecheck && npm test && npm run lint` before claiming a task done.
- Never use `--no-verify` (D8 hook bypass).
- Bump the audit schema version (NFR16) on any audit-shape change.
- New files belong in their concern's existing module; never `utils/` or `helpers/`.

**First implementation priority — story sequence (from Decision Impact Analysis):**

1. Project scaffold (`package.json`, `tsconfig.json`, ESLint, Prettier, simple-git-hooks, `src/` and `tests/` skeletons, CI workflow).
2. `Ref` domain primitive (branded type, validator, tests).
3. Diagnostic logger module.
4. Configuration module (env-var parsing, zod schema, secret-scrubber).
5. Audit logger (JSONL writer, exactly-one invariant helper, drain handling).
6. `DomainError` + formatter + audit serializer.
7. SB Runtime client (envelope, exec, ping, probe).
8. Permission engine (config-block parser, resolution algorithm).
9. Edit-batch validator (pure, property-tested).
10. Freshness state (bounded map).
11. Tool handlers (one per MCP tool).
12. Startup sequence + lifecycle wiring in `src/index.ts`.
13. Smoke test (stdout discipline).
14. CI workflow + Dependabot config.

**First story includes latency-baseline measurement** through the Runtime API against the author's reference SB deployment. If round-trip p95 exceeds budget, follow up with the Lua-script bundling refinement before proceeding to handler implementations.
