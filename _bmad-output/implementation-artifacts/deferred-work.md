# Deferred Work

A running ledger of items that are real but not actionable in the story that surfaced them. Each entry names its origin so future reviews can re-weigh.

## Deferred from: code review of story-1-1-project-scaffold-and-tooling (2026-04-30)

- **Enforce `engines.node` strictly?** — Decision (2026-04-30): leave advisory ("advisory is fine"). Contributors land on the right Node by README docs; no install-time gate. (`package.json:7-9`)
- **Test glob single-quoted breaks on Windows `cmd.exe`** — `package.json:21` uses `'src/**/*.test.ts'`; cmd.exe preserves the single quotes in argv and Node's glob then matches nothing. Project is POSIX-only for MVP; revisit when Windows support is on the roadmap.
- **`node --watch ./src/index.ts` may need `--experimental-strip-types` on early Node 24.x** — Strip-types became default-on partway through the 24.x line. Verify in CI which 24.x patch is the floor; flag README only if a regression appears. (`package.json:19`, `README.md:49`)
- **`.gitignore` audit-log pattern (`audit.jsonl`) may not match runtime write location** — Story 1.5 lands the audit logger; revisit the ignore pattern when the actual write path (CWD vs. configurable) is fixed.
- **`.gitignore` missing forward-looking patterns** (`dist/`, `coverage/`, `*.tsbuildinfo`) — No build step, no coverage tooling today. Revisit if either lands.
- **`lint-staged` glob misses `.editorconfig`, `*.yml`, `*.yaml`** — Minor formatting drift risk on non-`.ts/.js/.json/.md` configs. Tighten when CI / GH workflow YAML lands in Story 1.12.
