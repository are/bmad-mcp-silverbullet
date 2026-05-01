# Deferred Work

A running ledger of items that are real but not actionable in the story that surfaced them. Each entry names its origin so future reviews can re-weigh.

## Deferred from: code review of story-1-1-project-scaffold-and-tooling (2026-04-30)

- **Enforce `engines.node` strictly?** — Decision (2026-04-30): leave advisory ("advisory is fine"). Contributors land on the right Node by README docs; no install-time gate. (`package.json:7-9`)
- **Test glob single-quoted breaks on Windows `cmd.exe`** — `package.json:21` uses `'src/**/*.test.ts'`; cmd.exe preserves the single quotes in argv and Node's glob then matches nothing. Project is POSIX-only for MVP; revisit when Windows support is on the roadmap.
- **`node --watch ./src/index.ts` may need `--experimental-strip-types` on early Node 24.x** — Strip-types became default-on partway through the 24.x line. Verify in CI which 24.x patch is the floor; flag README only if a regression appears. (`package.json:19`, `README.md:49`)
- **`.gitignore` audit-log pattern (`audit.jsonl`) may not match runtime write location** — Story 1.5 lands the audit logger; revisit the ignore pattern when the actual write path (CWD vs. configurable) is fixed.
- **`.gitignore` missing forward-looking patterns** (`dist/`, `coverage/`, `*.tsbuildinfo`) — No build step, no coverage tooling today. Revisit if either lands.
- **`lint-staged` glob misses `.editorconfig`, `*.yml`, `*.yaml`** — Minor formatting drift risk on non-`.ts/.js/.json/.md` configs. Tighten when CI / GH workflow YAML lands in Story 1.12.

## Deferred from: code review of story-1-2-ref-domain-primitive (2026-04-30)

- **Per-segment leading `.`/`^` and per-segment `.md` suffix rules** — `makeRef` validator applies leading-`.`/`^` and `.md` suffix rules only at the full-string boundary, so `Foo/.hidden`, `Foo/^bar`, and `Foo.md/Bar` all pass. SB's `Names.md` is per-name not per-segment, so tightening here would diverge from upstream without a documented threat. Revisit if SB's upstream validator changes, if Story 1.8's permission engine treats per-segment dotfiles specially, or if a per-segment exploit surfaces. (`src/domain/ref.ts:58-77`)

## Deferred from: code review of story-1-3-diagnostic-logger (2026-04-30)

- **Hostile `err` payloads with throwing getters could crash the logger** — `renderError(err)` reads `err.stack`, `err.message`, and falls through to `String(err)` with no try/catch. An `Error` subclass that throws on its `.stack` getter, or a plain object with a throwing `toString` / `Symbol.toPrimitive`, would surface the throw out of `logger.error(...)` — contradicting AC3's "never throws on bad inputs" spirit. Theoretical: real-world callers do not hand-craft hostile payloads. Revisit if a production crash is ever traced back to this surface, or when a future story tightens the input contract. (`src/diagnostic/logger.ts:55-63`)
