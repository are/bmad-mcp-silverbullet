---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
releaseMode: phased
inputDocuments: []
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 0
  projectDocs: 0
classification:
  projectType: developer_tool
  domain: general
  complexity: low
  projectContext: greenfield
workflowType: 'prd'
---

# Product Requirements Document - bmad-silverbullet-mcp

**Author:** Are
**Date:** 2026-04-30

## Executive Summary

`bmad-silverbullet-mcp` is a Model Context Protocol server that exposes a self-hosted SilverBullet space to AI agents as a structured, permission-governed collaborator. It targets SilverBullet users who want their notes, documentation, and project context to remain their own personal knowledge environment while becoming a working surface their agents can read, learn from, and contribute back to — without ceding control of what the agent can see or change.

The product is unopinionated by design. It does not impose a knowledge schema, tagging convention, or workflow on users; it adapts to whatever organizational idiom the user has already built in their SilverBullet space, so it integrates into existing community workflows rather than replacing them.

### What Makes This Special

Existing PKM-MCP integrations treat agent access as an on/off switch — once connected, the agent sees and edits whatever it wants. This product makes **agent access a first-class trust contract** built on two mechanisms:

1. **Per-page access modes** declared by the user — `none` (page is invisible to the agent), `read-only`, `append-only`, or `read-write`. Sensitive material can be entirely excluded from the agent's reachable surface.
2. **A read-before-edit invariant** — non-append edits are rejected unless the agent has read the page since its last modification. This eliminates a category of agent harm (silent overwrites, stale-context edits) that current MCP servers ignore by default.

These guarantees rest on SilverBullet's underlying programmability — Lua/space-script and custom-rendered surfaces — letting the server expose richer interactions than plain markdown CRUD: cross-space queries, structured data access, and agent-facing UI that SilverBullet itself renders for the human in the loop.

The core insight: **agents should earn the right to write.** Permissioning + freshness checks make "agent collaborator in your knowledge base" trustworthy by construction, not by hope.

## Project Classification

- **Project Type:** Developer tool — distributable MCP server installed and run by users into their own self-hosted SilverBullet stack.
- **Domain:** General productivity / personal knowledge management. No regulated-industry constraints.
- **Complexity:** Low (domain) / non-trivial (technical — MCP protocol surface, SilverBullet integration, permission enforcement, freshness tracking).
- **Project Context:** Greenfield — no prior code, briefs, or research artifacts.
- **Distribution Model:** Open to the SilverBullet community; primary user is the author, secondary users are community members with diverse personal workflows.

## Success Criteria

### User Success

The product is succeeding for its user when, three months into adoption:

1. **Manual context-passing has stopped.** The user no longer copies page content into agent prompts to provide background — the agent reaches into SilverBullet itself and the user trusts it to do so without supervision.
2. **The agent has written notes the user later references.** Pages produced or extended by the agent become part of the user's working knowledge base, not throw-away artifacts. The bidirectional loop is live — agent reads to understand, writes to remember, user reads what agent wrote.
3. **The safety layer is invisible in normal use.** The user has never had an agent silently overwrite a page, never had an agent leak content from a `none`-mode page on a normal access path, and never had to think about whether the permission system is "on" — it just works.

### Business Success

This is an open, community-distributed tool with no commercial model. Success is defined by the author's own sustained use; community adoption is a welcome bonus, not a target.

- **Primary signal:** the author keeps using it daily after the build phase ends.
- **Secondary (bonus) signals:** other SilverBullet community members install it, file substantive issues, or contribute back. None of these are required for the project to be considered successful.

### Technical Success

- **Permission enforcement is correct on the common-path interfaces.** Listing, search, direct read, write, and append operations exposed through the MCP protocol respect declared per-page access modes. `none`-mode pages do not appear in agent-visible listings, search results, or direct fetch responses.
- **`none`-mode is best-effort, not a security boundary.** Because SilverBullet is programmable (Lua/space-script, queries, custom surfaces), the server cannot guarantee a determined agent is wholly prevented from inferring or reaching `none` content through edge paths. The success criterion is *blocked on common paths*, and this limitation is documented for users so expectations are honest.
- **The read-before-edit invariant is provably enforced.** Non-append edits to a page are rejected if the agent has not read that page since the page's last modification timestamp. The check is deterministic and testable.
- **Latency stays acceptable.** Agent interactions do not feel meaningfully slower than equivalent native MCP servers. Specific p95 targets are stated as NFR1 and NFR2.
- **Compatibility tracking.** The server stays compatible with current and recent SilverBullet releases. Compatibility breakage with a new SB release is treated as a P0.
- **Auditability.** Every agent action — read, append, edit attempt (allowed or rejected), search, listing — is loggable in a form the user can inspect after the fact.

### Measurable Outcomes

- Author personally relies on the tool ≥ 3 months post-launch with no regression to manual context-pasting.
- Zero confirmed cases of an agent silently overwriting a page protected by the read-before-edit invariant.
- p95 latency targets met on the author's reference deployment.
- Permission-engine behavior covered by a deterministic test suite the user can run locally.

## Product Scope

### MVP — Minimum Viable Product

The MVP ships the full safety story so the trust contract is real from day one.

- **Connection to a self-hosted SilverBullet instance** — authenticated, configurable endpoint.
- **Core MCP surface for pages**: list, read, search, append, edit, create, delete (subject to permissions).
- **Per-page access modes** declared by the user: `none`, `read-only`, `append-only`, `read-write`. Declaration mechanism is decided at architecture time (frontmatter, config page, Lua hook, or combination).
- **Read-before-edit invariant** — non-append edits rejected unless the agent has read the page since its last modification.
- **Best-effort blocking** of `none`-mode content on the common-path MCP interfaces (listing, search, direct read).
- **Audit log** of agent actions (initially file-based or write-into-SB; format settled at architecture time).
- **Documentation**: install, configure, declare permissions, threat-model honesty about `none`-mode limitations.

### Growth Features (Post-MVP)

- **Custom-rendered SilverBullet surfaces** — agent-facing interactions rendered as SB pages/widgets so the human-in-the-loop sees agent activity inside their own environment.
- **Lua-powered cross-space queries** exposed to the agent as structured tools.
- **Granular permission predicates** beyond per-page declaration — tag-based, path-pattern, time-windowed, etc.
- **Multi-agent identity** — different connected agents get different permission scopes.
- **In-SB approval workflow** — agent proposes a non-append edit and the user approves it from within SilverBullet.

### Vision (Future)

- The MCP server becomes the canonical adapter for "agent + personal knowledge base" in the SilverBullet ecosystem.
- The permission/freshness model influences how other PKM-MCP integrations handle agent trust.
- SilverBullet's programmability is fully leveraged — agents can not only read/write but invoke Lua-defined operations exposed by the user, turning the space into a programmable substrate the agent can compose against.

### MVP Strategy & Philosophy

**MVP approach:** Problem-solving MVP. The goal of the MVP is not adoption, revenue, or experience polish — it is proving the central thesis that *agents can be useful collaborators inside a personal knowledge base when access is governed by a server-enforced trust contract*. The MVP succeeds the moment that thesis is true in real day-to-day use against real agents.

**Resource picture:** Solo project on a dedicated cadence. There is no team to scale to, no external timeline pressure, and no investor or stakeholder expectation. Implementation pace is set by the author. This shapes the scoping in two ways:

1. **Scope discipline matters more than usual.** A solo cadence cannot absorb scope creep without slipping indefinitely. The MVP feature set is held strictly to what the four user journeys require; everything else is parked in Growth or Vision regardless of how interesting it looks.
2. **Quality bar is set by personal use.** The author is the primary user. Bugs that survive into "ship" become bugs the author hits daily. This biases toward shipping a small, correct MVP rather than a larger, fragile one.

### Phase Mapping — Journeys to Scope

The four user journeys (defined in the next section) map to phases as follows:

| Journey | Phase | Why |
|---|---|---|
| J1 — First-Time Setup | MVP | Without setup the product cannot be evaluated at all |
| J2 — Daily-Use Happy Path | MVP | The core value loop; without this nothing else matters |
| J3 — Safety Layer Earning Trust | MVP | The differentiator. Cannot ship without this and still claim the thesis is proven |
| J4 — Permission Boundary in Action | MVP | The other half of the safety story. Without `none`-mode filtering, the trust contract is incomplete |

**All four journeys ship in MVP.** The product cannot validate its problem-solving thesis with any of them deferred.

### Risk Mitigation Strategy

**Technical Risks**

- **Risk: Permission engine completeness across SilverBullet's surface.** SilverBullet exposes pages through multiple paths (listing, search, direct fetch, queries, indexed metadata). Ensuring `none`-mode filtering is consistent across every common-path interface is non-trivial; a single missed path leaks content that should be invisible.
  *Mitigation:* The permission engine and edit-batch validator are both designed to be testable in isolation (no network calls). Test suite covers each MCP tool's permission contract exhaustively. Documented threat model is honest that `none` is best-effort on common paths, so the bar is "no leaks via the documented MCP surface" rather than "absolute isolation."

- **Risk: Edit-batch correctness.** The snapshot-relative line-number resolution, overlap detection, and atomic application of mixed edit types is the most logic-heavy code in the project. Bugs here can silently corrupt user pages.
  *Mitigation:* Edit-batch validator tested against a wide property-based test suite covering edit ordering, overlap edge cases, and snapshot drift. Validator is pure (input: snapshot + edits → output: result + accept/reject) and runs offline.

- **Risk: SilverBullet API stability.** SB is actively developed. A breaking change in its HTTP API surface would break the MCP server's primary dependency.
  *Mitigation:* Compatibility breakage with a new SB release is treated as a P0. The SilverBullet client is small and concentrated, so adapting to API changes is bounded work.

- **Risk *ruled out by prototype:* agent runtime behavior on freshness errors.** Whether Claude- and GPT-class models gracefully re-read and retry when an edit is rejected for staleness was the most plausible "this won't work" risk. **The author has confirmed in prototypes that Claude handles the model correctly without prompt engineering.** This is no longer an open risk for MVP. Validation against other agent runtimes (Cursor, GPT-class, others) remains a Growth concern.

**Market Risks**

- **None applicable.** The product is open and community-distributed with no commercial model. The Business Success criteria explicitly state community adoption is not required for project success. No market risk to mitigate.

**Resource Risks**

- **Risk: Solo cadence sustainability.** Solo dedicated cadence is fragile to life events, burnout, and the inevitable late-stage scope-creep temptation that hits projects near completion.
  *Mitigation:* MVP scope is held strictly to the four-journey requirement. Growth-tier features are explicitly named so they can be pointed at when the impulse to expand MVP arises. The product remains useful at MVP without any Growth features ever shipping.

- **Risk: Ecosystem drift (MCP, agent runtimes, SilverBullet) during the build phase.** All three move quickly. The product depends on the intersection.
  *Mitigation:* Use the official `@modelcontextprotocol/sdk` rather than rolling protocol logic, so MCP-side drift is absorbed by the SDK. Track active SB releases. Stay current with Claude Code's MCP integration patterns.

## User Journeys

### Persona: Maya

Maya is a software engineer who has run a self-hosted SilverBullet instance for two years. Her space is a working environment, not a notebook — it holds project notes, working memory across long-running tasks, design sketches, debugging logs, and a small amount of personal material she keeps separate. She has begun using Claude Code and Claude Desktop daily and wants the same agents to ground their work in her notes. But she will not paste her space into a prompt by hand, and she will not connect an agent that can read or rewrite anything it wants. She wants the agent inside her workspace, and she wants to set the rules.

### Journey 1 — First-Time Setup

**Where we meet her:** Maya has just spent a week manually copy-pasting page content into Claude prompts to give it context for a multi-day refactor. The friction is wearing on her. She finds `bmad-silverbullet-mcp` mentioned in the SilverBullet community and decides to try it.

**What she does:** She installs the MCP server, points it at her self-hosted SilverBullet endpoint, and authenticates. She wires it into her Claude Code config. The first thing she does is *not* connect an agent — it's open her SilverBullet space and decide what the agent can see. She marks her `Personal/` directory as `none`, her active project page as `read-write`, her older project archive as `read-only`, and a daily-log page as `append-only`. She connects the agent.

**The "it works" moment:** She asks Claude a question about her current refactor. Claude reaches into the project page on its own. The reply is grounded in the actual notes. She did not paste anything.

**New reality:** Setup felt like fifteen minutes of permission-marking, not configuration hell. She now has an integration she trusts because she can see and edit what the agent can reach.

**Requirements this journey reveals:**
- Install path that works for the SilverBullet community's typical deployment patterns (Docker, native Deno, etc.)
- A single configuration surface (endpoint, credentials, MCP transport)
- Permission declaration mechanism that's discoverable from inside SilverBullet itself
- A clear "is this connected and working" feedback signal — first call should succeed visibly
- Default-deny behavior on unmarked pages, so misconfiguration fails closed

### Journey 2 — Daily-Use Happy Path

**Where we meet her:** Maya is two hours into a debugging session. She has been adding observations to a `Bugs/Active/2026-Q2-cache-corruption` page as she narrows the issue down.

**What she does:** She switches to Claude and asks "based on what I've found so far, what's the most likely root cause?" The agent calls the MCP server, fetches the bug page, reads her observations, and replies with a grounded analysis citing specific log entries she'd noted earlier. It then appends a "Hypothesis tree" section to the page — `append-only` is the page's mode, so the agent can extend but not rewrite.

**The "it works" moment:** Three days later, when the bug is fixed, Maya scrolls back through the bug page and finds the agent's hypothesis tree was correct on the second branch. She copies the structure into the post-mortem template she's drafting.

**New reality:** The agent contributes durable artifacts to her knowledge base, not just disposable chat output. Her notes have grown richer with collaboration than they ever did with her writing alone.

**Requirements this journey reveals:**
- Read operations that return page content with sufficient structure for the agent to reason over it (frontmatter, body, possibly indexed metadata)
- Append operations that are atomic and respect page mode
- Reads must update the agent's "last read" record so subsequent edits are admissible (feeds Journey 3)
- The agent's contributions are written into the user's normal SilverBullet content with no special namespacing — they live as first-class notes

### Journey 3 — The Safety Layer Earning Trust

**Where we meet her:** Maya has spent the morning rewriting a project's roadmap page in SilverBullet directly — adding new milestones, reorganizing sections, deleting a column. The agent had read this page yesterday and was holding context from then.

**What she does:** Later that afternoon, she asks the agent to "update the roadmap with what we discussed." The agent issues an edit using the version of the page from yesterday's read. The MCP server checks: page has been modified since the agent's last read. The edit is rejected with an error explaining the freshness violation.

**The "it works" moment:** The error message reaches the agent and surfaces in her chat: *"Edit rejected — page has changed since last read. Re-read to refresh context, then retry."* The agent re-reads, sees Maya's morning rewrite, and produces a new edit that *integrates* with her changes rather than overwriting them. Maya realizes that without this guardrail, the agent would have silently smashed half a morning's work.

**New reality:** Maya has an internalized confidence she did not have with prior PKM-MCP integrations: the agent cannot accidentally regress her work. The guardrail is invisible until it matters, and when it matters, it is unambiguous.

**Requirements this journey reveals:**
- Per-page modification timestamp tracking, comparable against the agent's per-page read timestamp
- Read-before-edit invariant enforced server-side, not by agent convention
- Append operations exempt from the invariant (since append-only is its own mode)
- Error responses must be *actionable for the agent* — explicit enough that a well-behaved agent re-reads and retries without human intervention
- Audit log captures the rejected edit so Maya can review what *would have* happened

### Journey 4 — Permission Boundary in Action

**Where we meet her:** Maya keeps a `Personal/Journal/` directory in SilverBullet. It is marked `none`. The agent has never seen it and should never see it.

**What she does:** During a planning session, she asks the agent to "summarize what I've been working on this quarter." The agent searches her space, reads her project pages, and replies with a coherent summary of work-related material. Nothing from the journal appears in the listing the agent received, in the search results, or in the reply.

**The "it works" moment:** Curious, Maya checks the audit log later. She sees the search query the agent issued, the list of pages the server returned to it, and confirms her journal pages were filtered out before the agent ever saw them. She also sees an entry that the agent attempted, at one point, to fetch `Personal/Journal/2026-04-21` directly (perhaps because some other page mentioned the date) — and the server returned `not found`. The agent did not retry; the safety contract held on the common path.

**New reality:** Maya can keep personal material in the same SilverBullet space as her work without compartmentalizing into separate instances. The boundary is enforced in the data the agent receives, not in the agent's promise to be polite.

**Requirements this journey reveals:**
- `none`-mode pages are filtered from listing operations server-side
- `none`-mode pages are filtered from search results server-side
- Direct fetches of `none`-mode pages return `not found` (or equivalent), not "forbidden" — the page should be invisible, not advertised-but-blocked
- Audit log records both the agent's intent (the call it made) and the server's response (what it returned), so the user can reconstruct what the agent saw
- The product documentation is honest that these filters are best-effort against well-behaved agents on common paths, not a hard isolation boundary

### Journey Requirements Summary

The four journeys above reveal the capabilities the MVP must deliver:

| Capability | Required by |
|---|---|
| Install + connect to self-hosted SilverBullet | J1 |
| Permission declaration mechanism (per-page modes) | J1, J2, J3, J4 |
| Default-deny on unmarked pages | J1 |
| Listing operations (filtered by permission) | J2, J4 |
| Search operations (filtered by permission) | J4 |
| Read operations (gated, timestamp-tracked) | J2, J3 |
| Append operations (atomic, gated) | J2 |
| Edit operations (gated, freshness-checked) | J3 |
| Per-page last-modified tracking, server-side | J3 |
| Per-agent-session per-page last-read tracking | J3 |
| Actionable error responses on permission/freshness failures | J3 |
| Audit log capturing agent intent + server response | J3, J4 |
| Honest documentation of `none`-mode threat model | J4 |

Every journey exercises the permission system, confirming the architectural-spine framing from the Executive Summary: **permissions are not a feature, they are the product**.

## Innovation & Novel Patterns

### Detected Innovation Areas

The product introduces two novel patterns to the MCP/agent-integration space:

1. **Freshness-gated edits as a server-enforced invariant.** Optimistic-concurrency-style staleness checks are well-established in collaborative editing and database systems, but they have not been broadly applied to LLM agent integrations with knowledge bases. The novel claim: an agent's notion of "what this page says" is inherently stale (it was true at read time, the human kept working), and the integration layer — not the agent — is responsible for catching that.

2. **Trust-contract framing for agent access.** The default in current MCP servers is "agent connects → agent acts." This product reframes access as a contract the user authors and the server enforces: per-page modes describe *what* the agent may do, the freshness invariant describes *under what conditions* the agent may write. The agent is not a privileged peer; it is a guest whose actions are auditable and bounded.

### Market Context & Competitive Landscape

- **Existing PKM-MCP integrations** (community-built bridges for Obsidian, Notion, Logseq) generally expose all-or-nothing access. Some honor read-only modes; none publicly visible enforce a freshness invariant against agent edits.
- **General-purpose MCP servers** for filesystems, databases, and version control similarly treat agent access as binary.
- **Adjacent prior art:** human-collaboration tools (Git, CRDTs, OT) have decades of mature staleness handling; this product borrows the conceptual model and applies it to a domain that has not yet adopted it.
- The competitive position is therefore not "another MCP server for SilverBullet" but "the safety-first MCP server pattern, demonstrated on SilverBullet."

### Validation Approach

The innovation is validated when:

1. **The freshness check fires usefully in real use** — i.e., a non-zero number of edits get rejected because the human had concurrently modified the page, *and* the agent recovers gracefully (re-reads and produces a correct edit). Both halves matter: rejections without graceful recovery just feel like a broken integration.
2. **Well-behaved agents (Claude, GPT-class models) handle the error responses correctly without prompt engineering** — actionable error messages should be enough.
3. **Subjective trust signal:** Maya (and the author) report that they connect this MCP server to agents they would not trust *without* the safety contract. If the product just feels like "another MCP integration," the innovation hasn't landed.
4. **Beyond the author:** if the pattern starts being borrowed — a Logseq or Obsidian MCP integration adopting freshness-gated edits — that's the strongest validation that the paradigm generalizes.

### Risk Mitigation

- **Risk: Freshness rejection loops.** If agents repeatedly hit the freshness check and don't recover, the system feels broken rather than safe.
  *Mitigation:* Error responses are explicit, machine-actionable, and include the guidance the agent needs to retry correctly. Test against major agent runtimes early.
- **Risk: Permission declaration friction.** If declaring page modes is tedious, users won't bother and the trust contract won't get authored, so default-deny will block useful work or default-allow will undercut the safety claim.
  *Mitigation:* Permission declaration must be lightweight and discoverable inside SilverBullet itself (architecture decision: frontmatter, config page, Lua hook, or combination — settled later). Documentation includes opinionated starter templates.
- **Risk: Innovation framing doesn't resonate beyond the author.** "Agents earning the right to write" is a thesis; not everyone will read the README and care.
  *Fallback:* The product still functions as a competently-built permission-gated SilverBullet MCP server even if the paradigm framing fails to spread. The technical features stand alone.
- **Risk: Best-effort `none`-mode boundary is mistaken for a security boundary.** Users assume `none` is a hard guarantee, store sensitive material accordingly, and are surprised when an edge path leaks.
  *Mitigation:* Documentation is explicit and prominent. The threat model is named and disclosed; users are told `none` blocks well-behaved agents on common paths and is not a hard isolation.

## Developer Tool — Specific Requirements

### Project-Type Overview

This is a developer tool in the MCP-server form factor: a small server process invoked by an agent runtime over a chosen transport, exposing a fixed set of tools that wrap a remote SilverBullet HTTP API. It is not a library agents import; it is a sidecar process they speak to. The "developer" being served is anyone running an MCP-capable agent (Claude Code, Claude Desktop, etc.) against their self-hosted SilverBullet instance.

### Technical Architecture Considerations

- **Implementation language:** TypeScript on Node.js. Aligns with the SilverBullet community's primary scripting language (TS/JS), gives access to the well-supported `@modelcontextprotocol/sdk` Node package, and makes the resulting npm artifact one `npx` away from runnable.
- **Runtime target:** Active LTS Node.js (≥ 20.x at time of this PRD). Single Node process, no native compilation steps.
- **Dependencies kept minimal:** the MCP SDK, an HTTP client for the SilverBullet API, and a markdown/frontmatter parser. No heavy framework, no native modules.
- **No persistent local state in MVP** (see *State & Session Model* below) — the server's process lifetime defines the boundary of what it remembers. This simplifies installation, removes a class of "state corruption" failure modes, and reinforces the freshness contract.

### Distribution & Installation

The product ships as a single npm package, intended to be invoked via `npx` so users do not maintain a local install.

**Installation pattern (Claude Code):**

```bash
claude mcp add-json silverbullet '{
  "type": "stdio",
  "command": "npx",
  "args": ["@are/mcp-silverbullet"],
  "env": {
    "SILVERBULLET_URL": "https://my-silverbullet.example.com",
    "SILVERBULLET_TOKEN": "..."
  }
}'
```

**Configuration surface:**

- `SILVERBULLET_URL` — endpoint of the user's self-hosted SilverBullet instance.
- `SILVERBULLET_TOKEN` — bearer token (see *Authentication*).
- Optional flags settled at architecture time (default permission mode, audit log path, etc.).

**Required sections from CSV:**

- `language_matrix`: TypeScript / Node.js only in MVP. No multi-language story.
- `installation_methods`: npm package, run via `npx`. No Docker image, no native binaries in MVP. Deno is *not* targeted in MVP despite SilverBullet itself being Deno-based — alignment is at the protocol/data level, not the runtime level.
- `migration_guide`: not applicable for a v1 release.

### MCP Tool Surface (API)

The MCP server exposes the following tools, all subject to the per-page permission engine and the freshness invariant where applicable:

| Tool | Purpose | Permission gate | Freshness gate |
|---|---|---|---|
| `list_pages` | List pages in the space | Filters out `none`-mode pages | — |
| `read_page(name)` | Fetch a page's content | Allowed unless `none` | Updates last-read timestamp on success |
| `search_pages(query)` | Full-text/query search | Filters out `none`-mode pages | — |
| `append_to_page(name, content)` | Append content to a page | Requires `append-only` or `read-write` | — |
| `edit_page(name, edits[])` | Apply a batch of edits atomically | Requires `read-write` | Whole batch rejected if page modified since last read |
| `create_page(name, content)` | Create a new page | Allowed if creation site is not under a `none`-scope | — |
| `delete_page(name)` | Delete a page | Requires `read-write` | Rejected if page modified since last read |

The tool surface is intentionally narrow. Cross-space queries via Lua, SilverBullet-rendered agent surfaces, and approval workflows are deferred to Growth.

#### `edit_page` — Unified Edit Tool

`edit_page` accepts an array of typed edit operations applied atomically against the page snapshot at the agent's last read.

**Edit operation types (MVP):**

```typescript
type Edit =
  | { type: "replace_all", content: string }
  | { type: "search_and_replace", search: string, replace: string, occurrence?: number | "all" }
  | { type: "replace_lines", from_line: number, to_line: number, content: string }
  | { type: "insert_at_line", line: number, content: string, position?: "before" | "after" }
```

- `replace_all` — full body replace. Last-resort.
- `search_and_replace` — verbatim string match. Default: error if multiple matches. `occurrence: <1-indexed int>` selects which match. `occurrence: "all"` replaces every occurrence.
- `replace_lines` — replace lines `from_line..to_line` (1-indexed, inclusive) with `content`.
- `insert_at_line` — insert `content` `before` (default) or `after` `line` (1-indexed).

**Architectural rationale for a unified tool over separate tools per edit type:**

1. **Atomicity** — a batch succeeds or fails together. The agent cannot leave a page in a partially-edited state.
2. **Single freshness check against a snapshot** — all positional arguments resolve against the page state at the agent's `lastReadAt`, not progressive state. The whole batch is one transactional unit.
3. **Conflict detection server-side** — two edits whose target regions overlap are rejected as a batch rather than mutating the page partway through.
4. **Audit clarity** — one logical "the agent edited this page" event with the structured edit list, instead of a fragmented sequence of tool calls.

`append_to_page`, `create_page`, and `delete_page` remain separate tools because they have distinct permission semantics (append-only mode, page lifecycle) that don't fit cleanly inside an edit-batch.

**Batch validation rules:**

- Every edit's positional arguments resolve against the snapshot at `lastReadAt` (so line numbers and search strings refer to original content, not progressively-mutated content).
- Two edits whose target regions overlap → batch rejected with a "conflicting edits" error identifying the conflict.
- Any single edit's preconditions failing (search string not found, line out of range, multiple matches without `occurrence`) → batch rejected with the failing edit identified.
- All edits applied atomically or none applied.

#### `replace_under_heading` — Deferred to Growth

A markdown-aware operation that replaces the body under a given heading until the next same-or-higher-level heading. Recognized as a high-value primitive for PKM agents but deferred to Growth because it requires markdown-AST parsing and section-boundary handling that the search-based and line-based primitives cover for MVP.

### Transport

**stdio only in MVP.** Claude Desktop and Claude Code both run MCP servers as child processes over stdio, which is the only transport the MVP needs to support. HTTP/SSE is deferred to Growth so that the MVP does not carry the operational and security overhead of running an internet-facing surface.

Implication: in MVP the MCP server cannot be used from agent runtimes that require a remote MCP endpoint (e.g., agents hosted on the public Claude API web surface). That is an explicitly-accepted constraint for the MVP audience (local agent runtimes).

### Authentication

**Bearer token only.** The MCP server authenticates to SilverBullet via the `Authorization: Bearer <token>` header on every HTTP call.

- The user is expected to configure `SB_AUTH_TOKEN` on their SilverBullet instance and pass the same value via `SILVERBULLET_TOKEN` env var to the MCP server.
- HTTP basic auth is *not* supported in MVP.
- Documentation must include the SilverBullet-side configuration step ("how to set `SB_AUTH_TOKEN`") because this is the most likely point of first-time-setup failure.

### State & Session Model

The freshness invariant is enforced using **in-memory state, scoped to a single MCP server process lifetime.**

- The server maintains a per-page record: `lastReadAt: timestamp` for each page the agent has read in the current process.
- Each `read_page` call updates that timestamp.
- Each `edit_page` or `delete_page` call compares the page's current SilverBullet `lastModified` against the in-memory `lastReadAt`; a non-append edit is rejected if `lastModified > lastReadAt` (or if no read has occurred in this session).
- When the MCP server process exits — e.g., when the agent runtime restarts, the user opens a new chat session that spawns a fresh process, or the host machine reboots — all read state is discarded. The next session must re-read before editing.

This is deliberately conservative:

- **No persistent state means no state-sync bugs** between server runs and SilverBullet.
- **Every new session starts with empty read history**, which means the first edit in any session is always preceded by a read — this is the correct default for an agent that has no reliable memory of prior sessions anyway.
- The trade-off: a long-running session that has read many pages will lose that read history if the process restarts, requiring re-reads on next attempt. Acceptable for MVP; a persistent option may be added in Growth.

### Code Examples (to ship in documentation)

The MVP documentation must include working examples of:

- Adding the server to Claude Code via the `claude mcp add-json` command above.
- Configuring `SB_AUTH_TOKEN` on SilverBullet and passing it through.
- Declaring a page's permission mode (mechanism settled at architecture time — frontmatter field, config page, or both).
- An end-to-end transcript of an agent reading a page, attempting an edit on stale state, getting rejected, re-reading, and succeeding.
- An end-to-end transcript showing an agent issuing a multi-edit batch (e.g., `search_and_replace` + `insert_at_line`) and the audit-log entry it produces.
- A starter template for a new SilverBullet space showing common permission patterns (work pages = `read-write`, archive = `read-only`, daily log = `append-only`, personal = `none`).

### Implementation Considerations

- **MCP SDK usage:** the `@modelcontextprotocol/sdk` Node package handles the protocol; the project's own code is the SilverBullet adapter, the permission engine, the freshness check, and the edit-batch validator.
- **SilverBullet client:** the project should depend on a maintained TypeScript HTTP client for SilverBullet if one exists in the community; otherwise, a minimal in-tree client targeting only the endpoints the tool surface needs.
- **Permission engine isolation:** the permission engine must be testable independently of the SilverBullet HTTP layer (i.e., given a page name and declared mode, decide allow/deny without making network calls). The edit-batch validator must be testable independently of both — given a page snapshot and an edit list, decide allow/deny and produce the resulting content without making network calls. This makes the contract auditable and the test suite fast.
- **Logging:** the audit log writes to stderr by default (since stdio reserves stdout for MCP protocol traffic) and optionally to a file via configuration.
- **Process discipline:** the server must shut down cleanly on stdio close. Stale Node processes from poorly-handled exits are a known annoyance with stdio-based MCP servers.

## Functional Requirements

### Connection & Configuration

- **FR1:** User can configure the MCP server with a SilverBullet endpoint URL and a bearer token via environment variables.
- **FR2:** User can launch the MCP server as a subprocess invoked by an MCP-capable agent runtime over an MCP-compatible transport.
- **FR3:** User can verify a successful end-to-end connection to SilverBullet through the agent runtime's first successful tool call.

### Permission Declaration

- **FR4:** User can declare a permission mode for any page or path scope, choosing one of: `none`, `read-only`, `append-only`, or `read-write`.
- **FR5:** User can author and update permission declarations from within SilverBullet itself, using a mechanism that is discoverable without leaving the SilverBullet UI.
- **FR6:** User can rely on default-deny behavior — any page without an explicit permission declaration is treated as inaccessible to the agent.
- **FR7:** User can update permission declarations and have changes take effect on the next agent operation without restarting the MCP server.

### Page Discovery

- **FR8:** Agent can list pages in the SilverBullet space, with `none`-mode pages filtered out of results server-side before the response is returned.
- **FR9:** Agent can search the space by query, with `none`-mode pages filtered out of results server-side before the response is returned.
- **FR10:** Agent receives no metadata, names, excerpts, or other identifying content for `none`-mode pages through any common-path interface (listing, search, or indexed result).

### Page Reading

- **FR11:** Agent can read the full content of any page that is not `none`-mode and that the page's permission declaration permits to be read.
- **FR12:** Each successful page read updates the agent session's last-read timestamp for that page.
- **FR13:** Agent receives a `not found` (or equivalent absence) response when attempting to directly fetch a `none`-mode page — the page is invisible, not advertised-but-blocked.

### Page Append

- **FR14:** Agent can append content to a page declared `append-only` or `read-write`.
- **FR15:** Each append operation is atomic — it either succeeds wholly or has no effect on the page.
- **FR16:** Append operations are not subject to the freshness invariant. The agent does not need to have read the page first.

### Page Edit (Batch)

- **FR17:** Agent can submit a batch of edit operations against a `read-write` page in a single tool call.
- **FR18:** A batch can contain any combination of supported edit operation types: `replace_all`, `search_and_replace`, `replace_lines`, `insert_at_line`.
- **FR19:** A `search_and_replace` operation requires a unique match by default; the agent must specify `occurrence` (a 1-indexed integer) when multiple matches exist, or specify `"all"` to replace every occurrence.
- **FR20:** A batch is rejected as a whole if the target page has been modified since the agent's last read of it (read-before-edit invariant).
- **FR21:** A batch is rejected as a whole if any individual operation's preconditions fail — including: search string not found, line range out of bounds, multiple matches without an `occurrence`, or two operations whose target regions overlap.
- **FR22:** All positional arguments in a batch (line numbers, search strings) resolve against the page snapshot at the agent's last read, not against progressively-mutated state during batch processing.
- **FR23:** A batch is applied atomically — either every operation in the batch is applied, or none of them are.

### Page Lifecycle

- **FR24:** Agent can create a new page provided the creation site is not under a `none`-scope.
- **FR25:** Agent can delete a page declared `read-write`, subject to the freshness invariant — the deletion is rejected if the page has been modified since the agent's last read.

### Error Responses

- **FR26:** Every rejected operation returns a structured, actionable error to the agent — including the reason category (permission, freshness, validation), enough information to identify which operation failed (in the case of a batch), and guidance the agent can use to recover (e.g., re-read the page and retry).

### Audit & Observability

- **FR27:** User can review a log of every agent operation, including: timestamp, tool name, arguments, decision (allowed or rejected), reason for rejection where applicable, and the response returned to the agent.
- **FR28:** User can review the audit log without the MCP server running and without depending on any in-memory state.

## Non-Functional Requirements

### Performance

- **NFR1:** Read operations (`list_pages`, `read_page`, `search_pages`) return at p95 ≤ 500ms when the SilverBullet instance is reachable over local network.
- **NFR2:** Write operations (`append_to_page`, `edit_page`, `create_page`, `delete_page`) return at p95 ≤ 1s under the same conditions.
- **NFR3:** MCP server cold start (from `npx` invocation to ready-for-first-request) completes within 3s on a typical developer machine.
- **NFR4:** Server resident memory does not grow unboundedly during a session — last-read state and any per-session caches are bounded by the number of distinct pages the agent has touched.

### Security

- **NFR5:** The bearer token (`SILVERBULLET_TOKEN`) is never written to logs, never included in error messages or responses returned to the agent, and never echoed to stdout/stderr.
- **NFR6:** The audit log records the *names* of pages an agent attempted to access regardless of permission outcome, but does not record *content* from `none`-mode pages — including content that may have been retrieved from SilverBullet during permission evaluation but was filtered before the agent saw it.
- **NFR7:** The server requires the SilverBullet endpoint URL to use `https://` in any deployment except explicitly-configured local development (`localhost`/`127.0.0.1`).
- **NFR8:** No internal state — including last-read timestamps, cached snapshots, or partially-resolved permission decisions — is exposed via the MCP tool surface to the agent.

### Reliability

- **NFR9:** The server shuts down cleanly within 1s of stdio close, releasing all resources and leaving no orphaned child processes.
- **NFR10:** A transient SilverBullet error during a write operation results in either complete success or no observable change to the target page — never a partially-applied edit.
- **NFR11:** The permission engine fails closed: if a permission decision cannot be made conclusively (e.g., malformed declaration, missing metadata), the operation is rejected as if the page were `none`-mode rather than allowed.
- **NFR12:** A failure inside one tool invocation does not affect the server's ability to handle subsequent tool invocations in the same session.

### Compatibility

- **NFR13:** The server runs on Node.js ≥ 20.x (active LTS at time of v1) without requiring native compilation steps or platform-specific binaries.
- **NFR14:** The server tracks SilverBullet's currently-stable release line; compatibility breakage triggered by a new SilverBullet release is treated as a P0 issue and addressed before any feature work resumes.
- **NFR15:** The server uses the official `@modelcontextprotocol/sdk` for protocol handling; MCP protocol-level concerns are delegated to the SDK rather than implemented in-tree.

### Observability

- **NFR16:** The audit log uses a documented, versioned schema. Schema-breaking changes are signalled by a version-bump field in each entry and accompanied by a documented migration path.
- **NFR17:** Audit log writes are non-blocking on the tool-call path — a slow or unavailable log destination does not stall tool responses to the agent.
- **NFR18:** The audit log is human-readable when inspected directly (e.g., line-delimited JSON or similarly inspectable format), without requiring the MCP server to be running.

### Testability

- **NFR19:** The permission engine is implemented as a pure function: given a page name, declared mode, and operation type, it returns allow/deny without performing I/O. It is unit-testable with no SilverBullet instance and no network.
- **NFR20:** The edit-batch validator is implemented as a pure function: given a page snapshot and an edit list, it returns the resulting content (on success) or the failing operation and reason (on rejection), without performing I/O.
- **NFR21:** The test suite runs to completion without requiring a live SilverBullet instance, an MCP-capable agent runtime, or any network connectivity.
