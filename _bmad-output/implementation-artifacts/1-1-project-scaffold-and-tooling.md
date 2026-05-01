# Story 1.1: Project Scaffold & Tooling

Status: done

## Story

As the project maintainer,
I want a hand-rolled project scaffold with linting, formatting, type-checking, test, and pre-commit gates configured,
so that all subsequent implementation lands on consistent, CI-ready tooling from day one.

## Acceptance Criteria

**AC1 — Root config files exist with correct shape**

**Given** the empty repo,
**When** I check the project root,
**Then** `package.json` exists declaring `engines.node >= 24`, `"type": "module"`, `bin: { "mcp-silverbullet": "./src/index.ts" }`, `files: ["src/**/*.ts", "README.md", "LICENSE"]`, and `simple-git-hooks` + `lint-staged` config inline,
**And** `tsconfig.json` exists with `strict`, `noEmit`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `allowImportingTsExtensions`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` set,
**And** `eslint.config.js` (flat config), `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE` exist.

**AC2 — `src/` and `tests/` skeleton trees exist**

**Given** the `src/` tree,
**When** I list its directories,
**Then** subfolders exist for each architectural seam: `config/`, `diagnostic/`, `audit/`, `domain/`, `permissions/`, `edits/`, `freshness/`, `silverbullet/`, `silverbullet/scripts/`, `mcp/`, `mcp/handlers/`,
**And** `src/index.ts` exists as a minimal stub (shebang + `void 0` placeholder body) so the `bin` entry resolves and `npm run dev` runs without error,
**And** `tests/integration/` and `tests/smoke/` exist as skeleton folders (use `.gitkeep` placeholders to track empty dirs).

**AC3 — ESLint stream-discipline rules active**

**Given** any TypeScript file in the repo,
**When** I add `console.log(...)` or `console.info(...)`,
**Then** ESLint flags it as an error,
**And** only `console.error` and `console.warn` are permitted (`no-console: ["error", { allow: ["error", "warn"] }]`),
**And** `no-floating-promises` and `no-misused-promises` rules are active,
**And** `@typescript-eslint/no-explicit-any` is active (errors on `any`).

**AC4 — Hooks register and all npm scripts run clean**

**Given** a fresh clone,
**When** I run `npm install` then `npx simple-git-hooks`,
**Then** the pre-commit hook is registered (`lint-staged && npm run typecheck && npm test`) and the pre-push hook is registered (stdout-discipline smoke test command — file may not exist until Story 1.12; hook is registered regardless),
**And** `npm run typecheck`, `npm run lint`, `npm run format`, `npm test`, `npm run dev` all run without error against the empty `src/` tree.

**AC5 — README "Development Setup" enforces no-postinstall posture**

**Given** the README "Development Setup" section,
**When** a contributor follows it,
**Then** the first command after clone is `npx simple-git-hooks` (no `postinstall` script — supply-chain hygiene per AR6).

## Tasks / Subtasks

- [x] **Task 1: Lock dependency versions and write `package.json`** (AC: #1, #4)
  - [x] Resolved versions (latest stable on 2026-04-30):
    - `@modelcontextprotocol/sdk` `^1.29.0` (v2 still pre-alpha — locked to 1.x)
    - `zod` `^4.4.1`
    - `typescript` `^6.0.3` (≥ 5.8 required for `erasableSyntaxOnly`; 6.x is current)
    - `@types/node` `^25.6.0`
    - `eslint` `^10.2.1`, `@eslint/js` `^10.0.1`, `typescript-eslint` `^8.59.1`, `prettier` `^3.8.3`, `simple-git-hooks` `^2.13.1`, `lint-staged` `^16.4.0`
  - [x] `package.json` written per architecture skeleton: `name`, `version: "0.1.0"`, `type: "module"`, `engines.node: ">=24"`, `bin`, `files`, scripts, inline `simple-git-hooks` + `lint-staged` blocks
  - [x] `npm install` succeeded — 203 packages, 0 vulnerabilities, `package-lock.json` produced
  - [x] **No `postinstall` script** — confirmed via `grep '"postinstall"' package.json` (zero matches)

- [x] **Task 2: Write `tsconfig.json`** (AC: #1)
  - [x] Wrote `tsconfig.json` with all architecture flags + `erasableSyntaxOnly: true` and `verbatimModuleSyntax: true` (Node 24 type-stripping subset compliance)
  - [x] Added `types: ["node"]` to make `node:test` resolve under TS 6 + NodeNext (without it, TS 6 didn't auto-pick up `@types/node` for test runner imports)
  - [x] `npx tsc --noEmit` exits 0

- [x] **Task 3: Write `eslint.config.js` (flat config)** (AC: #3)
  - [x] Composed with `@eslint/js` recommended + `tseslint.configs.recommendedTypeChecked` via `tseslint.config()` helper
  - [x] Configured `projectService: true` for type-aware linting
  - [x] Active rules: `no-console: ["error", { allow: ["error", "warn"] }]`, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/no-explicit-any`
  - [x] Disabled type-checked rules on `eslint.config.js` itself (it's a JS file — type-checked rules don't apply)
  - [x] Smoke-tested AC3: `console.log` in a temporary `src/__lint_smoke.ts` triggered `no-console` error — verbatim message "Only these console methods are allowed: error, warn"
  - [x] Ignores: `node_modules`, `_bmad-output`, `_bmad`, `.claude`, `docs`

- [x] **Task 4: Write supporting root files** (AC: #1)
  - [x] `.prettierrc.json` — `printWidth: 100`, single quotes, semis, trailing commas `all`, 2-space, LF line endings
  - [x] `.editorconfig` — UTF-8, LF, 2-space, trim trailing ws, final newline (markdown excepted from trim)
  - [x] `.gitignore` — `node_modules/`, `.env`, `.env.*`, `audit.jsonl`, logs, OS junk, editor dirs
  - [x] `.npmignore` — backstop list (primary control is `files` allowlist in `package.json`)
  - [x] `.prettierignore` — added so `prettier --write .` doesn't touch BMad install (`_bmad/`, `.claude/`, `docs/`)
  - [x] `LICENSE` — MIT, copyright "Artur Wojciechowski 2026" (per user direction)

- [x] **Task 5: Create `src/` and `tests/` skeleton tree** (AC: #2)
  - [x] Created seam directories: `src/config`, `src/diagnostic`, `src/audit`, `src/domain`, `src/permissions`, `src/edits`, `src/freshness`, `src/silverbullet/scripts`, `src/mcp/handlers`
  - [x] `.gitkeep` placeholders in each (parents `src/silverbullet/` and `src/mcp/` tracked transitively via their `scripts/`/`handlers/` children)
  - [x] `src/index.ts` minimal stub — shebang `#!/usr/bin/env node`, body `void 0;`, two comment lines pointing to Story 1.11 for real wiring
  - [x] `tests/integration/.gitkeep`, `tests/smoke/.gitkeep`
  - [x] Added `tests/integration/scaffold.test.ts` placeholder per user direction (empty body, marked for removal when Story 1.2 lands real integration tests). Uses top-level `await test(...)` to satisfy `no-floating-promises`

- [x] **Task 6: Configure git hooks (no `postinstall`)** (AC: #4, #5)
  - [x] `simple-git-hooks` block inlined in `package.json` exactly per architecture snippet
  - [x] **No `postinstall` script** — verified
  - [x] `npx simple-git-hooks` ran clean: `[INFO] Successfully set the pre-commit ... pre-push ... all git hooks`
  - [x] `cat .git/hooks/pre-commit` shows `npx lint-staged && npm run typecheck && npm test`
  - [x] `cat .git/hooks/pre-push` shows `node --test tests/smoke/stdout-discipline.test.ts` (will fail until Story 1.12 lands the smoke test — intentional gate)

- [x] **Task 7: Write README skeleton with Development Setup section** (AC: #5)
  - [x] `README.md` written with sections: status banner (pre-release), Requirements, Install (placeholder pointing to 1.13), Configuration (placeholder), Development Setup, Available scripts table, pre-commit/pre-push gates, License
  - [x] Development Setup lists `git clone` → `npm install` → `npx simple-git-hooks` (called out as the first command after clone, with explicit no-`postinstall` rationale)
  - [x] Includes "Never use `--no-verify`" rule per AR6 / D8

- [x] **Task 8: Local verification** (AC: #4)
  - [x] `npm install` — clean, 0 vulnerabilities
  - [x] `npx simple-git-hooks` — hooks registered
  - [x] `npx tsc --noEmit` — exits 0, zero TS errors
  - [x] `npx eslint .` — exits 0, zero rule violations
  - [x] `npx prettier --check .` — "All matched files use Prettier code style!"
  - [x] `npm test` — 1 placeholder test passes, 0 fail
  - [x] `node ./src/index.ts` — exits 0 (Node strips types natively under Node 25.6)
  - [x] `node --watch ./src/index.ts` (= `npm run dev`) starts and waits for file changes
  - [x] `npm pack --dry-run` — manifest contains exactly: `LICENSE`, `README.md`, `package.json`, `src/index.ts`. No tests, no configs, no `_bmad/`. Total 4 files, 2.7KB.

## Dev Notes

### Architectural source-of-truth

This is the **first implementation story** per the architecture's implementation sequence (`architecture.md:813`). It is foundational — every subsequent story depends on this scaffold being correct.

The complete repository layout is at `architecture.md:1199-1298`. The skeleton config snippets are at `architecture.md:1399-1465`. The CI/CD + hooks decisions are D8 (`architecture.md:714-806`).

### Critical guardrails (read these — don't rediscover)

1. **No build step. No `dist/`.** TypeScript source IS the published artifact. Node 24 strips types natively at load time. `tsc --noEmit` is a CI gate ONLY (per AR2, AR3, `architecture.md:120-126`).

2. **`erasableSyntaxOnly: true` in tsconfig is mandatory.** Without it, the dev agent could write `enum Foo {}` or `namespace X` or constructor parameter-properties — all of which crash at runtime under Node 24 type stripping. The flag makes `tsc` reject those constructs at type-check time, which is the only place we'd catch them. (This flag was not explicitly in the architecture snippet but is required by Node 24's type-stripping subset per [Node 24 TypeScript docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html).)

3. **No `postinstall` script.** Supply-chain hygiene per AR6, D8 (`architecture.md:771`). Hook activation is `npx simple-git-hooks`, run explicitly by the contributor after `npm install`. This is the rule the README's Development Setup section enforces (AC5).

4. **`bin` entry points at `./src/index.ts`** with shebang `#!/usr/bin/env node`. Node 24 type-strips the file at load time — no compile step. The minimal stub for this story is enough; real wiring lands in Story 1.11 (Startup Ladder).

5. **Stream discipline starts here.** ESLint's `no-console` rule (allow `error`/`warn` only) is the static enforcement of D7 (`architecture.md:644-650`). The dev agent must NOT add `console.log` calls anywhere — including in the `index.ts` stub. Use `void 0;` or no body.

6. **Acyclic dependency rule** (`architecture.md:1337`): the pure-domain core never imports from boundary modules. Not enforced by this story but the directory structure ENABLES it. Don't combine seams.

7. **No `index.ts` re-export barrels** anywhere except the entry point `src/index.ts` (`architecture.md:999`). Don't pre-emptively create `src/permissions/index.ts` etc.

8. **No `utils/` or `helpers/` catchalls** (`architecture.md:1000`). Resist the urge to add one "for later".

### Story scope boundaries (DO NOT include)

These belong to other stories — explicitly out of scope here:

- **CI workflow** (`.github/workflows/ci.yml`) — Story **1.12**
- **Dependabot config** (`.github/dependabot.yml`) — Story **1.12**
- **Stdout-discipline smoke test file** (`tests/smoke/stdout-discipline.test.ts`) — Story **1.12**. The pre-push hook in `package.json` references this file; it's expected that the hook will fail until 1.12 lands. Don't create a stub test that always passes — that would defeat the gate's purpose.
- **CONTRIBUTING.md, CLAUDE.md, CHANGELOG.md** — Story **2.9**
- **Full README content** (install walkthrough, `claude mcp add-json`, SB Runtime API disclosure, threat model link) — Story **1.13**
- **`docs/threat-model.md`, `docs/permissions.md`** — Story **1.13**
- **GitHub ISSUE_TEMPLATE files** — not in any current story; defer

### Files this story modifies vs. creates

This story is a greenfield scaffold — there are no UPDATE files. The repo currently contains only `_bmad/`, `_bmad-output/`, `.claude/`, `docs/` (empty), `.git/`. All files in this story are NEW.

### Testing standards

- Test framework: `node:test` (built-in, zero runtime dep) per AR4, `architecture.md:130-134`
- Test invocation: `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`
- Test discovery: tests adjacent to source (`*.test.ts` next to source unit) plus `tests/integration/` and `tests/smoke/`
- For THIS story specifically, no test code is written. The verification is "the test runner runs without error against zero or one placeholder test". Real tests start in Story 1.2 (`Ref` validator).

### Library / framework requirements

| Tool | Version pin policy | Notes |
|---|---|---|
| Node.js | `>=24` (engines) | NFR13 supersedes PRD's ≥20.x. Native TS type stripping requires 24. |
| TypeScript | `^5.8` minimum | `erasableSyntaxOnly` requires 5.8+. |
| `@modelcontextprotocol/sdk` | `^1.x` | v2 is pre-alpha as of 2026-04-30; lock to latest 1.x. Latest at story-creation: 1.29.0. |
| `zod` | latest stable | Used at boundaries (env-var parsing in Story 1.4, MCP tool input parsing in handler stories). |
| `eslint` + `@eslint/js` + `typescript-eslint` | latest stable | Flat config (`eslint.config.js`); no legacy `.eslintrc`. |
| `prettier` | latest stable | |
| `simple-git-hooks` | latest stable | Chosen over `husky` on minimal-deps grounds (`architecture.md:764`). |
| `lint-staged` | latest stable | |

**No runtime dependencies beyond `@modelcontextprotocol/sdk` + `zod`.** This is the floor; subsequent stories may add narrowly scoped deps (e.g., `ulid` for the audit logger in Story 1.5 — verify story-time).

### File-structure requirements

The exact `src/` tree to create (empty seams marked with `.gitkeep`):

```
src/
├── index.ts                        # NEW: minimal stub w/ shebang
├── config/.gitkeep
├── diagnostic/.gitkeep
├── audit/.gitkeep
├── domain/.gitkeep
├── permissions/.gitkeep
├── edits/.gitkeep
├── freshness/.gitkeep
├── silverbullet/
│   └── scripts/.gitkeep
└── mcp/
    └── handlers/.gitkeep

tests/
├── integration/.gitkeep
└── smoke/.gitkeep
```

Repo root files: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md`.

Do NOT create `.github/`, `CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/threat-model.md`, etc. — those are scoped to other stories.

### Latest tech information (researched 2026-04-30)

- **`@modelcontextprotocol/sdk`**: latest published is 1.29.0 (~Apr 8, 2026). v2 is in pre-alpha. **Lock to `^1.x`** for MVP. Sources: [npm registry](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [GitHub releases](https://github.com/modelcontextprotocol/typescript-sdk/releases).
- **Node 24 type stripping**: on by default; tsconfig recommendation from Node docs is `noEmit: true`, `target: "esnext"`, `module: "nodenext"`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `rewriteRelativeImportExtensions: true`. Architecture chose `target: "ES2022"` — keep that (it's a deliberate floor; no `using` syntax expected). Add `erasableSyntaxOnly` and consider `verbatimModuleSyntax` for explicit `import type` discipline. Source: [Node v24 TypeScript docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html).
- **`allowImportingTsExtensions`** is required for explicit `.ts` extensions in imports (Node 24 needs them; bundler-style extensionless imports don't work).

### Project Structure Notes

This story builds the structure the architecture mandates exactly. No deviations expected. If the dev agent finds tooling issues that force divergence (e.g., `node --test` glob behavior on zero matches forces a placeholder test), document the divergence in the Completion Notes List with rationale.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.1]
- Hand-rolled scaffold rationale + dependency list: [Source: _bmad-output/planning-artifacts/architecture.md#Selected Starter] (lines 95-175)
- D8 CI/CD + git hooks + release: [Source: _bmad-output/planning-artifacts/architecture.md#D8] (lines 714-806)
- D7 stream discipline (motivates ESLint `no-console`): [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- Naming + structure rules: [Source: _bmad-output/planning-artifacts/architecture.md#Naming], [#Structure] (lines 882-1000)
- `package.json` skeleton: [Source: _bmad-output/planning-artifacts/architecture.md#Configuration files reference] (lines 1399-1465)
- Repository layout: [Source: _bmad-output/planning-artifacts/architecture.md#Complete repository layout] (lines 1197-1298)
- Implementation sequence (this story = #1): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (lines 807-826)
- AR1–AR9 (scaffold-specific reqs): [Source: _bmad-output/planning-artifacts/epics.md#From Architecture — Project Scaffold]
- Node 24 type stripping subset: [Source: https://nodejs.org/docs/latest-v24.x/api/typescript.html]

## Open Questions for User

1. **License choice for `LICENSE` file** — architecture defers (`architecture.md:1209`). Default to **MIT** unless told otherwise. Confirm before publishing.
2. **`package.json` `name` field** — architecture skeleton uses `"@are/mcp-silverbullet"` (`architecture.md:1405`). Confirm npm scope/name before first publish (Story 2.10). For now, use the architecture skeleton value.
3. **`node --test` zero-match behavior on Node 24** — if the test runner errors when no test files match the glob, we'll add a single placeholder test in `tests/integration/` and remove it when Story 1.2 lands. Documented in Task 5; flag if this becomes a recurring fragility.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- Initial typecheck failed with `TS2591: Cannot find name 'node:test'` even with `@types/node@25.6.0` installed. TS 6.0 + NodeNext did not auto-include `@types/node`. Fixed by adding `"types": ["node"]` to `tsconfig.json`.
- ESLint flagged `tseslint.config()` signature as `[6387] deprecated` — this is a soft TS hint from typescript-eslint v8.59.1; the config still works correctly (lint exits 0; rules fire as expected per the smoke test). No migration needed for MVP; revisit if typescript-eslint v9 lands during the epic.
- Initial placeholder test `test('...', () => {})` triggered `no-floating-promises` because `node:test`'s `test()` returns a Promise. Resolved by using top-level `await test(...)` (ESM allows it under NodeNext).
- Prettier `--check` initially flagged 124 files including BMad skill markdown under `.claude/`. Added `.prettierignore` covering `_bmad/`, `_bmad-output/`, `.claude/`, `docs/`, `node_modules/`, `package-lock.json`, `LICENSE`, `.gitkeep`.

### Completion Notes List

- All 5 ACs satisfied; all 8 tasks marked [x].
- Validation gates green: `tsc --noEmit` exits 0, `eslint .` exits 0, `prettier --check .` all clean, `npm test` 1 pass / 0 fail, `node ./src/index.ts` runs under native type stripping, `npm run dev` starts watch mode.
- AR9 publish manifest verified: `npm pack --dry-run` ships only `LICENSE`, `README.md`, `package.json`, `src/index.ts` (4 files, 2.7KB).
- AC3 stream-discipline rule verified via smoke test: a temporary `src/__lint_smoke.ts` containing `console.log('test');` was rejected by ESLint with the architecture-mandated message. The temp file was removed.
- Hooks registered (`.git/hooks/pre-commit`, `.git/hooks/pre-push`); the pre-push will fail on `git push` until Story 1.12 lands `tests/smoke/stdout-discipline.test.ts` — that's the intended gate.
- Versions written 2026-04-30: `@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.1`, `typescript@6.0.3`, `eslint@10.2.1`, `typescript-eslint@8.59.1`, `prettier@3.8.3`, `simple-git-hooks@2.13.1`, `lint-staged@16.4.0`, `@types/node@25.6.0`, `@eslint/js@10.0.1`. All caret-pinned.
- Two minor deviations from the story plan, both noted above:
  1. Added `"types": ["node"]` to tsconfig (not in the original architecture snippet) — required by TS 6 + NodeNext for `node:test` resolution.
  2. Added `verbatimModuleSyntax: true` to tsconfig (not in original architecture snippet but recommended by Node 24 docs and consistent with the project's type-stripping discipline). Forces explicit `import type` for type-only imports.
- Open questions resolved by user: LICENSE = MIT (copyright Artur Wojciechowski 2026), package name = `@are/mcp-silverbullet`, placeholder test approved.

### File List

**New (all):**
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `eslint.config.js`
- `.prettierrc.json`
- `.prettierignore`
- `.editorconfig`
- `.gitignore`
- `.npmignore`
- `LICENSE`
- `README.md`
- `src/index.ts`
- `src/audit/.gitkeep`
- `src/config/.gitkeep`
- `src/diagnostic/.gitkeep`
- `src/domain/.gitkeep`
- `src/edits/.gitkeep`
- `src/freshness/.gitkeep`
- `src/mcp/handlers/.gitkeep`
- `src/permissions/.gitkeep`
- `src/silverbullet/scripts/.gitkeep`
- `tests/integration/.gitkeep`
- `tests/integration/scaffold.test.ts`
- `tests/smoke/.gitkeep`

### Change Log

- 2026-04-30 — Story 1.1 implementation complete. Hand-rolled scaffold landed: `package.json` with locked deps, `tsconfig.json` (NodeNext + `erasableSyntaxOnly` + `verbatimModuleSyntax`), `eslint.config.js` (flat config with stream-discipline rules), supporting root files (LICENSE/MIT, prettier, editorconfig, ignores), empty `src/` seam tree with `.gitkeep` markers, README skeleton with Development Setup section, simple-git-hooks registered (no `postinstall`). All gates green (typecheck/lint/format/test). Status: in-progress → review.
- 2026-04-30 — Code review run (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Acceptance Auditor: clean (AC1–AC5 pass, all 8 guardrails clean, no scope-boundary violations, no library/version-pin drift). Adversarial layers surfaced 7 patches, 3 decisions, 5 deferrals; ~29 findings dismissed as noise/spec-mandated/intentional.
- 2026-04-30 — Decisions resolved (D1: defer, D2: patch to `@types/node@^24`, D3: dismiss). All 8 patches applied and verified (typecheck, lint, test, prettier, pack). Status: review → done.

### Review Findings

**Source:** Blind Hunter (adversarial, diff-only) + Edge Case Hunter (path-tracing, project read) + Acceptance Auditor (spec-vs-diff conformance) — 2026-04-30.

**Acceptance Auditor verdict:** AC1: pass, AC2: pass, AC3: pass, AC4: pass, AC5: pass. All 8 critical guardrails clean. No scope-boundary violations. Library/framework version pins match Task 1 table verbatim. Verification limits noted: hook on-disk script contents, runtime exit-clean of `npm` scripts, and verbatim ESLint rejection message for `console.log` are verifiable only by running locally — story Completion Notes claim all green.

#### Decisions resolved (2026-04-30)

- D1: Enforce `engines.node` strictly? → **defer** ("advisory is fine"). Listed below under deferred.
- D2: Pin `@types/node` to `^24` to match `engines: ">=24"`? → **patch** (downgrade to `^24`).
- D3: Should `npm test` include `tests/smoke/`? → **dismiss** (smoke stays push-gated).

#### Patches (applied 2026-04-30)

- [x] [Review][Patch] Pin `@types/node` to `^24` to match `engines: ">=24"`. [package.json:39]
- [x] [Review][Patch] Add `+x` permission bit to `src/index.ts`. (`chmod +x` applied; mode now 0755 in working tree.) [src/index.ts]
- [x] [Review][Patch] README `cd mcp-silverbullet` → `cd <cloned-dir>`. [README.md:30]
- [x] [Review][Patch] Version aligned — `package.json` `"version": "0.1.0-pre.0"` (SemVer prerelease, matches README banner). [package.json:3]
- [x] [Review][Patch] `pre-commit` no longer uses `npx`: `npx lint-staged` → `lint-staged` (resolves via `node_modules/.bin`). Hook re-registered via `npx simple-git-hooks`. [package.json:26]
- [x] [Review][Patch] Added `prepublishOnly` script: `"prepublishOnly": "npm run typecheck && npm run lint && npm test"`. [package.json:18-25]
- [x] [Review][Patch] `lint-staged` `*.ts` now runs `eslint --max-warnings=0`. [package.json:31]
- [x] [Review][Patch] `files` allowlist excludes future `*.test.ts`: added `"!src/**/*.test.ts"`. `npm pack --dry-run` still 4 files (LICENSE, README, package.json, src/index.ts). [package.json:13-18]

**Post-patch verification (2026-04-30):**
- `npm install` — clean, 0 vulnerabilities, lockfile updated for `@types/node` downgrade.
- `npx simple-git-hooks` — pre-commit re-registered with `lint-staged && npm run typecheck && npm test`.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `npm test` — 1 pass, 0 fail.
- `npx prettier --check .` — all matched files use Prettier code style.
- `npm pack --dry-run` — 4 files, 2.8 kB tarball, manifest matches AR9.

#### Deferred (real but not actionable now)

- [x] [Review][Defer] Enforce `engines.node` strictly? — Decision (2026-04-30): leave advisory ("advisory is fine"). Contributors land on the right Node by README docs; no install-time gate. [package.json:7-9] — deferred, decision
- [x] [Review][Defer] Test glob single-quoted breaks on Windows `cmd.exe` — `'src/**/*.test.ts'` literal-quotes survive in argv on cmd; Node's glob then matches nothing. Project is POSIX-only for MVP — defer until Windows support is on the roadmap. [package.json:21] — deferred, scope
- [x] [Review][Defer] `node --watch ./src/index.ts` may need `--experimental-strip-types` on early Node 24.x — Strip-types became default-on partway through the 24.x line. Verify in CI which 24.x patch is the floor; flag README only if a regression appears. [package.json:19, README.md:49] — deferred, verify-locally
- [x] [Review][Defer] `.gitignore` audit-log pattern (`audit.jsonl`) may not match runtime write location — Story 1.5 lands the audit logger; revisit ignore patterns when the actual write path is known. [.gitignore] — deferred, blocked by Story 1.5
- [x] [Review][Defer] `.gitignore` missing forward-looking patterns (`dist/`, `coverage/`, `*.tsbuildinfo`) — No build step, no coverage tooling today. Revisit if either lands. [.gitignore] — deferred, pre-emptive
- [x] [Review][Defer] `lint-staged` glob misses `.editorconfig`, `*.yml`, `*.yaml` — Minor formatting drift risk on non-`.ts/.js/.json/.md` configs. Tighten when CI / GH workflow YAML lands in Story 1.12. [package.json:30] — deferred, blocked by Story 1.12

#### Dismissed as noise (30)

- `npm test` should include `tests/smoke/` — Decision (2026-04-30): keep smoke push-gated only; `npm test` covers unit + integration. [package.json:21, package.json:27]


Architecture-mandated or spec-mandated:

- `bin` points at `.ts` — AR2/AR3 mandate; Node 24 native type-stripping. (BH2, ECH3)
- `void 0;` body in `src/index.ts` — Critical Guardrail #5 mandates exactly this stub. (BH16)
- `pre-push` references `tests/smoke/stdout-discipline.test.ts` (doesn't exist yet) — intentional gate per story Task 6 / Story 1.12. (BH8, ECH2)
- `.npmignore` redundant with `files` allowlist — AC1 mandates `.npmignore` exists; story Task 4 line 81 calls it a backstop. (BH9, ECH14)
- Pre-commit chain runs typecheck+test on every commit — D8 / architecture intentional. (ECH6)
- Top-level `await test(...)` in `tests/integration/scaffold.test.ts` — documented in Debug Log line 246 (resolves `no-floating-promises`). (BH18, ECH18)
- No `main`/`exports` field — bin-only MCP server, not a library. (BH10)

False positives (verified against actual code or empirical evidence):

- "ESLint silently lints zero TS files" — story Task 3 line 74 smoke test rejected `console.log` in `src/__lint_smoke.ts`; .ts files ARE linted. (ECH11)
- "No `package-lock.json` committed" — lockfile is committed; the diff was reviewer-filtered to drop it for noise reduction. (BH1, Auditor file-list-drift note)
- "Phantom dependency versions" (typescript@^6, eslint@^10, @types/node@^25, etc.) — date is 2026-04-30; these are the latest stable versions in the project's timeline per story Task 1. (BH4)
- `.prettierignore` `.gitkeep` glob — Prettier uses gitignore-style matching; bare `.gitkeep` matches at any depth. (ECH21)

Out of scope / engines-pin handles / Story-1.x handles:

- `process.stdout.write` not blocked by `no-console` — Story 1.12 stdout-discipline smoke test handles. (ECH12)
- `noUncheckedIndexedAccess` doesn't catch `Object.entries`/`JSON.parse` — architecture mandates zod at boundaries. (ECH9)
- Consumers on Node 22/23 break on `.ts` imports — `engines: ">=24"` covers contractually. (ECH8)
- `erasableSyntaxOnly` doesn't block `const enum` re-exported from deps — obscure; defer to incident. (ECH7)
- `.gitkeep` ship risk if `files` pattern broadens — current pattern (`*.ts`) excludes; revisit if changed. (ECH16)
- `npm test` glob zero-match — handled by `tests/integration/scaffold.test.ts` placeholder per story Task 5 / Open Question 3. (ECH1)
- `tsconfig` include vs. ESLint ignores inconsistency — subjective; not a defect. (BH14)
- ESLint flat-config `projectService` traps stray `.ts` outside include — edge; defer to incident. (BH13)
- `lint-staged` runs `prettier --check` not `--write`, ESLint without `--fix` — style preference; fail-loud is defensible. (BH11)
- LICENSE year hardcoded — convention; manual update on next release. (ECH19)
- Em-dash in `package.json` description — UTF-8 OK; `npm publish --dry-run` doesn't warn. (BH22)
- README "first command after clone" wording vs. ordering (`npm install` precedes `npx simple-git-hooks`) — Auditor accepted as spirit-of-AC5; pragmatic ordering required for `simple-git-hooks` to resolve from `node_modules/.bin`. (Auditor note)
