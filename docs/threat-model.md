# Threat model — honest disclosure

This document tells you what `mcp-silverbullet` does and does not protect, so you can decide what
to keep in a SilverBullet space the agent can connect to.

The trust contract — per-page access modes plus a server-enforced read-before-edit invariant — is
the project's central claim. This document is the place where that claim is bounded honestly. If
the disclosures here surprise you, the right response is to adjust how you use the server (or
which spaces you connect it to), not to assume the gaps will be closed silently.

## Scope

This document covers the trust-contract guarantees and limitations of the MVP read-side surface
(`list_pages`, `search_pages`, `read_page`) and the write-side framing for Epic 2
(`append_to_page`, `edit_page`, `create_page`, `delete_page`).

It does **not** cover:

- General MCP-protocol attacks (transport-level, peer-impersonation) — those are upstream concerns
  handled by the MCP SDK and your agent runtime.
- Host-OS compromise — if an attacker has root on the host running this server, no application-level
  guarantee survives.
- The agent runtime's own behavior (Claude Code, Claude Desktop, etc.) — what those tools log, how
  they handle conversation history, what egress controls they apply. Refer to your agent runtime's
  own documentation.
- Supply-chain compromise of the npm registry, the SilverBullet release stream, or the MCP SDK —
  the project keeps its dependency surface minimal (see
  [Stream / output discipline](#stream--output-discipline) for the rules that enforce this) but
  cannot guarantee upstream integrity.

## `none`-mode is best-effort, NOT a hard isolation boundary

This is the most important disclosure in the document. The trust contract's `none` mode is
designed to keep well-behaved agents away from material on common-path interfaces. It is **not** a
security boundary against a determined agent.

**What `none` does block** — the common-path agent-visible surface:

- `list_pages` filters out `none`-mode pages server-side before the agent sees the listing.
- `search_pages` filters out `none`-mode hits server-side before the agent sees the results.
- A direct `read_page` call against a `none`-mode ref returns `not_found` — the same response as a
  page that genuinely doesn't exist. The agent does not learn the page is there.

**What `none` does NOT block** — paths the MCP tool surface does not mediate:

- A determined agent that can author or invoke Lua via SilverBullet's own programmability — the
  Lua / space-script surface is rich enough to query the index in ways the MCP server cannot
  intercept.
- Indirect references inside non-`none` pages — if a `read`-mode page contains the text
  `Personal/Journal/2026-04-21`, the agent has seen the page name. The trust contract does not
  redact non-`none` page bodies for `none`-mode references.
- Any future SilverBullet surface this MVP does not yet wrap — the MCP server uses only
  `POST /.runtime/lua` and `GET /.ping` (see [Runtime API surface](#runtime-api-surface) below);
  expansions of SilverBullet's HTTP API may expose `none`-mode metadata until the server adopts
  the same filtering for the new surface.

**What this means in practice:** `none` blocks **well-behaved agents on common-path interfaces**.
That is the MVP's stated and bounded promise. If your threat model requires a hard isolation
boundary — material an adversarial agent absolutely cannot reach by any path — store that material
in a **separate SilverBullet space** (or another tool entirely) and do not connect this server to
it. Compartmentalization at the space boundary is the only mechanism that gives a hard guarantee.

## Runtime API surface

The MCP server depends on **SilverBullet's experimental Runtime API** — currently tagged
`#maturity/experimental` upstream, with the cautionary "Not recommended for production" note in
the SilverBullet docs.

This dependency is a **deliberate accepted risk**: no other SilverBullet HTTP surface exposes the
index, search, and atomic page operations the trust contract needs. Without the Runtime API, the
permission engine could not query `#mcp/config` blocks, and `append_to_page` could not be atomic.

The contract the project commits to:

- **Compatibility breakage with a new SilverBullet release is treated as a P0 issue** and addressed
  before any feature work resumes. The project tracks SilverBullet's currently-stable release line.
- **The dependency surface is minimal.** The MVP uses **only** `POST /.runtime/lua` plus
  `GET /.ping` for liveness. The server does not touch `/.fs/*` or any other SilverBullet HTTP
  family, which would expand the breakage surface.

If a SilverBullet release breaks the Runtime API — by changing the response shape, removing the
endpoint, or tightening auth — this server breaks with it until a maintainer ships a fix.

## The read-before-edit invariant — guarantees and non-guarantees

The invariant is the load-bearing safety mechanism for non-`append` writes. This section pins down
exactly what it does and does not protect.

### What the invariant guarantees

- **Non-`append` edits to a `write`-mode page are rejected** if the page's current `lastModified`
  timestamp is newer than the agent's `lastReadAt` for that page in the current MCP server
  session. This applies to `edit_page` and `delete_page`.
- **The check is server-enforced**, not agent-promised. The agent cannot bypass it by claiming to
  have read; the server holds the per-page `lastReadAt` map in memory and checks it on every
  edit.
- **Rejection is structured and recoverable.** A `freshness_violation` error tells the agent
  exactly which page is stale and instructs it to call `read_page(<ref>)` to refresh, then retry.
  Well-behaved agents recover automatically without human intervention.

### What the invariant does NOT guarantee

- **`append_to_page` is exempt from the invariant.** Appends are atomic and additive; an agent
  does not need to have read a `write`-mode page before appending to it. This means the invariant
  does not protect against an `append_to_page` followed by an `edit_page` sequence where the
  agent's snapshot is older than the appended content the agent itself just added. Acceptable for
  MVP because append is by definition non-overwriting; flagged here so you know.
- **Cross-session protection is not provided.** The `lastReadAt` map is in memory only, scoped to
  a single MCP server process lifetime. When the server restarts (agent runtime restart, new chat
  session, host reboot), all read history is discarded. The next session must read each page
  before editing it. This is the safe default — a fresh session always re-reads — but it does
  mean the invariant cannot bridge across restarts.
- **The freshness map is bounded; eviction is silent.** The in-memory `lastReadAt` map holds at
  most ~1024 entries by default (LRU eviction). A long-running session that reads more pages than
  the cap loses the oldest entries silently. An `edit_page` against an evicted page sees no
  recorded read and is rejected with `freshness_violation` — the agent must call `read_page`
  again. The protection still holds (you cannot edit a page you haven't read **in this session**),
  but a "I read this an hour ago" intuition will fail in large spaces. Re-reading is cheap and
  always correct.
- **The invariant does not catch a read-then-edit pair where the read itself was already stale at
  read time.** The check is "your snapshot predates the latest modification we know about". If
  SilverBullet has already returned the most recent content to the agent at read time, an
  immediate edit is correctly accepted — `lastModified` does not advance between the read and
  the edit. The framing is "you must have read **this version**", not "you must have read
  **recently**". A concurrent third-party modification *between* the read and the edit IS caught
  (`lastModified` will have advanced).
- **No deep-diff or content-aware staleness check.** The check is timestamp-based against
  SilverBullet's `lastModified`. Two equal-timestamp writes that produce different content are
  not detected; conversely, a no-op touch that updates the timestamp is treated as a real
  modification.

### What "stale" means

The agent's snapshot is stale if `lastModified` (from SilverBullet) is greater than `lastReadAt`
(from the in-session map). Equality is fresh; "less than or equal" means the agent has seen the
current version.

## Auditability stance

Every tool call produces **exactly one entry** in the audit log, regardless of internal control
flow (allowed, rejected, infrastructure-failed — the entry is written in the handler's `finally`
block). The audit log is the after-the-fact record of agent activity. There is no failure mode
where a tool call leaves no trace.

**Where the log lives:**

- Default on Unix/macOS: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` (with `~/.local/state`
  fallback when `$XDG_STATE_HOME` is unset).
- Default on Windows: `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl`.
- Override: set `MCP_SILVERBULLET_AUDIT_LOG_PATH` to an absolute path.
- The audit-log directory is created with mode `0700` on first use.

**Verbosity policy in one sentence:** content from your space is digested
(`{ size, sha256 }`); content from the agent — `args` like search strings, replacement text,
edit operations — is logged in full, because that is the agent's intent and worth preserving for
forensics. The line-by-line schema reference and example `jq` queries land in `docs/audit-log.md`
alongside Story 2.7.

**What the audit log does NOT contain:**

- The bearer token. Ever. The config wrapper masks it as `***redacted***` in any serialization,
  including audit-log args.
- Internal state — the `lastReadAt` map, freshness deltas beyond what the per-call `details`
  exposes, partial permission decisions.
- User page content beyond digest hashes. The `response` field records `{ size, sha256 }`, never
  bodies. Search-result snippets are not recorded.
- Diagnostic / debugging output. Those go to stderr; they do not contaminate the audit log.

## Bearer-token hygiene

The `SILVERBULLET_TOKEN` (the bearer matching SilverBullet's `SB_AUTH_TOKEN` on the other side):

- **Is never written to logs** — not the diagnostic stream (stderr), not the audit log (file), not
  any error message returned to the agent.
- **Is never echoed at startup**, even when the env-var validator reports a problem with another
  field. The validator's error output redacts the token.
- **Is never exposed via the MCP tool surface to the agent.**

Mechanism: the config object is wrapped by a secret-scrubber whose `toString()`, `JSON.stringify`,
and any custom serializer mask `silverbulletToken` as `***redacted***`. Every module reading
config goes through that wrapper.

If you ever see your token in a log file, that is a bug — please report it.

## Stream / output discipline

The MCP transport rule is **stdout is reserved for MCP JSON-RPC traffic only**. Any non-protocol
bytes on stdout corrupt JSON-RPC framing and break the agent's connection to the server. This is
the single most important runtime rule in the codebase.

Why this matters in a threat model: a chatty `console.log` in any module would break framing.
That is not an "operational annoyance" — it is a correctness failure that turns the trust contract
inoperable until the operator notices. The project enforces the rule in three layers:

1. **ESLint `no-console` rule** allows only `console.error` and `console.warn`. `console.log` and
   `console.info` are linter errors.
2. **A single approved diagnostic logger module** is the only sanctioned writer to stderr; nobody
   else touches streams directly. (Direct `process.stdout.write` calls are not blocked by the
   linter; the smoke test in layer 3 is what catches them.)
3. **A CI smoke test** (`tests/smoke/stdout-discipline.test.ts`) spins the production binary,
   issues a real MCP handshake, and asserts every line on stdout is parseable JSON-RPC. This is
   the gate that catches stray `process.stdout.write` calls or any other non-JSON-RPC bytes; it
   runs on every PR and on every push to `main`.

Diagnostic output (lifecycle banners, warnings, errors) goes to **stderr**. Audit output goes to
the **audit log file**. Those are the only legitimate output destinations.

## Known limits worth naming

- **No persistent freshness state across server restarts.** The `lastReadAt` map is in-memory; a
  restart resets it. The first non-`append` edit per session always requires a fresh `read_page`.
- **stdio transport only.** HTTP/SSE is deferred to Growth. The server cannot be used from agents
  that require a remote MCP endpoint (e.g., agents hosted on a public web surface that cannot
  spawn local subprocesses). This is an explicitly-accepted constraint.
- **POSIX-only CI.** The smoke test and integration tests are exercised on Linux / macOS in CI.
  Windows is unverified — the audit-log default path documented in the README assumes `%LOCALAPPDATA%`
  semantics work, but the project has not yet exercised them in CI. If you run on Windows and hit
  a path issue, please open an issue.
- **No multi-agent identity.** Every agent connecting to the same MCP server process gets the
  same permission scope. Distinguishing agents by identity is a Growth concern.
- **No in-SB approval workflow.** The agent acts within the declared bounds without per-action
  human-in-the-loop confirmation. Approval flows are a Growth concern.
- **No HTTP/SSE transport, no audit-log rotation, no granular permission predicates beyond
  per-page modes** — all deferred to Growth.

## What "trust contract" actually means

The trust contract has two mechanisms and one observability stance:

- **Per-page access modes** describe **what** the agent may do — the four modes (`none`, `read`,
  `append`, `write`) are the closed vocabulary, declared by you in `#mcp/config` blocks the
  server refetches on every tool call.
- **The read-before-edit invariant** describes **under what conditions** the agent may write a
  non-`append` change — only against a fresh snapshot, server-enforced.
- **The audit log** makes both visible after the fact — every tool call is recorded, allowed or
  rejected, with structured reason codes.

None of these are hard isolation boundaries. They make agent collaboration **trustworthy by
construction** for well-behaved agents on common paths — and that is the MVP's stated and bounded
promise. The honesty here is the point: knowing exactly what the contract guarantees lets you
choose, deliberately, where to trust it.
