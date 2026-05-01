# mcp-silverbullet

An MCP (Model Context Protocol) server that lets an agent read and contribute to your
[SilverBullet](https://silverbullet.md) notes — under per-page permissions you declare in plain
markdown, with a server-enforced read-before-edit invariant so the agent cannot silently overwrite
your work.

Existing PKM-MCP integrations treat agent access as an on/off switch — once connected, the agent
sees and edits whatever it wants. This server makes **agent access a first-class trust contract**
built on two mechanisms:

1. **Per-page access modes** declared by you in plain markdown — `none` (page is invisible to the
   agent), `read`, `append`, or `write`. Sensitive material can be entirely excluded from the
   agent's reachable surface.
2. **A read-before-edit invariant** — non-`append` edits are rejected unless the agent has read the
   page since its last modification. This eliminates a category of agent harm (silent overwrites,
   stale-context edits) that current MCP servers ignore by default.

The core insight: **agents should earn the right to write.** Permissioning + freshness checks make
"agent collaborator in your knowledge base" trustworthy by construction, not by hope.

## Status

`0.1.0-pre` — Epic 1 is complete (read-side trust contract: install, configure, declare
permissions, list/search/read pages with `none`-mode filtering, audit log). Epic 2 (write-side:
`append_to_page`, `edit_page`, `create_page`, `delete_page`) is in progress.

This server tracks SilverBullet's currently-stable release line — including the experimental
Runtime API surface this MVP depends on. Compatibility breakage triggered by a new SilverBullet
release is treated as a P0 issue and addressed before any feature work resumes.

## Requirements

- **Node.js ≥ 24** — native TypeScript type stripping; no build step. The published artifact is
  TypeScript source.
- **A self-hosted SilverBullet instance with the experimental Runtime API enabled** — see
  [SilverBullet Runtime API](https://silverbullet.md/Runtime%20API). The Runtime API requires
  **Chrome/Chromium installed alongside SilverBullet**, **OR** running SilverBullet via the
  `-runtime-api` Docker variant. If neither is satisfied, this server fails fast at startup with a
  hint pointing at the same docs.

> **Heads up — experimental Runtime API.** The SilverBullet Runtime API is currently tagged
> `#maturity/experimental` upstream. This server depends on it as a deliberate accepted risk
> because no other SilverBullet HTTP surface exposes the index, search, and atomic page operations
> the trust contract needs. If a SilverBullet release breaks the Runtime API, this server breaks
> with it — and the maintainer treats that as a P0. A fuller disclosure lives in
> [`docs/threat-model.md`](./docs/threat-model.md).

## Install

The server runs via `npx`, invoked by your MCP-capable agent runtime.

**Claude Code** — wire it up with `claude mcp add-json`:

```bash
claude mcp add-json silverbullet '{
  "type": "stdio",
  "command": "npx",
  "args": ["@are/mcp-silverbullet"],
  "env": {
    "SILVERBULLET_URL": "https://my-silverbullet.example.com",
    "SILVERBULLET_TOKEN": "your-bearer-token-here"
  }
}'
```

Replace the URL and token with your own values. The `env` block is the only configuration surface;
there are no config files. See **Configuration / Environment variables** below for each variable's
contract.

> **Paste safety.** The JSON arg is shell-quoted with single quotes; the JSON itself uses ASCII
> double quotes. Keep it ASCII when you copy: smart quotes (`"` `"` `'` `'`), em-dashes (`—`), and
> zero-width characters render fine but break `claude mcp add-json` parsing.

> **The `SB_AUTH_TOKEN` ↔ `SILVERBULLET_TOKEN` step.** This is the most common first-time-setup
> failure point. SilverBullet authenticates inbound HTTP requests against an env var named
> **`SB_AUTH_TOKEN`** on the SilverBullet side. This server reads its own bearer token from
> **`SILVERBULLET_TOKEN`** (passed via the `env` block above). **Both env vars must be set to the
> same value** — `SB_AUTH_TOKEN` on your SilverBullet instance, `SILVERBULLET_TOKEN` on the MCP
> server. Same secret, two names, one on each side.
>
> **How to set `SB_AUTH_TOKEN` on SilverBullet:**
>
> - **Running the binary directly:** export it before launch — `SB_AUTH_TOKEN=your-bearer-token-here silverbullet ./space`.
> - **Running via Docker:** pass it as an env var — `docker run -e SB_AUTH_TOKEN=your-bearer-token-here zefhemel/silverbullet:latest`
>   (or your `docker-compose.yml`'s `environment:` block).
> - **Running via a systemd unit, launchd, etc.:** add `SB_AUTH_TOKEN=your-bearer-token-here` to the
>   service's environment file or unit-level `Environment=` directive.
>
> Use the same value here and in the `env` block of your `claude mcp add-json` snippet above.

After running `claude mcp add-json`, restart Claude Code so it picks up the new MCP server.

## Configuration

### Environment variables

| Variable                          | Required | Description                                                                                                                                                                                                                                                 |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SILVERBULLET_URL`                | yes      | Endpoint of your self-hosted SilverBullet instance. Must be an absolute URL using `https://`, unless the host is `localhost` or `127.0.0.1` (local development exemption).                                                                                  |
| `SILVERBULLET_TOKEN`              | yes      | Bearer token, matched on the SilverBullet side by `SB_AUTH_TOKEN`. Never logged, never recorded in the audit log, never echoed back to the agent.                                                                                                           |
| `MCP_SILVERBULLET_AUDIT_LOG_PATH` | no       | Absolute path overriding the default audit-log location. Defaults: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl` on Unix/macOS (with `~/.local/state` fallback when `$XDG_STATE_HOME` is unset); `%LOCALAPPDATA%\mcp-silverbullet\audit.jsonl` on Windows. |

The audit-log directory is created on first use with mode `0700`. If creation fails (permissions,
read-only filesystem), the server fails fast at startup with a clear error.

If a misconfigured env var trips the startup ladder, the FATAL message on stderr ends with a hint
pointing back at this section.

## First successful tool call

Once Claude Code is restarted with the server wired up, ask Claude something that requires looking
into your space — for example:

> _"List the pages in my SilverBullet space."_

Claude should call `list_pages` and reply with the pages your declared permissions allow.

**If the list is empty**, that is almost certainly correct: you haven't declared any permissions
yet, and the server's behavior is **default-deny** — every page resolves to `none` (invisible)
until you author a `#mcp/config` block. See [Permissions](#permissions) below.

**If the call succeeds**, the audit-log file is created on first use at the path resolved above
(default: `$XDG_STATE_HOME/mcp-silverbullet/audit.jsonl`). Every tool call writes exactly one
line-delimited JSON entry there — watch it in real time with `tail -f` on Unix/macOS or
`Get-Content -Path … -Wait` in Windows PowerShell.

## Permissions

You declare what the agent can see and do by authoring `#mcp/config` tagged YAML fence blocks
inside your SilverBullet space — in the pages where the rules apply. **Default-deny:** any page
without a matching `#mcp/config` block is `none` to the agent, regardless of what other pages say.

A minimum-viable starting block (paste this into your `CONFIG` page):

````markdown
```yaml #mcp/config
access: read
```
````

That declares your whole space as `read` to the agent — listed, searchable, readable. Override on
specific pages or directories with their own blocks.

**Full guide:** [`docs/permissions.md`](./docs/permissions.md) — covers all four access modes
(`none` / `read` / `append` / `write`), block-scope rules (global vs. host-scoped, the `exact`
modifier), the resolution algorithm, malformed-block fail-closed behavior, and worked examples.

## Audit log and threat model

Every tool call produces exactly one entry in the audit log — agent intent in `args` (logged in
full), user content in `response` (digested as `{ size, sha256 }` so page content never leaves your
machine via the log).

**Honest disclosure:** [`docs/threat-model.md`](./docs/threat-model.md) covers what `none`-mode
guarantees and what it does not (it blocks well-behaved agents on common-path interfaces and is
**not** a hard isolation boundary), the experimental status of the SilverBullet Runtime API, what
the read-before-edit invariant guarantees and does not, and the auditability stance. Read it before
storing anything sensitive in a SilverBullet space the agent can connect to.

A schema reference for the audit log lands in `docs/audit-log.md` (Story 2.7, alongside the
write-side handlers).

## For contributors

After cloning, run these commands **in this order**:

```sh
git clone <repo>
cd <cloned-dir>
npm install
npx simple-git-hooks      # ← first command after clone — required
```

> **No `postinstall`.** Hook activation is explicit by design (supply-chain hygiene).
> `npx simple-git-hooks` registers the pre-commit and pre-push hooks; no `postinstall` script will
> ever do this for you.

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
- `pre-push` runs the stdout-discipline smoke test (`tests/smoke/stdout-discipline.test.ts`).

**Never use `--no-verify`.** Hook bypass is forbidden — if a hook fails, fix the underlying issue.
This is the project's primary guardrail against agent regressions.

## License

MIT — see [`LICENSE`](./LICENSE).
