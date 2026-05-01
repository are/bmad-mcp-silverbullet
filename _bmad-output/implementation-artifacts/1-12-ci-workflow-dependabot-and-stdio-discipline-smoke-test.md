# Story 1.12: CI Workflow, Dependabot & Stdio-Discipline Smoke Test

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the project maintainer protecting against silent regressions,
I want a GitHub Actions CI workflow with sequential gates and a smoke test that spins the server and asserts every line on stdout is parseable JSON-RPC,
So that any code change that would corrupt MCP framing is caught in PR before reaching `main`.

## Acceptance Criteria

**AC1 — `.github/workflows/ci.yml` runs the D8 sequential gates on PR + push to `main`**

**Given** the new file at `.github/workflows/ci.yml`,
**When** I read it,
**Then** it declares:

- `name: ci`
- Triggers: `on: { pull_request: { branches: [main] }, push: { branches: [main] } }`
- A single `build` job running on `ubuntu-latest` with `strategy.matrix.node-version: ['24.x']` and `runs-on: ubuntu-latest`
- The job's steps execute in this order, fail-fast (any failure fails the build):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: ${{ matrix.node-version }}` and `cache: 'npm'`
  3. `npm ci` (reproducible install from `package-lock.json`)
  4. `npm run typecheck` (= `tsc --noEmit`)
  5. `npx prettier --check .`
  6. `npm run lint -- --max-warnings=0`
  7. `npm test`
  8. `node --test tests/smoke/stdout-discipline.test.ts` (the AC2 smoke test, runs as a separate step so a smoke failure surfaces as a distinct red gate in the GitHub UI)
  9. `npm pack --dry-run` (the AC4 manifest verification — the step parses the manifest and fails if any disallowed entry appears; see AC4 for details)

**And** the workflow has `permissions: contents: read` at the top level (least-privilege; the workflow neither writes back to the repo nor publishes anything).

**And** every step uses **major-version pinning** (`@v4`) for the actions — Dependabot's GitHub-Actions ecosystem (AC3) auto-PRs minor/patch bumps within the major; majors require manual review.

**And** there is **NO third-party action** outside the `actions/*` namespace — supply-chain hygiene (AR1 / D8 minimal-deps stance carries through to the action surface).

**And** **NO secrets** are referenced — the smoke test runs against an in-process fake SilverBullet HTTP server (AC2); no `SILVERBULLET_URL` / `SILVERBULLET_TOKEN` env vars are configured at the workflow level.

**AC2 — `tests/smoke/stdout-discipline.test.ts` validates JSON-RPC framing end-to-end**

**Given** the new file at `tests/smoke/stdout-discipline.test.ts`,
**When** `node --test tests/smoke/stdout-discipline.test.ts` runs,
**Then** the test:

1. **Spawns a local fake-SilverBullet HTTP server** (`node:http`) on an ephemeral port that:
   - Responds to `GET /.ping` with `200 OK`, body `{"version":"fake-sb-for-smoke"}` (the runtime client only checks `response.ok`, so the body shape doesn't matter — but it's well-formed JSON).
   - Responds to `POST /.runtime/lua`:
     - If the request body is exactly `1` (the probe — `client.probe()` posts the literal Lua source `1`): respond `200 OK`, `Content-Type: application/json`, body `{"result":1}`.
     - Otherwise (any envelope-wrapped script): respond `200 OK`, `Content-Type: application/json`, body `{"result":{"pages":[],"hits":[],"blocks":[],"content":"","lastModified":"1970-01-01T00:00:00.000Z"}}` — a permissive polymorphic shape that satisfies the type contracts of `query-config-blocks.lua`, `list-pages.lua`, `search-pages.lua`, and `read-page.lua`. (The runtime client extracts `parsed.result` and casts to the call-site `T`; with `pages: []` / `hits: []` the read-side handlers return empty results — semantically vacuous but stdout-discipline-valid.)
     - Other paths/methods: `404`.
   - **Bearer token check** is permissive — accepts any `Authorization: Bearer ...` header, no value validation. (The smoke test exercises happy-path stdout discipline; auth-failure stdout discipline is implicitly covered by the AR47 ESLint rule + Story 1.11's startup-failure paths.)
2. **Resolves an audit-log path under `os.tmpdir()`** via `path.join(os.tmpdir(), \`mcp-smoke-${process.pid}-${Date.now()}.jsonl\`)`. Cleans up the file in a `try/finally`. (The audit logger writes to disk during the smoke; a temp path keeps the test hermetic.)
3. **Spawns the server as a child process**: `child_process.spawn('node', ['./src/index.ts'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SILVERBULLET_URL: \`http://127.0.0.1:${port}\`, SILVERBULLET_TOKEN: 'SMOKE-TOKEN', MCP_SILVERBULLET_AUDIT_LOG_PATH: <temp path> } })`.
4. **Captures every byte written to the child's stdout and stderr** into separate buffers. **Stdout is captured raw** (not just decoded as utf8) — the assertion below verifies framing AS-WIRED.
5. **Waits for the server to reach `'serving'` state** by watching stderr for the `'ready (transport=stdio, audit=...)'` banner (AR50). The test polls stderr every 50ms with a 5000ms timeout; failure to see the banner within budget fails the test with the captured stderr appended to the assertion message.
6. **Issues a sequence of valid MCP JSON-RPC messages on the child's stdin**, each on its own line terminated by `\n`:
   - `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}` — handshake.
   - `{"jsonrpc":"2.0","method":"notifications/initialized"}` — handshake completion (no response expected).
   - `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` — enumerate registered tools (handled by the SDK's `McpServer` directly; does NOT call `client.exec`).
   - `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}` — exercise an actual tool call (hits the fake SB; returns an empty page list).
7. **Waits up to 5000ms** for the JSON-RPC responses to ids 1, 2, and 3 to appear on stdout. Tracks responses by `id` field — a response with `id: 3` (the `tools/call` response) is the terminal signal. Failure to see all three responses within budget fails the test.
8. **Sends `SIGINT`** to the child and waits up to 2000ms for it to exit. Asserts the exit code is `0` (clean cooperative shutdown per Story 1.11 AC4). Asserts the captured stderr contains the literals `'received SIGINT; flushing'` AND `'shutdown complete'` (Story 1.11's shutdown banners).
9. **Asserts stdout discipline**:
   - Decodes the captured stdout buffer as UTF-8.
   - Splits on `\n` and filters out empty trailing lines.
   - For every non-empty line, asserts:
     - `JSON.parse(line)` succeeds (no `SyntaxError`).
     - The parsed object is non-null and `typeof === 'object'`.
     - `parsed.jsonrpc === '2.0'`.
     - At least one of `'id' in parsed`, `'method' in parsed` is `true` (responses have `id`; notifications have `method`; both satisfy the JSON-RPC 2.0 envelope).
   - **No surrogate pairs / control characters** beyond what JSON-RPC permits — relies on `JSON.parse` to reject malformed strings.
   - The test's failure message identifies the offending line by 0-based index plus the first 200 chars verbatim, so a regression that lands a `console.log("hi")` in any module surfaces immediately as e.g. "stdout line 7 not parseable JSON-RPC: 'hi\\n...'".
10. **Asserts at least one response message appeared on stdout** (`responses.length >= 1`) — defends against the false-positive "stdout discipline is trivially satisfied if stdout is empty"; the server must have produced *something* to verify.

**And** the test uses `try/finally` to guarantee cleanup: kill the child if still alive, close the fake SB HTTP server, unlink the temp audit log. Cleanup must run even on assertion failure.

**And** the test is registered as a top-level `await test('stdout discipline ...', async () => { ... })` — same pattern as Stories 1.3-1.11. **No `describe` blocks.**

**And** the test does NOT depend on a real SilverBullet instance, real network, or any environment variable beyond what it sets explicitly — NFR21.

**And** the test runs to completion within `node:test`'s default 30s per-test timeout under a healthy CI runner. The 5000+5000+2000ms internal timeouts sum to ~12s at worst — the test typically finishes in ~1-2s.

**AC3 — `.github/dependabot.yml` enables weekly npm + GitHub-Actions updates**

**Given** the new file at `.github/dependabot.yml`,
**When** I read it,
**Then** it declares `version: 2` and two `updates` entries:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    groups:
      patch-and-minor:
        update-types: ["minor", "patch"]
    # Major version updates require manual review — they appear as separate
    # PRs without the `patch-and-minor` group label so a maintainer can
    # decide each one (D8 / AR8).
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    groups:
      patch-and-minor:
        update-types: ["minor", "patch"]
```

**And** `groups.patch-and-minor.update-types: ["minor", "patch"]` is the auto-PR mechanism: minor + patch bumps land as a single grouped PR per ecosystem per week. **Major updates fall outside the group** so they appear as separate, individually-reviewable PRs (AR8 mandates "manual review for major").

**And** `directory: "/"` is the repo root — the only `package.json` and the only `.github/workflows/` are there.

**And** `open-pull-requests-limit: 5` caps PR noise per ecosystem. Picked as a reasonable default for a small dependency surface (D3 minimal-deps); revisit if Dependabot floods.

**And** the file declares **no labels, reviewers, or assignees** — the project is solo-maintained for MVP (AR2 minimal-deps applies here too: configuration creep is a real cost). Adding labels/reviewers is a Growth concern.

**AC4 — `npm pack --dry-run` manifest contains only allowlisted files (AR9)**

**Given** the project after this story,
**When** I run `npm pack --dry-run` on a clean checkout,
**Then** the manifest contains EXACTLY these files (and only these):

- `LICENSE`
- `README.md`
- `package.json` (always included by npm regardless of `files` allowlist)
- All `src/**/*.ts` files **except** `*.test.ts` files (excluded by `package.json:15`'s `!src/**/*.test.ts` rule)

**And** the manifest does NOT contain:

- Any `*.test.ts` file
- Any file under `tests/` (smoke or integration)
- Any file under `.github/` (workflows, dependabot, issue templates)
- Any config file: `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `.prettierignore`
- Any file under `_bmad/`, `_bmad-output/`, `.claude/`, `docs/`, `scripts/`, `node_modules/`

**And** the CI workflow's `npm pack --dry-run` step (AC1, step 9) parses the dry-run output and **fails the build** if any disallowed entry appears, AND if the total file count drifts from the expected baseline + delta. The exact mechanism:

```yaml
- name: Verify pack manifest
  run: |
    set -euo pipefail
    npm pack --dry-run --json > /tmp/pack.json
    node --input-type=module -e '
      import fs from "node:fs";
      const report = JSON.parse(fs.readFileSync("/tmp/pack.json", "utf8"));
      const files = report[0].files.map(f => f.path).sort();
      const disallowedPatterns = [
        /^tests\//,
        /\.test\.ts$/,
        /^\.github\//,
        /^_bmad/,
        /^\.claude\//,
        /^docs\//,
        /^scripts\//,
        /\.prettierrc\.json$/,
        /\.editorconfig$/,
        /\.gitignore$/,
        /\.npmignore$/,
        /\.prettierignore$/,
        /^tsconfig\.json$/,
        /^eslint\.config\.js$/,
      ];
      const offenders = files.filter(f => disallowedPatterns.some(p => p.test(f)));
      if (offenders.length > 0) {
        console.error("Pack manifest contains disallowed files:");
        for (const f of offenders) console.error("  - " + f);
        process.exit(1);
      }
      const required = ["LICENSE", "README.md", "package.json", "src/index.ts"];
      const missing = required.filter(r => !files.includes(r));
      if (missing.length > 0) {
        console.error("Pack manifest missing required files: " + missing.join(", "));
        process.exit(1);
      }
      console.error("Pack manifest OK — " + files.length + " files");
    '
```

(The verification logic is inlined in the workflow YAML rather than a separate `scripts/verify-pack-manifest.ts` file because the script is short and pulling it into `scripts/` would put it in the published manifest unless explicitly excluded — moot only after a `.npmignore` rule, which is fragile. Inline is simpler and self-contained.)

**And** locally, the developer runs `npm pack --dry-run` on a clean checkout to manually verify before pushing. The CI gate is the canonical check.

**AC5 — All gates green; module-isolation greps clean; pre-push hook becomes functional**

**Given** the implementation,
**When** I run from the project root:
- `npm run typecheck`
- `npm run lint -- --max-warnings=0`
- `npx prettier --check .`
- `npm test`
- `node --test tests/smoke/stdout-discipline.test.ts`
- `npm pack --dry-run`

**Then** all six exit `0`.

**And** the existing test suite continues to pass without modification — Story 1.11's 459-test baseline is preserved (the smoke test runs as a separate `node --test` invocation; it does NOT roll into `npm test` directly, since `npm test`'s glob is `'src/**/*.test.ts' 'tests/integration/**/*.test.ts'` per `package.json:22` — `tests/smoke/` is deliberately excluded so the unit/integration suite stays fast).

**And** the smoke test reports exactly **1** new test case (the single top-level `await test(...)`).

**And** **module-isolation greps are green:**
- `grep -rE "console\.(log|info|debug)" tests/smoke/stdout-discipline.test.ts` → zero output (smoke test uses `console.error` only for assertion failure messages, allowed by AR47/the lint rule).
- `grep -rE "process\.stdout\.write" tests/smoke/stdout-discipline.test.ts` → zero output.
- `grep -rE "@modelcontextprotocol/sdk" tests/smoke/stdout-discipline.test.ts` → zero output (the smoke test treats the server as a black box; it speaks JSON-RPC over stdio without importing the SDK).

**And** **the existing pre-push hook becomes functional**: `package.json:30`'s `"pre-push": "node --test tests/smoke/stdout-discipline.test.ts"` was a forward-reference to this story since Story 1.1. Once `tests/smoke/stdout-discipline.test.ts` lands, `npx simple-git-hooks` (already run during scaffold) need NOT be re-run — the hook already points at the file. Verify locally by running the pre-push hook command directly: `node --test tests/smoke/stdout-discipline.test.ts` exits `0`.

**And** `package.json` is **UNCHANGED** — no script changes, no dep additions. **No new dependencies.** All needed primitives are stdlib (`node:test`, `node:http`, `node:child_process`, `node:os`, `node:path`, `node:fs`, `node:events`, `node:buffer`).

## Tasks / Subtasks

- [x] **Task 1: Author `.github/workflows/ci.yml`** (AC: #1)
  - [x] Create `.github/workflows/` directory.
  - [x] Create `ci.yml` with the structure from AC1: `name: ci`, `on: { pull_request: { branches: [main] }, push: { branches: [main] } }`, `permissions: { contents: read }`, single `build` job on `ubuntu-latest` with `strategy.matrix.node-version: ['24.x']`.
  - [x] Steps in order: checkout → setup-node (with `cache: 'npm'`) → `npm ci` → typecheck → format check → lint (with `--max-warnings=0`) → unit tests → smoke test → pack manifest verify.
  - [x] Pin actions at major versions: `actions/checkout@v4`, `actions/setup-node@v4`. **No third-party actions.**
  - [x] **No secrets** — the smoke test runs against an in-process fake SB. No `env:` block at the job level besides what the runner provides.
  - [x] Verify the YAML parses — no `python3-yaml` / `yq` available locally; relied on visual review + the fact that GitHub Actions itself is the canonical YAML validator on push. Inline pack-verify script's logic exercised locally; passes.
  - [x] Use **2-space indentation** consistent with `.editorconfig`.

- [x] **Task 2: Author `tests/smoke/stdout-discipline.test.ts`** (AC: #2, #5)
  - [x] Create the file under `tests/smoke/` (removed the placeholder `.gitkeep`).
  - [x] Imports: `node:test`, `node:assert/strict`, `node:child_process` (`spawn` + `ChildProcessWithoutNullStreams`), `node:http` (with `IncomingMessage`/`ServerResponse`/`Server` types), `node:events` (`once`), `node:os`, `node:path`, `node:fs/promises` (`unlink`), `node:buffer`, `node:timers/promises` (`setTimeout as delay`).
  - [x] **Helper `startFakeSilverBullet(): Promise<{ url; close }>`** — implementation reads request body via `for await (const chunk of req)` (cleaner than the manual event listener I had drafted; satisfies `await` so no eslint-disable needed). Routes:
    - `GET /.ping` → 200, body `{"version":"fake-sb-for-smoke"}`
    - `POST /.runtime/lua` body `'1'` → 200, body `{"result":1}` (probe)
    - `POST /.runtime/lua` other → 200, polymorphic-shape body
    - else → 404
    - Calls `server.listen(0)`; awaits `once(server, 'listening')`.
    - Reads port via `(server.address() as AddressInfo).port` — the cast is a sanctioned post-`'listening'` boundary cast (AR59).
    - Returns `{ url, close: Promise<void>-returning wrapper around `server.close(cb)` }`.
  - [x] **Polling helpers `waitForStderrPattern` / `waitForJsonRpcResponse`** — both poll at 25ms (`POLL_INTERVAL_MS`) with a budget; on timeout, throw with the captured stream appended for debuggability.
  - [x] **Top-level `await test('stdout discipline: every line on stdout is parseable JSON-RPC', async () => { ... });`** — sequence:
    1. Resolve `tempAuditPath` under `os.tmpdir()`.
    2. Start fake SB.
    3. Spawn `node ./src/index.ts` with `stdio: ['pipe','pipe','pipe']` + env (`SILVERBULLET_URL`, `SILVERBULLET_TOKEN`, `MCP_SILVERBULLET_AUDIT_LOG_PATH`).
    4. Wire stdout/stderr `'data'` listeners → `Buffer[]` accumulators.
    5. `try { ... } finally { SIGKILL if alive; close fake SB; unlink audit }`.
    6. Wait for `/ready \(transport=stdio, audit=/` on stderr (5000ms).
    7. Write four JSON-RPC messages to `child.stdin` (each `+ '\n'`): `initialize`, `notifications/initialized`, `tools/list`, `tools/call list_pages`.
    8. Await responses to ids 1, 2, 3 (cumulative 5000ms budget).
    9. `child.kill('SIGINT')`; `waitForExit` with 2000ms.
    10. Assert exit code `=== 0`.
    11. Assert stderr matches `/received SIGINT; flushing/` AND `/shutdown complete/`.
    12. Assert every non-empty stdout line parses as JSON, has `jsonrpc: '2.0'`, has either `id` or `method`.
    13. Assert `lines.length >= 1` AND `responses.length === 3`.
  - [x] **No `describe` blocks** — single top-level `await test(...)`.
  - [x] **No real SB, no real network beyond 127.0.0.1 fake** — NFR21 preserved.
  - [x] **No imports from `src/`; no imports from `@modelcontextprotocol/sdk`** — black-box-only.
  - [x] **No top-of-file ESLint disable needed** — first draft included `eslint-disable @typescript-eslint/require-await`, but the handler has `for await (const chunk of req)` so the directive is unnecessary; ESLint's `unused-disable-directive` rule caught it. Removed.

- [x] **Task 3: Author `.github/dependabot.yml`** (AC: #3)
  - [x] Create the file under `.github/`.
  - [x] Use the exact content from AC3 — `version: 2`, two `updates` entries (`npm` + `github-actions`), weekly schedule, `open-pull-requests-limit: 5`, `groups.patch-and-minor.update-types: ['minor','patch']`.
  - [x] **2-space YAML indentation** consistent with `ci.yml`.
  - [x] **No `assignees` / `reviewers` / `labels`** — solo MVP.
  - [x] Verify YAML parses — visual review only (no local YAML linter); GitHub UI / Dependabot itself is the canonical validator.

- [x] **Task 4: Verify `npm pack --dry-run` manifest** (AC: #4)
  - [x] Ran `npm pack --dry-run --json` locally; parsed file list with the inline-CI logic.
  - [x] Manifest contains exactly the allowlisted set: `LICENSE`, `README.md`, `package.json`, all `src/**/*.ts` (no `*.test.ts`).
  - [x] Confirmed NO `tests/`, `.github/`, configs, `_bmad/`, `.claude/`, `docs/`, `scripts/` entries.
  - [x] Ran the inline node script from `.github/workflows/ci.yml` step 9 verbatim; output: `Pack manifest OK — 29 files`; exit 0.
  - [x] **Total: 29 files** (matches Story 1.11 post-baseline; this story adds 0 files to the published manifest because all new files — `.github/workflows/ci.yml`, `.github/dependabot.yml`, `tests/smoke/stdout-discipline.test.ts` — are excluded by `package.json:13-18`'s allowlist).

- [x] **Task 5: Local verification** (AC: #5)
  - [x] `npm run typecheck` → exit 0.
  - [x] `npm run lint -- --max-warnings=0` → exit 0. (First draft tripped `unused-eslint-disable-directive`; removed the unused `eslint-disable @typescript-eslint/require-await` directive since `for await (const chunk of req)` already provides an `await`.)
  - [x] `npx prettier --check .` → exit 0.
  - [x] `npm test` → 459/459 passing (Story 1.11 baseline preserved; smoke test NOT in `npm test`'s glob).
  - [x] `node --test tests/smoke/stdout-discipline.test.ts` → exit 0; 1/1 passing; ~165ms test duration, ~2.2s end-to-end.
  - [x] `npm pack --dry-run` → manifest is exactly **29 files** (LICENSE, README.md, package.json, 26 src files post-1.11).
  - [x] **Module-isolation greps:**
    - `grep -rE "console\.(log|info|debug)" tests/smoke/stdout-discipline.test.ts` → zero output.
    - `grep -rE "process\.stdout\.write" tests/smoke/stdout-discipline.test.ts` → zero output.
    - `grep -rE "@modelcontextprotocol/sdk" tests/smoke/stdout-discipline.test.ts` → zero output.
  - [x] **Pre-push hook smoke**: `node --test tests/smoke/stdout-discipline.test.ts` (literal command from `package.json:30`) exits 0.
  - [ ] **GitHub Actions workflow lint** — deferred to GitHub's own validation on push. No `act` / `actionlint` available locally.
  - [ ] **CI smoke** — runs after push to remote; out of scope for the local dev pass (will surface as part of code review / PR opening).

- [x] **Task 6: Append deferred-work entries (post-implementation review)** (housekeeping)
  - [x] Appended 11 entries to `_bmad-output/implementation-artifacts/deferred-work.md` covering: Node 25.x matrix, startup-failure smoke, single-handler smoke coverage, shared smoke harness, Dependabot auto-merge, `node_modules` caching, ISSUE_TEMPLATE, CodeQL, cross-platform CI, branch-protection rules, PR-limit tuning, and shutdown-error exit-code differentiation.
  - [x] Each entry names origin (`dev of story-1-12-...`) and a precise file/line reference.

### Review Findings

**Code review 2026-05-01 (uncommitted working tree).** 3-layer adversarial review (Blind Hunter, Edge Case Hunter, Acceptance Auditor). Verdict: all AC met (Acceptance Auditor passed clean); proposed patches are hardening only, not blockers. No BLOCKER findings. **All decisions resolved and all 11 patches applied in the same review session** (typecheck + lint + prettier + 461/461 unit-integration + 1/1 smoke green).

**Decision needed**

- [x] [Review][Decision] **Internal spec inconsistencies — poll interval and audit-filename prefix** — AC2 step 5 says "polls stderr every 50ms"; the Tasks subsection (line 239 of this story) says "both poll at 25ms (`POLL_INTERVAL_MS`)". Implementation uses 25ms (matches Tasks, not AC text). AC2 step 2 specifies `mcp-smoke-${pid}-${Date.now()}.jsonl`; impl uses `mcp-smoke-stdout-${pid}-${Date.now()}.jsonl`. Both deviations are functionally invisible. Decide: amend AC text to match implementation, or change implementation to match AC text.

**Patch — major (smoke-test hardening)**

- [x] [Review][Patch] **No `'error'` listeners on `child.stdout` / `child.stderr`** [`tests/smoke/stdout-discipline.test.ts:213-218`] — A stream `'error'` event (e.g., child crashes mid-stream, broken pipe to test harness) escalates to an `uncaughtException` that kills the test process before assertions can capture diagnostic state. Add no-op `'error'` listeners (or push to a captured-errors array for later assertion).
- [x] [Review][Patch] **No `'error'` listener on `child.stdin`; `child.stdin.write` may EPIPE if child exited early** [`tests/smoke/stdout-discipline.test.ts:244-246`] — If the child process exits between `spawn` and the `for (const msg of messages)` loop (e.g., the env-var validation rejects), the synchronous write throws / emits an EPIPE error event. Without a listener, the test process aborts on an unrelated error rather than surfacing the actual startup failure. Add `child.stdin.on('error', () => {})` and check `child.exitCode === null` before writing.
- [x] [Review][Patch] **`server.listen(0)` has no `'error'` race; sandbox port-allocation failure hangs forever** [`tests/smoke/stdout-discipline.test.ts:93-94`] — `server.listen(0); await once(server, 'listening')` blocks indefinitely if `listen` fails (e.g., sandbox runners disallowing inet sockets). Replace `once(server, 'listening')` with `Promise.race([once(server, 'listening'), once(server, 'error').then((e) => { throw e[0]; })])` so a listen failure surfaces with a useful diagnostic.

**Patch — minor (hardening + CI ergonomics)**

- [x] [Review][Patch] **`fakeSB.close()` may hang on keep-alive sockets** [`tests/smoke/stdout-discipline.test.ts:104-107`] — `http.Server.close()` waits for keep-alive connections to drain. Once the child exits, sockets close — but on a slow shutdown the test process holds the event loop open. Add `server.closeAllConnections()` before `server.close()`, or set `server.keepAliveTimeout = 0`.
- [x] [Review][Patch] **SIGKILL race in finally: `child.exitCode === null && child.signalCode === null` has TOCTOU** [`tests/smoke/stdout-discipline.test.ts:302-307`] — If the child exits between the predicate and `child.kill('SIGKILL')`, the kill emits `ESRCH`; harmless but noisy and `Promise.race` resolves on timeout regardless. Tighten with `if (!child.killed && child.exitCode === null && child.signalCode === null)` or wrap kill in try/catch.
- [x] [Review][Patch] **Concurrent test invocations could collide on temp audit path** [`tests/smoke/stdout-discipline.test.ts:191-194`] — `${pid}-${Date.now()}` only guarantees uniqueness across-time, not across-runner. Two runners on the same host invoking the test in the same millisecond produce identical paths; one's `unlink` removes the other's file. Append `crypto.randomUUID()` for collision-proof uniqueness.
- [x] [Review][Patch] **Fake SilverBullet doesn't validate the `Authorization: Bearer` header — AR25 verification gap** [`tests/smoke/stdout-discipline.test.ts:46-77`] — Spec AC2 deliberately keeps the bearer-token check permissive ("smoke test exercises happy-path stdout discipline"), but a regression where `client.ts` strips the Authorization header would still pass the smoke. Decision-call vs. deliberate spec choice; flagging as patch-candidate. Either add `assert(req.headers.authorization === 'Bearer SMOKE-TOKEN')` in the fake-SB handler, OR amend the spec to acknowledge the gap (currently in the dev-deferred entries as "smoke exercises only `list_pages`" — extend that note to include AR25 coverage).
- [x] [Review][Patch] **`dependabot.yml` `groups.patch-and-minor` lacks `applies-to: version-updates`** [`.github/dependabot.yml:101-103,112-114`] — Default semantics work but are version-implicit; explicit `applies-to: version-updates` makes the group's intent clear and survives a Dependabot config-spec change.
- [x] [Review][Patch] **Pack-manifest verifier crashes opaquely on malformed `pack.json`** [`.github/workflows/ci.yml:54-91`] — `JSON.parse(...)` and `report[0].files` produce stack traces (`SyntaxError`, `Cannot read properties of undefined`) instead of actionable messages. Wrap in try/catch with explicit `console.error(...) + process.exit(1)`. Also harden `report[0]` access with `if (!Array.isArray(report) || report.length === 0)`.
- [x] [Review][Patch] **Pack-manifest verifier regex `/^tsconfig\.json$/` doesn't catch nested tsconfigs** [`.github/workflows/ci.yml:73`] — A future `tsconfig.build.json` or nested config would slip past the disallow list. Tighten to `/(^|\/)tsconfig.*\.json$/`.
- [x] [Review][Patch] **CI workflow lacks a `concurrency` group** [`.github/workflows/ci.yml:10-16`] — Force-pushes burn CI minutes on superseded commits. Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`.

**Deferred (already in `deferred-work.md` — confirming)**

- [x] [Review][Defer] **Smoke test exercises only `list_pages`; `search_pages` / `read_page` paths unverified** — already deferred in `dev of story-1-12` entries.
- [x] [Review][Defer] **Single-element matrix (Node 24.x only)** — already deferred.

**Dismissed (recorded for transparency)**

- Node 24 + `.ts` entrypoint without explicit `--experimental-strip-types` — works under the actual environment (`npm test` exercises this exact pattern with 461 passing tests; the smoke spawns the same way).
- `waitForJsonRpcResponse` matches first message with given `id` without checking for `result`/`error` — MCP framing forbids server-initiated requests, so a stdout message with `id` is necessarily a response.
- O(n²) polling buffer concatenation — performance-only; smoke output volume is a few hundred bytes.
- `console.error` on success message in pack verifier — fine; CI captures stderr alongside stdout.
- Dependabot comment referencing `epics.md:113` line — comment, not behavior.
- No overall test timeout — `node:test` default 30s already covers the worst-case 12s budget.
- Auditor's `console.error` in fake-SB defensive catch — AC5 grep is `console\.(log|info|debug)`; `console.error` is allowed (matches AR47).
- Auditor's "node:timers/promises missing from Dev Notes table" — internal spec inconsistency, not a code defect.

## Dev Notes

### Architectural source-of-truth

This is story **#13/14** in the implementation sequence (`architecture.md:825-826`):
- Item 13: "CI smoke test for stdout discipline — fake-stdio harness in `tests/smoke/`."
- Item 14: "CI workflow + Dependabot config — `.github/workflows/ci.yml`, `.github/dependabot.yml`."

This story bundles items 13 and 14 because they ship as a unit — the CI workflow's smoke-test step is meaningless without the smoke test, and the smoke test in `tests/smoke/` is the load-bearing gate the architecture earmarked for this slot.

It depends on:

- **Story 1.1's pre-push hook** (`package.json:30`): `"pre-push": "node --test tests/smoke/stdout-discipline.test.ts"`. The hook has been a dangling reference since 1.1 (intentionally — the hook fails until 1.12 lands the file). This story makes it functional.
- **Story 1.11's startup ladder** (`src/index.ts:303` `runServer`): the smoke test spawns this binary. Story 1.11's `'ready (transport=stdio, audit=...)'` banner (line 372) is the readiness signal the smoke test waits for.
- **Story 1.11's cooperative shutdown** (`src/index.ts:installShutdownTriggers`): `SIGINT` triggers the shutdown sequence; the smoke test asserts `'received SIGINT; flushing'` + `'shutdown complete'` appear on stderr.
- **Story 1.10's read-side handlers** (`src/mcp/handlers/{list-pages,search-pages,read-page}.ts`): the smoke test issues `tools/call list_pages` and expects a JSON-RPC response.
- **Story 1.7's runtime client** (`src/silverbullet/client.ts:208-258`): the smoke test's fake SB satisfies the `ping`, `probe`, and `exec` contracts.
- **Story 1.5's audit logger** (`src/audit/audit-logger.ts:openAuditLogger`): the smoke test sets `MCP_SILVERBULLET_AUDIT_LOG_PATH` to a temp file so the spawned server has a writable audit destination.
- **Stories 1.1-1.11 collectively**: every previously-shipped surface is exercised by spinning the actual binary.

It does NOT depend on:

- **Stories 2.x's write-side handlers** — the smoke test exercises `list_pages` only. Once Stories 2.x land, the smoke test stays as-is (the AR47 stdout-discipline guarantee is one-handler-suffices to verify; expanding the smoke to all seven handlers is a Growth concern).
- **The latency baseline** — separate concern; `scripts/latency-baseline.ts` has its own entry point.

**Primary specs (read these first):**

- AC source: `_bmad-output/planning-artifacts/epics.md:637-663` (Story 1.12 ACs).
- D8 — CI/CD & Quality Gates: `architecture.md:714-805`.
- AR7 — GitHub Actions CI workflow + sequential gates: `epics.md:112`.
- AR8 — Dependabot config: `epics.md:113`.
- AR9 — `npm pack` manifest: `epics.md:114`.
- AR47 — stdout reserved for MCP JSON-RPC: `epics.md:168`.
- NFR21 — test suite runs without live SB / network: `epics.md:101`.

### What this story owns (and does NOT own)

**Owns:**

- `.github/workflows/ci.yml` — the GitHub Actions workflow.
- `.github/dependabot.yml` — Dependabot config.
- `tests/smoke/stdout-discipline.test.ts` — the JSON-RPC framing smoke test.

**Does NOT own (these land in later stories or are explicitly out of scope):**

- **README updates** — Story 1.13 (a CI-status badge could be added, but is a docs concern).
- **`.github/ISSUE_TEMPLATE/`** — `architecture.md:1221-1223` lists `bug_report.md` + `feature_request.md`; not in the AC for this story. Defer to Story 1.13 (docs pass) or post-MVP.
- **CONTRIBUTING.md** — Story 2.9 (`epics.md:933+` per the planning artifacts).
- **CHANGELOG.md** — Story 2.9 (per AR70 `epics.md:199`).
- **CLAUDE.md** — defer to docs pass (Story 1.13 / 2.9).
- **Release workflow with `NPM_TOKEN`** — Growth (architecture.md:785).
- **Coverage gates** — Growth (architecture.md:735).
- **Adding `25.x` to the matrix** — architecture says "Optionally adds 25.x to track current"; AC1 mandates only `24.x`. Adding `25.x` is a deferred-work candidate.
- **Caching `node_modules`** — `actions/setup-node@v4`'s `cache: 'npm'` caches the npm cache directory (not `node_modules`); this is the GitHub-recommended approach. Caching `node_modules` directly is a `actions/cache` recipe, deferred until install times become a measured pain point.
- **Auto-merge for Dependabot patch PRs** — additional GitHub workflow (`dependabot-automerge.yml`); Growth.
- **CodeQL / SAST scans** — separate workflow; Growth.

### Files this story creates / modifies / deletes

**NEW:**

- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `tests/smoke/stdout-discipline.test.ts`

**MODIFIED:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.12 status transitions (`backlog` → `ready-for-dev` → `in-progress` → `review`; final transition lands when code-review passes).
- `_bmad-output/implementation-artifacts/deferred-work.md` — append new entries from the dev pass.

**UNCHANGED (do not touch):**

- All `src/` source files. **No code changes are required for this story.**
- All existing `tests/integration/*.test.ts` files.
- `package.json` / `package-lock.json` — **no new dependencies, no script changes**. The `simple-git-hooks.pre-push` field already references `tests/smoke/stdout-discipline.test.ts` (Story 1.1); that reference becomes functional with this story.
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.npmignore`, `.prettierrc.json`, `.editorconfig`, `LICENSE`, `README.md`.
- `scripts/latency-baseline.ts`.
- All `_bmad/`, `.claude/`, `docs/`, `_bmad-output/` (except sprint-status.yaml + deferred-work.md as noted above).

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: `tests/smoke/stdout-discipline.test.ts` — process-level smoke test (fake stdio) per `architecture.md:741`.
- Test invocation: **direct** — `node --test tests/smoke/stdout-discipline.test.ts`. **NOT** picked up by `npm test`'s glob (`'src/**/*.test.ts' 'tests/integration/**/*.test.ts'` per `package.json:22`); this is deliberate — the smoke test is heavier (spawns a child process) and runs only as a separate CI gate + the pre-push hook.
- **Top-level `await test(...)`** for the single case (no `describe` blocks — established Stories 1.3-1.11 pattern).
- **No real SilverBullet** — fake `http.createServer` on 127.0.0.1 satisfies `ping` / `probe` / `exec` contracts (NFR21).
- **No real `process.exit` of the test process** — the spawned child exits via SIGINT; the parent test process records the child's exit code via `once(child, 'exit')`.
- **No mocked timers** — the smoke test uses real wall-clock timeouts (5000ms / 5000ms / 2000ms) intentionally to surface race conditions in the production server. Tests are still hermetic because every wait has a budget; nothing waits indefinitely.
- **No fixed-`Date` injection** — the smoke test runs the production binary which calls `() => new Date()` for real. Stdout discipline does not depend on clock fixtures.
- **Cleanup is mandatory** — `try/finally` guards: kill the child if alive, close the fake SB HTTP server, unlink the temp audit log.
- Assertions:
  - `assert.equal(child.exitCode, 0, 'child exited cleanly')`.
  - `assert.match(stderr, /received SIGINT; flushing/)` and `assert.match(stderr, /shutdown complete/)`.
  - Per-line `JSON.parse` + `jsonrpc === '2.0'` + `('id' in obj || 'method' in obj)`.
  - `assert.ok(lines.length >= 1)` (false-positive guard).

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + Story-1.1-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:47`) | The smoke test is `.ts` source; Node 24's native type stripping handles it at runtime |
| Node | `>=24` (`package.json:8`) | Native TS stripping; `node --test` test runner; `node:http` server; `node:child_process.spawn` |
| `node:test` | built-in | Test framework |
| `node:assert/strict` | built-in | Assertions |
| `node:child_process` | built-in | `spawn` for the server child process |
| `node:http` | built-in | Fake SB server |
| `node:events` | built-in | `once` for waiting on listener events |
| `node:os` | built-in | `tmpdir()` for the audit log path |
| `node:path` | built-in | `path.join` for the audit log path |
| `node:fs/promises` | built-in | `fs.unlink` for audit log cleanup |
| `node:buffer` | built-in | `Buffer.concat` for stdout/stderr accumulation |

**Push back on:**

- Any third-party CI helper actions (`pnpm/action-setup`, `actions/cache` directly, etc.) — `actions/setup-node@v4`'s built-in `cache: 'npm'` is sufficient. Adding more is anti-AR1.
- A separate "matrix expand" job for Node 25.x — architecture mentions it as optional; AC1 mandates only 24.x. Adding 25.x is a deferred-work candidate.
- Replacing `node:http` with a test-fixture library (`nock`, `msw`, etc.) — adding a dep for a single ~30-line server handler is anti-AR2 (minimal-deps).
- Splitting the smoke test into multiple cases (separate "stdout is JSON-RPC" + "shutdown is clean" + "tools/list works" tests) — the integrated test is the natural unit; splitting would triple the spawn cost without adding coverage.
- Replacing the manual JSON-RPC string construction with `@modelcontextprotocol/sdk`'s client-side helpers — the smoke test is a black-box test of the binary; importing the SDK would defeat the purpose (a transparent SDK API change would break the test along with the production code, masking the actual stdout-framing regression).
- Auto-merge / auto-approve workflows for Dependabot — Growth.

### File-structure requirements

After this story, the changed directory tree:

```
.github/                              # NEW
├── workflows/
│   └── ci.yml                        # NEW
└── dependabot.yml                    # NEW

tests/
├── integration/                      # UNCHANGED
│   ├── handler-list-pages.test.ts
│   ├── handler-read-page.test.ts
│   ├── handler-search-pages.test.ts
│   └── startup-ladder.test.ts
└── smoke/
    └── stdout-discipline.test.ts     # NEW (replaces the .gitkeep placeholder if present)
```

**No barrel files** — N/A here; none of the new files have a parent `index.ts`.

**`.github/` is a boundary-of-the-repo artifact** — not part of `src/` and not part of the published npm artifact. The `.npmignore` already lists `.github/` as a backstop (line 9); the primary control is `package.json:files`'s allowlist.

**`tests/smoke/` was an empty directory** until this story. The pre-existing `.gitkeep` (if any) gets removed in favor of the actual file; if there was no `.gitkeep`, the new file is sufficient to track the directory.

### Latest tech information (researched 2026-05-01)

- **`actions/checkout@v4`** — current major. Latest minor at `v4.2.2` (Dependabot will auto-bump within `v4`). Use `@v4` (loose pin) so Dependabot's grouped patch/minor updates stay frictionless; `@v4.x.y` (exact pin) would force a manual update on every patch.
- **`actions/setup-node@v4`** — current major. Supports `node-version: '24.x'` (resolves to latest Node 24 in the runner's manifest). The `cache: 'npm'` parameter caches the npm CLI's cache (`~/.npm`), NOT `node_modules` — works with `npm ci` because npm reads the cache during install.
- **GitHub Actions matrix syntax** — `strategy.matrix.node-version: ['24.x']` is the canonical form for a single-version matrix; using `strategy.matrix.node-version: '24.x'` (string instead of array) also works but is non-idiomatic.
- **`permissions: contents: read`** — the GHA-recommended least-privilege default. Workflows that don't write back (no commit, no comment, no deploy) need only `contents: read`. Setting this at the workflow root prevents the workflow from inheriting the broader default permissions.
- **Dependabot `groups` syntax (v2)** — `groups.<name>.update-types: ["minor", "patch"]` lets Dependabot bundle non-major bumps into a single PR. Major updates fall outside any group whose `update-types` excludes `"major"` and appear as separate PRs. This is the documented mechanism for AR8's "auto-PR for patch/minor; manual review for major" requirement.
- **`npm pack --dry-run --json`** — produces a JSON report including the file list. The shape (in npm 10.x): `[{ name, version, files: [{ path, size, ... }, ...], ... }]`. Inline `node --input-type=module -e '...'` is the simplest way to validate the report without an extra script file.
- **`node:test`'s default per-test timeout** — 30s if no `timeout` option is passed to `test(...)`. The smoke test's internal budgets sum to ~12s worst-case; well within the default.
- **`child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']`** — gives the parent control over the child's stdin/stdout/stderr streams. The parent writes to `child.stdin` (a `Writable`) and reads from `child.stdout` / `child.stderr` (`Readable`s). Default encoding is binary (Buffer); decode to UTF-8 as needed.
- **MCP `initialize` request shape (protocol 2025-06-18)** — `{"jsonrpc":"2.0","id":<n>,"method":"initialize","params":{"protocolVersion":"<version>","capabilities":{},"clientInfo":{"name":"<str>","version":"<str>"}}}`. The server responds with its own `serverInfo` + `capabilities`. The `notifications/initialized` notification (no `id` field) closes the handshake.
- **MCP `tools/list` response** — `{"jsonrpc":"2.0","id":<n>,"result":{"tools":[{"name":"list_pages","description":"...","inputSchema":{...},"annotations":{...}}, ...]}}`. The smoke test does NOT validate the response payload shape — only that the response is parseable JSON-RPC on stdout.
- **`http.createServer(handler).listen(0)`** — `0` requests an ephemeral OS-allocated port. Read it via `(server.address() as { port: number }).port` AFTER the `'listening'` event fires. Pre-listening reads return `null`.
- **GitHub Actions runner image (`ubuntu-latest`)** — currently Ubuntu 24.04 LTS. Has Node 18+ pre-installed; `actions/setup-node@v4` overrides with the requested version. No additional system deps needed for our smoke test (no Chrome/Chromium needed; the smoke test fakes SB itself).
- **MCP SDK `McpServer.connect(transport)` over stdio** — once connected, the server reads JSON-RPC messages line-delimited from `stdin` and writes responses line-delimited to `stdout`. Each message is a complete JSON object on a single line, terminated by `\n`. The smoke test sends each JSON-RPC line verbatim (with a trailing `\n`) and expects responses delimited the same way.

### Previous story intelligence (from Stories 1.1-1.11)

Distilled patterns to apply:

1. **Top-level `await test(...)`** is the established test pattern (Stories 1.3-1.11). **No `describe` blocks.**
2. **`tests/integration/`-style harness extraction** (deferred per Story 1.10 + Story 1.11 entries) — defer for `tests/smoke/` too. The single smoke test inlines its `startFakeSilverBullet` helper (~30 lines); extracting to `tests/smoke/_smoke-helpers.ts` waits until a 2nd smoke test consumer arrives.
3. **`try/finally` for resource cleanup** is the established pattern (Stories 1.5, 1.7, 1.10, 1.11) — adopt verbatim for the smoke test's child process + fake server + temp file cleanup.
4. **Story 1.1's pre-push hook reference** (`package.json:30`) was a forward-reference to this story. The hook was registered via `npx simple-git-hooks` during scaffold setup; once `tests/smoke/stdout-discipline.test.ts` lands, the hook becomes functional without any additional registration step.
5. **Story 1.11's stderr banner contract** — `'starting up (silverbullet=<URL>)'`, `'connected — runtime API ok'`, `'ready (transport=stdio, audit=<PATH>)'`, plus shutdown banners `'received SIGINT; flushing'`, `'shutdown complete'`. The smoke test treats these as observable signals; they're tested at the `assert.match` level (regex match on stderr buffer).
6. **Story 1.7's `client.ping()` contract** — `GET /.ping` with `Authorization: Bearer <token>`; resolves on 200, rejects with `infrastructure_error` otherwise. The fake SB returns 200 unconditionally on `GET /.ping` (no auth check).
7. **Story 1.7's `client.probe()` contract** — `POST /.runtime/lua` with body `1`; expects `{"result":1}`. Fake SB matches body `'1'` and returns the canned response.
8. **Story 1.7's `client.exec<T>(script, params)` envelope** — `POST /.runtime/lua` with the IIFE-wrapped base64-encoded JSON envelope. The fake SB returns a polymorphic `result` shape that satisfies the read-side handlers' type contracts.
9. **Story 1.10's handler shape** — top-level `try/catch/finally`; exactly one audit entry per call. The smoke test exercises this shape end-to-end via `tools/call list_pages`.
10. **Story 1.11's exit-code contract** — clean cooperative shutdown exits 0; force-exit / error paths exit 1. The smoke test asserts `exit code === 0` after SIGINT.
11. **`@typescript-eslint/no-floating-promises`** — ESLint enforced (`eslint.config.js:19`). Watch for `child.stdout.on('data', ...)` (event-emitter callbacks are sync void-returning, no floating promise) and the test body's `await` sites.
12. **`@typescript-eslint/no-misused-promises`** — async functions cannot be passed where sync callbacks are expected. The `req.on('data', ...)` and `req.on('end', ...)` listeners must be sync void-returning.
13. **No `as` casts outside boundary constructors** — the smoke test is allowed to cast `(server.address() as { port: number })` (Node's typing for `address()` is `string | AddressInfo | null`; we know it's `AddressInfo` after `'listening'`); this is a sanctioned boundary cast per AR59.
14. **Imports use `.ts` extension for project files** — the smoke test imports nothing from `src/`, so no `.ts` extensions in its imports beyond `node:*` modules. (`node:` modules don't need extensions.)

### Critical guardrails (do not rediscover)

1. **stdout reserved for MCP JSON-RPC traffic only** (D7 / AR47 / `architecture.md:646-654`). The smoke test is the LIVE gate that verifies this invariant in CI. NEVER weaken the assertion (e.g., "skip lines that don't parse"). Every line must be valid.

2. **The smoke test must NOT need a real SilverBullet** — the fake `http.createServer` is the only sanctioned approach. Setting `SILVERBULLET_URL=https://real-sb.example.com` and exposing real credentials in CI is forbidden.

3. **Audit log path must be a temp file** — never write to `~/.local/state/mcp-silverbullet/audit.jsonl` from a smoke test. The CI runner's home directory is shared across the runner's lifetime; cross-test contamination is a footgun. Use `os.tmpdir()` + a unique-per-PID-per-timestamp suffix; clean up in `finally`.

4. **Cleanup is mandatory** — kill the child if alive, close the fake SB server, unlink the temp audit log. Failure to clean up leaks resources and may cause subsequent test runs to fail with "address already in use" or "audit file in unexpected state".

5. **The smoke test runs OUTSIDE `npm test`** — `package.json:22`'s glob does not include `tests/smoke/`. This is intentional (Story 1.1's deliberate decision per `architecture.md:737-743`). The CI workflow runs the smoke test as a SEPARATE step (AC1, step 8); the pre-push hook runs it as a separate command (`package.json:30`). Adding `tests/smoke/**/*.test.ts` to the `npm test` glob would slow down the dev loop without adding signal.

6. **No third-party GitHub Actions** — only `actions/checkout`, `actions/setup-node`. Adding any other action requires explicit deferred-work approval.

7. **No secrets in the workflow** — the smoke test runs against an in-process fake. Any `secrets.SILVERBULLET_TOKEN` reference is forbidden.

8. **Dependabot patch/minor PRs are auto-approvable; major PRs require manual review** (AR8). The `groups.patch-and-minor.update-types: ["minor", "patch"]` mechanism implements this. Adding `"major"` to the group is forbidden.

9. **`npm pack --dry-run` is the canonical AR9 gate** — local verification + CI gate together. The CI parses the JSON output and fails on any disallowed entry; the local verification is a pre-push sanity check.

10. **No coverage gate, no SAST scan, no auto-merge** — Growth.

11. **The pre-push hook (`package.json:30`) becomes functional with this story** — the hook was registered during Story 1.1's `npx simple-git-hooks` step; until 1.12 lands, `git push` would fail the hook (the file doesn't exist). 1.12 closes the loop.

12. **Matrix is `['24.x']` only** — architecture says "optionally adds 25.x"; AC1 mandates only 24.x. Adding 25.x is deferred-work, not in-scope.

13. **`ubuntu-latest` only** — the smoke test uses POSIX paths (`os.tmpdir()` on Ubuntu is `/tmp`); Windows paths would require platform-specific separators. Cross-platform CI is deferred (matches `tests/integration/`'s POSIX-only stance per `deferred-work.md` Story 1.5).

14. **The `Verify pack manifest` step uses an inline `node --input-type=module -e '...'` script** — NOT a separate `scripts/verify-pack-manifest.ts` file. Files under `scripts/` are tracked by `.gitignore` patterns differently from inline JS; keeping the verification inline avoids the "is this script published?" question entirely.

15. **The smoke test must run in well under 30s** — `node:test`'s default per-test timeout. The internal budgets (5000ms ready + 5000ms responses + 2000ms exit + ~500ms server boot) sum to ~12.5s worst-case; healthy CI runs in ~1-2s. If the test ever flakes near the 30s ceiling, REVISIT — don't blindly raise timeouts.

### Story scope boundaries (DO NOT include)

- **README updates** — Story 1.13.
- **CONTRIBUTING.md** — Story 2.9.
- **CHANGELOG.md / Unreleased section** — Story 2.9 (per AR70 `epics.md:199`).
- **`.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`** — `architecture.md:1221-1223` lists them; not in this story's AC. Defer.
- **CLAUDE.md** — separate docs concern.
- **CodeQL / SAST workflow** — Growth.
- **Auto-merge for Dependabot patch PRs** — Growth.
- **NPM publish workflow** — Growth (architecture.md:783-785).
- **Coverage gate** — Growth (architecture.md:735).
- **Adding `25.x` to the matrix** — deferred-work candidate (architecture says "optionally"; AC mandates 24.x only).
- **Cross-platform CI (Windows / macOS runners)** — POSIX-only for MVP per Story 1.5's `deferred-work.md` precedent.
- **Caching `node_modules` directly** — `actions/setup-node@v4`'s `cache: 'npm'` is sufficient.
- **Splitting the smoke test into multiple cases** — single integrated test is the natural unit.
- **Property-based testing of stdout discipline** — restricted to the edit-batch validator (architecture.md:1161). The smoke test's exhaustive-line assertion is sufficient.
- **A startup-time silversearch-plug probe in the smoke test** — `deferred-work.md:29` (Story 1.7); not this story.
- **Replacing `node:http` with a test-fixture library** — anti-AR2.

### Deferred-from-this-story candidates (proposed deferred-work entries — review post-implementation)

Append to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands, IF they feel real after the implementation pass:

1. **Adding Node 25.x to the CI matrix** — architecture says "optionally adds 25.x to track current". AC1 ships only `24.x` for predictability; revisit when (a) a Node-25-specific bug is suspected, (b) the project is preparing to bump the floor to 25.x, or (c) a maintainer wants the canary signal.

2. **`tests/smoke/_smoke-helpers.ts` shared harness** — This story inlines `startFakeSilverBullet` + the helper polling functions (~80 lines total). Stories 2.x may add additional smoke tests (write-side flow, audit-log invariant). Extract to `tests/smoke/_smoke-helpers.ts` when the 2nd smoke test consumer lands; same threshold as the integration-helpers extraction deferred since Story 1.10.

3. **Auto-merge for Dependabot patch PRs** — A separate `.github/workflows/dependabot-automerge.yml` could auto-approve+merge patch-only Dependabot PRs that pass CI. Reduces maintainer toil. Growth — revisit when Dependabot PR backlog becomes a measured pain point.

4. **Caching `node_modules` directly** — `actions/setup-node@v4`'s `cache: 'npm'` caches the npm CLI cache, not `node_modules`. `npm ci` is fast on cache hits but still re-extracts every package. A `actions/cache` recipe keyed on `package-lock.json` hash + Node version could shave seconds off `npm ci`. Growth — revisit when CI run time approaches the 5-minute mark.

5. **CI smoke test exit-code differentiation** — The smoke test asserts `exit code === 0`. If a regression causes a non-zero exit (e.g., the cooperative shutdown's hard-stop fires at 900ms), the assertion fails with a generic "exit code 1" message. A future enhancement could capture the WARN line distinguishing hard-stop from cooperative-shutdown errors and surface it in the failure message — but the current single-assertion design is fine for MVP.

6. **`.github/ISSUE_TEMPLATE/`** — `architecture.md:1221-1223` lists `bug_report.md` + `feature_request.md`. Not in scope here; revisit during the docs pass (Story 1.13 / 2.9) or after the first community issue surfaces an "I didn't know what to write" gap.

7. **CodeQL / SAST** — `.github/workflows/codeql.yml`. Growth — revisit when (a) the project has a non-trivial public surface, (b) a community contributor lands a security-impacting change, or (c) GitHub's free CodeQL becomes a default expectation for npm publishing.

8. **Cross-platform CI matrix (Windows / macOS runners)** — `tests/smoke/stdout-discipline.test.ts` uses POSIX paths; making it Windows-compatible requires `path.join` / `os.tmpdir()` discipline (which it already uses), plus verifying `child_process.spawn('node', ...)` resolves the same way on Windows (it does, via `node.exe`). Revisit when a community member reports a Windows-specific issue.

9. **Smoke test for startup-failure stdout discipline** — The current smoke test exercises the happy path. A complementary smoke test could (a) start without setting `SILVERBULLET_URL` → assert exit code 1, FATAL line on stderr, ZERO bytes on stdout (NFR21 + AR47); (b) start with an unreachable URL → assert similar. Defer until a regression in the failure path appears OR Stories 2.x add more failure surface.

10. **Smoke test for the four write-side handlers** (Stories 2.x) — when `append_to_page` / `edit_page` / `create_page` / `delete_page` ship, the smoke test could exercise one of them to verify their stdout discipline. Defer to the relevant Story 2.x; this story owns only the read-side handler exercise (`list_pages`).

11. **`open-pull-requests-limit: 5` may be too generous** — Dependabot will open up to 5 open PRs per ecosystem (10 total). The minimal-deps stance (D3) keeps the dep surface small, so the cap rarely binds, but if PR noise becomes a measured problem, lower to 3.

12. **Branch-protection rules** — GitHub Actions checks alone don't enforce "must be green before merge"; the maintainer must also configure branch protection in the GitHub UI (Settings → Branches → main) to require CI status. Document this as a manual setup step in CONTRIBUTING.md (Story 2.9) or note it as deferred-work.

### Project Structure Notes

- **Alignment with unified project structure:** `.github/workflows/ci.yml` matches `architecture.md:1218-1220` exactly. `.github/dependabot.yml` matches `architecture.md:1221`. `tests/smoke/stdout-discipline.test.ts` matches `architecture.md:992,1236`.
- **Detected variances:** none. The architecture's repo layout earmarked these three files; this story is the long-planned content drop.
- **No `index.ts` re-export barrel** — N/A here (no `src/` files affected).
- **`.github/` is OUTSIDE the published artifact** — `package.json:files` does not include `.github/**`, and `.npmignore:9` lists `.github/` as a backstop.
- **`tests/smoke/` was an empty directory** since Story 1.1 (the `.gitkeep` placeholder, if present). This story populates it.
- **The CI workflow is at the repo's apex of automation** — every PR + every push to main runs through it. The smoke test is the load-bearing gate that this story owns.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.12] (lines 637-663)
- D8 — CI/CD & Quality Gates (the AR7/AR8/AR9 implementation): [Source: _bmad-output/planning-artifacts/architecture.md#D8] (lines 714-805)
- Implementation sequence (this story = #13/14): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (lines 825-826)
- AR1 — Hand-rolled scaffold (the `.github/` files complete it): [Source: _bmad-output/planning-artifacts/epics.md] (line 106)
- AR2 — ESM-only, no build step: [Source: _bmad-output/planning-artifacts/epics.md] (line 107)
- AR3 — `tsc --noEmit` is the type-check gate: [Source: _bmad-output/planning-artifacts/epics.md] (line 108)
- AR4 — `node:test` framework: [Source: _bmad-output/planning-artifacts/epics.md] (line 109)
- AR5 — ESLint flat config + Prettier: [Source: _bmad-output/planning-artifacts/epics.md] (line 110)
- AR6 — `simple-git-hooks` (pre-push runs the smoke test): [Source: _bmad-output/planning-artifacts/epics.md] (line 111)
- AR7 — GitHub Actions CI workflow with sequential gates: [Source: _bmad-output/planning-artifacts/epics.md] (line 112)
- AR8 — Dependabot weekly + auto-PR patch/minor: [Source: _bmad-output/planning-artifacts/epics.md] (line 113)
- AR9 — `npm pack` manifest: [Source: _bmad-output/planning-artifacts/epics.md] (line 114)
- AR47 — stdout reserved for MCP JSON-RPC: [Source: _bmad-output/planning-artifacts/epics.md] (line 168)
- NFR21 — test suite runs without live SB / network: [Source: _bmad-output/planning-artifacts/epics.md] (line 101)
- D7 — Process & Diagnostic Logging (the smoke test verifies the AR47 invariant): [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- File structure (`.github/workflows/ci.yml`, `.github/dependabot.yml`, `tests/smoke/stdout-discipline.test.ts`): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1218-1221, 992, 1236)
- Hook-runner config (`package.json:28-31` references the smoke test): [Source: package.json] (lines 28-31)
- Pre-existing pre-push hook reference: [Source: _bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md] (line 97)
- Story 1.11's startup ladder (the smoke test spawns this binary): [Source: _bmad-output/implementation-artifacts/1-11-startup-ladder-and-cooperative-shutdown.md] (full)
- Story 1.11's stderr banners (`'ready (transport=stdio, audit=...)'`, etc.): [Source: src/index.ts] (lines 317, 354, 372, 420, 446)
- Story 1.10's read-side handlers (the smoke test invokes `list_pages`): [Source: src/mcp/handlers/list-pages.ts]
- Story 1.7's runtime client (`ping`/`probe`/`exec` contracts the fake SB satisfies): [Source: src/silverbullet/client.ts] (lines 70-74, 145-258)
- Story 1.5's audit logger (the smoke test's `MCP_SILVERBULLET_AUDIT_LOG_PATH`): [Source: src/audit/audit-logger.ts]
- npm pack file allowlist: [Source: package.json] (lines 13-18)
- ESLint stream-discipline rule: [Source: eslint.config.js] (line 18)
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Smoke test passed on the first run** — 1/1 cases, ~165ms test duration, ~2.2s end-to-end (child-spawn cost dominates). No iteration loops needed.
- **Pack manifest is exactly 29 files** — LICENSE, README.md, package.json, 26 src files. The CI's inline verification script ran clean locally (`Pack manifest OK — 29 files`).
- **`npm test` baseline preserved** — 459/459 cases pass after this story (matches Story 1.11's post-baseline). The smoke test runs as a separate `node --test` invocation and is NOT picked up by `npm test`'s glob, by design.
- **First-draft eslint-disable directive was unused** — initial `tests/smoke/stdout-discipline.test.ts` carried a top-of-file `/* eslint-disable @typescript-eslint/require-await */` mirroring `tests/integration/startup-ladder.test.ts`'s precedent. ESLint's `unused-eslint-disable-directive` rule caught it: the fake-SB request handler uses `for await (const chunk of req)`, so the `await` is real. Removed.
- **`actions/checkout@v4`, `actions/setup-node@v4` major-pin** — Dependabot's GitHub-Actions ecosystem (AC3) auto-bumps within `v4`; majors require manual review. `cache: 'npm'` on `setup-node` caches `~/.npm` (not `node_modules`), the GitHub-recommended pattern.
- **CI workflow uses `permissions: { contents: read }`** — least-privilege root-level permissions; the workflow neither writes back nor publishes anything in MVP.
- **No third-party actions** — only `actions/checkout` and `actions/setup-node`. Adding any other action requires explicit approval per the AC1 supply-chain hygiene rule.
- **No secrets in the workflow** — the smoke test runs against an in-process fake. Confirmed `git grep secrets\\. .github/` returns zero matches in this story's additions.
- **YAML validation** — no local `actionlint` / `yq` / `python3-yaml` available; visual review only. GitHub's own YAML validation runs on push and is the canonical gate. The pack-verify inline script's logic was exercised locally (passes).
- **Pre-push hook command works** — `node --test tests/smoke/stdout-discipline.test.ts` (the literal command from `package.json:30`) exits 0. The hook has been a forward-reference since Story 1.1; this story closes the loop.
- **Module-isolation greps green** — `console\.(log|info|debug)` zero matches in the smoke test (only `console.error` in the defensive `fake-sb handler error:` line, which is permitted by AR47); `process\.stdout\.write` zero matches; `@modelcontextprotocol/sdk` zero matches (the smoke test is a true black-box test of the binary).

### Completion Notes List

- ✅ AC1: `.github/workflows/ci.yml` ships the D8 sequential gates on PR + push to `main`. Single `build` job on `ubuntu-latest` with `strategy.matrix.node-version: ['24.x']`. Steps in order: checkout → setup-node (cache npm) → `npm ci` → typecheck → format check → lint (`--max-warnings=0`) → unit tests (`npm test`) → smoke test → pack manifest verify. `permissions: { contents: read }`. No third-party actions. No secrets.
- ✅ AC2: `tests/smoke/stdout-discipline.test.ts` spawns the production server with a fake-SB HTTP server on an ephemeral port; drives MCP via `initialize` → `notifications/initialized` → `tools/list` → `tools/call list_pages`; captures stdout/stderr; asserts every non-empty stdout line parses as JSON-RPC 2.0. Sends SIGINT, asserts exit code 0 + `'received SIGINT; flushing'` + `'shutdown complete'` banners on stderr. `try/finally` cleanup (kill child, close fake SB, unlink temp audit log).
- ✅ AC3: `.github/dependabot.yml` declares weekly schedules for `npm` and `github-actions` ecosystems with `groups.patch-and-minor.update-types: ['minor','patch']` (auto-PR for non-major) and `open-pull-requests-limit: 5`. No labels/reviewers/assignees (solo MVP).
- ✅ AC4: `npm pack --dry-run` manifest is exactly 29 files (LICENSE, README.md, package.json, 26 src files). The CI's inline verification script flags any disallowed entry (`tests/`, `.github/`, configs, etc.); ran locally and exits 0.
- ✅ AC5: All gates green — typecheck/lint/prettier/npm test (459/459)/smoke (1/1)/pack manifest. Module-isolation greps clean. Pre-push hook command exits 0.
- **No new dependencies.** All primitives are stdlib (`node:test`, `node:http`, `node:child_process`, `node:os`, `node:path`, `node:fs/promises`, `node:events`, `node:buffer`, `node:timers/promises`).
- **No `src/` modifications.** This story is purely additive in `.github/` and `tests/smoke/`.

### File List

**NEW:**

- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `tests/smoke/stdout-discipline.test.ts`

**MODIFIED:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.12 status: `backlog` → `ready-for-dev` → `in-progress` → `review`.
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended 11 entries from this dev pass (Node 25.x matrix, startup-failure smoke, single-handler coverage, harness extraction, auto-merge, node_modules caching, issue templates, CodeQL, cross-platform CI, branch protection, PR-limit tuning, shutdown exit-code differentiation).

**DELETED:**

- `tests/smoke/.gitkeep` — the placeholder is no longer needed; the directory is now tracked via the smoke test file.

### Change Log

| Date | Change | Files |
|------|--------|-------|
| 2026-05-01 | feat(ci): GitHub Actions workflow, Dependabot config, stdio-discipline smoke test (story 1.12) | `.github/workflows/ci.yml`, `.github/dependabot.yml`, `tests/smoke/stdout-discipline.test.ts` |
