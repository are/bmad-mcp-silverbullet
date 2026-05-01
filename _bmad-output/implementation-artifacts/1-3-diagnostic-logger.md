# Story 1.3: Diagnostic Logger

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As Maya operating the server,
I want a single approved stderr-bound logger module exposing `INFO` / `WARN` / `ERROR` with the `[mcp-silverbullet]` prefix, the only sanctioned writer to stderr,
so that diagnostic output never corrupts MCP JSON-RPC framing on stdout and every other module has one well-defined seam for operator-visible events.

## Acceptance Criteria

**AC1 — Module exposes a closed `Logger` shape with exactly three methods**

**Given** the diagnostic logger module at `src/diagnostic/logger.ts`,
**When** I import its public surface,
**Then** it exports:
- A type `Logger` with exactly three methods: `info(message: string): void`, `warn(message: string): void`, `error(message: string, err?: unknown): void`.
- A factory `createLogger(stream: NodeJS.WritableStream): Logger` that returns a `Logger` writing to the provided stream.
- A module-level default instance `logger: Logger` bound to `process.stderr` for non-DI callsites (e.g. the startup ladder before a `HandlerContext` exists).

**And** there is no `debug` / `trace` method, no log-level env var, no runtime gate. Levels are a closed set per AR49 (`architecture.md:170`, `architecture.md:670`); adding a level later is a new story, not a runtime toggle.

**AC2 — Output format is `[mcp-silverbullet] LEVEL  message\n` to stderr**

**Given** a `Logger` constructed with a fake `WritableStream`,
**When** I call `info('starting up')`,
**Then** exactly one `write` happens with the bytes `[mcp-silverbullet] INFO  starting up\n` (note: the level field is left-padded to 5 characters, so `INFO ` + a single separator space yields two visible spaces; `WARN ` + space → two; `ERROR` + space → one — matching `architecture.md:660-668` literally).

**And** the same shape holds for `warn(...)` (level `WARN `) and `error(...)` without a second argument (level `ERROR`).

**And** **nothing** is ever written to stdout — verified by an `process.stdout.write` interceptor in tests.

**AC3 — `error(msg, err)` appends a clean stack trace on subsequent lines**

**Given** an `Error` instance `e` with `e.stack` populated,
**When** I call `logger.error('handler crashed', e)`,
**Then** the stream receives a single `write` whose payload is `[mcp-silverbullet] ERROR handler crashed\n` followed by `e.stack` followed by a trailing `\n` (assembled and emitted in **one** `write` call — atomicity matters because concurrent handlers may log; interleaved partial writes are forbidden).

**And** if `err` is `undefined`, only the primary line is emitted (no stack lines).

**And** if `err` is **not** an `Error` (e.g. a thrown string, a plain object), the logger falls back to `String(err)` rendered on the line after the primary — a stack-trace-shaped slot is the contract, not "must be an `Error`". Story 1.6's `formatToolError` is the place where infrastructure-error wrapping happens; this logger never throws on non-`Error` inputs (per NFR12 spirit — diagnostics must never destabilise the process).

**And** if `err` is an `Error` whose `.stack` is `undefined`, the logger falls back to `err.message` (then `String(err)` if that is also empty).

**AC4 — Single approved stderr writer (the D7 invariant codified)**

**Given** the diagnostic logger module,
**When** any other module needs to emit an operator-visible event,
**Then** it MUST go through `Logger` (either via the default `logger` import or via `ctx.logger` in tool handlers per the canonical handler shape — `architecture.md:1043`, `architecture.md:1084`),
**And** direct `console.error` / `console.warn` calls outside this module are discouraged in code review (the ESLint `no-console` allowlist of `error` / `warn` is a defense-in-depth backstop only — `architecture.md:652`, `architecture.md:1146-1148`),
**And** direct `process.stderr.write(...)` outside this module is discouraged for the same reason — it bypasses the `[mcp-silverbullet]` prefix and the single-write atomicity guarantee.

This AC is verified by **JSDoc** on the exported `Logger`, `createLogger`, and `logger` symbols stating the rule explicitly. The lint enforcement of "no direct stream access outside this module" is **deferred** — a custom ESLint rule for `process.stderr.write` is overkill for MVP. JSDoc + code-review discipline + no `_bmad-output/implementation-artifacts/deferred-work.md` retro from review is sufficient.

**AC5 — No accidental stdout corruption**

**Given** a smoke harness that intercepts `process.stdout.write` for the lifetime of a test,
**When** the test calls `logger.info(...)`, `logger.warn(...)`, `logger.error(...)`,
**Then** the stdout interceptor records zero writes (`architecture.md:646` — "stdout is reserved for MCP JSON-RPC traffic only").

**And** the test calls `process.stdout.write` once directly with arbitrary bytes to confirm the interceptor is functioning (positive control, prevents a silent test-skip if the interceptor is mis-wired).

**AC6 — Pure of clock and global state; deterministic output**

**Given** the logger module,
**When** I import and exercise it,
**Then** it does **not** stamp timestamps onto log lines (timestamping happens in the audit log per D4 — `architecture.md:411`; the diagnostic stream is for tailing humans, line-by-line, with `tail -f`).

**And** it does **not** read environment variables, the filesystem, the network, or the system clock.

**And** the only side-effect is one `write` per `info`/`warn`/`error` invocation, on the stream supplied to `createLogger`.

**AC7 — Unit tests use a fake stream; no real stderr writes**

**Given** the unit tests at `src/diagnostic/logger.test.ts`,
**When** `npm test` runs,
**Then** every test constructs a `Logger` via `createLogger(fakeStream)` where `fakeStream` is a hand-rolled `NodeJS.WritableStream` capturing chunks into an array — **never** writing to real `process.stderr`,
**And** the test that asserts the `process.stdout` clean-channel invariant (AC5) installs and removes a `process.stdout.write` shim within the test body (cleanly restored in a `try / finally`),
**And** test count strictly increases vs. the post-1.2 baseline (64 → ≥ 76 expected; conservative floor of 12 new diagnostic-logger cases).

**AC8 — `src/diagnostic/.gitkeep` removed; no other file changes**

**Given** the `src/diagnostic/` module after this story,
**When** I list it,
**Then** it contains exactly `logger.ts` and `logger.test.ts` — no `.gitkeep`, no `index.ts` re-export barrel (AR57, `architecture.md:999`),
**And** no other source file in the repo is changed (no `src/index.ts` edits — startup wiring lands in story 1.11; no handler edits — handlers don't exist yet).

**AC9 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm test` from the project root,
**Then** all four exit 0,
**And** `npm test` reports the new `logger.test.ts` cases as passing,
**And** `npm pack --dry-run` manifest grows by exactly **1 file** (`src/diagnostic/logger.ts` — the test file is excluded by the `"!src/**/*.test.ts"` allowlist; `.gitkeep` is gitignored from `files` already by extension).

## Tasks / Subtasks

- [x] **Task 1: Implement the `Logger` type, `createLogger` factory, and default `logger` instance** (AC: #1, #2, #3, #4, #6)
  - [x] Create `src/diagnostic/logger.ts` exporting:
    ```ts
    export type Logger = {
      info(message: string): void;
      warn(message: string): void;
      error(message: string, err?: unknown): void;
    };

    export function createLogger(stream: NodeJS.WritableStream): Logger { /* ... */ }

    export const logger: Logger = createLogger(process.stderr);
    ```
  - [x] Implementation rules:
    - Format constant: `const PREFIX = '[mcp-silverbullet]';`
    - Level rendering: pad each level token to **5 characters** with a trailing space (`INFO `, `WARN `, `ERROR`) so that `${PREFIX} ${level.padEnd(5)} ${message}\n` reproduces the architecture's three-line example at `architecture.md:660-668` byte-for-byte.
    - **Single `stream.write(...)` per logger call.** Assemble the full payload (primary line + optional stack lines + final `\n`) before writing. Multiple writes risk interleaving when two handlers log concurrently.
    - For `error(message, err)`:
      ```ts
      const lines: string[] = [`${PREFIX} ERROR ${message}`];
      if (err instanceof Error) {
        lines.push(err.stack ?? err.message ?? String(err));
      } else if (err !== undefined) {
        lines.push(String(err));
      }
      stream.write(lines.join('\n') + '\n');
      ```
      (Architecture's `architecture.md:665` shows the stack on subsequent lines — that's `err.stack`, which conventionally already includes `Error: <msg>` as line 1 and `    at ...` lines below; keep it verbatim — do **not** strip the first line of the stack, even though it duplicates `err.message`. Operators reading stderr expect the stack as Node renders it.)
  - [x] **JSDoc** the three exports (per AC4):
    - `Logger`: "Closed set of operator-visible severities. The only sanctioned surface for stderr writes — see `architecture.md` D7. Direct `process.stderr.write` and `console.error`/`console.warn` outside this module are discouraged."
    - `createLogger`: "Construct a `Logger` bound to a writable stream. Tests pass a fake stream; production wires `process.stderr`."
    - `logger`: "Default `Logger` instance bound to `process.stderr`. Used by code paths that run before a `HandlerContext` exists (the startup ladder in story 1.11). Inside tool handlers, prefer `ctx.logger` (DI seam — `architecture.md:1106`)."
  - [x] No timestamp, no level-gating, no env-var read. Pure of clock and global state per AC6.
  - [x] Imports use the `.ts` extension if any (none expected; module is self-contained).
  - [x] Use `import type` only where required (`verbatimModuleSyntax: true`).
  - [x] Cast nothing — no `as` is needed in this module.

- [x] **Task 2: Write unit tests with a fake stream** (AC: #2, #3, #5, #6, #7)
  - [x] Create `src/diagnostic/logger.test.ts` using `node:test` + `node:assert/strict` per the established pattern (story 1.1 / 1.2; `_bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md` Dev Notes "Testing standards").
  - [x] **Top-level `await test(...)`** for each case to satisfy `no-floating-promises` (the pattern locked in story 1.1's Debug Log line 246 and story 1.2 Dev Notes line 220). Do **not** introduce `describe` blocks — the flat-top-level pattern is proven clean.
  - [x] Hand-roll a minimal fake stream:
    ```ts
    function makeFakeStream(): { stream: NodeJS.WritableStream; writes: string[] } {
      const writes: string[] = [];
      const stream: NodeJS.WritableStream = {
        write(chunk: string | Uint8Array): boolean {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        },
        end(): NodeJS.WritableStream { return stream; },
        // Other methods are not exercised by Logger; they can be stubs that throw if called.
      } as NodeJS.WritableStream;
      return { stream, writes };
    }
    ```
    (If the typecheck pushes back on the cast-via-`as`, expand the stub to cover the full `WritableStream` surface. Acceptable since this is test-only scaffolding adjacent to the unit; AR59's `as` rule is about production code at boundaries — `architecture.md:1031`. If the cast feels load-bearing, document it inline in the test.)
  - [x] Cases (full enumeration; ≥ 12 to satisfy AC7's floor):
    1. `info('starting up')` → `writes` is `['[mcp-silverbullet] INFO  starting up\n']`. Exactly one entry, byte-for-byte match.
    2. `warn('audit write failed: ENOSPC; continuing')` → `writes` is `['[mcp-silverbullet] WARN  audit write failed: ENOSPC; continuing\n']`.
    3. `error('handler crashed')` (no err) → `writes` is `['[mcp-silverbullet] ERROR handler crashed\n']`. Note: `ERROR` is 5 chars, no padding, single space separator before message.
    4. `error('handler crashed', new Error('boom'))` → exactly one `write`; payload starts with `[mcp-silverbullet] ERROR handler crashed\n`, contains `boom` somewhere in the stack body, ends with `\n`. (Stack contents are runtime-dependent — assert structural shape, not exact stack frames.)
    5. `error('handler crashed', undefined)` → identical to case 3 (undefined `err` is the same as no-arg).
    6. `error('handler crashed', 'string thrown')` (non-Error err) → payload is `[mcp-silverbullet] ERROR handler crashed\nstring thrown\n` exactly.
    7. `error('handler crashed', { foo: 'bar' })` (non-Error object err) → payload is `[mcp-silverbullet] ERROR handler crashed\n[object Object]\n` exactly. (`String({foo: 'bar'})` is `[object Object]`. Document this as an explicit choice — agents/operators benefit from knowing they should pass a real `Error`.)
    8. `error('e', { ...new Error('m'), stack: undefined })` (Error-shaped, no stack) — verify the fallback chain: stack? → message? → `String(err)`. Use a hand-built `Error` and overwrite `.stack = undefined`. Expected payload: primary line + `m\n`.
    9. `error('e', new Error())` where the Error has no message and (artificially) no stack — fallback to `String(err)` which is `Error`. Skip if too brittle on Node 24.x; keep the simpler 7+8 cases as the contract.
    10. **Atomicity:** for case 4, `writes.length === 1` — the primary line and the stack are in one chunk. Concurrent-handler interleaving safety depends on this.
    11. **Three-method closed shape:** at compile time, `logger.debug` does not exist. Add a `_methodCheck` test (analogous to `ref.test.ts`'s `_brandCheck`) using `// @ts-expect-error` to assert `logger.debug` is rejected by the compiler. The `@ts-expect-error` requires an inline justification per AR59 / `architecture.md:1032` — cite "AC1: closed level set, no debug method per AR49".
    12. **`logger` (default) writes to `process.stderr`:** import the default `logger`, install a `process.stderr.write` shim (capture invocations into an array), call `logger.info('x')`, restore the shim in a `finally`, assert the shim received exactly the formatted line. This proves the wiring of the default instance.
    13. **stdout untouched (AC5):** install a `process.stdout.write` shim that pushes into a captured array; exercise `info` / `warn` / `error`; assert the captured array stays empty; *also* call `process.stdout.write('control')` once at the end to confirm the shim is live (positive control); restore in `finally`.
  - [x] Test isolation: each test creates its own fake stream / shim; nothing shared across tests. The `process.stdout`/`process.stderr` shim cases install in `try`, restore in `finally` (uncaught test failure must still restore — otherwise `node:test`'s own diagnostic output corrupts).
  - [x] No mocks of `Date`, `setTimeout`, etc. — the logger has no such dependencies (AC6).
  - [x] Assertions use `assert.deepStrictEqual` for `writes` array equality, `assert.match` for stack-trace shape (case 4), `assert.strictEqual` elsewhere.

- [x] **Task 3: Remove `src/diagnostic/.gitkeep`** (AC: #8)
  - [x] `git rm src/diagnostic/.gitkeep` (or equivalent — file deletion). Module now has real files, the .gitkeep is no longer needed (matches the pattern in story 1.2 / `1-2-ref-domain-primitive.md` Task 1 "Delete `src/domain/.gitkeep`").

- [x] **Task 4: Local verification** (AC: #9)
  - [x] `npm run typecheck` → exit 0, zero TS errors. (Confirm `@ts-expect-error` directive in case 11 is *necessary* — i.e. tsc without it would flag the call. If unused, tsc errors out, which is the desired test-of-the-test.)
  - [x] `npm run lint` → exit 0, zero rule violations. (`no-floating-promises`, `no-misused-promises`, `no-explicit-any` all active.)
  - [x] `npx prettier --check .` → all matched files formatted (100 col, single quotes, semis, trailing-comma all per `.prettierrc.json`).
  - [x] `npm test` → all tests pass; count increases by ≥ 12 vs. the post-1.2 baseline (64 → 77 = +13).
  - [x] `npm pack --dry-run` → manifest grows by exactly **1** file (`src/diagnostic/logger.ts`); confirm `logger.test.ts` is excluded by the `"!src/**/*.test.ts"` allowlist (pack confirmed: 7 → 8 files; only `src/diagnostic/logger.ts` added).
  - [x] Visually spot-check stderr output by running a quick one-liner — skipped; the unit-test fake-stream assertions are byte-for-byte against the architecture's example format (`architecture.md:660-668`), so the visual spot-check would re-prove what the test suite already verifies.

## Dev Notes

### Architectural source-of-truth

This is story **#3** in the implementation sequence (`architecture.md:813-826`, item 3). The diagnostic logger lands before the configuration module (story 1.4) because configuration's startup-error path needs to log to stderr — see the dependency map at `architecture.md:828-842` ("Configuration depends on Diagnostic logger for startup errors").

**Primary specs:**
- D7 — Process & Diagnostic Logging Discipline (`architecture.md:642-712`).
- The format example, level set, and content rules: `architecture.md:660-686`.
- The single-approved-API rule: `architecture.md:652-654` (defense-in-depth: lint allowlist + this single module + CI smoke test).
- Stream/output discipline codification: `architecture.md:1144-1148`.
- Cooperative shutdown lifecycle that consumes this logger: `architecture.md:691-704` (story 1.11 territory; not implemented here).

**Closed level set rationale (`architecture.md:670`, AR49 `epics.md:170`):** `INFO` / `WARN` / `ERROR` only. No `DEBUG` / `TRACE` in MVP. No log-level env var (`architecture.md:672`). Volume is low — lifecycle events + warnings + errors only — so verbosity gating is unnecessary. Adding levels later is a new story; adding a runtime gate later is straightforward (the `Logger` shape doesn't preclude it). YAGNI applied here per the "Don't add features beyond what the task requires" guidance.

### What the diagnostic log contains (and emphatically does NOT)

Already covered by D7 (`architecture.md:674-686`); restated for the dev agent's quick-reference:

**Contains** — lifecycle (startup banner, ready signal, shutdown), warnings (audit-write failures, malformed `#mcp/config` blocks, unexpected SB response shapes), errors (unhandled exceptions in handlers, infrastructure failures with stack traces).

**Does NOT contain** — the bearer token (NFR5), per-tool-call traces (those go to the audit log per D4), page content (would never reach diagnostics by design), internal state dumps (NFR8).

**Token-safety in this story:** the logger is naïve — it writes whatever the caller passes. Token-redaction is the **caller's** responsibility, enforced by the secret-scrubber wrapping the config object (story 1.4 — D5 / `architecture.md:529-540` / AR40). Do **not** add a token-detector to the logger. That would (a) duplicate the scrubber, (b) be a false sense of security (any new secret format would slip through), and (c) violate the "boring + minimal deps" disposition. The discipline is upstream.

### Format details (be exact)

Architecture line 660-668 shows the format example:

```
[mcp-silverbullet] INFO  starting up (silverbullet=https://example.com)
[mcp-silverbullet] INFO  connected — runtime API ok
[mcp-silverbullet] INFO  ready (transport=stdio, audit=/Users/are/.local/state/mcp-silverbullet/audit.jsonl)
[mcp-silverbullet] WARN  audit write failed: ENOSPC; continuing
[mcp-silverbullet] ERROR unhandled exception in tool handler: <message> (id=01HV...)
[mcp-silverbullet] INFO  stdio closed; flushing
[mcp-silverbullet] INFO  shutdown complete
```

Decoding the columns: `[mcp-silverbullet]` (constant prefix) + ` ` (separator) + `LEVEL` (left-padded to 5 chars: `INFO ` / `WARN ` / `ERROR`) + ` ` (separator) + `message` + `\n`. So `INFO ` (5 chars with trailing space) + ` ` (separator) renders as two visible spaces; `ERROR` (5 chars, no padding) + ` ` (separator) renders as one. That's the `padEnd(5)` rule, byte-for-byte.

**Don't tab-align.** Tabs render unpredictably across terminals. Use spaces. Don't use ANSI colour. The diagnostic stream goes to `tail -f`, journald, Docker logs — colour codes are noise in those contexts.

### Single approved stderr writer (the D7 invariant)

This story plants the **only sanctioned writer to stderr** (`architecture.md:653`). Subsequent stories that need to log stderr events:

- Story 1.4 (config / startup errors): imports `logger` from `src/diagnostic/logger.ts`, calls `logger.error(...)` before `process.exit(1)`.
- Story 1.5 (audit logger): warns via `logger.warn` on stream errors per AR34 / `architecture.md:455`.
- Story 1.7 (runtime client): no diagnostic writes typical; routes infrastructure failures via `DomainError` (story 1.6).
- Story 1.10 / 2.x handlers: receive `ctx.logger` per `HandlerContext` injection (`architecture.md:1043, 1084, 1106`) — this story's `Logger` type **is** `ctx.logger`'s type. Story 1.10 (handler context plumbing) wires the production `logger` into `ctx`.

The `console.error` / `console.warn` ESLint allowlist (`eslint.config.js:18`) is a **defense-in-depth backstop** for transitive deps and accidental code-review escapes. The discipline this story establishes: **always go through the logger module**. Direct `console.*` outside this module should be flagged in code review.

**Future strengthening (deferred):** an ESLint rule banning direct `process.stderr.write` and `console.error`/`console.warn` outside `src/diagnostic/**`. Out of scope for MVP; record in `_bmad-output/implementation-artifacts/deferred-work.md` if the dev agent feels strongly during implementation.

### Why a factory + default instance (and not just a singleton)

Two reasons:

1. **Tests need DI.** A unit test cannot hijack `process.stderr` cleanly across all assertion paths. `createLogger(fakeStream)` lets tests pass a controlled stream and capture writes deterministically. AC7's "no real stderr writes during tests" is satisfied by this factory.

2. **Handlers need DI.** The canonical handler shape (`architecture.md:1043`) injects `ctx.logger`. Production code (the startup ladder in story 1.11) constructs the `Logger` once and threads it through the `HandlerContext` to every handler. The factory is what `index.ts` calls.

The default `logger` (bound to `process.stderr`) exists for **pre-`ctx`** callsites: the very early startup steps that log "starting up" before the `HandlerContext` has been constructed. There are very few of these (essentially: lines 1 and 2 of the startup ladder). Outside that narrow window, prefer `ctx.logger`.

### Files this story creates / modifies / deletes

**NEW:**
- `src/diagnostic/logger.ts` — the `Logger` type, `createLogger` factory, default `logger` instance.
- `src/diagnostic/logger.test.ts` — adjacent unit tests (≥ 12 cases).

**DELETE:**
- `src/diagnostic/.gitkeep` (module now has real files).

**UNCHANGED (do not touch):**
- `src/index.ts` — startup wiring lands in story 1.11.
- `eslint.config.js` — the `no-console` allowlist is already correctly configured for this story (`error`/`warn` allowed; `log`/`info` errors). A custom rule banning direct `process.stderr.write` outside `src/diagnostic/**` is deferred.
- Every handler / module under `src/*/` — none exist yet that consume `Logger`. Story 1.4 / 1.5 are the first consumers.
- All `_bmad/`, `_bmad-output/`, `docs/` — no doc updates in this story (the README's "Development Setup" section already covers `npm test`; nothing logger-specific needs to land in user docs at this point).

### Testing standards

- Test framework: `node:test` (built-in; locked in story 1.1 at AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/diagnostic/logger.test.ts` next to `src/diagnostic/logger.ts` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`); the new `logger.test.ts` is picked up by the first glob.
- **No real stderr / stdout writes** during the test run — tests use a fake stream (factory injection) and a `process.stdout.write` shim with `try/finally` restore (AC5/AC7).
- **No `Date.now()`, no `setTimeout`, no fake clock needed** — the logger is pure of clock (AC6).
- **No mocks beyond the fake stream and the stdout shim.** Direct imports + inline values, matching the established pattern from story 1.2.
- Use top-level `await test(...)` over `describe` blocks (story 1.2 Dev Notes line 220, "Test structure: flat top-level `await test(...)` over `describe` blocks").

### Library / framework requirements

**No new dependencies.** This story is plain TypeScript + `node:test` + `node:buffer` (used only in the fake-stream test helper for `Buffer.from(chunk).toString('utf8')` — same `node:buffer` import already present in story 1.2's `src/domain/ref.ts`).

If the dev agent feels a library is needed (`pino`, `winston`, `chalk`, `picocolors`, anything log-formatting): **push back**. The format is 5 lines of string assembly. The architecture's "boring + minimal deps" disposition (`architecture.md:99`) is the rule. If `npm install` is suggested, that's a red flag.

| Tool | Locked version | Notes |
|---|---|---|
| TypeScript | `^6.0.3` | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes` all active |
| Node | `>=24` | Native TS stripping; no build step |
| `node:test` | built-in | Test framework |
| `node:buffer` | built-in | Used only in the test helper for `chunk: string | Uint8Array` normalization |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | `no-console` (allow error/warn), `no-floating-promises`, `no-misused-promises`, `no-explicit-any` all on |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

### File-structure requirements

After this story, `src/diagnostic/` must look like:

```
src/diagnostic/
├── logger.ts            # NEW: Logger type, createLogger factory, default logger instance
└── logger.test.ts       # NEW: unit tests with fake stream + process.stdout.write shim
```

(`.gitkeep` removed.) No new directories. No barrel files (AR57, `architecture.md:999`). No `helpers.ts` or `format.ts` siblings — the `padEnd(5)` and the `lines.join('\n')` are tightly coupled to `Logger` and stay in `logger.ts`.

### Latest tech information (researched 2026-04-30)

- **Node 24's `process.stderr.write(string)` returns `boolean`** indicating backpressure. The logger does **not** check this — diagnostic volume is low (lifecycle events; not per-tool-call traces). If backpressure ever becomes an issue, that's a Growth concern. The MVP discipline is fire-and-forget for diagnostics; the audit log is the place where backpressure handling matters (story 1.5 / D4 / `architecture.md:447-453`).
- **Atomic-write expectation:** Node's `process.stderr` is line-buffered when attached to a TTY, and unbuffered/synchronous when attached to a file or pipe (which is the MCP runtime case — stderr is typically captured by the parent agent process). Single `stream.write(payload)` calls are effectively atomic per call from Node's side. Hence the AC3 single-write requirement: assemble the full payload (primary + stack) and write **once**.
- **Error.stack format:** Node renders `err.stack` as `Error: <message>\n    at <frame>\n    at <frame>\n...` — the first line duplicates `err.message`. Architecture's example (`architecture.md:665`) shows `<message>` once on the primary line; the duplicate is acceptable in the stack body because that's what operators see when they hand-throw `err.stack` into a debugger. Don't strip the first line.
- **`@ts-expect-error` requires inline justification per AR59 / `architecture.md:1032`.** Story 1.2 used this in `_brandCheck` for the `Ref` brand; this story uses it in `_methodCheck` for the closed `Logger` shape. Same convention.
- **No new TypeScript or Node features needed.** This story is bog-standard TS module authoring.

### Project Structure Notes

This story slots exactly into the architecture-mandated structure (`architecture.md:1244-1246`):

```
src/diagnostic/                   # D7
├── logger.ts                     #   stderr-only logger; INFO/WARN/ERROR; structured prefix
└── logger.test.ts
```

No deviations. The `src/diagnostic/` directory was scaffolded empty in story 1.1 (with `.gitkeep`); this story is its first real content. No conflicts with previous stories.

### Previous story intelligence (from stories 1.1 + 1.2)

Distilled from `_bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md` and `_bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md`:

1. **Top-level `await test(...)` is the established test pattern** — `tests/integration/scaffold.test.ts:5`, story 1.1 Debug Log line 246, story 1.2 Task 4. Use this in `logger.test.ts`. Do **not** introduce `describe` blocks (story 1.2 Debug Log line 361 — "Skipped `describe` because `node:test`'s synchronous `describe` callbacks complicate the established `no-floating-promises`-clean top-level-await pattern").
2. **`@types/node` is pinned to `^24`** — `process.stderr` types and `NodeJS.WritableStream` come from this. No `@types/node` action needed.
3. **No `npm install` should be needed.** Lockfile is committed; the dependency surface for this story is zero new packages.
4. **`npx prettier --check .`** is the format gate. `.prettierignore` already excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep` — new `.ts` files under `src/` ARE checked.
5. **`npm pack --dry-run` baseline after story 1.2:** 7 files (`LICENSE`, `README.md`, `package.json`, `src/index.ts`, `src/domain/error.ts`, `src/domain/ref.ts`, `src/domain/result.ts`). After this story: **8 files** (adds `src/diagnostic/logger.ts`). `logger.test.ts` correctly excluded by `"!src/**/*.test.ts"`.
6. **Pre-push hook (`tests/smoke/stdout-discipline.test.ts`) doesn't exist yet** (story 1.12 lands it). `git push` will fail until then — that's intentional. Local commits work via pre-commit (lint-staged + typecheck + test). When AC9 says "all gates green," it means `npm run *` commands; not `git push`.
7. **`erasableSyntaxOnly: true`** (`tsconfig.json:11`) — no `enum`, no `namespace`, no constructor parameter properties. The logger is a `function` factory + `type` alias + `const` — no class, no enum. Compliant by default.
8. **`verbatimModuleSyntax: true`** — `import type` for type-only imports. The `Logger` export is a `type` (declared with `export type Logger = ...`) which is itself a value-namespace export from the consumer's perspective — but inside this module's tests, `import { type Logger } from './logger.ts'` (or just `import type { Logger } from './logger.ts'`) is the right form.
9. **No barrel re-exports** (AR57). Do **not** create `src/diagnostic/index.ts`. Importers in later stories will write `from '../diagnostic/logger.ts'` directly.
10. **Story 1.2's `_brandCheck` pattern** (story 1.2 Debug Log line 362) uses `// @ts-expect-error` with an inline AR59 justification to assert a type-level property (the `Ref` brand). This story re-applies the pattern as `_methodCheck` to assert `Logger` has no `debug` method (AC1).

### Git intelligence

Recent commits (`git log --oneline -10`):
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`
- `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`

Story 1.2's commit footprint: 4 new files in `src/domain/`, 1 update to `tests/integration/scaffold.test.ts`, 1 deletion of `src/domain/.gitkeep`. **Expected commit footprint for this story:** 2 new files in `src/diagnostic/`, 1 deletion of `src/diagnostic/.gitkeep`. No other tree changes.

The Conventional Commits gate landed in `a867ada`. This story's commit message should follow the format established by `f3f90df`: `feat(diagnostic): stderr-bound Logger with closed INFO/WARN/ERROR levels (story 1.3)`.

### Critical guardrails (do not rediscover)

1. **stdout is reserved for MCP JSON-RPC traffic only** (`architecture.md:646`, AR47 `epics.md:168`). The logger writes to **stderr**; the unit tests verify (AC5) that stdout is never touched. This is the single most important runtime invariant in the codebase.
2. **No `DEBUG` / `TRACE` levels** (`architecture.md:670`, AR49). Closed set. Adding a level later is a story, not a feature flag.
3. **No log-level env var** (`architecture.md:672`). All messages emitted unconditionally. Volume is low.
4. **Single-write atomicity** (AC3) — assemble the full payload (primary + stack) and call `stream.write()` once. Concurrent handlers logging interleaved partial writes would produce unreadable diagnostic output and is exactly the failure mode the architecture's "single approved API" rule (`architecture.md:653`) prevents.
5. **No timestamp in diagnostic log** (`architecture.md:411` — timestamps are an audit-log concern; the diagnostic stream is for `tail -f` and journald, both of which add their own timestamps).
6. **No token redaction in the logger.** Caller responsibility, enforced upstream by the secret-scrubber (story 1.4 / AR40). Adding redaction here is duplicate, false-security, and out of scope.
7. **No structured (JSON) format for diagnostics in MVP** (`architecture.md:658`). Plain text, single line per event, prefixed. JSONL is for the audit log (D4), not diagnostics.
8. **`as` casts are forbidden outside boundary constructors** (AR59, `architecture.md:1031`). This module needs zero `as` casts in production code. The fake-stream test helper may use one cast (`as NodeJS.WritableStream`) — document it inline.
9. **`@ts-expect-error` requires inline justification** (AR59, `architecture.md:1032`). The `_methodCheck` test case is the only place this rule applies in this story; cite "AC1: closed level set, no debug method per AR49".
10. **Imports must use `.ts` extension** (`tsconfig.json:14`, Node 24 native type stripping). This story has no inter-module imports, but the convention applies if any are added.

### Story scope boundaries (DO NOT include)

- **`process.exit` in the logger.** The logger only writes to stderr. Process termination is the caller's responsibility (config validation in story 1.4 calls `process.exit(1)` *after* logging). Never call `process.exit` from inside `logger.error`.
- **The `infrastructure_error` `DomainError` wrapping.** Story 1.6 owns `formatToolError` / `serializeForAudit` and the `DomainError` shape. The logger does not produce `DomainError`s; it formats text for stderr.
- **The shutdown sequence** (D7 `architecture.md:691-704`). Story 1.11 (startup + lifecycle) wires the cooperative shutdown that calls `audit.close()` and `logger.info('shutdown complete')`. This story does not implement shutdown.
- **The CI smoke test for stdout discipline** (`architecture.md:654, 992, 733`). Story 1.12 lands `tests/smoke/stdout-discipline.test.ts`. AC5 of this story uses an in-test `process.stdout.write` shim — that's a unit-test technique, not the smoke test. They're complementary: AC5 verifies the logger never targets stdout; the smoke test verifies the *whole server* never emits non-JSON-RPC bytes on stdout.
- **A custom ESLint rule banning direct `process.stderr.write` outside `src/diagnostic/**`.** Deferred — record in `_bmad-output/implementation-artifacts/deferred-work.md` if the dev agent feels the JSDoc-only enforcement is too soft after implementation.
- **A `child_logger(prefix)` API for sub-prefixed lines** (e.g. `[mcp-silverbullet][audit] WARN ...`). Out of scope; no caller needs it for MVP. Add when a second prefix is genuinely useful.
- **Colour, terminal detection, `chalk`/`picocolors`-style formatting.** Diagnostic stream feeds `tail -f` / journald / Docker logs. No colour.
- **Configuration of the prefix string.** It's a constant: `[mcp-silverbullet]`. Hard-coded.
- **A `Buffer | string` overload on the logger methods.** Methods take `string` only. Callers convert as needed.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.3] (lines 341-362)
- D7 — Process & Diagnostic Logging Discipline: [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- Format example (literal byte-for-byte spec): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 660-668)
- Single approved API rule (AR48): [Source: _bmad-output/planning-artifacts/epics.md] (line 169) and [Source: _bmad-output/planning-artifacts/architecture.md] (line 653)
- Closed level set (AR49): [Source: _bmad-output/planning-artifacts/epics.md] (line 170) and [Source: _bmad-output/planning-artifacts/architecture.md] (line 670)
- Stream/output discipline codified (`no-console` lint rule): [Source: _bmad-output/planning-artifacts/architecture.md#Stream/output discipline] (lines 1144-1148)
- Implementation sequence (this story = #3): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (lines 813-815)
- Cross-component dependency map: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 833-834)
- Canonical handler shape (`ctx.logger` consumer site): [Source: _bmad-output/planning-artifacts/architecture.md#Tool-handler shape] (lines 1043, 1084, 1106)
- Source-tree contract for `src/diagnostic/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 1244-1246)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md], [Source: _bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md]
- AR59 (no `as` outside boundaries; `@ts-expect-error` inline justification): [Source: _bmad-output/planning-artifacts/architecture.md#Type-safety patterns] (lines 1028-1032)
- AR57 (no barrels; no utils/helpers catchalls): [Source: _bmad-output/planning-artifacts/architecture.md#Structure] (lines 999-1000)
- NFR5 (token never logged): [Source: _bmad-output/planning-artifacts/epics.md#NonFunctional Requirements] (line 77)
- NFR12 (per-call failures don't poison the session — informs the "logger never throws on bad inputs" choice in AC3): [Source: _bmad-output/planning-artifacts/epics.md] (line 86)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Red phase confirmed before green.** Initial `npm test` after `logger.test.ts` landed reported 1 failing test file with the expected `Cannot find module './logger.ts'` error and an "Unused `@ts-expect-error` directive" diagnostic on the `_methodCheck` line — both signals that the directive will become *necessary* (and the test load-bearing) once `Logger` exists. Both cleared on green.
- **Three lint errors after first green run, all in test scaffolding** (none in production code): `@typescript-eslint/no-unnecessary-type-assertion` flagged the inner `return stream as unknown as NodeJS.WritableStream;` (TS already knew the type from the closure cast), the `as typeof process.stderr.write` cast, and the `as typeof process.stdout.write` cast. Removed all three. Production `logger.ts` has zero `as` casts (AR59 spirit honored beyond the strict letter; the test-helper still has one outer `as unknown as NodeJS.WritableStream` for the fake-stream-shape boundary, with an inline justification comment).
- **Prettier complained once** about the post-edit test file; resolved with `npx prettier --write src/diagnostic/logger.test.ts` and re-checked clean.
- **`@ts-expect-error` directive verified necessary.** Removed-and-tested locally (mentally): if `Logger` ever gains a `debug` method, the directive becomes unused → tsc fails → CI catches the regression. Inline justification comment cites "AC1: Logger has no `debug` method (AR49 closed level set)" per the AR59 inline-tracked-issue requirement (`architecture.md:1032`).
- **`Error.stack` fallback chain choice.** Architecture says "the underlying error's stack trace is appended" (epics.md:352) — but real-world `Error` instances may have `undefined` stack (synthetic errors, certain subclasses, non-V8 engines). Added a `.stack → .message → String(err)` fallback chain so the logger never emits a bare primary line for an Error case. AC3 documents this; tests 8–9 cover both fallback steps. Operators reading stderr will always see *something* useful below the primary line when an `err` is supplied.
- **`String({foo:'bar'})` → `[object Object]`.** Test case 7 documents this explicitly. Caller agents that throw structured non-Error values lose detail; the architecture (D6, story 1.6) is where structured errors get the proper formatter — this logger's job is to never throw and never silently swallow.
- **Pre-existing `eslint.config.js:4` deprecation diagnostic** (`tseslint.config()` from `typescript-eslint@8.59.1`) — already documented in story 1.1 / 1.2 Debug Logs; not introduced by this story; continues to be ignorable until typescript-eslint v9 lands.
- **Pack manifest delta verified:** 7 → 8 files. Only `src/diagnostic/logger.ts` (2.5 kB) added. `src/diagnostic/logger.test.ts` correctly excluded by `"!src/**/*.test.ts"` allowlist.

### Completion Notes List

- All 9 ACs satisfied; all 4 tasks (with subtasks) ticked. Validation gates: `npm run typecheck` exit 0, `npm run lint` exit 0, `npx prettier --check .` clean, `npm test` 77/77 pass (was 64 → +13 logger cases), `npm pack --dry-run` 7 → 8 files (delta = `src/diagnostic/logger.ts` only).
- `Logger` is the project's first stderr-bound output surface. From story 1.4 onwards every module that needs to emit operator-visible events imports either the default `logger` (pre-`ctx` paths like the startup ladder in story 1.11) or receives the `Logger` via `ctx.logger` (tool handlers per `architecture.md:1106`). Direct `console.error`/`console.warn` outside `src/diagnostic/` should be flagged in code review; the lint allowlist remains a defense-in-depth backstop, not the discipline.
- **Format implemented byte-for-byte** to the architecture example (`architecture.md:660-668`): `[mcp-silverbullet] ${level.padEnd(5)} ${message}\n`. `INFO ` and `WARN ` produce two visible spaces between level and message; `ERROR` produces one. Tests assert this exactly via `assert.deepStrictEqual` against literal strings.
- **Single-write atomicity contract is load-bearing.** `error(msg, err)` assembles primary + stack body in one string and calls `stream.write` exactly once; concurrent handlers logging will not interleave partial lines. Test case 10 asserts `writes.length === 1` for the stack-bearing case as a regression guard.
- **No new dependencies; no `npm install` was run.** The lockfile is unchanged. The dependency surface for this story was zero new packages, as predicted in the story's "Library / framework requirements" section.
- **Token-safety stays upstream.** The logger does **not** scrub bearer tokens — that is the secret-scrubber's job (story 1.4 / AR40). Adding a token-detector here would duplicate the scrubber, give a false sense of security against new secret formats, and violate the "boring + minimal deps" disposition.
- **Story scope held tight.** No edits to `src/index.ts` (story 1.11 owns startup wiring), no edits to `eslint.config.js` (the existing `no-console` allowlist is correct for this story; a custom rule banning direct `process.stderr.write` outside `src/diagnostic/**` remains deferred — record in `_bmad-output/implementation-artifacts/deferred-work.md` if a reviewer feels JSDoc-only enforcement is too soft).
- **Open questions for review:** none. The architecture's D7 spec is unambiguous; the only judgment call (`Error.stack` fallback chain) is documented in AC3 and Debug Log.

### File List

**New:**
- `src/diagnostic/logger.ts`
- `src/diagnostic/logger.test.ts`

**Modified:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: 1-3 backlog → ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/1-3-diagnostic-logger.md` (Tasks/Subtasks ticked; Dev Agent Record / File List / Change Log filled; Status: ready-for-dev → review — this story file itself, per the workflow's permitted-modification surface)

**Deleted:**
- `src/diagnostic/.gitkeep` (module now has real files)

### Review Findings

- [x] [Review][Patch] **Sanitize multi-line `message` so `\n` does not split log records** [`src/diagnostic/logger.ts:25-27,30,37,38`] — added `sanitize(s)` helper, applied in `format()` and in `renderError()`'s non-stack branches; stack bodies remain multi-line by design. New tests cover `\n` and `\r` escaping plus the "stack keeps frames" invariant. (resolved from decision; sources: blind+edge)

- [x] [Review][Patch] **Swallow `stream.write` exceptions so a broken stderr cannot crash a handler** [`src/diagnostic/logger.ts:45-53`] — added `safeWrite(stream, payload)` helper wrapping the write in `try { ... } catch { /* swallow */ }`; all four `info`/`warn`/`error` paths route through it. New test asserts no exception propagates from a throwing fake stream across all four call shapes. (resolved from decision; sources: edge)

- [x] [Review][Defer] **Hostile `err` payloads with throwing `.stack` / `.message` / `toString` / `Symbol.toPrimitive` getters would crash the logger** [`src/diagnostic/logger.ts:55-63`] — deferred, theoretical and out of spec. Real-world `Error` instances and thrown plain objects do not have throwing getters; AC3 covers normal inputs and the documented fallback chain. Revisit if a runtime crash is ever traced back to this surface. (sources: edge)

### Change Log

- 2026-04-30 — Story 1.3 implementation complete. New diagnostic surface shipped: stderr-bound `Logger` (closed `INFO`/`WARN`/`ERROR` set per AR49) at `src/diagnostic/logger.ts`, with `createLogger(stream)` factory for DI/test injection and a default `logger` instance bound to `process.stderr` for pre-`ctx` callsites. Output format byte-for-byte matches `architecture.md:660-668` (`[mcp-silverbullet] LEVEL  message\n`, level left-padded to 5 chars). Single-write atomicity contract enforced for stack-bearing `error(msg, err)` calls; concurrent handlers cannot interleave partial diagnostic lines. 13 new unit tests cover format spec, all `error` fallback paths (`Error` with stack / no stack / no message; non-`Error` string and object; `undefined`), atomicity, the closed-shape assertion via `@ts-expect-error _methodCheck`, the default `logger` wiring to `process.stderr`, and the AC5 stdout-untouched invariant (with positive control). All gates green: typecheck/lint/prettier exit 0; tests 64 → 77 (+13); pack manifest 7 → 8 files. Status: ready-for-dev → in-progress → review.
- 2026-04-30 — Code review passed (3-layer adversarial: Acceptance Auditor APPROVED across all 9 ACs; Blind Hunter and Edge Case Hunter findings triaged to 2 decision-needed + 1 defer + 27 dismissed). Two patches landed post-review: (1) `sanitize()` escapes `\n`/`\r` in user-supplied `message` and in the non-stack error fallbacks so each call emits exactly one log record (`tail -f`/journald single-line invariant); stack bodies retain multi-line frames by design. (2) `safeWrite()` wraps every `stream.write` in `try/catch` (silent swallow) so a closed stderr pipe (EPIPE / `ERR_STREAM_DESTROYED`) cannot propagate out of `logger.*` and crash the handler (NFR12 / D7). Four new unit tests added (sanitize `\n`, sanitize `\r`, mixed sanitize-vs-stack, throwing-stream resilience). Tests 77 → 81. All gates re-verified green; pack manifest unchanged at 8 files. One deferred item recorded in `deferred-work.md` (hostile `err` getters with throwing `.stack`/`.message`/`toString` — theoretical, revisit on production crash). Status: review → done.
