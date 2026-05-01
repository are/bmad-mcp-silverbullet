# mcp-silverbullet

> ⚠️ **Pre-release scaffold.** Real install + usage docs land in Story 1.13. This README currently seeds the project skeleton and the development setup contract.

An MCP (Model Context Protocol) server that lets an agent read and contribute to your [SilverBullet](https://silverbullet.md) notes — under per-page permissions you declare in plain markdown.

## Status

`0.1.0-pre` — scaffold only. Tools, permission engine, edit pipeline, and audit log are being implemented across Epic 1 + Epic 2.

## Requirements

- **Node.js ≥ 24** (native TypeScript type stripping; no build step).
- A self-hosted SilverBullet instance with the experimental Runtime API enabled.

## Install (placeholder)

Full install instructions — including a `claude mcp add-json` example and the SilverBullet Runtime API enablement walkthrough — land in Story 1.13.

## Configuration (placeholder)

Configuration surface is environment variables only. Story 1.4 documents `SILVERBULLET_URL`, `SILVERBULLET_TOKEN`, and `MCP_SILVERBULLET_AUDIT_LOG_PATH`.

## Development Setup

After cloning, run these commands **in this order**:

```sh
git clone <repo>
cd <cloned-dir>
npm install
npx simple-git-hooks      # ← first command after clone — required
```

> **No `postinstall`.** Hook activation is explicit by design (supply-chain hygiene). `npx simple-git-hooks` registers the pre-commit and pre-push hooks; no `postinstall` script will ever do this for you.

Once hooks are installed, verify the toolchain:

```sh
npm run typecheck
npm run lint
npm test
```

### Available scripts

| Command             | What it does                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run dev`       | `node --watch ./src/index.ts` — Node-native watch loop, no `tsx`.                                            |
| `npm run typecheck` | `tsc --noEmit` — TS source is the published artifact; `tsc` is the CI type-check gate, never an emitter.     |
| `npm test`          | `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'` — built-in `node:test`, zero runtime deps. |
| `npm run lint`      | `eslint .` — flat config with stream-discipline rules (`no-console` allows only `error`/`warn`).             |
| `npm run format`    | `prettier --write .`.                                                                                        |

### Pre-commit and pre-push gates

- `pre-commit` runs `lint-staged` → `npm run typecheck` → `npm test`.
- `pre-push` runs the stdout-discipline smoke test (lands in Story 1.12).

**Never use `--no-verify`.** Hook bypass is forbidden — if a hook fails, fix the underlying issue. This is the project's primary guardrail against agent regressions.

## License

MIT — see [`LICENSE`](./LICENSE).
