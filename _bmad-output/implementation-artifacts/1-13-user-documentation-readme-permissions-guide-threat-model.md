# Story 1.13: User Documentation (README, Permissions Guide, Threat Model)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a SilverBullet community member discovering this MCP server,
I want a README that walks me through installation and a `claude mcp add-json` snippet, plus docs that teach me how to author `#mcp/config` blocks and honestly disclose the `none`-mode best-effort threat model,
So that I can install, configure, and trust (or knowingly distrust) the server end-to-end without reading the source.

## Acceptance Criteria

**AC1 — `README.md` is the first-time-setup artifact (J1; AR62; NFR14)**

**Given** the file at `README.md` (overwriting today's pre-release placeholder),
**When** a community member reads it top-to-bottom in one sitting,
**Then** it contains, in this order, with no broken cross-references:

1. **Project pitch** — a 2–4 paragraph framing that establishes the **trust contract** thesis from `prd.md:37-52` (`§ Executive Summary` + `§ What Makes This Special`). The framing must name verbatim:
   - **Per-page access modes** — `none` (invisible), `read`, `append`, `write`.
   - **Read-before-edit invariant** — non-append edits rejected if the agent has not read the page since its last modification.
   - "Agents earn the right to write" framing (or equivalent — must be unmistakably the trust-contract pitch, not generic MCP marketing).

2. **Status banner** — keep the version (`0.1.0` once 1.13 ships; the placeholder `0.1.0-pre` line at `README.md:9` is removed) and a one-line note that the project tracks SilverBullet's currently-stable release line per NFR14, with breakage treated as P0.

3. **Prerequisites section** naming exactly:
   - **Node.js ≥ 24** — native TypeScript type stripping; no build step (per `architecture.md:107-108` / AR2).
   - **A self-hosted SilverBullet instance with the experimental Runtime API enabled** — link to `https://silverbullet.md/Runtime%20API` (the same URL emitted by the FATAL `503` hint at `src/index.ts:216`).
   - **Chrome/Chromium installed alongside SilverBullet, OR run SilverBullet via the `-runtime-api` Docker variant** — both options must be named explicitly (per AR62 + the `503` hint at `src/index.ts:216`).
   - A prominent **disclosure** that the SB Runtime API is currently `#maturity/experimental` and the MVP depends on it as a deliberate accepted risk — this restates AR62/NFR14 here so the reader meets the trade-off before installing (a fuller disclosure lives in `docs/threat-model.md`; this is the README-side flag).

4. **Installation walkthrough — `claude mcp add-json` snippet** — the `claude mcp add-json silverbullet '{...}'` command from `prd.md:323-333` reproduced verbatim, with one instructional change: the `args` array uses the published package name `@are/mcp-silverbullet` (matches `package.json:2`). The snippet must include the `env` block with `SILVERBULLET_URL` and `SILVERBULLET_TOKEN` placeholders.

5. **SilverBullet-side configuration step (`SB_AUTH_TOKEN`)** — explicit, callout-level instructions for setting `SB_AUTH_TOKEN` on the SilverBullet instance and passing the **same value** through to the MCP server's `SILVERBULLET_TOKEN` env var (per `prd.md:412`). This is the most likely first-time-setup failure point and must not be buried in prose.

6. **Configuration / Environment variables section** — section heading is **exactly `## Configuration` with subsection `### Environment variables`**, because `src/config/config.ts:210` and `src/config/config.test.ts:191` emit the FATAL hint `see the project README — Configuration / Environment variables`. The hint becomes a broken reference if this anchor is renamed. Document each var:
   - `SILVERBULLET_URL` — required; absolute URL; must use `https://` unless host is `localhost` or `127.0.0.1` (NFR7).
   - `SILVERBULLET_TOKEN` — required; bearer token; never logged, audited, or echoed (NFR5).
   - `MCP_SILVERBULLET_AUDIT_LOG_PATH` — optional; absolute path overriding the default audit-log location.
   - The default audit-log path on Unix/macOS (`$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl`, with `~/.local/state` fallback) and Windows (`%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl`), per AR27 / `architecture.md:392-397`.

7. **First successful tool call — sanity check** — instruct the reader, after wiring up the agent, to issue a request that triggers `list_pages` (e.g., "ask Claude to list pages in your SilverBullet space") and confirm a non-empty result returns. Set the expectation that the audit log file is created on first successful call (per AR27 directory bootstrap). This is the J1 "it works" moment from `prd.md:184-186` and the FR3 anchor.

8. **Permissions: declare what the agent can see** — short bridge section that points readers at `docs/permissions.md` (AC2) for full guidance. **Must include the default-deny rule** — a page with no `#mcp/config` block is `none` to the agent (FR6 / AR16). One-paragraph teaser plus a working minimal block (a global block on `CONFIG`) is sufficient — the full coverage lives in the dedicated doc.

9. **Threat model + audit log pointers** — short paragraph naming what's logged (every tool call, AR33) and pointing to `docs/threat-model.md` (AC3) and (when it lands in Story 2.7) `docs/audit-log.md`. Story 1.13 must NOT block on Story 2.7's audit-log doc — link target may be a forward reference (relative path) flagged "lands in Story 2.7" or omitted; do NOT invent reference content.

10. **Existing Development Setup section (today's `README.md:24-60`) is preserved verbatim** — the `npx simple-git-hooks`-first-after-clone rule, the script table, and the `--no-verify` prohibition. **Move it to a `## For contributors` (or similar) section near the bottom**, below the user-facing content, so the README reads in J1's order: pitch → install → use → contribute. **Do not delete or rewrite** this content; it's load-bearing for the project's supply-chain hygiene story (AR6).

11. **License footer** — preserve the existing `## License` section pointing at `LICENSE`.

**And** terminology is consistent throughout: `#mcp/config` (never bare `#config`, per AR56); `none` / `read` / `append` / `write` (never PRD's superseded `read-only`/`append-only`/`read-write` — see "Terminology hygiene" in Critical Guardrails below); "trust contract"; "read-before-edit invariant" (AC4 cross-check).

**And** every code fence with a shell command parses cleanly when copy-pasted (no smart quotes, no zero-width characters, no unmarked placeholders without an instruction line above the fence telling the reader what to substitute).

**And** every internal link is verified to resolve: `./LICENSE`, `./docs/permissions.md`, `./docs/threat-model.md` (relative paths from repo root). External links use `https://`.

---

**AC2 — `docs/permissions.md` is the permission-authoring guide (AR64; FR4–FR7)**

**Given** the new file at `docs/permissions.md`,
**When** Maya reads it to learn how to declare permissions,
**Then** it covers, in this order:

1. **What `#mcp/config` is** — a SilverBullet-tag-indexed YAML fence block that declares what the MCP server is allowed to do with a page or scope (`architecture.md:205-276` / AR14). Name the tag `#mcp/config` exactly (AR56). Show the canonical block shape:

   ````markdown
   ```yaml #mcp/config
   access: write          # one of: none | read | append | write
   exact: false           # optional, default false
   ```
   ````

   Include the warning that the YAML is indexed by SilverBullet's tag system, so the block must use the exact `#mcp/config` tag — typos silently fail to index (covered explicitly under AR17 below).

2. **The four access modes** with exact ordering and inclusion semantics from `architecture.md:209-215`:
   - `none` — page is invisible; not listed, not searchable, direct fetch returns `not_found` (FR8/FR9/FR10/FR13).
   - `read` — list / search / read allowed.
   - `append` — `read` plus atomic append (FR14, FR16).
   - `write` — `append` plus edit + delete; freshness-checked for non-append ops (FR17, FR20, FR25).
   - State the **permissiveness rank** (`none < read < append < write`) and that it's used for tie-breaks (resolution rule 2 below).

3. **Block scope rules** (per `architecture.md:226-229`):
   - **Global** — a `#mcp/config` block on the page named `CONFIG` applies to any page not matched by a more-specific rule.
   - **Scoped** — a block on any other page applies to the host page **and all descendants** (page-ref prefix match), unless `exact: true` confines it to the host page only.

4. **The `exact: true` modifier** — a worked sentence: "without `exact`, a block on `Projects/Active` covers `Projects/Active/Foo` and `Projects/Active/Foo/Bar`; with `exact: true`, it covers only `Projects/Active`."

5. **Resolution algorithm (in plain English)** — restate `architecture.md:267-272` as two short rules:
   1. **Across specificities — most specific wins**, regardless of permissiveness. A more-specific `none` overrides a less-specific `write`. (Security boundary preserved.)
   2. **Within the same specificity — most permissive wins** (OR-of-intents). Multiple equally-specific blocks compose as a permission union.
   - Specificity ordering: `exact` > `scope` (longer-root wins among scoped) > `global`.
   - **Default-deny** — any page not matched by any block resolves to `none` (FR6 / AR16).

6. **Worked examples — at minimum these four scenarios** (AR64 mandates "at least"; this story locks in the four below from `epics.md:680`). Each example shows the `#mcp/config` block(s) Maya would author, the page(s) they affect, and the resolved access for one or two probe refs:

   - **(a) Global block on `CONFIG`** — `access: read` on the `CONFIG` page; demonstrate that a page with no other block resolves to `read`.
   - **(b) Directory-scoped block** — `access: write` on `Projects/Active`; show that `Projects/Active`, `Projects/Active/Foo`, and `Projects/Active/Foo/Bar` all resolve to `write`, while a sibling `Projects/Archive/Bar` resolves to `read` (inherits global) or `none` (no global).
   - **(c) `exact: true` block** — `access: write` `exact: true` on `Daily/2026-04-30`; show that only that exact ref is `write`; descendants — if any — fall through to a less-specific rule.
   - **(d) Personal journal `none` example** — `access: none` on `Personal/Journal` (scoped); show that listing, search, and direct fetch all return as if the page family doesn't exist (FR8/FR9/FR13). This is Maya's J4 motivation (`prd.md:228-243`).

   Each example uses Maya-realistic refs (`Projects/Active/Foo`, `Personal/Journal/2026-04-21`, etc. — not placeholder `Foo/Bar`).

7. **Malformed-block behavior (AR17 / NFR11 fail-closed)** — be explicit:
   - Unparseable YAML → block ignored, audit log records `reason: config_error`.
   - `access` value not in `none`/`read`/`append`/`write` → block ignored, audit log records `reason: config_error`.
   - **Tag typo** (`#mcp/cfg`, `#mcp/conf`, etc.) → block is not indexed at all, fails silently (no audit entry — there is nothing to be malformed about; SB's index simply has no record). The doc must call this out as the most common authoring footgun.
   - Invalid blocks fall through to the next-most-specific rule (or default-deny). **`config_error` does not unblock a request** — the engine continues resolution with the bad block removed.

8. **Updating permissions takes effect immediately (FR7 / AR18 / D2)** — every tool call refetches `#mcp/config` blocks before resolving access. There is no cache, no TTL, no restart needed. Maya edits the block, the next agent operation sees it.

9. **Pointer forward to `docs/starter-template.md`** — flag that Story 2.8 ships a paste-ready starter template with common patterns (work = `write`, archive = `read`, daily log = `append`, personal = `none`) per AR66. Story 1.13 does NOT ship that template. If linking, mark it as a Story 2.8 forward reference; do NOT attempt to render the template inline as a substitute.

**And** the doc uses `none` / `read` / `append` / `write` exclusively — never PRD's superseded `read-only` / `append-only` / `read-write` (AC4 cross-check).

**And** every example block uses ` ```yaml #mcp/config ` as the fence opener — verbatim, including the tag — because that is what SilverBullet's tag indexer matches on (AR14 / AR56).

---

**AC3 — `docs/threat-model.md` is the honest-disclosure document (AR63; NFR6 spirit; PRD risk mitigation)**

**Given** the new file at `docs/threat-model.md`,
**When** a security-minded reader reads it,
**Then** it discloses, in this order:

1. **Scope statement** — what this document covers (the trust-contract guarantees and limitations of the MVP) and what it does not (general MCP-protocol attacks, host-OS compromise, supply-chain-of-the-agent-runtime — those are upstream concerns).

2. **`none`-mode is best-effort on common-path interfaces, NOT a hard isolation boundary.** Be explicit (per `prd.md:82` / AR63):
   - **What's blocked** — `list_pages`, `search_pages`, and direct `read_page` filter out `none` pages server-side before the agent sees them (FR8/FR9/FR10/FR13). `not_found` is returned for direct fetches so the page is invisible, not advertised-but-blocked (FR13).
   - **What's not blocked** — a determined agent that can author / invoke Lua via SilverBullet's programmability, indirect references in non-`none` pages, or other edge paths the MCP tool surface does not mediate. Name this honestly: `none` blocks **well-behaved agents on common paths**.
   - **What this means in practice** — do not store material requiring strong isolation in a SilverBullet space the agent can connect to. Use a separate SB space (or another tool) for material whose threat model demands a hard boundary.
   - This restates `prd.md:301-302` ("Risk: Best-effort `none`-mode boundary is mistaken for a security boundary") as user-facing guidance.

3. **The SilverBullet Runtime API is `#maturity/experimental`** — this MVP depends on it as a deliberate accepted risk (`architecture.md:366-367` + AR62). Disclose:
   - Compatibility breakage with a new SB release is treated as a P0 issue and addressed before any feature work resumes (NFR14 / `epics.md:90`).
   - The MVP uses ONLY `POST /.runtime/lua` (and `/.runtime/lua_script` where multi-statement is needed) plus `GET /.ping` — no `/.fs/*` (per AR20 / `architecture.md:290-292`). This is the smallest dependency surface compatible with the tool set.

4. **The read-before-edit invariant — what it guarantees and what it does NOT** (per `prd.md:211-226` / FR20):
   - **Guarantees** — `edit_page` and `delete_page` are rejected if the page's `lastModified` is newer than the agent's `lastReadAt` for that page in this session. The check is server-enforced; agent-side promises don't count.
   - **Does NOT guarantee** — protection against `append_to_page` followed by `edit_page` sequences on the same `write`-mode page (append is exempt from the freshness invariant per FR16); protection across MCP server process restarts (in-memory state per `prd.md:418-429`); protection against an agent that issues a stale `read_page` immediately before a stale `edit_page` (the read updates `lastReadAt` to now — the protection is "you must have read this version", not "you must have read recently").
   - **What "stale" means** — the agent's snapshot is older than the page's current `lastModified`. The check is timestamp-based; deep diff is out of scope.

5. **Auditability stance** — every tool call produces exactly one audit-log entry (AR33 / `architecture.md:708-712`). The audit log is the after-the-fact record of agent activity. Maya can review what the agent attempted, what it was permitted, and what was rejected. Pointers (do NOT invent content):
   - Default audit path: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` (Unix) / `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl` (Windows) (AR27).
   - Schema reference: forward-reference to `docs/audit-log.md` (Story 2.7 / AR65) — do NOT write the schema reference here; flag it as "lands in Story 2.7" or omit the link.
   - Verbosity policy headline only: agent intent (`args`) is logged in full; user content (`response`) is digested as `{ size, sha256 }` (AR31 / `architecture.md:438-443`). One sentence; full coverage belongs in 2.7.
   - **What the audit log does NOT contain** — name the four exclusions from `architecture.md:459-464`: the bearer token, internal state, page content beyond digest, diagnostic output.

6. **Bearer-token hygiene** (NFR5 + `architecture.md:527-531`) — the `SILVERBULLET_TOKEN` is never logged (diagnostic stream), audited, or echoed back to the agent. The config wrapper masks it as `***redacted***` in any serialization. State this so Maya understands her token cannot leak via the audit log or stderr.

7. **Stream / output discipline** (D7 / AR47) — stdout is reserved for MCP JSON-RPC; diagnostic output goes to stderr; audit log goes to its file. Mention that this is enforced by an ESLint rule + a CI smoke test (AR47 / Story 1.12), not just convention. This matters in the threat model because a chatty `console.log` in any module would corrupt MCP framing — turning correctness into a security-ish failure mode (the agent's session breaks).

8. **Limits worth naming explicitly** — known limitations the user should expect:
   - No persistent freshness state across restarts (`prd.md:423`); first edit per session always requires a fresh `read_page`.
   - No HTTP/SSE transport in MVP — stdio only (AR73). Cannot be used from agents that require a remote MCP endpoint.
   - No cross-platform CI in MVP; tested on Linux/macOS POSIX paths (`deferred-work.md` story-1-5 entry — repeated here so the user knows).
   - No multi-agent identity — every connected agent gets the same permission scope (AR75 / Growth).

9. **What "trust contract" means concretely** — close with a one-paragraph framing that reaffirms `prd.md:45-52`: permissions describe **what** the agent may do; the freshness invariant describes **under what conditions** it may write; the audit log makes both visible after the fact. None of these are hard isolation boundaries — they make agent collaboration **trustworthy by construction** for well-behaved agents on common paths, which is the MVP's stated and bounded promise.

**And** the doc does NOT make hard-security claims (e.g., "data exfiltration prevented") that the architecture's best-effort stance cannot back (`prd.md:82`).

**And** the doc does NOT contradict the PRD's user journeys (`prd.md:172-244`) or the architecture's D1/D6/D7 sections.

---

**AC4 — Cross-document consistency check (AR64 / AR62 / AR63 + epics.md:686-689)**

**Given** the three documents from AC1, AC2, AC3 plus the existing `prd.md` and `architecture.md`,
**When** I diff terminology and claims across them,
**Then**:

- **Tag name** is `#mcp/config` everywhere (no `#config`, no `#mcp-config`, no `#mcp:config`) — AR56.
- **Access modes** are written `none` / `read` / `append` / `write` everywhere; never PRD's superseded `read-only` / `append-only` / `read-write`. (Permitted exception: a one-line note in README's pitch acknowledging the rename if the writer judges it useful — but the prevailing usage is the new vocabulary.)
- **Trust contract** appears in README pitch and threat-model framing — the same concept, same name.
- **Read-before-edit invariant** appears verbatim in README pitch, permissions guide (mode-`write` semantics), and threat-model guarantees. Same name across docs.
- **No document claims** a feature that hasn't shipped (e.g., README must NOT advertise edit/append/delete tooling as ready unless 2.x has actually landed when 1.13 ships — this story may run before or after Epic 2; the writer must check sprint state and phrase accordingly. **Safe pattern:** describe the *trust-contract* shape in README pitch (always true) and reserve handler-specific copy for the docs in their owning stories — Story 2.6 / 2.7 / 2.8.).
- **No broken cross-links** — every `./docs/*.md` reference resolves to a file landing in this story (`permissions.md`, `threat-model.md`); references to `audit-log.md` / `starter-template.md` are flagged as Story 2.7 / 2.8 forward references and not blockers.
- **No contradiction** with `architecture.md` (D1/D5/D6/D7) or `prd.md` (Executive Summary, Authentication, State & Session Model). When the PRD and architecture differ (e.g., PRD's `read-only` vs. architecture's `read`), the docs follow the architecture (per `epics.md:28-29` "supersedes PRD's …"). The PRD-amendments list at `architecture.md:378-385` and `architecture.md:466-468` is the canonical record of these supersessions; the docs land on the architecture's side.

**And** the cross-check is performed by the dev as the final pre-PR step (mechanical: open all five files, search for the four bullet items above, fix any drift). Document the result in the dev's Completion Notes.

---

**AC5 — All gates green; placeholder cleared; status flipped (AR68 spirit; existing CI gates from Story 1.12)**

**Given** the implementation,
**When** I run from the project root:

- `npm run typecheck`
- `npm run lint -- --max-warnings=0`
- `npx prettier --check .`
- `npm test`
- `node --test tests/smoke/stdout-discipline.test.ts`
- `npm pack --dry-run`

**Then** all six exit `0` (Story 1.11 + 1.12 baselines preserved — this story changes only docs and `README.md`, no code).

**And** the placeholder banner at today's `README.md:3` (`> ⚠️ **Pre-release scaffold.** Real install + usage docs land in Story 1.13.`) is removed.

**And** today's `README.md:9` placeholder version line `\`0.1.0-pre\` — scaffold only.` is updated to `\`0.1.0-pre\` — Epic 1 complete; Epic 2 in progress.` (or equivalent factual status — do NOT claim Epic 2 is done if it isn't).

**And** today's `README.md:16-22` "Install (placeholder)" + "Configuration (placeholder)" sections are replaced by AC1's real content. The placeholder text is gone — no "lands in Story 1.13" forward references survive.

**And** `npm pack --dry-run --json` shows `README.md` is still in the published manifest (it's in `package.json:13-18`'s allowlist) and that the new `docs/*.md` files are NOT in the manifest (the allowlist excludes `docs/`). Verify by inspecting the JSON output; do NOT add `docs/` to the allowlist.

**And** the sprint status file `_bmad-output/implementation-artifacts/sprint-status.yaml` has its `1-13-...` entry transitioned through `ready-for-dev` → `in-progress` → `review` → `done` per the existing project convention.

**And** module-isolation greps remain green (no new code; reaffirms the existing invariants):
- `grep -rE "console\.(log|info|debug)" src/` → zero output.
- `grep -rE "process\.stdout\.write" src/` → zero output (modulo SDK-internal writes).

**And** `package.json` is **UNCHANGED** — no script changes, no dep additions.

## Tasks / Subtasks

- [x] **Task 1: Replace the README placeholders with the real content** (AC: #1, #4, #5)
  - [x] Read `README.md` start-to-end and identify every line that is "placeholder" (lines 3, 9, 16-22 today). Plan the rewrite section-by-section before editing — this file is the project's first impression and edits should land in one coherent pass.
  - [x] Open `prd.md` `§ Executive Summary` (lines 37-52) as the source for the trust-contract pitch. **Do not paraphrase loosely** — the framing must include `none` / `read` / `append` / `write`, "agents earn the right to write", and read-before-edit invariant. These are the load-bearing terms (AC4).
  - [x] Author the **Project pitch** (AC1.1) — 2–4 paragraphs.
  - [x] Author the **Status banner** (AC1.2) — keep the version line, drop the "scaffold only" framing; replace with NFR14-anchored status.
  - [x] Author the **Prerequisites** section (AC1.3) — Node ≥ 24 + SB Runtime API enabled (Chrome OR `-runtime-api` Docker variant). Include the experimental-Runtime-API disclosure inline.
  - [x] Author the **Installation walkthrough** (AC1.4) — the `claude mcp add-json` snippet from `prd.md:323-333`, with `args: ["@are/mcp-silverbullet"]`. Verify the JSON parses (paste through a JSON linter mentally — no smart quotes).
  - [x] Author the **`SB_AUTH_TOKEN` configuration step** (AC1.5) — callout-level; this is the most likely first-time-setup failure point.
  - [x] Author the **Configuration / Environment variables section** (AC1.6) — heading must be exactly `## Configuration` with `### Environment variables`. (Hidden constraint — see Critical Guardrails.)
  - [x] Author the **First successful tool call sanity check** (AC1.7) — instruct "ask Claude to list pages"; describe expected behavior including "the audit log file is created on first call".
  - [x] Author the **Permissions teaser** (AC1.8) — short bridge paragraph + minimal example block + link to `./docs/permissions.md`. Re-state the default-deny rule (FR6).
  - [x] Author the **Threat model + audit log pointer paragraph** (AC1.9) — link to `./docs/threat-model.md`; mention `docs/audit-log.md` as a Story 2.7 forward reference.
  - [x] **Preserve** the existing Development Setup section (today's lines 24-60) — move under a clearly-marked `## For contributors` (or `## Development setup`) section near the bottom. Do NOT rewrite this content; it's load-bearing for AR6.
  - [x] Preserve the License footer.
  - [x] Mechanical cross-check: search the file for `read-only`, `append-only`, `read-write`, `#config`, `#mcp-config` — confirm zero matches except the explicit "supersedes PRD's …" note (if any).
  - [x] Run `npx prettier --check README.md` → exit 0 (the markdown formatter must not flag).

- [x] **Task 2: Author `docs/permissions.md`** (AC: #2, #4, #5)
  - [x] Create the file. The directory `docs/` already exists (empty today per `ls -la docs/`).
  - [x] Open `architecture.md:205-276` (D1) as the source.
  - [x] Section 1 — **What `#mcp/config` is** — name the tag exactly; show the canonical block shape using a fenced ` ```yaml #mcp/config ` opener.
  - [x] Section 2 — **Four access modes** — exact ordering and inclusion semantics; permissiveness rank `none < read < append < write`.
  - [x] Section 3 — **Block scope rules** — global (CONFIG page), scoped (host + descendants), `exact` modifier.
  - [x] Section 4 — **`exact: true` worked sentence**.
  - [x] Section 5 — **Resolution algorithm in plain English** — most-specific-wins; tie-break to most-permissive; default-deny.
  - [x] Section 6 — **Worked examples** — author all four (a/b/c/d) with Maya-realistic refs. Each example shows the block(s), the affected refs, and the resolved access for at least one probe ref.
  - [x] Section 7 — **Malformed-block behavior** — list the three failure modes (unparseable YAML, unknown access, tag typo); call out the tag-typo silent-failure as the #1 footgun.
  - [x] Section 8 — **No cache; FR7 immediacy** — every tool call refetches.
  - [x] Section 9 — **Forward reference** to `docs/starter-template.md` (Story 2.8 / AR66) — flag clearly.
  - [x] Mechanical cross-check: every fenced block uses ` ```yaml #mcp/config ` exactly; zero usage of `read-only`/`append-only`/`read-write`.
  - [x] Run `npx prettier --check docs/permissions.md` → exit 0.

- [x] **Task 3: Author `docs/threat-model.md`** (AC: #3, #4, #5)
  - [x] Create the file under `docs/`.
  - [x] Section 1 — **Scope statement**.
  - [x] Section 2 — **`none`-mode best-effort disclosure** — anchor on `prd.md:82` and `prd.md:301-302`. Be explicit about what's blocked (common-path interfaces) vs. what's not (Lua-driven edge paths, indirect references). Recommend a separate SB space for material requiring hard isolation.
  - [x] Section 3 — **Runtime API experimental status** — anchor on `architecture.md:366-367` + AR62; name the P0 stance from NFR14.
  - [x] Section 4 — **Read-before-edit invariant — guarantees and non-guarantees** — anchor on `prd.md:211-226` + FR20 + FR16.
  - [x] Section 5 — **Auditability stance** — every call → one entry (AR33); default path; verbosity policy headline; **what the audit log does NOT contain**. Forward-reference `docs/audit-log.md` as Story 2.7 (do NOT inline the schema).
  - [x] Section 6 — **Bearer-token hygiene** — NFR5 + `architecture.md:527-531`.
  - [x] Section 7 — **Stream/output discipline** — D7/AR47; mention CI smoke gate (Story 1.12).
  - [x] Section 8 — **Known limits** — no persistent freshness, stdio-only transport, POSIX-only CI, no multi-agent identity.
  - [x] Section 9 — **Trust-contract framing** — closing paragraph reaffirming `prd.md:45-52`.
  - [x] Mechanical cross-check: do not make claims that exceed the architecture's best-effort stance.
  - [x] Run `npx prettier --check docs/threat-model.md` → exit 0.

- [x] **Task 4: Cross-document consistency pass** (AC: #4)
  - [x] Open all five docs in editor: `README.md`, `docs/permissions.md`, `docs/threat-model.md`, `_bmad-output/planning-artifacts/prd.md`, `_bmad-output/planning-artifacts/architecture.md`.
  - [x] Grep across the new docs for: `read-only`, `append-only`, `read-write`, `#config\b`, `#mcp-config`, `#mcp:config`. Expect zero matches (or one explicit "supersedes" note in README pitch).
  - [x] Grep for "trust contract" — appears in README + threat-model.
  - [x] Grep for "read-before-edit invariant" — appears in README + permissions.md (mode-`write` semantics) + threat-model.
  - [x] Verify all internal links resolve: `./LICENSE`, `./docs/permissions.md`, `./docs/threat-model.md`. Forward references to `docs/audit-log.md` (Story 2.7) and `docs/starter-template.md` (Story 2.8) are explicitly flagged as such; broken-link checkers should not be run for these.
  - [x] Verify external links use `https://`.
  - [x] Document the cross-check result in the dev's Completion Notes (e.g., "Cross-check 2026-05-XX: zero forbidden-vocabulary matches; all internal links resolve except 2.7/2.8 forward refs which are flagged").

- [x] **Task 5: Local verification** (AC: #5)
  - [x] `npm run typecheck` → exit 0 (no code changed; baseline preserved).
  - [x] `npm run lint -- --max-warnings=0` → exit 0.
  - [x] `npx prettier --check .` → exit 0 (must include the new markdown files).
  - [x] `npm test` → 461/461 (post-1.12 baseline preserved; this story changes no code).
  - [x] `node --test tests/smoke/stdout-discipline.test.ts` → exit 0; 1/1 passing, 210ms.
  - [x] `npm pack --dry-run` → manifest contains `README.md`, `LICENSE`, `package.json`, all `src/**/*.ts` (excluding `*.test.ts`); manifest does NOT contain `docs/`. Confirmed via the same inline-node parse the CI uses (29 files, 0 in `docs/`, README.md present).
  - [x] `git diff README.md` — reviewed the rewrite end-to-end as a reader.
  - [x] **Smoke a copy-paste of the `claude mcp add-json` snippet** — pasted the JSON arg into `node -e 'JSON.parse(process.argv[1])' '<json>'`; parses cleanly.
  - [x] **Verify the placeholder is gone** — `grep -nE "placeholder|land in Story 1\.13|Pre-release scaffold" README.md` returns zero matches.
  - [x] **Verify the FATAL hint anchor still resolves** — `grep -nE "## Configuration|### Environment variables" README.md` returns matches at lines 80 and 82 (the `formatConfigError` hint at `src/config/config.ts:210` references this anchor).

- [x] **Task 6: Append deferred-work entries (post-implementation review)** (housekeeping)
  - [x] Appended 12 entries to `_bmad-output/implementation-artifacts/deferred-work.md` covering: README architecture diagram; `docs/index.md` aggregator; permissions.md extended scenarios; permissions ADR; agent-runtime-side disclosures; physical-host considerations; quickstart sub-doc; audit-log examples in threat model; `SECURITY.md`; SB-side `#mcp/config` rendering plugin; i18n / additional languages; end-to-end transcripts forward-reference; Windows audit-log path verification.
  - [x] Each entry names origin (`dev of story-1-13-user-documentation-readme-permissions-guide-threat-model (2026-05-01)`) and a precise file/section reference.
  - [x] Items NOT added because they are already tracked elsewhere or out of scope: CONTRIBUTING.md / CLAUDE.md (Story 2.9 — owns those files outright, not deferred); `docs/audit-log.md` (Story 2.7 — owns it outright); `docs/starter-template.md` (Story 2.8 — owns it outright); `.github/ISSUE_TEMPLATE/` (already in the ledger from Story 1.12's dev pass — re-adding would duplicate).

## Dev Notes

### Architectural source-of-truth

This is a **documentation-only story** — no `src/` changes, no `tests/` changes, no `package.json` changes. It is the load-bearing closer for Epic 1: Maya can install the MCP server, declare permissions, and trust the trust-contract framing — all from artifacts that ship in this story.

It depends on:

- **All of Epic 1** — every behavior the docs describe has shipped. README's `claude mcp add-json` snippet works end-to-end against the binary that landed in Stories 1.1–1.12. The permissions guide describes the engine that landed in Stories 1.8 + 1.10. The threat model describes the audit log that landed in Story 1.5 and the read-before-edit framing that lands in Epic 2.
- **`prd.md` and `architecture.md`** as canonical sources. Where they differ, follow architecture (per the PRD-amendments lists at `architecture.md:378-385` and `architecture.md:466-468`).

It does NOT depend on:

- **Epic 2 stories.** This story may run before or after any of 2.x. The README's pitch describes the trust-contract *shape* (the architectural promise), not handler-by-handler readiness. Story 2.6 owns end-to-end transcripts; do NOT pre-empt 2.6 by writing transcripts inline.
- **`docs/audit-log.md` (Story 2.7) or `docs/starter-template.md` (Story 2.8).** Forward-reference both as "lands in Story 2.7 / 2.8" or omit links entirely. Do NOT invent reference content.

**Primary specs (read these first):**

- AC source: `_bmad-output/planning-artifacts/epics.md:665-689` (Story 1.13 ACs).
- AR62 — README content + Runtime API disclosure: `_bmad-output/planning-artifacts/epics.md:191`.
- AR63 — Threat-model honesty: `epics.md:192`.
- AR64 — Permissions guide with worked examples: `epics.md:193`.
- D1 — Permission Declaration Mechanism: `architecture.md:205-276`.
- D5 — Configuration & Startup Validation: `architecture.md:470-531`.
- D6 — Error Response Structure (trust-contract framing context): `architecture.md:533-641`.
- D7 — Process & Diagnostic Logging Discipline: `architecture.md:642-712`.
- PRD `§ Executive Summary` (trust-contract pitch source): `prd.md:37-52`.
- PRD `§ User Journeys` (Maya context): `prd.md:172-244`.
- PRD `§ Distribution & Installation` (the `claude mcp add-json` snippet): `prd.md:317-345`.
- PRD `§ Authentication` (`SB_AUTH_TOKEN` ↔ `SILVERBULLET_TOKEN`): `prd.md:408-414`.

### What this story owns (and does NOT own)

**Owns:**

- `README.md` — overwrites today's pre-release scaffold; preserves the Development Setup section verbatim (moved to a `## For contributors` section near the bottom).
- `docs/permissions.md` — new file.
- `docs/threat-model.md` — new file.

**Does NOT own (these land in later stories or are out of scope):**

- **`docs/audit-log.md`** — Story 2.7 / AR65.
- **`docs/starter-template.md`** — Story 2.8 / AR66.
- **End-to-end transcripts in README** — Story 2.6 / AR67. The README pitch describes the trust contract *as a contract*; transcript-based proof lands once Epic 2's handlers are real.
- **`CONTRIBUTING.md`** — Story 2.9 / AR68.
- **`CLAUDE.md`** — Story 2.9 / AR69.
- **`CHANGELOG.md`** — Story 2.9 / AR70.
- **`.github/ISSUE_TEMPLATE/`** — already deferred per `deferred-work.md` (Story 1.12 dev pass entry); revisit alongside CONTRIBUTING.md.
- **Architecture diagram in README** — Growth.
- **Cross-platform CI verification of the Windows audit-log path** — POSIX-only stance per `deferred-work.md` Story 1.5 entry.

### Files this story creates / modifies / deletes

**NEW:**

- `docs/permissions.md`
- `docs/threat-model.md`

**MODIFIED:**

- `README.md` — substantive rewrite. Today's `README.md:3` placeholder banner, `:9` "scaffold only" framing, and `:16-22` "Install/Configuration (placeholder)" sections are replaced. Today's `:24-60` Development Setup is **preserved verbatim** and moved under a `## For contributors` heading near the bottom.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.13 status transitions (`backlog` → `ready-for-dev` → `in-progress` → `review` → `done`).
- `_bmad-output/implementation-artifacts/deferred-work.md` — append entries from the dev pass (see Task 6).

**UNCHANGED (do not touch):**

- All `src/` source files. **No code changes are required for this story.**
- All `tests/` files (unit, integration, smoke).
- `package.json` / `package-lock.json` — **no new dependencies, no script changes, no `files` allowlist changes**. The published artifact's manifest stays exactly as Story 1.12 left it (29 files post-1.12 baseline; this story adds 0 published files because `docs/` is excluded by the allowlist).
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.npmignore`, `.prettierrc.json`, `.editorconfig`, `LICENSE`.
- `.github/workflows/ci.yml`, `.github/dependabot.yml` — Story 1.12's gates run unchanged on this PR.
- `scripts/latency-baseline.ts`.
- All `_bmad/`, `.claude/`, `_bmad-output/` (except sprint-status.yaml + deferred-work.md as noted).

### Testing standards

**This is a documentation-only story; there are no automated tests for prose content.** The verification gates are:

- **Prettier formatter** (`npx prettier --check .`) — markdown formatting hygiene. Already enforced by `.github/workflows/ci.yml`'s format-check step (Story 1.12) and the pre-commit hook.
- **Unit + integration suite** (`npm test`) — must remain at the post-1.12 baseline (461/461 or current); no doc change should regress code tests, but run them anyway as a sanity gate.
- **Smoke test** (`node --test tests/smoke/stdout-discipline.test.ts`) — same.
- **`npm pack --dry-run`** — verify `README.md` is in the manifest and `docs/` is NOT.
- **Manual cross-document consistency check** — Task 4. The "test" here is the dev reading the docs as Maya would. There is no automated equivalent.
- **Manual JSON-snippet copy-paste smoke** — paste the `claude mcp add-json` snippet through `node -e 'JSON.parse(process.argv[1])' '<json>'`; the snippet must parse cleanly. Smart-quote regressions are silent-but-fatal in shell-pasted JSON.

**No test-suite addition is required.** Adding a custom "docs link checker" or "vocabulary linter" is a Growth concern (anti-AR2 minimal-deps) — the manual cross-check is sufficient for MVP.

### Library / framework requirements

**No new dependencies.** Documentation is plain markdown rendered by GitHub / npm / IDE markdown renderers. The existing dev stack handles formatting:

| Tool | Locked version | Purpose |
|---|---|---|
| Prettier | `^3.8.3` (`package.json:46`) | Markdown formatter (the `## Configuration` heading discipline and code-fence shapes go through it) |
| `lint-staged` | `^16.4.0` (`package.json:45`) | Pre-commit hook formatter via `*.{ts,js,json,md}: prettier --check` (`package.json:34`) |

**Push back on:**

- Any markdown linter beyond Prettier (`markdownlint`, `remark`, etc.) — anti-AR2 (minimal deps). Prettier's formatting is the project's canonical markdown discipline.
- A custom link checker — anti-AR2. The manual cross-check (Task 4) plus rendered-preview review is sufficient for MVP.
- A custom vocabulary linter — anti-AR2. The grep-based check in Task 4 catches the four forbidden terms.
- Mermaid / PlantUML diagrams in any of these docs — `prettier` doesn't validate them, GitHub renders them but breaks copy-paste, and they add a maintenance surface no one has volunteered for. Keep diagrams to ASCII boxes if absolutely needed.
- Splitting permissions.md or threat-model.md into multiple files — anti-AR2; each is a single-page reference doc, not an index. The "shard later" pattern (e.g., `docs/permissions/index.md` + per-mode shards) is overkill for the content volume.
- Adding `docs/` to `package.json:files` — the published artifact intentionally excludes `docs/` (manifest stays at post-1.12 size). User-facing docs are GitHub-rendered; the npm tarball is for runtime, not for reading.
- Auto-generated permission-syntax docs — there is nothing to auto-generate; the syntax is YAML-fenced markdown, hand-authored. Inline examples are the documentation.

### File-structure requirements

After this story, the changed directory tree:

```
README.md                              # MODIFIED — substantive rewrite

docs/                                  # was empty (per `ls -la docs/`)
├── permissions.md                     # NEW
└── threat-model.md                    # NEW
```

**No barrel files** — N/A here; markdown docs don't have `index.md` aggregation in MVP. (Architecture's `docs/` entry at `architecture.md:1224-1230` mentions an `architecture.md` symlink; that's a separate concern for a different story and out of scope here.)

**`docs/` is OUTSIDE the published npm artifact** — `package.json:13-18`'s allowlist does NOT include `docs/`. AC5 verifies this explicitly via `npm pack --dry-run`. Adding `docs/` to the allowlist would be a published-artifact change requiring a separate decision (and would break Story 1.12's pack-manifest verification step).

**README.md is INSIDE the published artifact** — `package.json:13-18`'s allowlist includes it. The rewrite is published with the next `0.1.0` release (Story 2.10).

### Latest tech information (researched 2026-05-01)

- **`@modelcontextprotocol/sdk` ^1.29.0** (`package.json:37`) — current major. The `claude mcp add-json` snippet's `protocolVersion` field is set by the SDK at `initialize` time; the snippet itself does not name a protocol version (correct — the user's `claude` CLI handles that).
- **Claude Code's `claude mcp add-json` syntax** (current as of 2026-05) — the JSON arg shape is `{"type":"stdio","command":"...","args":["..."],"env":{...}}`; the form has been stable since the MCP-CLI integration shipped. The PRD-canonical form at `prd.md:323-333` matches.
- **SilverBullet Runtime API** (current as of 2026-05) — still tagged `#maturity/experimental` per `https://silverbullet.md/Runtime%20API`. Requires Chrome/Chromium installed on the host running SilverBullet (or the `-runtime-api` Docker variant). No API-version field is exposed; compatibility is best-effort tracking-of-current-stable per NFR14.
- **`SB_AUTH_TOKEN`** (the SB-side env var) — name confirmed at `prd.md:412`. The MCP server's matching var is `SILVERBULLET_TOKEN` per `package.json` ecosystem. Doc note: same value, two env vars (one on each side).
- **`$XDG_STATE_HOME`** — XDG Base Directory Specification; defaults to `~/.local/state` when unset (per AR27 / `architecture.md:392-397`). The audit log path is `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl`. README documents the *default* path; the `MCP_SILVERBULLET_AUDIT_LOG_PATH` env var overrides it.
- **GitHub markdown rendering** — supports fenced code blocks with language tags, including ` ```yaml ` and ` ```yaml #mcp/config ` (the latter renders as YAML; the `#mcp/config` text is treated as info-string and shown alongside the language tag in some viewers, hidden in others — but SilverBullet's tag indexer matches on it regardless of GitHub's rendering choice). The fence opener must be exact for SB's index to pick it up.
- **Prettier 3.8.3 markdown discipline** — preserves fenced-block info strings (the ` ```yaml #mcp/config ` opener is preserved through formatting). Wraps prose at the configured `printWidth` (the project's `.prettierrc.json` default is 80 unless overridden — confirm before writing wide URLs that would mangle).

### Previous story intelligence (from Stories 1.1–1.12)

Distilled patterns to apply:

1. **Story 1.1's README placeholder** (`README.md:3-18`) explicitly forward-referenced this story ("Real install + usage docs land in Story 1.13"). This story is the long-planned content drop; the placeholder line has been a tracked debt since 2026-04-30.
2. **Story 1.4's config-error hint** (`src/config/config.ts:210` + `src/config/config.test.ts:191`) references "the project README — Configuration / Environment variables" as the anchor for misconfigured-env-var help. The README's section heading must be **exactly `## Configuration` with `### Environment variables`** for this hint to resolve. Renaming the heading would make the FATAL output point at a non-existent anchor — a silent regression caught only by an operator hitting the FATAL path. **This is a hidden constraint.** (Critical Guardrail #1 below.)
3. **Story 1.5's audit log default path** (`architecture.md:392-397` / AR27) is `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` (Unix), `~/.local/state/mcp-silverbullet/audit.jsonl` (fallback), `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl` (Windows). The README's Configuration section documents these as **defaults**; the override env var is `MCP_SILVERBULLET_AUDIT_LOG_PATH`.
4. **Story 1.7's runtime client** uses ONLY `POST /.runtime/lua` + `GET /.ping`. The threat model's "API surface" disclosure must reflect this — the MVP does not touch `/.fs/*` or any other SB endpoint family. Useful for the Section 3 (Runtime API experimental) disclosure.
5. **Story 1.8's `#mcp/config` block parser** + Story 1.10's per-call refetch — the permissions guide must describe the "every call refetches" semantics (FR7 / AR18). No cache means no TTL means no restart needed after a permission change. This is a delight-feature for Maya and worth foregrounding in the worked-examples section.
6. **Story 1.10's read-side handlers** + Story 1.11's startup ladder — the README's "first successful tool call" sanity check is a `list_pages` round-trip. The end-to-end binary works today; the docs catch up.
7. **Story 1.11's stderr banners** (`'starting up (silverbullet=...)'`, `'ready (transport=stdio, audit=...)'`, etc.) — the README does NOT need to document these (they're operator-visible only); the threat model's stream-discipline section mentions stderr as the diagnostic destination but does not enumerate banner text.
8. **Story 1.12's CI gates** — the format-check step (`npx prettier --check .`) covers the new markdown files automatically. The pack-manifest step (`npm pack --dry-run`) verifies that `docs/` is NOT in the published artifact. Both are passive — this story does not modify them — but their pass conditions are part of AC5.
9. **Stories 1.5 + 1.6 + 1.10's "what the audit log does NOT contain"** discipline (AR50, AR45, NFR6) — the threat model's auditability section restates this without inventing new exclusions. The four exclusions are: bearer token, internal state, page content beyond digest, diagnostic output. Repeat verbatim from `architecture.md:459-464`.
10. **Top-level `### Review Findings` + `### Dev Agent Record` pattern** from prior stories applies here for the dev pass's record-keeping. Documentation stories still require the same record discipline.
11. **PRD-supersession discipline** — the architecture supersedes the PRD on `read-only`/`append-only`/`read-write` → `read`/`append`/`write` (`epics.md:28-29`); audit-log default sink (`architecture.md:466-468`); state-and-session model (`architecture.md:382`). The docs follow architecture. **The PRD itself is not edited by this story** — it remains a historical artifact with embedded amendments lists.
12. **No `index.ts` re-export barrel pattern** — N/A here (no `src/`); but the analogous "no `docs/index.md` aggregator" pattern applies. Each doc is self-contained.
13. **`try/finally` for resource cleanup** — N/A (no resources allocated); but the analogue is "every claim a doc makes must be cross-checked against the source-of-truth" (Task 4). Treat the cross-check as the cleanup step that runs even on assertion failure.
14. **"Push back on" patterns** — Stories 1.7–1.12 each include a "Push back on" subsection in their dev notes that's been useful in practice (steers reviewers away from out-of-scope additions). This story preserves the pattern in `### Library / framework requirements`.

### Critical guardrails (do not rediscover)

1. **The README's Configuration heading anchor is load-bearing for the FATAL hint.** `src/config/config.ts:210` emits the literal hint `"see the project README — Configuration / Environment variables"` when env-var validation fails at startup. The README MUST contain a section with the heading `## Configuration` and a subsection `### Environment variables` (exact text, GitHub-rendered anchor `#configuration` and `#environment-variables`). Renaming either heading is a silent regression — the operator hitting a config error sees a hint pointing at a non-existent anchor. If a future writer wants to rename, they must update `src/config/config.ts:210` and `src/config/config.test.ts:191` in the same PR.

2. **Terminology hygiene — `none` / `read` / `append` / `write` everywhere; `#mcp/config` everywhere.** PRD's superseded `read-only` / `append-only` / `read-write` (`prd.md:103`, `:354`, `:357-360`) and bare `#config` are forbidden across all three new docs. AC4 enforces this with a grep-based cross-check. Single permitted exception: a one-line "supersedes PRD's `read-only` etc." note in README's pitch if the writer judges it useful — but the prevailing usage is the new vocabulary.

3. **Forward-reference discipline.** `docs/audit-log.md` (Story 2.7) and `docs/starter-template.md` (Story 2.8) and end-to-end transcripts (Story 2.6 / AR67) are NOT in this story. Where the README or threat-model needs to point at them, mark them clearly as "lands in Story 2.7" / "lands in Story 2.8" or omit the link entirely. Do NOT invent the missing content. Do NOT inline a placeholder schema or transcript "to be replaced later" — those become drift surfaces.

4. **`docs/` is NOT in the published npm artifact.** `package.json:13-18`'s allowlist excludes it; Story 1.12's pack-manifest gate verifies this. The new markdown files are GitHub-rendered docs only — they do not ship to npm consumers. If a reader installs via `npx @are/mcp-silverbullet`, they get `README.md` only. (This is correct: docs are linked from the README.) Do NOT add `docs/` to the `files` allowlist.

5. **Threat-model honesty over reassurance.** AR63 mandates honest disclosure of the `none`-mode best-effort guarantee and the experimental Runtime API. The threat model must NOT make claims that exceed the architecture's stance (`prd.md:82`, `architecture.md:366-367`). Specifically: do NOT say `none` "prevents data exfiltration"; do say `none` "blocks well-behaved agents on common-path interfaces (listing, search, direct fetch) and is not a hard isolation boundary." Wording matters here — a future auditor reading the threat model should walk away knowing what the MVP does NOT promise, not feeling falsely safe.

6. **The `claude mcp add-json` snippet must be copy-pasteable.** Smart quotes (`'` vs `'`), zero-width characters, line-continuation backslashes that mangle in some terminals — all silent failures. Verify by pasting the snippet through `node -e 'JSON.parse(process.argv[1])'` before committing. The snippet's `args` array names `@are/mcp-silverbullet` (`package.json:2`); confirm the package name has not changed before publishing.

7. **`SB_AUTH_TOKEN` ↔ `SILVERBULLET_TOKEN` is the #1 first-time-setup confusion.** The SB instance reads `SB_AUTH_TOKEN` from its own env; the MCP server reads `SILVERBULLET_TOKEN` from its env (passed via `claude mcp add-json`'s `env` block). Same value, two names. The README must call this out explicitly — not in passing prose, but in a callout-level instruction. Per `prd.md:412-414`: "Documentation must include the SilverBullet-side configuration step ('how to set `SB_AUTH_TOKEN`') because this is the most likely point of first-time-setup failure."

8. **Permissions guide examples use Maya-realistic refs.** Worked examples use `Projects/Active/Foo`, `Personal/Journal/2026-04-21`, `Daily/2026-04-30`, etc. — names that match Maya's persona at `prd.md:174-176`. **Do NOT** use `Foo/Bar`, `example/page`, or generic placeholders. The doc's didactic value comes from the reader thinking "yes, my space looks like that" — placeholder refs break the J1 onboarding story.

9. **Default-deny is not optional content.** FR6 + AR16 mandate that any page without a `#mcp/config` block is `none` to the agent. Both README and permissions.md must state this. Forgetting it is the #2 first-time-setup confusion (after the token mismatch): Maya doesn't write any blocks, asks her agent "list my pages", gets nothing back, thinks the install is broken. The answer is "you haven't declared anything visible yet." State it.

10. **The trust-contract framing is the README's load-bearing claim.** Per `prd.md:45-52`, the trust contract has two mechanisms (per-page modes + read-before-edit invariant). The README pitch must include both. Dropping either reduces the project to "another MCP server"; the pitch's job is to make the differentiator clear in the first 30 seconds of reading. AC1.1 is non-negotiable on this.

11. **Read-before-edit invariant non-guarantees are required content** (AC3 / `prd.md:223`). The threat model must name what the invariant does NOT protect against — append-then-edit sequences, cross-restart state, immediate-stale-read-then-stale-edit. A doc that only lists guarantees creates false confidence and contradicts AR63's honesty mandate.

12. **`docs/` directory exists and is empty today** (`ls -la docs/` shows just `.` and `..`). The new markdown files populate it. No `.gitkeep` to remove (none was placed). If git ever stops tracking the empty directory, the new files re-establish tracking; no special action needed.

13. **No edits to PRD or architecture from this story.** Both are historical artifacts; they have embedded amendments lists for tracking supersessions. If the dev catches a contradiction during the cross-check (Task 4), the resolution is to follow the architecture in the new docs — NOT to edit the PRD or architecture. Surface any genuine contradictions in the dev's Completion Notes for review-time discussion; do not silently adjust.

14. **No code path changes inside this story.** If during the dev pass the writer notices a code issue (e.g., the FATAL hint anchor doesn't match the README they're writing — see Guardrail #1), the resolution is to **align the README to the existing code**, not the other way around. Code/docs alignment work belongs in the originating story (Story 1.4 for config), not here. If the misalignment is severe, surface it as a deferred-work entry and continue.

15. **Prettier markdown discipline applies to the new docs.** `npm run format` rewrites them; `npx prettier --check .` verifies them. Run the formatter before the cross-check task — formatter-introduced changes (line-wrapping, list-marker normalization) shouldn't surprise the reviewer mid-cross-check.

### Story scope boundaries (DO NOT include)

- **End-to-end transcripts** — Story 2.6 / AR67. README's pitch describes the trust-contract *shape*; transcript-based proof lands once Epic 2's handlers are real.
- **`docs/audit-log.md` schema reference** — Story 2.7 / AR65. Threat model points at it as a forward reference; do NOT inline schema details.
- **`docs/starter-template.md` paste-ready CONFIG snippets** — Story 2.8 / AR66. Permissions guide's worked examples are illustrative, not paste-ready starter content.
- **`CONTRIBUTING.md`** — Story 2.9 / AR68. The README's "For contributors" section restates the existing Development Setup; CONTRIBUTING.md is a separate, deeper artifact.
- **`CLAUDE.md`** — Story 2.9 / AR69.
- **`CHANGELOG.md`** — Story 2.9 / AR70.
- **`.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`** — already deferred per `deferred-work.md` Story 1.12 entry; stays deferred until a community contributor reports a "didn't know what to write" gap (or alongside CONTRIBUTING.md in 2.9).
- **Architecture diagram in README** — Growth.
- **Permission-syntax auto-generation** — there is nothing to auto-generate; the syntax is hand-authored YAML in markdown fences.
- **Custom markdown linter / link checker / vocabulary linter** — anti-AR2 (minimal-deps). The grep-based manual cross-check (Task 4) plus Prettier is sufficient for MVP.
- **Splitting permissions.md or threat-model.md into multiple files** — anti-AR2. Each is a single-page reference, not an index.
- **Publishing `docs/` to npm** — explicit AR9 boundary; pack-manifest gate would fail.
- **PRD or architecture edits** — both are historical; supersessions tracked via embedded amendments lists.
- **Mermaid / PlantUML diagrams** — Growth.
- **Localization / non-English versions** — out of scope for MVP (`bmm/config.yaml`'s `document_output_language: English` is the current baseline).

### Deferred-from-this-story candidates (proposed deferred-work entries — review post-implementation)

Append to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands, IF they feel real after the implementation pass:

1. **README architecture diagram** — `architecture.md:1304-1325` has a textual boundary diagram. A simplified ASCII or Mermaid version in the README would help visual learners. Defer until reader feedback names this as a gap, OR until Story 2.10's release procedure asks for a polish pass.

2. **`docs/index.md` aggregator** — Once `audit-log.md` (2.7) and `starter-template.md` (2.8) land, four docs in `docs/` may benefit from an index page. Defer until the 4th doc lands; analogous to the "extract `tests/integration/_helpers.ts` when 5th consumer arrives" threshold.

3. **`docs/permissions.md` extended scenarios** — the AC mandates four worked examples (a/b/c/d). A future writer may want to add scenarios covering: `exact: true` on a page that also has descendants with their own blocks; conflicting blocks at the same specificity (the permissive-wins tie-break); `config_error` propagation when a global CONFIG block has a typo; FR7 immediacy demonstrated mid-session. Defer until a community-question pattern surfaces.

4. **Architecture decision log for permissions** — explaining *why* SilverBullet's tag-indexed YAML fence blocks were chosen over frontmatter or a config page. The PRD floats both (`prd.md:103`); the architecture chose YAML fence blocks (`architecture.md:205-276`). Documenting the rationale for users who wonder "why this shape?" is a polish concern, not MVP.

5. **Threat model: agent-runtime-side disclosures** — what Maya should know about Claude Desktop's / Claude Code's own audit / logging behavior. Out of scope (upstream concern), but worth pointing at if Anthropic publishes a canonical doc.

6. **Threat model: physical-host considerations** — disk encryption of the audit log file, multi-user host considerations (the audit-log dir is `0o700`, but `~/.local/state` may be `0o755`). Stays in `deferred-work.md` Story 1.5 entry; this story does not pre-empt.

7. **Quickstart sub-doc** — the README's installation walkthrough is comprehensive; some readers may want a 5-line quickstart at the top. Growth — revisit when a reader's first-paint feedback names verbosity as a friction.

8. **Internationalization / additional languages** — `_bmad/bmm/config.yaml` has `document_output_language: English`. A community translation effort is Growth.

9. **Audit-log examples in threat model** — the threat model's auditability section is policy-level (verbosity, exclusions). It does NOT show example log entries. Story 2.7's `docs/audit-log.md` covers concrete examples. Defer cross-linking to 2.7's landing.

10. **`SECURITY.md` in repo root** — GitHub's standard "how to report security issues" file. Growth — revisit when the project has a sustained external user base or before publishing to a public registry.

11. **Reference rendering of `#mcp/config` blocks in SilverBullet itself** — a future SB plugin / custom-rendered surface (`prd.md:111-115`, deferred AR75) would render `#mcp/config` blocks with mode-aware styling in Maya's space. Growth.

### Project Structure Notes

- **Alignment with unified project structure:** `README.md` is at repo root (`architecture.md:1210-1211` / `package.json:13-18`'s allowlist). `docs/permissions.md` matches `architecture.md:1228`. `docs/threat-model.md` matches `architecture.md:1226-1227`.
- **Detected variances:** none. The architecture's `docs/` tree at `architecture.md:1224-1230` lists exactly the five docs across the project's lifecycle: `architecture.md` (symlink — Growth), `threat-model.md` (1.13), `permissions.md` (1.13), `audit-log.md` (2.7), `starter-template.md` (2.8). This story ships the two 1.13 entries.
- **No `index.ts` re-export barrel** — N/A here (no `src/` files affected).
- **`docs/` is OUTSIDE the published artifact** — `package.json:files` does not include it; pack-manifest gate (Story 1.12, AC4) verifies. AC5 reaffirms.
- **`docs/` was empty until this story** — no `.gitkeep` placeholder; git tracks it via these new files. (If a `.gitkeep` had existed, it would be removed in favor of the actual files.)
- **The README is the project's user-facing first impression** — every prior story has deferred to "Story 1.13 will land the real README." This story closes that loop.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.13] (lines 665-689)
- AR62 — README content + Runtime API disclosure: [Source: _bmad-output/planning-artifacts/epics.md] (line 191)
- AR63 — Threat-model honesty: [Source: _bmad-output/planning-artifacts/epics.md] (line 192)
- AR64 — Permissions guide with worked examples: [Source: _bmad-output/planning-artifacts/epics.md] (line 193)
- D1 — Permission Declaration Mechanism: [Source: _bmad-output/planning-artifacts/architecture.md#D1] (lines 205-276)
- D5 — Configuration & Startup Validation (audit-log default path, env-var schema): [Source: _bmad-output/planning-artifacts/architecture.md#D5] (lines 470-531)
- D6 — Error Response Structure (recovery templates, info-leak rules): [Source: _bmad-output/planning-artifacts/architecture.md#D6] (lines 533-641)
- D7 — Process & Diagnostic Logging Discipline (stream rule): [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- AR27 — Audit log default path: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 392-397)
- AR33 — Exactly-one-audit-entry-per-tool-call invariant: [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 708-712)
- AR47 — stdout reserved for MCP JSON-RPC: [Source: _bmad-output/planning-artifacts/epics.md] (line 168)
- AR56 — `#mcp/<name>` tag namespace: [Source: _bmad-output/planning-artifacts/epics.md] (line 181)
- AR62-AR67 — Documentation deliverables block (this story owns 62/63/64; 65/66/67 are forward references): [Source: _bmad-output/planning-artifacts/epics.md] (lines 190-196)
- NFR14 — SB-currently-stable tracking + experimental Runtime API: [Source: _bmad-output/planning-artifacts/epics.md] (line 90)
- FR4–FR10 — Permission and discovery contract (the docs describe these): [Source: _bmad-output/planning-artifacts/epics.md] (lines 28-37)
- FR20 — Read-before-edit invariant rejection: [Source: _bmad-output/planning-artifacts/epics.md] (line 53)
- FR16 — Append exempt from freshness: [Source: _bmad-output/planning-artifacts/epics.md] (line 46)
- PRD § Executive Summary (trust-contract pitch source): [Source: _bmad-output/planning-artifacts/prd.md] (lines 37-52)
- PRD § Distribution & Installation (the `claude mcp add-json` snippet): [Source: _bmad-output/planning-artifacts/prd.md] (lines 317-345)
- PRD § Authentication (`SB_AUTH_TOKEN` ↔ `SILVERBULLET_TOKEN`): [Source: _bmad-output/planning-artifacts/prd.md] (lines 408-414)
- PRD § State & Session Model (in-memory freshness; cross-restart non-guarantee): [Source: _bmad-output/planning-artifacts/prd.md] (lines 416-429)
- PRD § Code Examples (transcripts deferred to 2.6): [Source: _bmad-output/planning-artifacts/prd.md] (lines 431-440)
- PRD § Risk Mitigation (`none`-mode threat-model framing): [Source: _bmad-output/planning-artifacts/prd.md] (lines 293-302)
- Existing README content (preserve Development Setup): [Source: README.md] (lines 24-60)
- Config FATAL hint anchor (the README anchor must match this string): [Source: src/config/config.ts] (line 210)
- Config FATAL hint test (the test pins the anchor string): [Source: src/config/config.test.ts] (line 191)
- `package.json:files` allowlist (excludes `docs/`): [Source: package.json] (lines 13-18)
- `package.json:bin` (the published binary name): [Source: package.json] (lines 10-12)
- Story 1.1's pre-existing README placeholder forward-referencing 1.13: [Source: README.md] (lines 3, 9, 16-22)
- Story 1.12's pack-manifest gate (verifies `docs/` exclusion): [Source: .github/workflows/ci.yml]
- Sprint status file (transition this story): [Source: _bmad-output/implementation-artifacts/sprint-status.yaml] (line 58)
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **No code changes; all gates green on first run.** No iteration loops needed; this is a docs-only story.
- **Prettier auto-formatted the README's `## Configuration` table on first `--write`** — column-width normalization only (extra trailing spaces inside the wide-cell columns); no content changed. Re-run of `prettier --check .` passes whole-repo.
- **Whole-repo `prettier --check .` passes** — confirms `_bmad-output/implementation-artifacts/deferred-work.md` (also modified) and the existing planning artifacts stay clean.
- **`npm test` baseline preserved** — 461/461 passing, exact match to Story 1.12's post-baseline. The smoke test runs separately (1/1, ~210ms test duration, ~2.3s end-to-end with child-spawn cost).
- **Pack manifest is exactly 29 files** — same as Story 1.12 baseline; this story adds 0 files to the published artifact because `docs/` is excluded by the `package.json:files` allowlist.
- **`docs/` exclusion verified** — inline-node parse over `npm pack --dry-run --json` confirmed `files.filter(f => f.startsWith("docs/")).length === 0` and `README.md` is present.
- **JSON-snippet copy-paste smoke** — pasted the `claude mcp add-json` `args` JSON through `node -e 'JSON.parse(process.argv[1])' '<json>'`; parses cleanly. No smart-quote regression.
- **FATAL-hint anchor verified** — `## Configuration` at README.md:80 and `### Environment variables` at README.md:82. The hint emitted by `src/config/config.ts:210` ("see the project README — Configuration / Environment variables") resolves to a real anchor.
- **Cross-document consistency grep results (2026-05-01):**
  - `read-only|append-only|read-write` across `README.md` + `docs/*.md` → one hit at `README.md:91` ("read-only filesystem"), the legitimate POSIX-permissions sense in the audit-log directory bootstrap description; not the access-mode vocabulary. Acceptable.
  - `#config\b|#mcp-config|#mcp:config` → only inside `docs/permissions.md`'s Malformed-block-behavior section where they are intentionally listed as forbidden tag-typo examples. Acceptable.
  - `trust contract` appears in README + permissions.md + threat-model.md.
  - `read-before-edit invariant` appears in README + permissions.md + threat-model.md.
  - All internal links (`./LICENSE`, `./docs/permissions.md`, `./docs/threat-model.md`) verified to resolve.
  - Forward references to `docs/audit-log.md` (Story 2.7) and `docs/starter-template.md` (Story 2.8) explicitly flagged as such; not validated as resolvable links.
- **Module-isolation greps remain green** — `console\.(log|info|debug)` zero matches in `src/`; `process\.stdout\.write` zero matches outside the SDK. (No code changed; reaffirms the existing invariants.)

### Completion Notes List

- All five Acceptance Criteria satisfied: AC1 (README), AC2 (permissions.md), AC3 (threat-model.md), AC4 (cross-doc consistency), AC5 (gates green + placeholder cleared + status flipped).
- Three documents authored: README rewrite preserves the Development Setup section verbatim under `## For contributors` near the bottom, per the AC1.10 mandate. The new `docs/permissions.md` has 9 sections matching the AC2 contract including all four worked examples (a/b/c/d) with Maya-realistic refs. The new `docs/threat-model.md` has 9 sections matching the AC3 contract with the explicit "best-effort, NOT a hard isolation boundary" disclosure of `none`-mode prominent.
- The hidden constraint from Critical Guardrail #1 is preserved: the README's `## Configuration` + `### Environment variables` heading anchor matches the literal hint string emitted by `src/config/config.ts:210` and tested at `src/config/config.test.ts:191`. A future writer renaming either heading must update both code and test in the same PR.
- The hidden constraint from Critical Guardrail #4 is preserved: `docs/` is NOT in the published npm artifact's allowlist; pack-manifest verification (Story 1.12, AC4) passes unchanged. User-facing docs are GitHub-rendered only.
- The `claude mcp add-json` snippet uses `args: ["@are/mcp-silverbullet"]` matching `package.json:2`; the `env` block carries `SILVERBULLET_URL` and `SILVERBULLET_TOKEN` placeholders. The snippet was smoke-tested through `node -e 'JSON.parse(process.argv[1])'` and parses cleanly.
- The `SB_AUTH_TOKEN` ↔ `SILVERBULLET_TOKEN` step is called out at callout-level (block-quote with bold framing) in the README's Install section, per Critical Guardrail #7. The same secret on both sides, two env-var names, one on each side.
- The default-deny rule is named explicitly in both README's `## Permissions` section and `docs/permissions.md`'s Resolution algorithm + Worked Example A. This pre-empts the #2 first-time-setup confusion (Critical Guardrail #9): "I haven't authored anything; my agent says my space is empty".
- The threat-model's `## none-mode is best-effort, NOT a hard isolation boundary` section names what's blocked (common-path interfaces) AND what's not (Lua-driven edge paths, indirect references in non-`none` pages, future SB HTTP surfaces). Recommends a separate SilverBullet space for material requiring hard isolation. Per AR63's honesty mandate, the document does not make claims that exceed the architecture's best-effort stance.
- The read-before-edit invariant's non-guarantees are enumerated in `docs/threat-model.md` Section 4: append-then-edit sequences not protected (FR16); cross-session protection not provided (in-memory state); immediate stale-read-then-stale-edit not caught; no deep-diff semantics. This matches Critical Guardrail #11.
- The auditability stance section in `docs/threat-model.md` lists what the audit log does NOT contain (bearer token, internal state, page content beyond digest, diagnostic output) — verbatim from `architecture.md:459-464`. Verbosity policy is described as one-sentence headline; full schema is forward-referenced to Story 2.7's `docs/audit-log.md` (link not added since the file does not yet exist).
- All six verification gates passed: `typecheck`, `lint --max-warnings=0`, `prettier --check .`, `npm test` (461/461), smoke (1/1), `npm pack --dry-run` (29 files, 0 in `docs/`, README present).
- 12 deferred-work entries appended to `_bmad-output/implementation-artifacts/deferred-work.md` under the new `## Deferred from: dev of story-1-13-...` heading; no code-review pass yet — additional entries may be appended after review.

### File List

**Modified:**
- `README.md` — substantive rewrite. Preserved the Development Setup section verbatim under `## For contributors` near the bottom. Replaced the placeholder banner, status, install, and configuration sections with the AC1 content.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.13 transitions: `backlog` → `ready-for-dev` (during create-story) → `in-progress` (Step 4) → `review` (Step 9). `last_updated` field bumped.
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended 12 new entries under `## Deferred from: dev of story-1-13-user-documentation-readme-permissions-guide-threat-model (2026-05-01)`.

**New:**
- `docs/permissions.md` — 9-section permission-authoring guide with four worked examples (global CONFIG block, directory-scoped block, `exact: true` block, personal journal `none` block).
- `docs/threat-model.md` — 9-section honest-disclosure document covering `none`-mode best-effort, Runtime API experimental, read-before-edit invariant guarantees and non-guarantees, auditability, bearer-token hygiene, stream discipline, known limits, and trust-contract framing.

**Unchanged (verified by gates):**
- All `src/` source files (no code changes).
- All `tests/` files (unit, integration, smoke).
- `package.json` / `package-lock.json` (no script or dependency changes; pack manifest stays at 29 files).
- `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`.
- `.github/workflows/ci.yml`, `.github/dependabot.yml` (gates run unchanged).
- `scripts/latency-baseline.ts`.

### Change Log

| Date       | Author | Change                                                                                                                                                  |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-01 | Amelia | Story 1.13 dev pass: README rewrite, `docs/permissions.md` + `docs/threat-model.md` created; all gates green; sprint-status `in-progress` → `review`. |
| 2026-05-01 | Amelia | Story 1.13 code-review pass: 13 patches applied (1 decision dismissed, 1 promoted to patch); 3 items deferred; 8 dismissed; all gates green; sprint-status `review` → `done`.       |

### Review Findings

Code-review pass 2026-05-01 (Blind Hunter + Edge Case Hunter + Acceptance Auditor). 25 findings after dedup.

**Decisions resolved:**

- [x] [Review][Decision→Dismiss] Package not yet on npm; README install snippet assumes published artifact — Resolved: trust the Status banner ("pre-release") to convey not-for-end-users. README install snippet remains as-is; Story 2.10 publication will retroactively make it accurate.
- [x] [Review][Decision→Patch] Threat-model claims `/.runtime/lua_script` is part of the API surface; code only calls `/.runtime/lua` and `/.ping` — Resolved: drop `/.runtime/lua_script` parenthetical from `docs/threat-model.md` §3 to match code. Note this is a deviation from spec AC3 §3 (line 139) and `architecture.md:290-292`; the architecture line may be stale or reflect Epic 2 forward-state. (Promoted to patch P13.)

**Patches (all applied 2026-05-01):**

- [x] [Review][Patch] AC1.5 callout missing the "how to set `SB_AUTH_TOKEN` on SilverBullet" half [README.md SB_AUTH_TOKEN callout] — Added a "How to set" sub-block covering binary-direct, Docker, and systemd/launchd patterns.
- [x] [Review][Patch] Threat-model overstates lint enforcement: `process.stdout.write` is NOT linted (smoke test gates it) [docs/threat-model.md §7] — Rewrote Layer 1 + Layer 3 to reflect actual enforcement: lint catches `console.log`/`console.info`; smoke test catches `process.stdout.write` and other stray bytes.
- [x] [Review][Patch] Threat-model omits LRU eviction non-guarantee (1024-entry cap → silent freshness loss in long sessions) [docs/threat-model.md §4] — Added a "freshness map is bounded; eviction is silent" non-guarantee bullet.
- [x] [Review][Patch] Permissions guide malformed-block list omits `exact_invalid` (truthy-but-non-boolean YAML) [docs/permissions.md §7] — Added a fourth row to the malformed-block table covering YAML truthy-non-boolean values.
- [x] [Review][Patch] Permissions guide tag-typo footgun has no diagnostic; add a "verify your block was indexed" recipe [docs/permissions.md §7] — Added a new "Verifying a block is actually indexed" subsection with the SB tag-pane recipe.
- [x] [Review][Patch] Worked Example C cumulative-state ambiguity — clarify which prior blocks remain in scope [docs/permissions.md §6 (c)] — Replaced the ambiguous "(Assume A/B remains)" parenthetical with explicit "only the global from Example A; Example B's `Projects/Active` block is NOT present here — these worked examples do not stack" framing.
- [x] [Review][Patch] Threat-model "immediate stale-read-then-stale-edit" non-guarantee is tautological/confused; rewrite [docs/threat-model.md §4] — Rewrote the bullet to: "you must have read THIS version, not recently"; clarified that a concurrent third-party modification IS caught.
- [x] [Review][Patch] Strip inline FR/AR/NFR/Story-2.x tokens from user-facing prose; consolidate into a References footer [docs/threat-model.md, docs/permissions.md] — Stripped `FR16` / `FR20` / `FR25` / `NFR14` from threat-model prose; permissions had none. Story 2.7 / 2.8 forward references kept (spec-mandated).
- [x] [Review][Patch] README install hint phrasing drifts from FATAL hint string ("→" vs "/") [README.md ~L78] — Changed "Configuration → Environment variables" to "Configuration / Environment variables" to match `src/config/config.ts:210` verbatim.
- [x] [Review][Patch] Permissions guide "take effect immediately" overstates — acknowledge SB tag-indexer lag [docs/permissions.md §8] — Renamed section to "Updates take effect on the next tool call" and added a paragraph naming SB's async tag indexer as the one moving part.
- [x] [Review][Patch] README `tail -f` is a Unix-ism [README.md audit-log paragraph] — Replaced with platform-aware: `tail -f` on Unix/macOS, `Get-Content -Path … -Wait` on Windows PowerShell.
- [x] [Review][Patch] Add "ASCII-only inside the JSON snippet" caveat near the install snippet [README.md install section] — Added a "Paste safety" callout immediately above the SB_AUTH_TOKEN block.
- [x] [Review][Patch] Drop `/.runtime/lua_script` parenthetical from threat-model §3 to match actual code [docs/threat-model.md §3] — Removed the parenthetical; surface is now stated as "only `POST /.runtime/lua` plus `GET /.ping`". Note for future writers: spec AC3 §3 + `architecture.md:290-292` mention `/.runtime/lua_script` for multi-statement scripts; reintroduce the parenthetical when Epic 2's write-side actually uses it.

**Deferred (real but not actionable here):**

- [x] [Review][Defer] Token-redaction triple-claim has thin evidence in user docs [README.md L97 + docs/threat-model.md §6] — deferred, polish over correctness; redaction mechanism is real and tested at the source layer (config wrapper).
- [x] [Review][Defer] Cross-host clock-skew non-guarantee not named (agent host clock vs SB host clock) [docs/threat-model.md §4] — deferred, deeper edge case beyond MVP threat-model scope; assumes NTP-synced hosts.
- [x] [Review][Defer] Document the `MCP_SILVERBULLET_AUDIT_LOG_PATH=relative-path` failure class distinct from "creation failed" [README.md env-var table] — deferred, table currently says "absolute path" which sets the contract; the precise failure-class distinction is polish.

**Dismissed (8): see review log.** `-runtime-api` Docker variant naming follows project canon (matches FATAL hint at `src/index.ts:216`); `docs/audit-log.md` forward references are spec-accepted (Story 2.7 owns it); path-as-hierarchy in worked examples is SB convention, spec-mandated; permissive-wins tie-break end-to-end demo is explicitly deferred in `deferred-work.md`; calendar date `2026-04-30` follows spec; threat-model anchor `#stream--output-discipline` works on GitHub; `[::1]`/IPv6 localhost exemption — README mirrors actual code (code-side concern); Status line `0.1.0-pre` follows AC5 wording (spec internal contradiction with AC1.2; AC5 is more recent and `package.json` is `0.1.0-pre.0`).

