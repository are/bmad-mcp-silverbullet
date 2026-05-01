---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
---

# bmad-silverbullet-mcp - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for bmad-silverbullet-mcp, decomposing the requirements from the PRD and Architecture into implementable stories. (No UX Design document exists — product is a stdio MCP server with no UI surface.)

## Requirements Inventory

### Functional Requirements

**Connection & Configuration**
- FR1: User can configure the MCP server with a SilverBullet endpoint URL and a bearer token via environment variables.
- FR2: User can launch the MCP server as a subprocess invoked by an MCP-capable agent runtime over an MCP-compatible transport.
- FR3: User can verify a successful end-to-end connection to SilverBullet through the agent runtime's first successful tool call.

**Permission Declaration**
- FR4: User can declare a permission mode for any page or path scope, choosing one of: `none`, `read`, `append`, or `write`. *(Mode names per Architecture D1; supersedes PRD's `read-only`/`append-only`/`read-write`.)*
- FR5: User can author and update permission declarations from within SilverBullet itself, using a mechanism that is discoverable without leaving the SilverBullet UI. *(Architecture D1: `#mcp/config` tagged YAML fence blocks.)*
- FR6: User can rely on default-deny behavior — any page without an explicit permission declaration is treated as inaccessible to the agent.
- FR7: User can update permission declarations and have changes take effect on the next agent operation without restarting the MCP server. *(Architecture D2: every operation refetches; no cache.)*

**Page Discovery**
- FR8: Agent can list pages in the SilverBullet space, with `none`-mode pages filtered out of results server-side before the response is returned.
- FR9: Agent can search the space by query, with `none`-mode pages filtered out of results server-side before the response is returned.
- FR10: Agent receives no metadata, names, excerpts, or other identifying content for `none`-mode pages through any common-path interface (listing, search, or indexed result).

**Page Reading**
- FR11: Agent can read the full content of any page that is not `none`-mode and that the page's permission declaration permits to be read.
- FR12: Each successful page read updates the agent session's last-read timestamp for that page.
- FR13: Agent receives a `not found` (or equivalent absence) response when attempting to directly fetch a `none`-mode page — the page is invisible, not advertised-but-blocked.

**Page Append**
- FR14: Agent can append content to a page declared `append` or `write`.
- FR15: Each append operation is atomic — it either succeeds wholly or has no effect on the page.
- FR16: Append operations are not subject to the freshness invariant. The agent does not need to have read the page first.

**Page Edit (Batch)**
- FR17: Agent can submit a batch of edit operations against a `write` page in a single tool call.
- FR18: A batch can contain any combination of supported edit operation types: `replace_all`, `search_and_replace`, `replace_lines`, `insert_at_line`.
- FR19: A `search_and_replace` operation requires a unique match by default; the agent must specify `occurrence` (a 1-indexed integer) when multiple matches exist, or specify `"all"` to replace every occurrence.
- FR20: A batch is rejected as a whole if the target page has been modified since the agent's last read of it (read-before-edit invariant).
- FR21: A batch is rejected as a whole if any individual operation's preconditions fail — including: search string not found, line range out of bounds, multiple matches without an `occurrence`, or two operations whose target regions overlap.
- FR22: All positional arguments in a batch (line numbers, search strings) resolve against the page snapshot at the agent's last read, not against progressively-mutated state during batch processing.
- FR23: A batch is applied atomically — either every operation in the batch is applied, or none of them are.

**Page Lifecycle**
- FR24: Agent can create a new page provided the creation site is not under a `none`-scope.
- FR25: Agent can delete a page declared `write`, subject to the freshness invariant — the deletion is rejected if the page has been modified since the agent's last read.

**Error Responses**
- FR26: Every rejected operation returns a structured, actionable error to the agent — including the reason category (permission, freshness, validation), enough information to identify which operation failed (in the case of a batch), and guidance the agent can use to recover (e.g., re-read the page and retry).

**Audit & Observability**
- FR27: User can review a log of every agent operation, including: timestamp, tool name, arguments, decision (allowed or rejected), reason for rejection where applicable, and the response returned to the agent.
- FR28: User can review the audit log without the MCP server running and without depending on any in-memory state.

### NonFunctional Requirements

**Performance**
- NFR1: Read operations (`list_pages`, `read_page`, `search_pages`) return at p95 ≤ 500ms when the SilverBullet instance is reachable over local network.
- NFR2: Write operations (`append_to_page`, `edit_page`, `create_page`, `delete_page`) return at p95 ≤ 1s under the same conditions.
- NFR3: MCP server cold start (from `npx` invocation to ready-for-first-request) completes within 3s on a typical developer machine.
- NFR4: Server resident memory does not grow unboundedly during a session — last-read state and any per-session caches are bounded by the number of distinct pages the agent has touched.

**Security**
- NFR5: The bearer token (`SILVERBULLET_TOKEN`) is never written to logs, never included in error messages or responses returned to the agent, and never echoed to stdout/stderr.
- NFR6: The audit log records the *names* of pages an agent attempted to access regardless of permission outcome, but does not record *content* from `none`-mode pages — including content that may have been retrieved from SilverBullet during permission evaluation but was filtered before the agent saw it.
- NFR7: The server requires the SilverBullet endpoint URL to use `https://` in any deployment except explicitly-configured local development (`localhost`/`127.0.0.1`).
- NFR8: No internal state — including last-read timestamps, cached snapshots, or partially-resolved permission decisions — is exposed via the MCP tool surface to the agent.

**Reliability**
- NFR9: The server shuts down cleanly within 1s of stdio close, releasing all resources and leaving no orphaned child processes.
- NFR10: A transient SilverBullet error during a write operation results in either complete success or no observable change to the target page — never a partially-applied edit.
- NFR11: The permission engine fails closed: if a permission decision cannot be made conclusively (e.g., malformed declaration, missing metadata), the operation is rejected as if the page were `none`-mode rather than allowed.
- NFR12: A failure inside one tool invocation does not affect the server's ability to handle subsequent tool invocations in the same session.

**Compatibility**
- NFR13: The server runs on Node.js ≥ 24.x (supersedes PRD's ≥ 20.x; rationale: enables native TS type stripping, removes the build step) without requiring native compilation steps or platform-specific binaries.
- NFR14: The server tracks SilverBullet's currently-stable release line (including the experimental Runtime API surface this MVP depends on); compatibility breakage triggered by a new SilverBullet release is treated as a P0 issue and addressed before any feature work resumes.
- NFR15: The server uses the official `@modelcontextprotocol/sdk` for protocol handling; MCP protocol-level concerns are delegated to the SDK rather than implemented in-tree.

**Observability**
- NFR16: The audit log uses a documented, versioned schema. Schema-breaking changes are signalled by a version-bump field (`v`) in each entry and accompanied by a documented migration path.
- NFR17: Audit log writes are non-blocking on the tool-call path — a slow or unavailable log destination does not stall tool responses to the agent.
- NFR18: The audit log is human-readable when inspected directly (line-delimited JSON), without requiring the MCP server to be running.

**Testability**
- NFR19: The permission engine is implemented as a pure function: given a page name, declared mode, and operation type, it returns allow/deny without performing I/O. It is unit-testable with no SilverBullet instance and no network.
- NFR20: The edit-batch validator is implemented as a pure function: given a page snapshot and an edit list, it returns the resulting content (on success) or the failing operation and reason (on rejection), without performing I/O.
- NFR21: The test suite runs to completion without requiring a live SilverBullet instance, an MCP-capable agent runtime, or any network connectivity.

### Additional Requirements

**From Architecture — Project Scaffold (D8 / Step 3)**
- AR1: Hand-rolled project scaffold as the first implementation story: `package.json` (with `engines.node ≥ 24`, `type: module`, `bin` pointing at `./src/index.ts`, `files` allowlist of `src/**/*.ts` + `README.md` + `LICENSE`), `tsconfig.json` (strict, NodeNext, `noEmit`, `allowImportingTsExtensions`), `eslint.config.js` (flat config with `no-console` allowing only `error`/`warn`, `no-floating-promises`, `no-misused-promises`), `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `src/` tree skeleton, `tests/` skeleton.
- AR2: ESM-only, no build step. TypeScript source is the published npm artifact; Node strips types natively at load time.
- AR3: `tsc --noEmit` runs in CI as the type-check gate (type stripping ≠ type checking).
- AR4: Test framework is `node:test` (built-in, zero runtime dep). Tests adjacent to units (`*.test.ts` next to source) plus `tests/integration/` and `tests/smoke/`.
- AR5: Lint is ESLint flat config; format is Prettier. Both run in CI.
- AR6: `simple-git-hooks` for pre-commit (lint-staged + typecheck + test) and pre-push (stdout-discipline smoke test). Activation via `npx simple-git-hooks` post-clone (no `postinstall` script — supply-chain hygiene).
- AR7: GitHub Actions CI workflow (`.github/workflows/ci.yml`) with sequential gates: install → typecheck → format-check → lint → unit tests → stdio smoke test. Matrix on Node 24.x.
- AR8: Dependabot config for weekly npm + GitHub Actions updates, auto-PR for patch/minor.
- AR9: `npm pack` dry-run inspection ensures published artifact contains only `src/**/*.ts`, `README.md`, `LICENSE` — no tests, no configs.

**From Architecture — Domain Primitives & Pure-Function Cores**
- AR10: Branded TypeScript primitive `Ref` (filesystem-shaped page paths) constructed via `makeRef()` validator: filesystem-safe characters, no `..`, no empty segments, no leading/trailing whitespace, aligned with SB page-naming. Every MCP tool argument naming a page is converted via `makeRef()` *before any other logic*. Refs returned from SB are re-validated defensively.
- AR11: `Result<T> = { kind: "ok"; value: T } | { kind: "error"; error: DomainError }` shape — used by all pure-function modules. Pure functions return `Result<T>`; throws are reserved for invariant violations and infrastructure failures.
- AR12: Permission engine as a pure function `(Ref, ConfigBlock[]) → AccessMode` implementing the D1 specificity-then-permissiveness resolution algorithm with default-deny on no match.
- AR13: Edit-batch validator as a pure function `(snapshot, Edit[]) → Result<string>` implementing snapshot-relative line/search resolution, region overlap detection, and atomic apply-or-reject. Property-based tests required (atomicity, snapshot-relative resolution, overlap detection, sequential-equivalence).

**From Architecture — Permission Mechanism (D1)**
- AR14: Permission declarations are SilverBullet `#mcp/config` tagged YAML fence blocks discoverable via SB's tag index. Block format: `access: <none|read|append|write>`, optional `exact: <bool>` defaulting to `false`.
- AR15: Block scope rules: blocks on the `CONFIG` page are global; other blocks apply to host page + descendants (page-ref prefix match) unless `exact: true`.
- AR16: Resolution: most-specific wins across specificities (security boundary preserved); within same specificity, most-permissive wins (OR-of-intents). Default-deny when no block matches.
- AR17: Malformed-block fail-closed (NFR11): unparseable YAML or unknown `access` value → block is ignored entirely, recorded in audit as `category: config_error`, scope falls through to next-most-specific rule.

**From Architecture — Permission Cache & Refresh (D2)**
- AR18: No cache. Every MCP tool invocation queries SilverBullet for current `#mcp/config` blocks before invoking the permission engine.
- AR19: Strict fail-closed on infra failure: if the index query fails for any reason, the tool call is rejected with a structured `infrastructure` error category. No last-known-good fallback.

**From Architecture — SilverBullet Integration (D3)**
- AR20: Single endpoint family: all SilverBullet operations flow through `POST /.runtime/lua` (and `/.runtime/lua_script` where multi-statement scripts are needed); plus `GET /.ping` for liveness. `/.fs/*` is not used.
- AR21: In-tree minimal `RuntimeClient` module with only three methods: `exec<T>(script, params)`, `ping()`, `probe()`. **The only module in the project that performs network I/O.**
- AR22: All values passed from TS to Lua are conveyed as a base64-encoded JSON envelope, decoded inside the Lua script. Raw string interpolation of any value into Lua source is forbidden and enforced by tests against adversarial inputs.
- AR23: One `.lua.ts` file per Lua template under `src/silverbullet/scripts/`, each exporting the template string *and* the TS type of its return value. `client.exec<T>(script, params)` always called with explicit return type.
- AR24: First implementation story includes a latency-baseline task measuring round-trip p95 against the Runtime API to validate NFR1/NFR2; if budgets exceeded, revisit (e.g., bundle read-side queries into a single multi-statement Lua script, add etag revalidation).
- AR25: Authentication: same `SILVERBULLET_TOKEN` bearer sent on every `/.runtime/*` request. If Runtime API has its own auth model, surface a clear startup error rather than fall through silently.

**From Architecture — Audit Log (D4)**
- AR26: Audit log format is JSON Lines (`.jsonl`), one object per line, append-only, schema versioned via `v` field. No rotation in MVP.
- AR27: Default audit log path is platform-appropriate state directory: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` (Unix), `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl` (Windows), with `~/.local/state` fallback. Override via `MCP_SILVERBULLET_AUDIT_LOG_PATH` env var (absolute path).
- AR28: Audit log writes to a *file* by default — *not* to stderr. (Inverts PRD's "stderr by default, optionally file"; stderr is reserved for diagnostic output per D7.)
- AR29: Audit schema v1 required fields: `v`, `t` (ISO 8601 UTC), `id` (ULID), `tool`, `args`, `decision`, `response`, `durationMs`. Conditional `reason` + `details` when `decision == "rejected"`.
- AR30: Closed reason vocabulary: `permission_denied`, `freshness_violation`, `validation_error`, `infrastructure_error`, `config_error`, `not_found`. Adding a value requires bumping audit schema version.
- AR31: Verbosity policy — agent intent in `args` logged in full; user-space content in `response` digested as `{ size, sha256 }`; search/list results recorded as ref lists with no snippets.
- AR32: Non-blocking write path via `fs.createWriteStream(... { flags: 'a' })` with backpressure handling; tool-call response path never awaits flush.
- AR33: Exactly-one-audit-entry-per-tool-call invariant — written in handler `finally` block; the audit log is a complete record of agent activity with no failure mode that leaves no trace.
- AR34: Audit-write failure policy: non-blocking-and-continue. Stream errors logged loudly to diagnostic stream; tool calls keep being served.
- AR35: Shutdown flush: drain the queue and `stream.end()` on stdio close, within NFR9's 1s budget.

**From Architecture — Configuration & Startup (D5)**
- AR36: Configuration surface is env vars only — no config file. `SILVERBULLET_URL` (required), `SILVERBULLET_TOKEN` (required), `MCP_SILVERBULLET_AUDIT_LOG_PATH` (optional override).
- AR37: zod schemas validate env config at startup; failure → exit 1 with the issue list, values redacted (token never echoed even by zod).
- AR38: Deterministic startup ladder, fail-fast: env-read → zod-validate → resolve audit log path (mkdir -p with `0700`) → open audit stream → `GET /.ping` → `POST /.runtime/lua` body `1` (auth + Runtime API probe) → connect MCP stdio transport.
- AR39: Distinct startup error messages for `503` (Runtime API not enabled — point at SB-side enable docs), `401`/`403` (auth failed — point at `SILVERBULLET_TOKEN`), other failures (underlying error). Exit code `1` for all in MVP.
- AR40: Config object is wrapped by a secret-scrubber: `toString()`, `JSON.stringify`, custom serializers all mask `silverbulletToken` as `***redacted***`.
- AR41: No hot-reload of config in MVP. Restart picks up changes (sub-3s per NFR3).

**From Architecture — Error Response (D6)**
- AR42: Single internal `DomainError` type with two projections: audit-log JSON serialization, and MCP-response text formatting. Same `ReasonCode` enum and `details` schemas shared.
- AR43: MCP error responses returned as a single human-readable text block via `content` (not `_meta`) with `isError: true` — so the LLM sees the recovery instructions.
- AR44: Per-reason recovery template (closed mapping): `permission_denied` → "page not accessible to you" (no retry); `freshness_violation` → "call read_page(<ref>) to refresh, then retry" (explicit re-read); `validation_error` → "verify content / fix input, then retry"; `infrastructure_error` → "transient — retry shortly"; `config_error` → "user must fix declaration"; `not_found` → "page does not exist (or is not accessible) — verify the ref" (deliberately ambiguous with `permission_denied` for `none` per FR13).
- AR45: Information-leak rules in the formatter: scrub `Authorization` headers and any field named `token`/`apiKey`/`secret`/`password`; never include `none`-mode page content; never expose internal state beyond what's strictly needed for recovery; no raw stack traces in agent-facing errors (those go to diagnostic stream).
- AR46: Batch errors identify the failing operation by 0-based index into `args.edits` plus the offending edit object (FR26).

**From Architecture — Process & Diagnostic Logging (D7)**
- AR47: stdout reserved for MCP JSON-RPC traffic only — non-protocol bytes corrupt framing. ESLint `no-console` allows only `error`/`warn`; `console.log`/`console.info` are errors. Direct `process.stdout.write` outside MCP SDK is flagged.
- AR48: Single approved diagnostic logger module (`src/diagnostic/logger.ts`); only sanctioned writer to stderr. Plain text, single-line per event, prefixed `[mcp-silverbullet]`.
- AR49: Closed level set in MVP: `INFO`, `WARN`, `ERROR`. No `DEBUG`/`TRACE`. No log-level env var.
- AR50: Diagnostic log captures lifecycle events (startup banner, ready signal, shutdown), warnings (audit-write failures, malformed `#mcp/config` blocks, unexpected SB response shapes), errors (unhandled exceptions, infra failures with stack traces). Never logs token, page content, or per-tool-call traces.
- AR51: Cooperative shutdown signals: stdin close, SIGINT, SIGTERM. Sequence: mark "draining" (new calls rejected with `infrastructure_error`) → await in-flight calls → flush audit stream → close runtime client → close MCP transport → `process.exit(0)`. Hard-stop force-exit at ~900ms if shutdown hangs.
- AR52: Top-level catch for unhandled exceptions/promise rejections → log at `ERROR`, convert to `infrastructure_error` for the in-flight tool call. Process does NOT crash (NFR12).

**From Architecture — Tool-Handler Shape (Step 5)**
- AR53: Every MCP tool handler follows the same shape: top-level `try / catch / finally`; `finally` writes exactly one audit entry; check order is parse → permission → freshness (where applicable) → execute → respond; failures return early via `formatToolError`; `ctx` injection (no module-level singletons reachable from handlers).
- AR54: Canonical `handler-template.ts` defines `HandlerContext` and helpers (`formatToolError`, `formatToolSuccess`, error constructors). New handlers copy the template and fill the body.

**From Architecture — Naming & Structure (Step 5/6)**
- AR55: TypeScript file/directory naming: `kebab-case.ts` for files; lowercase-hyphenated directory names; `.lua.ts` suffix for Lua templates. Identifiers: `PascalCase` for types, `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` only for true compile-time literals. MCP tool names: `snake_case` per MCP convention.
- AR56: SB tag namespace `#mcp/<name>`; permission blocks use `#mcp/config` (never bare `#config`).
- AR57: Project structure mirrors architectural seams one-to-one: `src/config/`, `src/diagnostic/`, `src/audit/`, `src/domain/`, `src/permissions/`, `src/edits/`, `src/freshness/`, `src/silverbullet/`, `src/mcp/`. No `index.ts` re-export barrels. No `utils`/`helpers` catchalls.
- AR58: Acyclic dependency rule: pure-domain core (`permissions/`, `edits/`, `domain/`, `freshness/`, `audit/schema`, `audit/digest`) imports from no boundary module. Boundary modules import the core, never the inverse.

**From Architecture — Type Safety & Discipline (Step 5)**
- AR59: No `any`, no `as` outside boundary constructors / zod-parsed boundaries, no `@ts-ignore` without inline tracked-issue justification (ESLint enforced). `unknown` is the right type for parsed external input.
- AR60: Discriminated unions use `type` as the discriminant; switch statements over them include `default: never` exhaustiveness checks.
- AR61: Async patterns: all I/O is `async/await`; `no-floating-promises` enforced; `void someAsync()` permitted only with inline justification (audit-write is the sanctioned exception); `no-misused-promises` enforced.

**From Architecture — Documentation Deliverables**
- AR62: README with install steps, `claude mcp add-json` example, configuration walkthrough, and prominent disclosure of the SilverBullet Runtime API requirement (Chrome installed, `-runtime-api` Docker variant).
- AR63: `docs/threat-model.md` honestly disclosing `none`-mode best-effort guarantee on common-path interfaces and the experimental status of the SB Runtime API.
- AR64: `docs/permissions.md` covering how to author `#mcp/config` blocks with worked examples.
- AR65: `docs/audit-log.md` with v1 schema reference and example `jq` queries.
- AR66: `docs/starter-template.md` with paste-ready CONFIG snippets for typical layouts (work pages = `write`, archive = `read`, daily log = `append`, personal = `none`).
- AR67: End-to-end transcripts in documentation: (a) agent reads, attempts edit on stale state, gets rejected, re-reads, succeeds; (b) agent issues multi-edit batch and the resulting audit-log entry.
- AR68: `CONTRIBUTING.md` whose first command after clone is `npx simple-git-hooks`; explicit rule against `--no-verify`.
- AR69: `CLAUDE.md` codifying agent guardrails: tool-handler shape, audit invariant, no-bypass discipline, mandatory-rules summary from architecture Step 5.
- AR70: `CHANGELOG.md` in keep-a-changelog format.

**From Architecture — Release & Versioning (D8)**
- AR71: Manual release process for MVP: `npm version <bump>` → push commit + tag → CI builds + tests against tag → maintainer runs `npm publish` from clean checkout → GitHub Release with changelog excerpt. Automated tag-triggered publish is Growth.
- AR72: Versioning is semver, starting at `0.1.0`. Move to `1.0.0` when the SB Runtime API graduates from experimental *or* the trust-contract thesis is sufficiently proven on real day-to-day use.

**Explicit MVP Exclusions (from PRD/Architecture)**
- AR73: HTTP/SSE transport deferred to Growth — stdio only in MVP.
- AR74: `replace_under_heading` markdown-aware edit operation deferred to Growth.
- AR75: Custom-rendered SilverBullet surfaces, Lua-powered cross-space queries, granular permission predicates, multi-agent identity, and in-SB approval workflow all deferred to Growth.
- AR76: Persistent freshness/permission state across server restarts deferred to Growth.
- AR77: Audit log rotation, distinct startup exit codes per failure category, and coverage gates deferred to Growth.
- AR78: Write-into-SilverBullet audit log deferred to Growth.

### UX Design Requirements

*Not applicable — no UX Design document; this product is a stdio MCP server with no UI surface. Permission declaration in SilverBullet is via plain markdown YAML fence blocks (the user authors them in their normal SB editor); there is no MCP-server-rendered UI in MVP.*

### FR Coverage Map

| FR | Epic | Brief |
|---|---|---|
| FR1 | Epic 1 | env-var config (`SILVERBULLET_URL`, `SILVERBULLET_TOKEN`) |
| FR2 | Epic 1 | subprocess-launchable MCP server over stdio |
| FR3 | Epic 1 | first successful tool call verifies the connection |
| FR4 | Epic 1 | per-page mode declaration (`none`/`read`/`append`/`write`) |
| FR5 | Epic 1 | `#mcp/config` YAML fence block from inside SilverBullet |
| FR6 | Epic 1 | default-deny on unmarked pages |
| FR7 | Epic 1 | no-cache: changes take effect on next operation |
| FR8 | Epic 1 | `list_pages` with `none` filtered server-side |
| FR9 | Epic 1 | `search_pages` with `none` filtered server-side |
| FR10 | Epic 1 | no metadata leakage for `none` pages on common paths |
| FR11 | Epic 1 | `read_page` returns content for non-`none` pages |
| FR12 | Epic 1 | successful read updates last-read timestamp |
| FR13 | Epic 1 | direct fetch of `none` page returns `not_found` |
| FR14 | Epic 2 | `append_to_page` for `append`/`write` modes |
| FR15 | Epic 2 | append is atomic |
| FR16 | Epic 2 | append exempt from freshness invariant |
| FR17 | Epic 2 | `edit_page` accepts a batch of edits |
| FR18 | Epic 2 | batch supports all four edit op types |
| FR19 | Epic 2 | `search_and_replace` `occurrence` rules |
| FR20 | Epic 2 | batch rejected if page modified since last read |
| FR21 | Epic 2 | batch rejected if any op precondition fails (incl. overlap) |
| FR22 | Epic 2 | positional args resolve against snapshot-at-last-read |
| FR23 | Epic 2 | atomic batch apply |
| FR24 | Epic 2 | `create_page` (not under `none`-scope) |
| FR25 | Epic 2 | `delete_page` (write + freshness-gated) |
| FR26 | Epic 1 | structured `DomainError` + actionable text formatter |
| FR27 | Epic 1 | every operation appears in audit log |
| FR28 | Epic 1 | audit log readable without server running (JSONL file) |

## Epic List

### Epic 1: Read-Side Trust Contract & First-Time Setup

Maya can install the MCP server, point it at her self-hosted SilverBullet, declare per-page permissions in plain markdown (`#mcp/config` YAML fence blocks), and have her agent discover and read her notes — with `none`-mode pages invisible everywhere on common-path interfaces. This delivers PRD Journey 1 (First-Time Setup) and Journey 4's read-side filtering end-to-end.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR26, FR27, FR28

**Implementation notes:**
- Foundation stories (scaffold, `Ref` domain primitive, diagnostic logger, config + secret-scrubber, audit log, `DomainError` + formatter, in-tree SB Runtime client incl. latency baseline measurement) ship as ordered stories *within* this epic — not their own epics.
- The full `ReasonCode` enum is established here as a closed set; `freshness_violation` is reserved for use by Epic 2.
- The freshness state module ships here (FR12 — read updates timestamp), even though the consumer side (edit/delete check) ships in Epic 2.
- Docs landing in this epic: README, `docs/permissions.md`, `docs/threat-model.md` — everything Maya needs to install + declare permissions.
- CI workflow + stdio-discipline smoke test ship here so the gate is in place from day one.

### Epic 2: Agent Contribution & Read-Before-Edit Invariant

Maya's agent can extend her notes (append-only pages), edit pages where she's granted `write`, create new pages, and delete pages — but every non-append edit is rejected if she has changed the page since the agent last read it. The trust contract is real: the agent earns the right to write. This delivers PRD Journeys 2 (Daily-Use Happy Path) and 3 (Safety Layer Earning Trust), plus Journey 4's write-side closure.

**FRs covered:** FR14, FR15, FR16, FR17, FR18, FR19, FR20, FR21, FR22, FR23, FR24, FR25

**Implementation notes:**
- Pure edit-batch validator (with property-based tests per AR13) is the load-bearing first story.
- Then freshness consumer side — `lastReadAt` lookup → reject when stale.
- Then four write-side handlers: `append_to_page`, `edit_page`, `create_page`, `delete_page` — sharing the canonical handler-template established in Epic 1.
- Audit polish: `digest()` helper for `response` field, ULID id generator, end-to-end forensics shape.
- Docs landing in this epic: `docs/audit-log.md`, `docs/starter-template.md`, end-to-end transcripts in README/docs (J3 reject-reread cycle, batch + audit entry), `CONTRIBUTING.md` + `CLAUDE.md` + `CHANGELOG.md`, the `0.1.0` release procedure.

## Epic 1: Read-Side Trust Contract & First-Time Setup

Maya can install the MCP server, point it at her self-hosted SilverBullet, declare per-page permissions in plain markdown (`#mcp/config` YAML fence blocks), and have her agent discover and read her notes — with `none`-mode pages invisible everywhere on common-path interfaces.

### Story 1.1: Project Scaffold & Tooling

As the project maintainer,
I want a hand-rolled project scaffold with linting, formatting, type-checking, test, and pre-commit gates configured,
So that all subsequent implementation lands on consistent, CI-ready tooling from day one.

**Acceptance Criteria:**

**Given** the empty repo,
**When** I check the project root,
**Then** `package.json` exists declaring `engines.node >= 24`, `"type": "module"`, `bin: { "mcp-silverbullet": "./src/index.ts" }`, `files: ["src/**/*.ts", "README.md", "LICENSE"]`, and `simple-git-hooks` + `lint-staged` config inline,
**And** `tsconfig.json` exists with `strict`, `noEmit`, `NodeNext`, `allowImportingTsExtensions`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` set,
**And** `eslint.config.js` (flat config), `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE` exist.

**Given** the `src/` tree,
**When** I list its directories,
**Then** empty subfolders exist for each architectural seam: `config/`, `diagnostic/`, `audit/`, `domain/`, `permissions/`, `edits/`, `freshness/`, `silverbullet/`, `silverbullet/scripts/`, `mcp/`, `mcp/handlers/`,
**And** `tests/integration/` and `tests/smoke/` exist as empty skeleton folders.

**Given** any TypeScript file in the repo,
**When** I add `console.log(...)` or `console.info(...)`,
**Then** ESLint flags it as an error,
**And** only `console.error` and `console.warn` are permitted,
**And** `no-floating-promises` and `no-misused-promises` rules are active.

**Given** a fresh clone,
**When** I run `npm install` then `npx simple-git-hooks`,
**Then** the pre-commit hook is registered (`lint-staged` + `typecheck` + `test`) and the pre-push hook is registered (stdout-discipline smoke test),
**And** `npm run typecheck`, `npm run lint`, `npm run format`, `npm test`, `npm run dev` all run without error against the empty `src/` tree.

**Given** the README "Development Setup" section,
**When** a contributor follows it,
**Then** the first command after clone is `npx simple-git-hooks` (no `postinstall` script — supply-chain hygiene per AR6).

### Story 1.2: `Ref` Domain Primitive

As a developer building tool handlers,
I want a branded `Ref` type with a validator-constructor for SilverBullet page paths,
So that every MCP tool call's page argument is validated once at the boundary and internal modules can rely on the type system to enforce the discipline.

**Acceptance Criteria:**

**Given** any string `s`,
**When** I call `makeRef(s)`,
**Then** it returns a `Ref` if `s` is filesystem-safe (no null bytes, no control characters), contains no `..` path-traversal segments, has no empty segments (`Foo//Bar` invalid), no leading/trailing whitespace, and aligns with SB page-naming conventions,
**And** it throws `RefValidationError(value)` otherwise.

**Given** the `Ref` type at compile time,
**When** I attempt to assign a plain `string` to a `Ref`-typed binding,
**Then** TypeScript rejects the assignment unless the value is constructed via `makeRef()`.

**Given** the `Result<T>` shape (`{ kind: "ok"; value: T } | { kind: "error"; error: DomainError }`),
**When** I import it from `src/domain/result.ts`,
**Then** it is available for use by all pure-function modules to return expected failures (per AR11).

**Given** the unit tests `src/domain/ref.test.ts`,
**When** `npm test` runs,
**Then** valid-ref and adversarial invalid-ref cases all pass with no I/O performed.

### Story 1.3: Diagnostic Logger

As Maya operating the server,
I want a single approved stderr-bound logger with `INFO`/`WARN`/`ERROR` levels and the `[mcp-silverbullet]` prefix,
So that diagnostic output never corrupts MCP JSON-RPC framing on stdout.

**Acceptance Criteria:**

**Given** the diagnostic logger module at `src/diagnostic/logger.ts`,
**When** I call `logger.info(msg)`, `logger.warn(msg)`, or `logger.error(msg, err?)`,
**Then** the message appears on stderr formatted as `[mcp-silverbullet] LEVEL  message`,
**And** for `error` calls, the underlying error's stack trace is appended on subsequent lines,
**And** nothing is written to stdout.

**Given** the levels exposed by the module,
**When** I import its public API,
**Then** only `INFO`, `WARN`, `ERROR` are available (no `DEBUG`/`TRACE` per AR49),
**And** there is no log-level env var or runtime gate — all messages are emitted unconditionally.

**Given** the unit tests,
**When** `npm test` runs,
**Then** logger output is captured via a fake stderr writer and asserted against expected lines, with no real stderr writes during tests.

### Story 1.4: Configuration Module & Secret-Scrubber

As Maya configuring the server,
I want env-var-only configuration with zod validation, secret-scrubbing, and clear startup errors,
So that misconfiguration fails fast with actionable messages and the bearer token is never echoed anywhere.

**Acceptance Criteria:**

**Given** the env vars `SILVERBULLET_URL` and `SILVERBULLET_TOKEN` (with optional `MCP_SILVERBULLET_AUDIT_LOG_PATH`),
**When** I call the config loader at startup,
**Then** zod validates the URL is a valid URL and uses `https://` (or `localhost`/`127.0.0.1` for dev per NFR7), and the token is non-empty,
**And** validation failures cause `process.exit(1)` with a stderr message naming the missing/invalid variable — token *value* never echoed, even by zod's default issue formatting.

**Given** the loaded config object,
**When** any code calls `JSON.stringify(config)`, `config.toString()`, or otherwise serializes it,
**Then** the `silverbulletToken` field is masked as `***redacted***` (AR40).

**Given** a missing required env var,
**When** the server is launched,
**Then** stderr contains a single-line FATAL message and a one-line hint pointing at the relevant doc (AR39),
**And** exit code is `1`.

**Given** the unit tests,
**When** `npm test` runs,
**Then** valid configs parse correctly, every adversarial-input case (missing vars, invalid URL, http:// for non-localhost, empty token) is rejected with the expected message,
**And** a snapshot test confirms `JSON.stringify` of a sample config redacts the token.

### Story 1.5: Audit Logger (JSONL, ULID, Digest, Drain)

As Maya reviewing agent activity post-hoc,
I want a JSONL audit log written to a platform-appropriate state directory with non-blocking writes, ULID entry IDs, and a `digest()` helper for response payloads,
So that every agent operation produces exactly one durable, human-readable record without stalling the tool-call path.

**Acceptance Criteria:**

**Given** the audit logger module at `src/audit/audit-logger.ts`,
**When** the server starts,
**Then** the audit log path resolves to `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` (Unix, with `~/.local/state` fallback) or `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl` (Windows), unless `MCP_SILVERBULLET_AUDIT_LOG_PATH` overrides,
**And** the parent directory is created recursively with mode `0700` if missing,
**And** the file stream is opened with `{ flags: 'a' }` (append-only).

**Given** a tool-call entry,
**When** `audit.write(entry)` is called from a handler,
**Then** the entry is serialized as a single JSON line with required fields `v: 1`, `t` (ISO 8601 UTC), `id` (ULID via in-tree generator), `tool`, `args`, `decision`, `response`, `durationMs`,
**And** the write is non-blocking (no `await`), with backpressure handled via a small in-memory queue drained on `'drain'` events,
**And** the tool-call response path never waits on flush (NFR17).

**Given** a successful read returning page content,
**When** the handler calls `digest(content)`,
**Then** the helper returns `{ size, sha256 }` — never the raw content (NFR6),
**And** the `response` field in the audit entry uses this digest form for body content (search/list responses log ref lists with no snippets).

**Given** a stream write failure (disk full, permissions revoked mid-session),
**When** the logger encounters the error,
**Then** it emits a `WARN` to the diagnostic logger and continues serving tool calls (AR34),
**And** subsequent `audit.write` calls do not throw.

**Given** stdio close,
**When** the shutdown sequence calls `audit.close()`,
**Then** the queue drains and `stream.end()` completes within NFR9's 1s budget.

**Given** the unit tests with a fake clock and fake write stream,
**When** `npm test` runs,
**Then** ULID monotonicity, digest determinism, schema-v1 field set, drain handling, and shutdown flush all pass with no real filesystem writes.

### Story 1.6: `DomainError`, Formatter & Audit Serializer

As an MCP-using agent receiving an error,
I want every rejected operation to return a structured human-readable text block with category, context, and explicit recovery instructions,
So that I (the agent) can recover automatically — and Maya can correlate the same rejection in the audit log.

**Acceptance Criteria:**

**Given** the closed `ReasonCode` enum at `src/domain/error.ts`,
**When** I import it,
**Then** it contains exactly: `permission_denied`, `freshness_violation`, `validation_error`, `infrastructure_error`, `config_error`, `not_found` (AR30),
**And** changing this set requires bumping the audit schema version per NFR16.

**Given** a `DomainError` value,
**When** I call `formatToolError(error)`,
**Then** it produces an MCP tool result with `isError: true` and a single `content` text block matching the per-reason templates from D6 — including a one-line summary, a context block (page ref, timestamps, failing operation index for batches), and an explicit recovery instruction (AR44),
**And** the recovery template for `freshness_violation` contains the literal guidance `"call read_page(<ref>) to refresh, then retry"`.

**Given** the same `DomainError`,
**When** I call `serializeForAudit(error)`,
**Then** it produces the audit log's `reason` + `details` (+ `failedOperation` when a batch error) fields exactly matching the D4 schema-v1.

**Given** an underlying network/HTTP error wrapping headers like `Authorization: Bearer ...` or fields named `token` / `apiKey` / `secret` / `password`,
**When** the formatter wraps it as an `infrastructure_error`,
**Then** the centralized scrubber removes these fields before serialization (AR45),
**And** unit tests against a golden adversarial input set assert the scrubber leaves no token residue.

**Given** an `infrastructure_error` produced from an unhandled exception,
**When** the agent-facing message is rendered,
**Then** it contains a clean human-readable summary with no raw stack trace,
**And** the stack trace appears only in the diagnostic logger output (AR45).

**Given** the unit tests,
**When** `npm test` runs,
**Then** every reason category has a formatted-text fixture, every reason category has an audit-serialization fixture, and adversarial-secret cases all pass with no I/O.

### Story 1.7: SilverBullet Runtime Client & Latency Baseline

As the only network-touching module in the project,
I want a minimal `RuntimeClient` with `exec`/`ping`/`probe` primitives that talk to SilverBullet's `/.runtime/lua` endpoint via a base64+JSON envelope,
So that every other module can stay pure and the test suite can mock at this single seam.

**Acceptance Criteria:**

**Given** the `RuntimeClient` interface at `src/silverbullet/client.ts`,
**When** I import it,
**Then** it exposes exactly three methods: `exec<T>(script: string, params?: object): Promise<T>`, `ping(): Promise<void>` (`GET /.ping`), `probe(): Promise<void>` (`POST /.runtime/lua` body `1`).

**Given** any `params` object passed to `exec`,
**When** the client builds the Lua script body,
**Then** it base64-encodes `JSON.stringify(params)` and embeds it as a Lua string literal — no value is ever raw-interpolated into the Lua source,
**And** an `envelope.test.ts` adversarial-input suite asserts injection-safety against payloads like `'; os.exit() --` and `\\"); evil()`.

**Given** an HTTP response from the Runtime API,
**When** `exec` returns,
**Then** the typed return value is parsed from the response's JSON `result` field via `JSON.parse`,
**And** non-`200` responses raise an `infrastructure_error` `DomainError` carrying the underlying status + scrubbed body.

**Given** `src/silverbullet/scripts/`,
**When** I list it,
**Then** one `.lua.ts` file exists per Lua template needed by Epic 1's tools: `read-page.lua.ts`, `list-pages.lua.ts`, `search-pages.lua.ts`, `query-config-blocks.lua.ts`, `page-meta.lua.ts`,
**And** each file exports both the Lua template string and the TypeScript type of the script's return value (AR23).

**Given** a local SilverBullet instance with the Runtime API enabled,
**When** I run the latency-baseline harness shipped with this story,
**Then** it measures p95 round-trip latency for `read_page`, `list_pages`, `search_pages` over 100 iterations and writes a baseline report to `_bmad-output/implementation-artifacts/latency-baseline.md`,
**And** if p95 exceeds NFR1 (500ms) or NFR2 (1s) budgets, the report flags the budget breach and lists the optimization seams (Lua-script bundling, etag-revalidating cache) to revisit.

**Given** the contract tests at `src/silverbullet/client.test.ts`,
**When** `npm test` runs,
**Then** the client is exercised against an HTTP test fixture (no live SB needed), covering envelope construction, success-path response parsing, and error-path conversion to `infrastructure_error` (NFR21).

### Story 1.8: Permission Engine & `#mcp/config` Block Parser

As Maya declaring permissions inside SilverBullet,
I want my `#mcp/config` YAML fence blocks to be discovered and resolved into a per-page access mode by a deterministic, pure-function engine,
So that the trust contract is auditable, testable in isolation, and obviously fail-closed.

**Acceptance Criteria:**

**Given** a markdown YAML fence block tagged `#mcp/config` with fields `access: <none|read|append|write>` and optional `exact: <bool>`,
**When** the parser at `src/permissions/config-block-parser.ts` processes it,
**Then** it returns a `ConfigBlock` value with `{ page, access, exact }` populated,
**And** an unparseable YAML body or an unknown `access` value causes the block to be dropped entirely, an entry to be recorded for the audit log with `category: config_error` (location of block included), and the scope to fall through to the next-most-specific rule (AR17).

**Given** the pure function `resolveAccess(ref: Ref, blocks: ConfigBlock[]): AccessMode` at `src/permissions/engine.ts`,
**When** it is called with a `ref` and the full set of indexed blocks,
**Then** it implements the D1 algorithm: most-specific match wins across specificities (`exact` > `scope-by-longer-root` > `global`); within the same specificity, most-permissive wins; default-deny when no block matches,
**And** the function performs zero I/O (NFR19).

**Given** the access-mode total order `none < read < append < write`,
**When** I check whether a given mode permits a given operation type (read / list / search / append / edit / delete / create),
**Then** the helper at `src/permissions/access-mode.ts` returns the answer based on the documented permissiveness rank.

**Given** a global block on the `CONFIG` page declaring `access: write`,
**When** a more-specific block on `Personal/` declares `access: none`,
**Then** any ref under `Personal/` resolves to `none` (security boundary preserved per AR16),
**And** any ref outside `Personal/` resolves to `write`.

**Given** two equally-specific blocks both applying to `Projects/Active/`, one with `access: read` and one with `access: write`,
**When** the engine resolves a ref under that scope,
**Then** the result is `write` (most-permissive wins within same specificity per AR16).

**Given** the unit tests at `src/permissions/engine.test.ts` and `config-block-parser.test.ts`,
**When** `npm test` runs,
**Then** specificity-ordering cases, tie-breaking cases, default-deny cases, malformed-block fail-closed cases, and `exact: true` boundary cases all pass with no I/O.

### Story 1.9: Freshness State Module

As the freshness invariant's substrate,
I want an in-memory bounded `Map<Ref, lastReadAt>` updated only on successful reads,
So that Epic 2's edit/delete handlers can reject stale-snapshot operations against a deterministic data structure.

**Acceptance Criteria:**

**Given** the freshness state module at `src/freshness/state.ts`,
**When** I import it,
**Then** it exposes `touch(ref: Ref, at: Date)`, `get(ref: Ref): Date | undefined`, and a bounded-size policy that evicts least-recently-touched entries when a documented size cap is exceeded (NFR4 — bounded growth).

**Given** a successful `read_page` call within the same MCP server process,
**When** the read handler calls `freshness.touch(ref, now)`,
**Then** subsequent `freshness.get(ref)` calls in the same process return that timestamp,
**And** when the process exits, the state is discarded (no persistence in MVP per PRD §State & Session Model).

**Given** the unit tests with a fake clock,
**When** `npm test` runs,
**Then** touch/get round-trip, eviction policy under cap-exceeding load, and process-restart-discards-state behavior are all covered with no I/O.

### Story 1.10: Read-Side Tool Handlers (`list_pages`, `search_pages`, `read_page`)

As Maya's agent on first connection,
I want to list, search, and read pages in Maya's SilverBullet space — with `none`-mode pages invisible everywhere,
So that the agent can ground its responses in Maya's notes without ever seeing material she has marked off-limits.

**Acceptance Criteria:**

**Given** the canonical `handler-template.ts` at `src/mcp/handler-template.ts`,
**When** I read it,
**Then** it defines the `HandlerContext` injection type (carrying `client`, `permissionEngine`, `freshness`, `audit`, `logger`, `clock`) and exports helpers `formatToolError`, `formatToolSuccess`, plus the per-reason error constructors (`permissionDenied`, `validationError`, `infrastructureError`, `notFound`, `configError`).

**Given** every read handler in `src/mcp/handlers/`,
**When** I read its source,
**Then** it follows the canonical try/catch/finally shape: parse → permission → execute → respond,
**And** the `finally` block writes exactly one audit entry,
**And** no module-level singletons are reached from inside the handler — all dependencies arrive via `ctx` (AR53).

**Given** the `list_pages` handler,
**When** an agent calls it,
**Then** the response contains only pages whose resolved access mode is not `none` (FR8, FR10) — `none`-mode pages are filtered server-side before the response is built,
**And** the audit `response` field records the returned ref list (no snippets per AR31).

**Given** the `search_pages` handler with a query,
**When** an agent calls it,
**Then** the response contains only matching pages whose resolved access mode is not `none` (FR9, FR10),
**And** result snippets / excerpts for `none`-mode pages never appear in the audit log nor in the response.

**Given** the `read_page` handler called with a `ref` whose access mode is at least `read`,
**When** the handler executes,
**Then** it returns the page's body content (FR11),
**And** it calls `freshness.touch(ref, clock.now())` on success (FR12),
**And** the audit `response` field records `{ size, sha256 }` digest only (NFR6).

**Given** the `read_page` handler called with a `ref` whose access mode is `none`,
**When** the handler executes,
**Then** it returns a `not_found` error indistinguishable from a missing page (FR13),
**And** the audit log records the call with `decision: rejected`, `reason: not_found`, and the requested ref string verbatim (NFR6 — names yes, content no).

**Given** any read handler call,
**When** the SilverBullet Runtime API is unreachable mid-call,
**Then** the handler's top-level catch converts the error to an `infrastructure_error` returned to the agent,
**And** the process keeps serving subsequent calls (NFR12).

**Given** the integration tests at `tests/integration/handler-read-page.test.ts` and friends,
**When** `npm test` runs,
**Then** every above scenario is exercised with a mocked `RuntimeClient` test double, with no live SB and no network (NFR21).

### Story 1.11: Startup Ladder & Cooperative Shutdown

As Maya launching the server via `npx`,
I want a deterministic fail-fast startup probe and a clean cooperative shutdown,
So that misconfiguration produces actionable errors immediately and the server never leaves orphaned Node processes when the agent runtime disconnects.

**Acceptance Criteria:**

**Given** `src/index.ts`,
**When** the server is invoked,
**Then** it executes the D5 startup ladder in order: env-read → zod-validate → resolve audit log path (mkdir -p, mode 0700) → open audit stream → `GET /.ping` → `POST /.runtime/lua` body `1` → connect MCP stdio transport,
**And** any step's failure causes `process.exit(1)` with the appropriate diagnostic-log FATAL line per AR39 (`503` → Runtime API enable hint; `401`/`403` → "authentication failed — check `SILVERBULLET_TOKEN`"; other → underlying error),
**And** the entire ladder completes within NFR3's 3s budget on a healthy SB.

**Given** stdio close, `SIGINT`, or `SIGTERM`,
**When** the signal arrives,
**Then** the server marks itself "draining" (new tool calls rejected with `infrastructure_error: server shutting down`),
**And** awaits in-flight tool calls (bounded by their own timeouts),
**And** flushes the audit stream (`stream.end()`) and closes the runtime client and MCP transport,
**And** calls `process.exit(0)` within NFR9's 1s budget,
**And** if shutdown hangs past ~900ms, it force-exits to avoid orphan Node processes.

**Given** an unhandled exception or unhandled promise rejection in any tool handler,
**When** the top-level handler catches it,
**Then** the in-flight tool call (if any) is converted to an `infrastructure_error` returned to the agent,
**And** the diagnostic logger emits an `ERROR` line with the full stack trace,
**And** the process does NOT crash (NFR12).

**Given** the integration tests at `tests/integration/startup-ladder.test.ts`,
**When** `npm test` runs,
**Then** every startup-ladder failure path produces the expected stderr message and exit code, and shutdown sequencing is asserted via a fake-stdio harness with mocked timers (NFR21).

### Story 1.12: CI Workflow, Dependabot & Stdio-Discipline Smoke Test

As the project maintainer protecting against silent regressions,
I want a GitHub Actions CI workflow with sequential gates and a smoke test that spins the server and asserts every line on stdout is parseable JSON-RPC,
So that any code change that would corrupt MCP framing is caught in PR before reaching `main`.

**Acceptance Criteria:**

**Given** `.github/workflows/ci.yml`,
**When** a PR is opened or pushed to `main`,
**Then** the workflow runs sequential gates: `npm ci` → `npm run typecheck` → `npx prettier --check .` → `npm run lint` → `npm test` → smoke test,
**And** any failure fails the build,
**And** the matrix runs on Node `24.x`.

**Given** `tests/smoke/stdout-discipline.test.ts`,
**When** the smoke test runs,
**Then** it spawns the server with a fake stdio peer, issues a sequence of valid tool calls, captures every byte written to stdout, and asserts each line parses as JSON-RPC,
**And** the test fails if any non-JSON-RPC byte appears on stdout (e.g., from a transitive dep accidentally `console.log`-ing) — catching what AR47's ESLint rule cannot.

**Given** `.github/dependabot.yml`,
**When** Dependabot runs on its weekly schedule,
**Then** it opens auto-PRs for npm + GitHub Actions patch/minor updates,
**And** major-version updates require manual review.

**Given** `npm pack` run locally on a clean checkout,
**When** I inspect the resulting tarball's file list,
**Then** it contains `src/**/*.ts`, `README.md`, `LICENSE` only — no `tests/`, no configs, no `tsconfig.json`, no `eslint.config.js` (per AR9).

### Story 1.13: User Documentation (README, Permissions Guide, Threat Model)

As a SilverBullet community member discovering this MCP server,
I want a README that walks me through installation and a `claude mcp add-json` snippet, plus docs that teach me how to author `#mcp/config` blocks and honestly disclose the `none`-mode best-effort threat model,
So that I can install, configure, and trust (or knowingly distrust) the server end-to-end without reading the source.

**Acceptance Criteria:**

**Given** `README.md`,
**When** a community member reads it,
**Then** it contains: project pitch (the trust-contract framing from PRD §Executive Summary), prerequisites (Node ≥ 24, SilverBullet with Runtime API enabled — Chrome installed or `-runtime-api` Docker variant), installation walkthrough with the `claude mcp add-json silverbullet '{...}'` snippet from the PRD verbatim, the `SB_AUTH_TOKEN` configuration step on the SilverBullet side, a "first successful tool call" sanity check, and prominent disclosure of the SilverBullet Runtime API requirement (per NFR14 + AR62).

**Given** `docs/permissions.md`,
**When** Maya wants to declare permissions,
**Then** the document explains the `#mcp/config` YAML fence-block format, the four access modes (`none` / `read` / `append` / `write`), the global-vs-host-scoped block semantics, the `exact: true` modifier, the resolution algorithm in plain English (most-specific wins; tie-break to most-permissive), and default-deny behavior,
**And** it includes worked examples covering at least: a global block on `CONFIG`, a directory-scoped block, an `exact` block, and a "personal journal" `none` example (per AR64).

**Given** `docs/threat-model.md`,
**When** a security-minded reader reads it,
**Then** it honestly discloses: `none`-mode is best-effort on common-path interfaces (listing, search, direct fetch) and is *not* a hard isolation boundary against a determined agent; the SilverBullet Runtime API is currently `#maturity/experimental` and depended on as a deliberate accepted risk; what the read-before-edit invariant guarantees and what it does *not* guarantee (e.g., does not protect against append-then-edit sequences on `write`-mode pages); the auditability stance (every operation logged) (per AR63).

**Given** all three documents,
**When** I cross-check them against the PRD's Maya-facing language,
**Then** terminology is consistent (`#mcp/config`, `none`/`read`/`append`/`write`, "trust contract", "read-before-edit invariant"),
**And** no document contradicts the architecture or PRD.

## Epic 2: Agent Contribution & Read-Before-Edit Invariant

Maya's agent can extend her notes (append-only pages), edit pages where she's granted `write`, create new pages, and delete pages — but every non-append edit is rejected if she has changed the page since the agent last read it. The trust contract is real: the agent earns the right to write.

### Story 2.1: Edit-Batch Validator (Pure)

As the load-bearing logic core of the trust contract,
I want a pure-function validator that takes a page snapshot and an array of typed edit operations and returns either resolved final content or a structured rejection identifying the failing operation,
So that edit atomicity, snapshot-relative positional resolution, and overlap detection are all testable offline against property-based test suites.

**Acceptance Criteria:**

**Given** the validator at `src/edits/validator.ts`,
**When** I import it,
**Then** it exposes `applyEdits(snapshot: string, edits: Edit[]): Result<string>` — a pure function performing zero I/O (NFR20).

**Given** the `Edit` discriminated union at `src/edits/types.ts`,
**When** I read it,
**Then** it is exactly the union from the PRD: `{ type: "replace_all"; content }` | `{ type: "search_and_replace"; search; replace; occurrence? }` | `{ type: "replace_lines"; from_line; to_line; content }` | `{ type: "insert_at_line"; line; content; position? }` (FR18).

**Given** any batch where one operation's preconditions fail (search string not found, line range out of bounds, multiple matches without `occurrence`, or two operations with overlapping target regions),
**When** `applyEdits` runs,
**Then** it returns `{ kind: "error", error: DomainError(validation_error) }` with `failedOperation` populated to identify the offending edit by 0-based index plus the operation object (FR21, FR26, AR46),
**And** the input snapshot is left observably unchanged (atomicity per FR23).

**Given** any successful batch,
**When** `applyEdits` runs,
**Then** every edit's positional argument (line numbers, search strings) resolves against the *snapshot at last read* — never against progressively-mutated state (FR22),
**And** the returned content is equivalent to applying each edit independently against the original snapshot and merging non-overlapping changes.

**Given** a `search_and_replace` operation with multiple matches,
**When** `occurrence` is omitted,
**Then** the batch is rejected with `validation_error`,
**And** when `occurrence` is a 1-indexed integer, only the n-th match is replaced,
**And** when `occurrence` is `"all"`, every match is replaced (FR19).

**Given** the property-based test suite at `src/edits/validator.test.ts`,
**When** `npm test` runs,
**Then** properties hold over generated inputs: (a) atomicity — rejected batches return the input snapshot unchanged; (b) snapshot-relative — line numbers always reference the original; (c) overlap detection — any two ops touching the same region rejected; (d) sequential equivalence — applying [A, B] equals applying A then B if both succeed against an immutable snapshot (per AR13).

### Story 2.2: `append_to_page` Handler

As Maya's agent contributing observations to a daily-log or active-bug page,
I want to append content to pages declared `append` or `write` without needing to have read the page first,
So that low-friction additive contributions are atomic and never blocked by the freshness invariant.

**Acceptance Criteria:**

**Given** the `append_to_page` handler at `src/mcp/handlers/append-to-page.ts`,
**When** I read its source,
**Then** it follows the canonical handler shape (try/catch/finally with exactly-one audit entry per AR53).

**Given** an agent calling `append_to_page(ref, content)` where the resolved access mode is `append` or `write`,
**When** the handler executes,
**Then** the content is appended to the page atomically via the SB-side space-lua atomic append API (FR15, AR21),
**And** the operation does *not* check the freshness state — append is exempt from the read-before-edit invariant (FR16),
**And** the audit `response` field records `{ size, sha256 }` of the appended content.

**Given** an agent calling `append_to_page` on a page whose mode is `none` or `read`,
**When** the handler executes,
**Then** it returns a `permission_denied` error,
**And** the audit log records the rejection with the requested ref.

**Given** a transient SB error during the atomic append,
**When** the operation fails,
**Then** the agent sees an `infrastructure_error` with retry guidance (NFR10 — no partial application possible since SB owns atomicity),
**And** the integration tests at `tests/integration/handler-append.test.ts` exercise both happy-path and SB-error-path scenarios with a mocked `RuntimeClient`.

### Story 2.3: `edit_page` Handler (Full Pipeline with Freshness Check)

As Maya's agent attempting to edit a page Maya may have changed since I last read it,
I want my edit batch to be rejected with explicit re-read instructions if my snapshot is stale, applied atomically against the snapshot otherwise,
So that the read-before-edit invariant holds server-side and I (the agent) can recover automatically by re-reading and retrying.

**Acceptance Criteria:**

**Given** the `edit_page` handler at `src/mcp/handlers/edit-page.ts`,
**When** I read its source,
**Then** the check sequence is exactly: parse args + `makeRef` → `queryConfigBlocks` → `permissionEngine.resolve` (require `write`) → `pageMeta` → freshness check (`lastReadAt` from in-memory state vs `lastModified` from SB) → `readPage` (snapshot) → `applyEdits` (pure validator from 2.1) → `writePage` (full body via space-lua) → `freshness.touch` post-write → respond,
**And** the `finally` writes exactly one audit entry (AR33).

**Given** a freshness check where `lastReadAt` is missing (no read in this session) or `lastModified > lastReadAt`,
**When** the handler executes,
**Then** it returns a `freshness_violation` error with the recovery template `"call read_page(<ref>) to refresh, then retry"` (FR20, AR44),
**And** no SB write occurs,
**And** the audit log records `decision: rejected, reason: freshness_violation, details: { lastModified, lastReadAt }`.

**Given** a successful edit batch,
**When** the handler executes,
**Then** the validator's resolved content is written to SB in a single space-lua call (AR21 — "at-rest edit is always a full-page write"),
**And** the freshness state is updated post-write to the new write timestamp,
**And** the audit `response` field records the digest of the resolved content.

**Given** a batch where the validator rejects (overlap, search-not-found, etc.),
**When** the handler executes,
**Then** the agent receives a `validation_error` with `failedOperation` identifying the offending edit (FR21, FR26),
**And** no SB write occurs (atomicity per FR23, NFR10).

**Given** the integration tests at `tests/integration/handler-edit-page.test.ts`,
**When** `npm test` runs,
**Then** every scenario above is exercised with a mocked `RuntimeClient`, a fake clock, and a controlled freshness state — no live SB, no network (NFR21).

### Story 2.4: `create_page` Handler

As Maya's agent producing a new note (e.g., a hypothesis tree extracted to its own page),
I want to create a page provided the creation site is not under a `none`-scope,
So that the agent can author durable artifacts in Maya's space without violating her boundary declarations.

**Acceptance Criteria:**

**Given** the `create_page` handler at `src/mcp/handlers/create-page.ts`,
**When** I read its source,
**Then** it follows the canonical handler shape with the check sequence: parse + `makeRef` → `queryConfigBlocks` → `permissionEngine.resolve` for the *creation site* (require not-`none`) → SB-side create via space-lua → respond,
**And** the audit `finally` writes exactly one entry.

**Given** an agent calling `create_page(ref, content)` where the resolved access mode for `ref` is not `none`,
**When** the handler executes,
**Then** the page is created with the given content (FR24),
**And** the audit `response` records `{ size, sha256 }` of the created content.

**Given** an agent calling `create_page` on a ref under a `none`-scope,
**When** the handler executes,
**Then** the call is rejected with `permission_denied` (or `not_found` to maintain `none`-invisibility per FR13 — the choice between the two is decided at story time consistent with the FR13 principle),
**And** the audit log records the requested ref (NFR6).

**Given** a ref pointing at an already-existing page,
**When** the handler executes,
**Then** the call is rejected with a `validation_error` (`page_already_exists`),
**And** no overwrite occurs.

**Given** the integration tests,
**When** `npm test` runs,
**Then** happy-path, none-scope rejection, and already-exists scenarios all pass with a mocked `RuntimeClient`.

### Story 2.5: `delete_page` Handler (Freshness-Gated)

As Maya's agent cleaning up a page Maya may have just edited,
I want the delete to be rejected if Maya has modified the page since I last read it,
So that the read-before-edit invariant extends to deletions and a stale agent cannot wipe out work-in-progress.

**Acceptance Criteria:**

**Given** the `delete_page` handler at `src/mcp/handlers/delete-page.ts`,
**When** I read its source,
**Then** the check sequence is: parse + `makeRef` → `queryConfigBlocks` → `permissionEngine.resolve` (require `write`) → `pageMeta` → freshness check (same logic as `edit_page`) → SB-side delete via space-lua → respond,
**And** the `finally` writes exactly one audit entry.

**Given** an agent calling `delete_page(ref)` where access is `write` and freshness check passes,
**When** the handler executes,
**Then** the page is deleted (FR25),
**And** the audit `response` records the prior content digest `{ size, sha256 }`.

**Given** an agent calling `delete_page` where freshness check fails (page modified since `lastReadAt`),
**When** the handler executes,
**Then** the call is rejected with `freshness_violation` and the same recovery template as `edit_page`,
**And** no deletion occurs.

**Given** the integration tests,
**When** `npm test` runs,
**Then** happy-path delete, freshness-rejected delete, and permission-rejected delete (modes `read`/`append`/`none`) all pass with a mocked `RuntimeClient`.

### Story 2.6: End-to-End Transcripts in README

As a community member evaluating the trust contract,
I want to see real-shaped transcripts of an agent (a) hitting a freshness rejection, re-reading, and succeeding, and (b) issuing a multi-edit batch with the resulting audit-log entry,
So that I can understand from the docs alone how the safety story plays out in practice.

**Acceptance Criteria:**

**Given** the README,
**When** I scroll to the "How the Trust Contract Plays Out" section,
**Then** I see a verbatim transcript of an agent reading a page, attempting an edit on stale state, receiving the `freshness_violation` error message exactly as the formatter renders it (matching D6's J3 narrative), re-reading, and producing a successful corrected edit (per AR67),
**And** the transcript shows the corresponding audit log entries for both the rejected and successful calls.

**Given** the same section,
**When** I read further,
**Then** I see a second transcript of an agent issuing a multi-edit `edit_page` batch (e.g., one `search_and_replace` + one `insert_at_line`),
**And** I see the resulting audit log entry showing the structured edit list in `args` (full agent intent) and the digest in `response` (per AR31, AR67).

**Given** the README,
**When** I cross-check the transcripts against the formatter and audit serializer code,
**Then** the rendered text matches what the formatter produces for the corresponding `DomainError`,
**And** the audit JSON shape matches schema v1 exactly.

### Story 2.7: Audit Log Reference (`docs/audit-log.md`)

As Maya querying the audit log post-hoc,
I want a schema reference and example `jq` queries for common forensic questions,
So that I can answer "what did the agent attempt?" / "which edits were rejected?" / "what was the agent allowed to read?" without reading the source.

**Acceptance Criteria:**

**Given** `docs/audit-log.md`,
**When** I read it,
**Then** it documents the schema v1 fields (`v`, `t`, `id`, `tool`, `args`, `decision`, `response`, `durationMs`, conditional `reason` + `details` + `failedOperation`) with type information for each (per AR65),
**And** it lists the closed `reason` vocabulary with one-sentence definitions (`permission_denied`, `freshness_violation`, `validation_error`, `infrastructure_error`, `config_error`, `not_found`),
**And** it explains the digest stance for `response` (NFR6) — agent intent in `args` is full; user-space content in `response` is digest-only.

**Given** the same document,
**When** I scroll to "Common Queries",
**Then** it includes example `jq` invocations for at least: (a) all rejected calls in the last hour; (b) all `freshness_violation` rejections (showing the J3 forensic angle); (c) all attempts on a specific ref regardless of decision; (d) duration percentiles per tool.

### Story 2.8: Starter Template (`docs/starter-template.md`)

As a new SilverBullet community member adopting this MCP server,
I want paste-ready `#mcp/config` snippets for the common layouts I'm likely to have (work pages, archive, daily log, personal),
So that I can declare a sensible permission baseline in five minutes without reading the algorithm.

**Acceptance Criteria:**

**Given** `docs/starter-template.md`,
**When** I read it,
**Then** it includes paste-ready snippets covering at least: a global `CONFIG` block setting a sensible default; a `Projects/Active/` `write` block; a `Projects/Archive/` `read` block; a `Daily/` or daily-log `append` block; a `Personal/` `none` block (per AR66),
**And** each snippet is shown in the exact YAML-fence-block syntax that SilverBullet's `#mcp/config` parser expects.

**Given** the same document,
**When** I follow the "Combining Patterns" section,
**Then** I see worked examples of how the resolution algorithm composes across these patterns (e.g., "global `read` + `Personal/` `none` = personal stays invisible while everything else is readable").

### Story 2.9: Contributor Documentation (`CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`)

As an agent or human contributor working on this codebase,
I want explicit guardrails codifying the architectural invariants (handler shape, audit invariant, no-bypass, stream discipline) and a changelog convention,
So that contributions stay consistent with the design and regressions in load-bearing rules are caught early.

**Acceptance Criteria:**

**Given** `CONTRIBUTING.md`,
**When** a contributor reads it,
**Then** the first command after clone is `npx simple-git-hooks` (no `postinstall`),
**And** the document explicitly forbids `--no-verify` on commits (per AR68),
**And** it covers: dev workflow (`npm run dev`), test layout (adjacent + integration + smoke), the quality gates (typecheck → format → lint → test → smoke), and how to run the latency baseline.

**Given** `CLAUDE.md`,
**When** an agent reads it as initial context,
**Then** it codifies the mandatory rules summary from the architecture (per AR69): tool-handler shape, base64+JSON envelope for Lua params, validate-at-boundary discipline, `DomainError` vs throw, stdout discipline, audit schema bump rule, test-adjacency rule, run-the-gates-before-claiming-done rule, no-`--no-verify` rule,
**And** it explicitly enumerates the anti-patterns (`any`, module-level singletons in handlers, raw-string Lua interpolation, `console.log`, `// @ts-ignore` without justification, audit entries outside `finally`, duplicate permission checks).

**Given** `CHANGELOG.md`,
**When** I check its format,
**Then** it follows keep-a-changelog conventions (`Added` / `Changed` / `Fixed` / `Removed` sections per release) and contains an `Unreleased` section ready to receive entries (per AR70).

### Story 2.10: Release Procedure (Manual `0.1.0`)

As the project maintainer cutting the first public release,
I want a documented manual release runbook covering version bump, tag push, CI green-gate, `npm publish` from a clean checkout, and GitHub Release authoring,
So that the first publication is reproducible and any future maintainer can follow the same steps without inventing them.

**Acceptance Criteria:**

**Given** `docs/release.md` (or a section in `CONTRIBUTING.md`),
**When** the maintainer follows the runbook,
**Then** it covers: `npm version <patch|minor|major>` → push commit + tag → wait for CI green on the tag → run `npm pack` from a clean checkout and inspect the file list (assert `src/**/*.ts` + `README.md` + `LICENSE` only, per AR9) → `npm publish` → create GitHub Release at the tag with a changelog excerpt (per AR71).

**Given** `package.json`,
**When** I check the version field,
**Then** it is set to `0.1.0` for the first MVP release (per AR72),
**And** the document explains the pre-1.0 prefix rationale (depends on SB Runtime API still being `#maturity/experimental`; promotion to `1.0.0` waits on either Runtime API graduation or the trust-contract thesis being sufficiently proven on real day-to-day use).

**Given** the release runbook,
**When** I check for hook-bypass guidance,
**Then** the document explicitly states no `--no-verify` and no `--ignore-scripts` shortcuts during release; if a gate fails, the release is rerolled, not bypassed.
