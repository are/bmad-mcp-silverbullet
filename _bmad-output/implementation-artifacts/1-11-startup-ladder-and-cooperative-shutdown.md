# Story 1.11: Startup Ladder & Cooperative Shutdown

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As Maya launching the server via `npx`,
I want a deterministic fail-fast startup probe and a clean cooperative shutdown,
So that misconfiguration produces actionable errors immediately and the server never leaves orphaned Node processes when the agent runtime disconnects.

## Acceptance Criteria

**AC1 — Startup ladder at `src/index.ts` executes the D5 sequence in order**

**Given** `src/index.ts` invoked as `node ./src/index.ts` (or via the `bin` resolution from `npx @are/mcp-silverbullet`),
**When** the process starts,
**Then** it runs the deterministic startup ladder in this exact order, fail-fast on any step:

1. **Read env vars.** `process.env` is captured once into a frozen snapshot — every downstream reader (config, audit logger) reads from the snapshot, NOT `process.env` directly. (Defends against env mutation by transitive deps after step 1.)
2. **Validate config (zod).** Calls `loadConfigOrExit(envSnapshot, logger)` from `src/config/config.ts`. Failure paths emit the AR39 FATAL+hint via the diagnostic logger and `process.exit(1)`. Successful return wraps the config via `wrapConfig` (already done inside `loadConfigOrExit`).
3. **Resolve audit log path + open audit stream.** Calls `openAuditLogger({ env: envSnapshot, platform: process.platform, homeDir: os.homedir(), clock: () => new Date(), logger })`. The composition resolves the path, `mkdir -p` with mode `0o700` if missing, and opens the append-only write stream. Failure → `logger.error(...)` then `process.exit(1)`.
4. **`GET /.ping`.** Calls `client.ping()` on a `RuntimeClient` constructed via `createRuntimeClient({ config })`. Failure paths surface as `infrastructure_error` `DomainError`s thrown by the client; the ladder maps them to AR39 messages by inspecting `details.code` (`ESBRUNTIME` / `EUNAUTHORIZED` / `EBADSTATUS` / native errno like `ECONNREFUSED`).
5. **`POST /.runtime/lua` body `1`.** Calls `client.probe()`. Same error-mapping discipline as step 4; `EUNAUTHORIZED` here MUST emit the auth-failed hint (the bearer token is exercised by `probe`, not `ping`, in the current SB setup).
6. **Connect MCP stdio transport.** Constructs `new McpServer({ name: 'mcp-silverbullet', version })` from `@modelcontextprotocol/sdk/server/mcp.js`, calls `registerTools({ server, ctx, lifecycle })` (Task 2), constructs `new StdioServerTransport()` from `@modelcontextprotocol/sdk/server/stdio.js`, then `await server.connect(transport)`. Once `connect` resolves, lifecycle state transitions from `'starting'` to `'serving'`.

**And** the version embedded into `McpServer`'s `Implementation` field is read from `package.json` via a single `import pkg from '../package.json' with { type: 'json' };` at the top of `src/index.ts` (or via `readFileSync` + `JSON.parse` if the import-attribute syntax is unstable on the Node 24.x floor — verified at implementation time against `node:tsc` typecheck and `node --test` runtime).

**And** the diagnostic logger emits the AR50 lifecycle banners during the ladder:
- After step 2: `logger.info(\`starting up (silverbullet=${config.silverbulletUrl})\`)` — `config.silverbulletUrl` is unwrapped via `String(config)` ONLY through the wrapped config's `toString` (which redacts the token); for the URL specifically, `config.silverbulletUrl` is the raw string and SAFE to log per AR40 / NFR5 (only the token is sensitive).
- After step 5: `logger.info('connected — runtime API ok')`.
- After step 6: `logger.info(\`ready (transport=stdio, audit=${auditFilePath})\`)`.

**And** `package.json` is UNCHANGED — no script changes, no dep additions; `@modelcontextprotocol/sdk` is already a runtime dep (`package.json:37`).

**AC2 — Distinct startup error messages per failure category (AR39)**

**Given** the startup ladder reaches step 4 or 5 and the underlying `client.ping()` / `client.probe()` rejects with an `infrastructure_error` `DomainError`,
**When** the ladder's catch block translates the failure to an AR39 fatal line,
**Then** the mapping is:

| `details.code` | FATAL line | hint line |
|---|---|---|
| `'ESBRUNTIME'` | `[mcp-silverbullet] FATAL: SilverBullet Runtime API not enabled (HTTP 503)` | `[mcp-silverbullet] hint: see https://silverbullet.md/Runtime%20API — Chrome/Chromium must be installed, or use the -runtime-api Docker variant` |
| `'EUNAUTHORIZED'` | `[mcp-silverbullet] FATAL: SilverBullet authentication failed` | `[mcp-silverbullet] hint: check SILVERBULLET_TOKEN` |
| `'EBADSTATUS'` | `[mcp-silverbullet] FATAL: SilverBullet returned HTTP <status>` | `[mcp-silverbullet] hint: see <SILVERBULLET_URL>/.ping in a browser to verify the endpoint` |
| `'EBADRESPONSE'` | `[mcp-silverbullet] FATAL: SilverBullet returned an unparseable response` | `[mcp-silverbullet] hint: verify the Runtime API is enabled and not behind a proxy that rewrites bodies` |
| `'ECONNREFUSED'` (native errno) | `[mcp-silverbullet] FATAL: cannot connect to SilverBullet at <SILVERBULLET_URL>` | `[mcp-silverbullet] hint: check the URL and that SilverBullet is running` |
| `'ENOTFOUND'` (native errno) | `[mcp-silverbullet] FATAL: SilverBullet hostname did not resolve` | `[mcp-silverbullet] hint: check SILVERBULLET_URL` |
| any other or absent | `[mcp-silverbullet] FATAL: SilverBullet unreachable` | `[mcp-silverbullet] hint: <details.underlying.message slice 200 chars>` (scrubbed by `infrastructureError`) |

**And** the `<status>` placeholder in `'EBADSTATUS'` is read from `details.status` (the runtime client populates this on non-2xx); fall back to the literal `???` if absent.

**And** the `<SILVERBULLET_URL>` placeholder uses `config.silverbulletUrl` — the URL is NOT a secret per NFR5 (only the token is). The token is NEVER inserted into any FATAL or hint line.

**And** all paths exit with code `1` (per AR39 — distinct exit codes per category is Growth / AR77).

**And** the ladder catches `DomainError` shape via the structural `isDomainError` test from `src/mcp/handler-template.ts:182`. Non-DomainError throws (highly unlikely from the runtime client, but possible from `os.homedir()` / `mkdirSync`) are wrapped via `infrastructureError(err)` first, then formatted with the same table.

**AC3 — Cold start completes within 3s on a healthy SB (NFR3)**

**Given** a reachable SilverBullet instance with the Runtime API enabled,
**When** the startup ladder runs end-to-end,
**Then** the wall-clock duration from `node ./src/index.ts` to the `ready (transport=stdio, ...)` banner is ≤ **3000 ms** (NFR3 / `epics.md:73`).

**And** an integration test at `tests/integration/startup-ladder.test.ts` measures synthetic ladder duration with a mocked `RuntimeClient` (`ping()` and `probe()` resolve immediately) and asserts `durationMs < 3000`. (Real-network NFR3 verification is operator territory; this test pins the synthetic floor — NO accidental sleeps / blocking I/O introduced by future refactors.)

**AC4 — Cooperative shutdown sequence on stdio close, SIGINT, SIGTERM (NFR9, AR51)**

**Given** the server is in `'serving'` state and one of `stdin.on('end')` / `stdin.on('close')` / `process.on('SIGINT')` / `process.on('SIGTERM')` fires,
**When** the shutdown sequence executes,
**Then** it runs these steps in order, **all** within NFR9's **1000 ms** budget on a healthy state:

1. **Mark draining.** Lifecycle state transitions from `'serving'` to `'draining'`. The `lifecycle.isDraining()` predicate now returns `true`. `logger.info('stdio closed; flushing')` (or the appropriate signal-named variant: `'received SIGINT; flushing'` / `'received SIGTERM; flushing'`).
2. **Reject new tool calls.** Any tool callback firing AFTER the draining mark MUST short-circuit before invoking the underlying handler — the registry wrapper checks `lifecycle.isDraining()` first; if true, builds an `infrastructureError(new Error('server shutting down'))` `DomainError`, writes EXACTLY ONE audit entry (`tool, args: input, decision: 'rejected', response: undefined, durationMs: 0, reason: 'infrastructure_error', details: { underlying: ... }`), and returns `formatToolError(...)` directly. **The underlying handler (`handleListPages` / `handleSearchPages` / `handleReadPage`) is NEVER invoked in the draining state** — verified by mock-call-count assertions in tests.
3. **Await in-flight tool calls.** Wait for every promise registered via `lifecycle.trackInflight(p)` to settle (`Promise.allSettled`). In-flight calls are bounded by their own timeouts (Story 1.7's runtime client has no fetch timeout yet — deferred per `deferred-work.md:27` — so a hung SB call is bounded only by the hard-stop timer in step 7).
4. **Flush audit.** `await ctx.audit.close()` — drains the in-memory queue and `stream.end()`s the underlying file stream per `src/audit/audit-logger.ts:430-481`. The audit logger's `close()` resolves within the bounded budget per its own contract.
5. **Close runtime client.** Currently a no-op — `RuntimeClient` (Story 1.7) has no per-request connection pool to drain (`globalThis.fetch` manages its own). The shutdown sequence calls a `closeRuntime` hook anyway (an empty async function for now) so the future addition of an `AbortController` / connection pool (per `deferred-work.md:27`) lands at a sanctioned seam without re-architecting the shutdown.
6. **Close MCP transport.** `await server.close()` — the `McpServer.close()` from the SDK closes the `Transport` it owns and tears down its protocol state. Wrap with try/catch; a transport-close failure is logged at WARN but does NOT prevent the process from exiting.
7. **`process.exit(0)`.** Lifecycle state transitions from `'draining'` to `'shutdown'`; `logger.info('shutdown complete')`; `process.exit(0)`.

**And** the shutdown sequence is **idempotent** — multiple signals (e.g., SIGINT followed by SIGTERM, or stdin-close + SIGINT) trigger only ONE shutdown run. The lifecycle's `state !== 'serving'` check at the top of the shutdown handler is the gate.

**And** signal handlers and stream listeners are installed AFTER step 6 of the startup ladder — installing them earlier risks racing the audit logger's open and would require synthetic state-machine handling for the "shutdown signal arrived during startup" edge.

**And** all four trigger paths (`stdin end`, `stdin close`, `SIGINT`, `SIGTERM`) call the same shutdown function. The diagnostic-banner WORD differs per trigger: `'stdio closed'` for stream-end; `'received SIGINT'` / `'received SIGTERM'` for signals.

**AC5 — Hard-stop force-exit at ~900 ms if shutdown hangs (AR51)**

**Given** the shutdown sequence has begun,
**When** `setTimeout(forceExit, 900)` fires before step 7 completes,
**Then** `forceExit`:

1. Logs at WARN: `logger.warn('shutdown exceeded 900ms — forcing exit')`.
2. Calls `process.exit(1)` (NOT `process.exit(0)` — a force-exited shutdown indicates degraded state; the operator should see the non-zero exit code in their MCP-client logs).

**And** the hard-stop timer is set with `setTimeout(forceExit, 900).unref()` so it does NOT itself keep the event loop alive — without `.unref()`, a fast shutdown that completes in 50ms would still wait for the 900ms timer to fire before the loop drains.

**And** the timer is the FIRST thing the shutdown sequence sets (immediately after the `state === 'serving'` gate), so a shutdown that hangs at step 1 / 2 / 3 / 4 / 5 / 6 still terminates within 900ms.

**And** integration tests at `tests/integration/startup-ladder.test.ts` assert the hard-stop path with mocked timers (Node's `node:test` provides `mock.timers.enable({ apis: ['setTimeout'] })` — used to advance the 900ms boundary deterministically without real wall-clock waits).

**AC6 — Top-level catch for unhandled exceptions and promise rejections (AR52, NFR12)**

**Given** the process reaches `'serving'` state,
**When** an `'uncaughtException'` or `'unhandledRejection'` event fires on `process`,
**Then** the registered handler:

1. Logs at ERROR via `logger.error('<event>: <message>', err)` — the diagnostic logger renders the full stack trace per `src/diagnostic/logger.ts:35-42`. Operator gets the trace; per AR45 #4 the AGENT never sees stack traces (the per-handler `try/catch/finally` already converts internal throws to `infrastructure_error` for the agent's tool result).
2. Does **NOT** call `process.exit` — NFR12 (`epics.md:86`) mandates per-call failures don't poison the session. The process keeps serving subsequent tool calls.

**And** these handlers are installed once during step 6 of the startup ladder (after `server.connect`), NOT during step 1 — installing earlier intercepts startup-ladder failures the ladder is supposed to handle deterministically.

**And** the per-handler `try/catch/finally` in Story 1.10 already converts handler-internal throws to `infrastructure_error` for the agent's tool result (Story 1.10 AC7). The top-level catch is the safety net for throws that escape the handler boundary entirely (e.g., a microtask scheduled by `client.exec` that throws after the handler returned, an unhandled promise rejection in a fire-and-forget audit-write — though Story 1.5 already pins audit-write as throw-safe).

**And** an `'unhandledRejection'` whose `reason` is a `DomainError` (per `isDomainError`) is logged with the same `logger.error` line but does NOT trigger any tool-result re-emission — the in-flight handler that produced it has already returned to the SDK; this path is purely a diagnostic record.

**AC7 — Tool registry at `src/mcp/registry.ts` wires the three Story 1.10 handlers**

**Given** the new module at `src/mcp/registry.ts`,
**When** I read it,
**Then** it exports:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HandlerContext } from './handler-template.ts';

export type LifecycleHandle = {
  isDraining(): boolean;
  trackInflight<T>(promise: Promise<T>): Promise<T>;
};

export type RegisterToolsOptions = {
  readonly server: McpServer;
  readonly ctx: HandlerContext;
  readonly lifecycle: LifecycleHandle;
};

export function registerTools(opts: RegisterToolsOptions): void;
```

**And** `registerTools(...)` calls `server.registerTool(name, config, cb)` for each of the three Story 1.10 handlers (`list_pages`, `search_pages`, `read_page`). The SDK callback for each tool follows this shape:

```typescript
async (args, _extra) => {
  // The SDK passes `args` as the validated input under `inputSchema`;
  // we declared `inputSchema: undefined` (or omitted it) for list/search/read
  // so `args` arrives as the RAW JSON-RPC `arguments` field. Each handler
  // does its own zod parse — duplicating SDK validation costs nothing and
  // keeps the strict-rejection AC8 contract (Story 1.10) at the handler.
  if (lifecycle.isDraining()) {
    const error = infrastructureError(new Error('server shutting down'));
    ctx.audit.write({
      tool: name,
      args,
      decision: 'rejected',
      response: undefined,
      durationMs: 0,
      reason: error.reason,
      details: error.details,
    });
    return formatToolError(error);
  }
  return await lifecycle.trackInflight(handler(args, ctx));
};
```

**And** the `name` / `description` / `inputSchema` (omitted for now) / `annotations` per tool match these literals:

| Tool name | Description | Annotations |
|---|---|---|
| `list_pages` | `List page refs in the SilverBullet space. Pages declared none-mode are filtered server-side.` | `{ readOnlyHint: true, openWorldHint: false }` |
| `search_pages` | `Search the SilverBullet space by query. Pages declared none-mode are filtered server-side.` | `{ readOnlyHint: true, openWorldHint: false }` |
| `read_page` | `Read the body of a page by ref. Returns not_found for none-mode pages (deliberately invisible).` | `{ readOnlyHint: true, openWorldHint: false }` |

(The annotations are advisory hints for MCP clients; `readOnlyHint: true` is correct for Epic 1 read-side handlers. Stories 2.x will register write-side handlers with `readOnlyHint: false`.)

**And** the registry is the ONLY module in the repo that imports `@modelcontextprotocol/sdk/server/mcp.js` — `src/index.ts` imports `McpServer` from the same path for the constructor only. Handlers and tests do NOT import the SDK (Story 1.10 already enforced this; this story preserves the seam).

**And** `registerTools` does NOT call `server.connect(...)` — that lives in `src/index.ts` so the registry stays test-friendly (tests construct `McpServer`, register tools, then connect to a fake transport in-memory).

**AC8 — Lifecycle module at `src/index.ts` (or co-located helper)**

**Given** the lifecycle owner inside `src/index.ts`,
**When** I read it,
**Then** it exposes a private `createLifecycle(): { handle: LifecycleHandle; markDraining(): void; awaitInflight(): Promise<void>; state(): LifecycleState }` factory:

```typescript
type LifecycleState = 'starting' | 'serving' | 'draining' | 'shutdown';
```

**And** the factory's contract:

1. `state` starts at `'starting'`; flips to `'serving'` after `server.connect(transport)` resolves; flips to `'draining'` on the first call to `markDraining()`; flips to `'shutdown'` immediately before `process.exit`.
2. `handle.isDraining()` returns `true` iff `state === 'draining' || state === 'shutdown'`.
3. `handle.trackInflight(p)` registers `p` in an internal `Set<Promise<unknown>>`, attaches a `.finally(() => set.delete(p))` to remove it on settle, and returns a Promise that resolves / rejects exactly when `p` does. **It does NOT swallow `p`'s rejection** — the SDK's tool callback awaits this; a rejection here surfaces as the SDK's own infra failure (which then becomes a tool-error response on the wire). In practice handlers don't reject (they always resolve with a `ToolResult`); the `trackInflight` rejection branch is defensive.
4. `awaitInflight()` returns `Promise.allSettled([...set])` — never rejects; the shutdown sequence calls it during step 3.

**And** the lifecycle factory is implemented inline in `src/index.ts` (NOT extracted to its own module) — this story is the only consumer; extracting it costs more than it earns. If Stories 2.x want to reuse it, the extraction lands then.

**AC9 — Integration tests at `tests/integration/startup-ladder.test.ts`**

**Given** the test file at `tests/integration/startup-ladder.test.ts`,
**When** `npm test` runs,
**Then** the suite covers (≥ **14 cases**, top-level `await test(...)`):

**Startup ladder happy path + cold-start budget (AC1, AC3):**

1. Happy path: env populated with valid `SILVERBULLET_URL` + `SILVERBULLET_TOKEN`; mocked `RuntimeClient` (`ping()` and `probe()` resolve immediately); the ladder reaches `'serving'` state; `auditFilePath` is the resolved path; the three lifecycle banners appear in order on the captured logger.
2. Cold-start budget: same setup; assert the synthetic ladder duration `< 3000` ms with `node:test`'s `mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] })` and a real-time clock around the ladder call (the mocks are off for the duration measurement; the assertion is purely a "no accidental delay" floor).

**Startup ladder failure paths (AC2):**

3. `ESBRUNTIME`: mocked `client.probe()` rejects with `infrastructureError({ code: 'ESBRUNTIME', status: 503 })`; assert `process.exit(1)` is called via the injected `exitFn`; assert the captured stderr contains the literal `'SilverBullet Runtime API not enabled (HTTP 503)'`; assert the audit stream is opened then closed (not leaked).
4. `EUNAUTHORIZED`: mocked `client.probe()` rejects with `infrastructureError({ code: 'EUNAUTHORIZED', status: 401 })`; assert FATAL line is `'SilverBullet authentication failed'`; assert hint mentions `SILVERBULLET_TOKEN` (the variable name, NOT the value).
5. `EBADSTATUS`: mocked `client.ping()` rejects with `infrastructureError({ code: 'EBADSTATUS', status: 500 })`; assert FATAL line includes `'HTTP 500'`.
6. `ECONNREFUSED`: mocked `client.ping()` rejects with `infrastructureError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))`; assert FATAL line names the SB URL.
7. Missing env: empty env → `loadConfigOrExit` calls `exitFn(1)` (already pinned by Story 1.4's tests; this case re-asserts at the ladder level that we surface the failure rather than swallow it).
8. Malformed audit path: env's `MCP_SILVERBULLET_AUDIT_LOG_PATH` points at an unwritable directory (e.g., a path under a `mkdirSync`-failing fake fs); assert ladder exits 1 with a stderr line that names the variable. (Use a fake `mkdirSync` injected via dependency-injection — see AC10.)

**Cooperative shutdown (AC4, AC5):**

9. Stdin end triggers shutdown: ladder reaches `'serving'`; emit `'end'` on a fake stdin Readable; assert the lifecycle transitions through `'draining'` and reaches `'shutdown'`; assert audit `close()` was called; assert `server.close()` was called; assert `exitFn(0)` fired; assert the diagnostic stream contains both `'stdio closed; flushing'` and `'shutdown complete'`.
10. SIGINT triggers shutdown: same end-state; banner is `'received SIGINT; flushing'`. Use a synthetic process EventEmitter (the test wires `process.emit('SIGINT')` on a fake `process` injected via the entry-point function's `deps.process`).
11. SIGTERM triggers shutdown: same end-state; banner is `'received SIGTERM; flushing'`.
12. New tool call during draining is rejected: enter `'serving'`, emit SIGINT, then BEFORE `awaitInflight` resolves call one of the three registered tool callbacks via the SDK harness; assert the response is an `isError: true` tool result with text containing `'server shutting down'`; assert the audit logger received exactly one entry with `decision: 'rejected'`, `reason: 'infrastructure_error'`; assert the underlying handler was never called (mock-call-count zero on the handler).
13. In-flight tool call resolves before exit: enter `'serving'`; trigger a long-running mock `client.exec` (returns a Promise that resolves on a controlled signal); call `handleListPages` via the SDK harness; emit SIGINT; assert `process.exit(0)` is NOT called until the in-flight call settles; resolve the mock; assert exit fires after settle.
14. Hard-stop force-exit: enter `'serving'`; trigger an in-flight `client.exec` that NEVER resolves; emit SIGINT; advance the mock clock by 900 ms via `mock.timers.tick(900)`; assert `exitFn(1)` fires (NOT 0); assert the WARN line `'shutdown exceeded 900ms — forcing exit'` appears in the diagnostic stream.

**Top-level unhandled exceptions (AC6):**

15. Top-level `uncaughtException`: in `'serving'` state, emit `process.emit('uncaughtException', new Error('boom'))`; assert `logger.error` recorded a line containing `'boom'` plus the stack; assert `exitFn` was NOT called; assert lifecycle state remains `'serving'`.
16. Top-level `unhandledRejection`: in `'serving'` state, emit `process.emit('unhandledRejection', new Error('boom'), Promise.resolve())`; assert `logger.error` recorded the rejection; assert `exitFn` was NOT called.

**Idempotency (AC4):**

17. Double signal: emit SIGINT twice in quick succession; assert the shutdown sequence runs ONCE (audit.close, server.close, exitFn each called exactly once).

**And** every test uses dependency injection (no real `process`, no real `setTimeout`, no real `os.homedir`, no real `fs.mkdirSync`, no real `fs.createWriteStream`) — the entry-point function takes a `deps: StartupDeps` parameter (AC10) and tests pass fakes.

**And** every test exits cleanly within `node:test`'s default 30s per-test timeout. None of the tests touch `process.exit` for real (the injected `exitFn` is a spy that records the code and returns `never` via a deliberate `throw` — the ladder's call to `exitFn(1)` in tests effectively halts via the throw).

**AC10 — Dependency injection seam for `src/index.ts`**

**Given** `src/index.ts`,
**When** I read it,
**Then** the file exports a `runServer(deps: StartupDeps): Promise<void>` function (the testable seam) and has a `main()` invocation at the bottom that calls `runServer(productionDeps)`. Both `runServer` and `productionDeps` are exported (test imports `runServer` directly; the bottom-of-file `void main(); — guarded by the import-this-file-directly test below — runs only when the module is the entry point).

**And** the `StartupDeps` type names every external surface the ladder touches, so tests inject fakes:

```typescript
export type StartupDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly mkdir: (path: string, opts: { recursive: true; mode: number }) => void;
  readonly createWriteStream: (path: string, opts: { flags: 'a' }) => NodeJS.WritableStream;
  readonly fetch: typeof globalThis.fetch;
  readonly stdin: NodeJS.ReadableStream;  // for the stdin-close shutdown signal
  readonly process: {
    on(event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection', cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
    exit(code?: number): never;
  };
  readonly setTimeout: (cb: () => void, ms: number) => { unref(): void };
  readonly mcpServerFactory: (info: { name: string; version: string }) => McpServer;
  readonly stdioTransportFactory: () => StdioServerTransport;
};
```

**And** `productionDeps` wires every field to the real Node API: `process.env`, `process.platform`, `os.homedir()`, `() => new Date()`, the production `logger` const from `src/diagnostic/logger.ts`, `node:fs`'s `mkdirSync` and `createWriteStream`, `globalThis.fetch`, `process.stdin`, an adapter object exposing the four `process.*` methods, `globalThis.setTimeout`, `(info) => new McpServer(info)`, `() => new StdioServerTransport()`.

**And** the `mkdir` / `createWriteStream` injection is wired through to `openAuditLogger` indirectly: this story does NOT modify `openAuditLogger`'s signature (it already takes `env`/`platform`/`homeDir`/`clock`/`logger`). For tests that need to fail audit-stream open, the test injects a fake `fs.createWriteStream` via `(globalThis as Record<PropertyKey, unknown>).__patchedCreateWriteStream` — NO. Cleaner: refactor `openAuditLogger` to accept optional `mkdir` + `createWriteStream` injection? **NO — out of scope.** Story 1.5's `openAuditLogger` is sealed; this story adapts by either (a) running the production composition unconditionally and asserting on the captured stderr after a real `EACCES` test (impractical in CI), or (b) **injecting a custom audit-logger factory** at the `StartupDeps` level instead of `mkdir`/`createWriteStream`:

```typescript
readonly auditLoggerFactory: (opts: OpenAuditLoggerOptions) => { logger: AuditLogger; filePath: string };
```

That's the right shape — `productionDeps.auditLoggerFactory = openAuditLogger` (re-exported from `src/audit/audit-logger.ts`). Tests inject a fake factory that throws or returns canned values. **Use `auditLoggerFactory` in `StartupDeps`; drop `mkdir` + `createWriteStream` from the type.** The runtime client gets the same treatment via `runtimeClientFactory`:

```typescript
readonly auditLoggerFactory: (opts: OpenAuditLoggerOptions) => { logger: AuditLogger; filePath: string };
readonly runtimeClientFactory: (opts: CreateRuntimeClientOptions) => RuntimeClient;
```

**Final `StartupDeps` (canonical):**

```typescript
export type StartupDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly auditLoggerFactory: (opts: OpenAuditLoggerOptions) => {
    logger: AuditLogger;
    filePath: string;
  };
  readonly runtimeClientFactory: (opts: CreateRuntimeClientOptions) => RuntimeClient;
  readonly stdin: NodeJS.ReadableStream;
  readonly process: ProcessLike;
  readonly setTimeout: SetTimeoutLike;
  readonly mcpServerFactory: (info: { name: string; version: string }) => McpServer;
  readonly stdioTransportFactory: () => StdioServerTransport;
};
```

(Where `ProcessLike` and `SetTimeoutLike` are co-located narrow interfaces capturing only what `runServer` uses.)

**AC11 — File structure, pack manifest, all gates green**

**Given** the project after this story,
**When** I list the changed files,
**Then**:

**NEW:**

- `src/mcp/registry.ts` — `LifecycleHandle`, `RegisterToolsOptions`, `registerTools`. ≤ 100 lines.
- `tests/integration/startup-ladder.test.ts` — ≥ 17 cases per AC9.

**MODIFIED:**

- `src/index.ts` — full rewrite from the 5-line stub to the production startup ladder + lifecycle + shutdown + signal handlers + `runServer`/`productionDeps` exports. Estimated ~250-350 lines.

**DELETED:**

- None.

**UNCHANGED (do not touch):**

- All `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/freshness/`, `src/permissions/`, `src/silverbullet/` source files. **Specifically: `openAuditLogger`, `createRuntimeClient`, `loadConfigOrExit`, `createLogger`, the production `logger` const — all consumed as-is.**
- `src/mcp/handler-template.ts`, `src/mcp/handlers/{list-pages,search-pages,read-page}.ts`. (Story 1.10's handlers compose unchanged into the new registry.)
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.prettierrc.json`, `package.json`, `package-lock.json` — UNCHANGED. **No new dependencies.** `@modelcontextprotocol/sdk` is already a runtime dep at `^1.29.0`.
- `tests/integration/handler-{list,search,read}-pages.test.ts`, `src/mcp/handler-template.test.ts` — UNCHANGED.
- `tests/smoke/*` — empty in the post-1.10 state; Story 1.12 owns the stdout-discipline smoke test.
- All `_bmad/`, `.claude/`, `docs/`, `_bmad-output/` — UNCHANGED except for `sprint-status.yaml` (status transition) and `deferred-work.md` (post-implementation appends).

**And** `npm pack --dry-run` manifest grows from **28 files** (post-1.10 baseline per `1-10-...md:299`) to **29 files** — the one new published file is `src/mcp/registry.ts`. `src/index.ts` is already in the manifest (as the `bin` target); the rewrite is in-place. All `*.test.ts` files (adjacent + integration) remain excluded.

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint -- --max-warnings=0`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`.

**And** `npm test` reports ≥ **+17 net new cases** versus the post-1.10 baseline of **439 tests** (per `1-10-...md:903`). Expected total ≥ **456**.

**And** the existing test suite continues to pass without modification.

**And** **module-isolation greps are green:**
- `grep -rE "console\.(log|info|debug)" src/index.ts src/mcp/registry.ts` → zero output (D7 stream discipline).
- `grep -rE "process\.stdout\.write" src/index.ts src/mcp/registry.ts` → zero output.
- `grep -rE "@modelcontextprotocol/sdk" src/` → matches ONLY `src/index.ts` (for `McpServer`, `StdioServerTransport` constructor types) and `src/mcp/registry.ts` (for `McpServer` parameter type). NO match in `src/mcp/handlers/`, `src/mcp/handler-template.ts`, or any pure-domain module.
- `grep -rE "Date\.now\(\)|new Date\(\)" src/mcp/registry.ts` → zero output (registry uses `ctx.clock` only).
- `grep -nE "process\.(env|exit|on|off)" src/index.ts` → matches ONLY in `productionDeps` and the `main()` wiring at the bottom — never inside `runServer` itself.

## Tasks / Subtasks

- [x] **Task 1: Author `src/mcp/registry.ts`** (AC: #7, #8)
  - [x] Create the file. Imports follow `verbatimModuleSyntax: true` — types via `import type`, runtime values via plain `import`.
  - [x] Import `McpServer` type from `@modelcontextprotocol/sdk/server/mcp.js` via `import type { McpServer } from ...`. **Type-only** — no runtime side effects from this import.
  - [x] Import `HandlerContext`, `formatToolError`, `infrastructureError` from `'./handler-template.ts'`.
  - [x] Import the three handler functions: `handleListPages`, `handleSearchPages`, `handleReadPage` from `'./handlers/{list-pages,search-pages,read-page}.ts'`.
  - [x] Define and export `type LifecycleHandle = { isDraining(): boolean; trackInflight<T>(promise: Promise<T>): Promise<T>; }`.
  - [x] Define and export `type RegisterToolsOptions = { server: McpServer; ctx: HandlerContext; lifecycle: LifecycleHandle; }`.
  - [x] Implement `export function registerTools(opts: RegisterToolsOptions): void`:
    1. Define a private `TOOL_DEFS` array: `[{ name: 'list_pages', description: '...', annotations: { readOnlyHint: true, openWorldHint: false }, handler: handleListPages }, ...]` for the three tools.
    2. For each entry, call `opts.server.registerTool(name, { description, annotations }, async (args, _extra) => { ... })`. Omit `inputSchema` — Story 1.10's handlers do their own zod parse with `.strict()`; supplying an SDK-side schema duplicates work and risks divergence (the strict-rejection AC8 contract lives in the handler).
    3. Inside the SDK callback:
       - First: `if (opts.lifecycle.isDraining()) { ... }` — build `infrastructureError(new Error('server shutting down'))`, write the audit entry directly via `opts.ctx.audit.write({ tool: name, args, decision: 'rejected', response: undefined, durationMs: 0, reason: error.reason, details: error.details })`, return `formatToolError(error)`.
       - Otherwise: `return await opts.lifecycle.trackInflight(handler(args, opts.ctx));`. The `await` matters — without it, `trackInflight`'s rejection branch escapes back into the SDK as an unhandled rejection.
  - [x] **No `inputSchema` on `registerTool`** — handlers own their zod schemas. Document this in a JSDoc comment at the top of `registerTools`.
  - [x] **No registry-level catch** — the SDK callback's `await` propagates handler failures, but Story 1.10's handlers always RESOLVE (with `ToolResult`); they never reject. The wrapper inherits that contract. Adding a try/catch here would mask handler bugs that should surface in tests.
  - [x] JSDoc all exports citing the architecture / epic line numbers.

- [x] **Task 2: Rewrite `src/index.ts` — startup ladder + lifecycle + shutdown** (AC: #1, #2, #3, #4, #5, #6, #8, #10)
  - [x] **Read the existing stub** (5 lines at `src/index.ts:1-5`) to confirm baseline; the rewrite replaces it entirely.
  - [x] **Top of file:** `#!/usr/bin/env node` shebang preserved (it was the only meaningful content of the stub; the `bin` resolution depends on it for `chmod +x` workflows).
  - [x] **Imports** (verbatimModuleSyntax — `import type` for types):
    - `import os from 'node:os';`
    - `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`
    - `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`
    - `import { type Config, loadConfigOrExit } from './config/config.ts';`
    - `import { type Logger, logger as productionLogger } from './diagnostic/logger.ts';`
    - `import { type AuditLogger, openAuditLogger, type OpenAuditLoggerOptions } from './audit/audit-logger.ts';`
    - `import { createRuntimeClient, type CreateRuntimeClientOptions, type RuntimeClient, type RuntimeErrorCode } from './silverbullet/client.ts';`
    - `import { createFreshnessState } from './freshness/state.ts';`
    - `import { defaultPermissionEngine, type HandlerContext, isDomainError } from './mcp/handler-template.ts';`
    - `import { registerTools, type LifecycleHandle } from './mcp/registry.ts';`
    - `import type { DomainError } from './domain/error.ts';`
    - **No `import pkg from '../package.json' with { type: 'json' };`** — Node 24.x's import-attributes syntax is stable for JSON, but using it requires `tsconfig.json`'s `resolveJsonModule: true` (currently unset) and `module: "NodeNext"` (set). Test the import at implementation time; if typecheck fails, fall back to:
      ```typescript
      import { readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
      const SERVER_VERSION = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
      ```
      Read once at module load; assigning to a `const` keeps it pure.
  - [x] **Define types:** `LifecycleState`, `ProcessLike`, `SetTimeoutLike`, `StartupDeps` per AC10.
  - [x] **Implement `createLifecycle(): { handle, markDraining, awaitInflight, state, transitionToServing, transitionToShutdown }`** per AC8:
    - Closure variable `state: LifecycleState = 'starting';`.
    - Closure variable `inflight = new Set<Promise<unknown>>();`.
    - `handle.isDraining = () => state === 'draining' || state === 'shutdown';`.
    - `handle.trackInflight<T>(p: Promise<T>): Promise<T>` — register, attach `.finally`, return the original promise unchanged. **Type-narrowing trick:** the `.finally` does not affect resolution; just call `void p.finally(() => inflight.delete(p));` and return `p`. The `void` is required to silence `no-floating-promises` since the `.finally` chain is fire-and-forget.
    - `awaitInflight()` returns `Promise.allSettled([...inflight])` cast to `Promise<void>` via `.then(() => undefined)`.
    - `state()` returns the current value.
    - `transitionToServing()` — assert current state is `'starting'`, set to `'serving'`.
    - `transitionToShutdown()` — set to `'shutdown'`.
  - [x] **Implement `formatStartupError(err: unknown, config?: Config): { fatal: string; hint: string }`** per AC2:
    1. Wrap non-DomainError throws via `infrastructureError(err)`.
    2. Inspect `details.code` (`extractCode` from Story 1.6 already populated this).
    3. Switch on the code per AC2's table.
    4. The default arm uses `details.underlying.message` (sliced to 200 chars) — secret-scrubbed already by `infrastructureError`.
    5. Return `{ fatal, hint }`. **No \n at the end of either line** — the diagnostic logger appends one.
  - [x] **Implement `runServer(deps: StartupDeps): Promise<void>`** — the entry-point function:
    1. Step 1: capture frozen env snapshot: `const env = Object.freeze({ ...deps.env });`.
    2. Step 2: `const config = loadConfigOrExit(env, deps.logger, deps.process.exit);` (`loadConfigOrExit` already takes `logger` and `exitFn` — use them).
    3. Banner: `deps.logger.info(\`starting up (silverbullet=${config.silverbulletUrl})\`);` — token never reached.
    4. Step 3 (audit): `const { logger: audit, filePath: auditFilePath } = deps.auditLoggerFactory({ env, platform: deps.platform, homeDir: deps.homeDir, clock: deps.clock, logger: deps.logger });` — wrap in try/catch so a failure here surfaces via `formatStartupError(err, config)` then `deps.process.exit(1)`.
    5. Step 4 (`client.ping`): `const client = deps.runtimeClientFactory({ config, fetch: undefined });` (use the default fetch; tests inject via `runtimeClientFactory`). Then `try { await client.ping(); } catch (err) { /* format + exit 1 */ }`.
    6. Step 5 (`client.probe`): `try { await client.probe(); } catch (err) { /* format + exit 1 */ }`.
    7. Banner: `deps.logger.info('connected — runtime API ok');`.
    8. Step 6: build `HandlerContext` — `const freshness = createFreshnessState();`, `const ctx: HandlerContext = { client, permissionEngine: defaultPermissionEngine, freshness, audit, logger: deps.logger, clock: deps.clock };`.
    9. Construct lifecycle: `const lifecycle = createLifecycle();`.
    10. Construct server + register tools: `const server = deps.mcpServerFactory({ name: 'mcp-silverbullet', version: SERVER_VERSION });`; `registerTools({ server, ctx, lifecycle: lifecycle.handle });`.
    11. Construct transport + connect: `const transport = deps.stdioTransportFactory(); await server.connect(transport);`.
    12. Transition: `lifecycle.transitionToServing();`.
    13. Banner: `deps.logger.info(\`ready (transport=stdio, audit=${auditFilePath})\`);`.
    14. **Install signal handlers + stdin-close listeners** per Task 3.
    15. **Install top-level catch handlers** per Task 3.
    16. Return — `runServer` resolves; the process stays alive via the stdio transport's read loop.
  - [x] **Each step's catch block** uses the SAME format-and-exit helper:
    ```typescript
    function fatalExit(err: unknown, config: Config | undefined, deps: StartupDeps): never {
      const { fatal, hint } = formatStartupError(err, config);
      deps.logger.error(fatal);
      deps.logger.error(hint);
      return deps.process.exit(1);
    }
    ```
    Steps 3-5 call `fatalExit(err, config, deps)`; steps 1-2 cannot — `loadConfigOrExit` owns its own format-and-exit (the FATAL line for config errors uses the AR39 mapping in `formatConfigError`, which is the same shape as `formatStartupError` but for config-rule failures).
  - [x] **`runServer` returns `Promise<void>`** and never throws after `transitionToServing` — all internal errors route to either `process.exit(1)` (startup) or the top-level catch handler (post-startup).

- [x] **Task 3: Wire shutdown signals + top-level exception handlers** (AC: #4, #5, #6)
  - [x] **Inside `runServer`, after `transitionToServing()`,** define and install:
    - `let shuttingDown = false;` — guards the idempotency check.
    - `function shutdown(reason: 'stdio-end' | 'stdio-close' | 'SIGINT' | 'SIGTERM'): void { ... }`:
      1. If `shuttingDown` → return immediately (idempotency).
      2. `shuttingDown = true;`.
      3. **Hard-stop timer FIRST.** `const hardStopTimer = deps.setTimeout(() => { deps.logger.warn('shutdown exceeded 900ms — forcing exit'); deps.process.exit(1); }, 900); hardStopTimer.unref();`.
      4. Banner: `deps.logger.info(\`${bannerFor(reason)}; flushing\`);` where `bannerFor` maps `'stdio-end' → 'stdio closed'`, `'stdio-close' → 'stdio closed'`, `'SIGINT' → 'received SIGINT'`, `'SIGTERM' → 'received SIGTERM'`.
      5. `lifecycle.markDraining();` — flips `state` to `'draining'`.
      6. **The remainder is async**, but `shutdown` itself is sync (signal handlers must be sync; the async work is fired via an async IIFE wrapped in a try/catch + `.catch` to surface unhandled errors at the WARN level rather than crash the shutdown sequence). Implementation pattern:
         ```typescript
         void (async () => {
           try {
             await lifecycle.awaitInflight();
             await audit.close();
             // closeRuntime hook — no-op for now; future AbortController seam.
             try { await server.close(); } catch (closeErr) {
               deps.logger.warn('mcp transport close failed: ' + String(closeErr));
             }
             lifecycle.transitionToShutdown();
             deps.logger.info('shutdown complete');
             deps.process.exit(0);
           } catch (asyncErr) {
             deps.logger.warn('shutdown sequence error: ' + String(asyncErr));
             deps.process.exit(1);
           }
         })();
         ```
         The `void` keyword is required to silence `no-floating-promises` — fire-and-forget is intentional here (the async work cannot block the sync signal-handler return).
  - [x] **Stdin-close listener** (`stdin end` AND `stdin close` both trigger):
    - `deps.stdin.once('end', () => { shutdown('stdio-end'); });`
    - `deps.stdin.once('close', () => { shutdown('stdio-close'); });`
    - The `once` semantics matter — without `once`, an `'end'` followed by `'close'` would fire `shutdown` twice; the idempotency guard handles it but `once` is belt-and-suspenders.
  - [x] **Signal listeners:**
    - `deps.process.on('SIGINT', () => { shutdown('SIGINT'); });`
    - `deps.process.on('SIGTERM', () => { shutdown('SIGTERM'); });`
  - [x] **Top-level exception handlers:**
    - `deps.process.on('uncaughtException', (err: unknown) => { deps.logger.error('uncaughtException: ' + (err instanceof Error ? err.message : String(err)), err); });`
    - `deps.process.on('unhandledRejection', (err: unknown) => { deps.logger.error('unhandledRejection: ' + (err instanceof Error ? err.message : String(err)), err); });`
    - Neither calls `process.exit` — NFR12 (`epics.md:86`).
    - **No mutation of the in-flight tool result** here — the per-handler `try/catch/finally` already converts internal throws to `infrastructure_error`. The top-level catch is purely a diagnostic safety net for anything that escapes the handler boundary.

- [x] **Task 4: `productionDeps` and `main()` invocation** (AC: #10)
  - [x] Define and export `productionDeps: StartupDeps`:
    ```typescript
    export const productionDeps: StartupDeps = {
      env: process.env,
      platform: process.platform,
      homeDir: os.homedir(),
      clock: () => new Date(),
      logger: productionLogger,
      auditLoggerFactory: openAuditLogger,
      runtimeClientFactory: createRuntimeClient,
      stdin: process.stdin,
      process: {
        on: (event, cb) => { process.on(event, cb); },
        off: (event, cb) => { process.off(event, cb); },
        exit: (code) => process.exit(code),
      },
      setTimeout: (cb, ms) => {
        const t = setTimeout(cb, ms);
        return { unref: () => { t.unref(); } };
      },
      mcpServerFactory: (info) => new McpServer(info),
      stdioTransportFactory: () => new StdioServerTransport(),
    };
    ```
    The `.bind(...)`-free wrapper functions (`(event, cb) => { process.on(event, cb); }`) are required by `@typescript-eslint/unbound-method` (Story 1.9's lesson, `1-9-...md:548`). Direct `on: process.on` would trip the lint.
  - [x] **Bottom of file:**
    ```typescript
    // Run the server when this file is the entry point. The `import.meta.url`
    // check distinguishes "imported by tests" from "executed as the bin".
    if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] ?? '')) {
      void runServer(productionDeps);
    }
    ```
    The `void` silences `no-floating-promises`; `runServer` resolves cleanly under the production deps (it returns once the SDK transport is connected; the server stays alive via the transport's read loop).
  - [x] **Use `import.meta.url` comparison instead of `require.main === module`** — ESM context (`type: 'module'` in `package.json`) has no `require.main`. The `import.meta.url`-based check is the ESM equivalent.

- [x] **Task 5: Author `tests/integration/startup-ladder.test.ts`** (AC: #9)
  - [x] Create the file. Imports: `node:test` (with the `mock` namespace for `mock.timers`), `node:assert/strict`, `runServer` and `StartupDeps` from `'../../src/index.ts'`, plus the testing helpers below.
  - [x] **Helper `buildFakeDeps(overrides: Partial<StartupDeps>): StartupDeps`** — construct a baseline `StartupDeps` whose every field is a recording fake:
    - `env` defaults to `{ SILVERBULLET_URL: 'https://test.example', SILVERBULLET_TOKEN: 'TEST-TOKEN' }`.
    - `platform: 'linux'`, `homeDir: '/home/test'`.
    - `clock` returns a fixed `Date`.
    - `logger` captures `info`/`warn`/`error` calls into per-level arrays.
    - `auditLoggerFactory` returns `{ logger: { write: spy, close: spy that resolves }, filePath: '/tmp/audit.jsonl' }`.
    - `runtimeClientFactory` returns `{ ping: spy resolving, probe: spy resolving, exec: spy resolving }`.
    - `stdin` is a `node:stream`'s `PassThrough` — emits `'end'` / `'close'` when the test calls `stdin.end()`.
    - `process` is a synthetic `EventEmitter` exposing `on`/`off` for `SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection`, plus an `exit` spy that THROWS an `ExitSentinel(code)` error so the test can `await assert.rejects(runServer(...), ExitSentinel)`. (The throw simulates `process.exit`'s `never` return without actually ending the test process.)
    - `setTimeout` is a spy that records `(cb, ms)` and returns `{ unref: spy }` — combined with `node:test`'s `mock.timers` for the hard-stop test.
    - `mcpServerFactory` returns a fake `McpServer` whose `registerTool(name, config, cb)` records the tool definitions, whose `connect(transport)` resolves immediately, and whose `close()` is a spy.
    - `stdioTransportFactory` returns a `Symbol('fake-transport')` (or a minimal stub).
  - [x] **Helper `runUntilExit(deps): Promise<{ exitCode?: number; logs: { info: string[]; warn: string[]; error: string[] }; ... }>`** — wraps `runServer(deps)` in a try/catch that intercepts the `ExitSentinel` and records the exit code; returns once the ladder has exited or the test caller decides it's done (e.g., for shutdown tests, the harness exposes a `triggerSignal` method that emits SIGINT and waits for the next exit).
  - [x] **Implement AC9 cases #1-17.** Each case is a top-level `await test('description', async () => { ... });`.
  - [x] **Mock-call-count assertions:** for case #12 (draining-rejected), assert `handleListPages`-bound spy was called ZERO times (the registry wrapper short-circuits before the handler).
  - [x] **Mocked timers** for case #14: `mock.timers.enable({ apis: ['setTimeout'] }); ...; mock.timers.tick(900); ...; mock.timers.reset();`. Wrap in try/finally to guarantee `mock.timers.reset()` even on assertion failure.
  - [x] **No real fs / network / process / signals** — every external surface is fake; `node:test`'s `--allow-natives` is NOT used.
  - [x] **No `Date.now()` in the test file** — fixed millis only.

- [x] **Task 6: Local verification** (AC: #11)
  - [x] `npm run typecheck` → exit 0.
  - [x] `npm run lint -- --max-warnings=0` → exit 0. Watch for: `@typescript-eslint/no-floating-promises` (every `await` site checks; the shutdown's `void (async () => {})()` is intentional — silenced by `void`), `@typescript-eslint/no-misused-promises` (signal handlers must be sync — the `(reason) => { shutdown(reason); }` shape is sync void-returning, not async), `@typescript-eslint/unbound-method` (use wrapped lambdas in `productionDeps.process`, NOT `on: process.on`), `@typescript-eslint/no-explicit-any` (use `unknown` for SDK args).
  - [x] `npx prettier --check .` → exit 0.
  - [x] `npm test` → all passing; ≥ **456** total cases (439 baseline + ≥ 17 new).
  - [x] `npm pack --dry-run` → manifest is exactly **29 files** (28 baseline + 1 new source file: `src/mcp/registry.ts`; `src/index.ts` already in manifest as the rewritten `bin` target).
  - [x] **Module-isolation greps:**
    - `grep -rE "console\.(log|info|debug)" src/index.ts src/mcp/registry.ts` → zero output.
    - `grep -rE "process\.stdout\.write" src/index.ts src/mcp/registry.ts` → zero output.
    - `grep -rE "@modelcontextprotocol/sdk" src/` → matches ONLY `src/index.ts` and `src/mcp/registry.ts`.
    - `grep -rE "Date\.now\(\)|new Date\(\)" src/mcp/registry.ts` → zero output.
    - `grep -nE "process\." src/index.ts` → matches ONLY in `productionDeps` (the wiring) and the bottom-of-file `main()` invocation. The `runServer` body MUST NOT touch `process.*` directly (it routes everything through `deps`).
  - [x] **Smoke: actually run `node ./src/index.ts`** with valid env vars pointing at a local SB instance. Verify the three lifecycle banners, then SIGINT and verify `'received SIGINT; flushing'` + `'shutdown complete'` appear, and the process exits 0 within ~1 second. (Manual smoke is OK — there is no `tests/smoke/` test for this story; Story 1.12 owns the stdout-discipline smoke test.)
  - [x] **Smoke: invalid token** → `EUNAUTHORIZED` FATAL line + hint mentioning `SILVERBULLET_TOKEN` + exit code 1 within sub-second.

- [x] **Task 7: Append deferred-work entries (post-implementation review)** (housekeeping)
  - [x] Append entries that surface during the implementation pass — particularly: (a) the `closeRuntime` hook is empty for now; revisit once `AbortController` lands per `deferred-work.md:27`, (b) the hard-stop timer's `process.exit(1)` may leak the audit-stream's last buffered line — operationally acceptable (force-exit is by definition degraded) but documenting the trade-off, (c) the lifecycle's `state` is intentionally not exposed via the MCP tool surface (NFR8); revisit if a future health-check tool is added, (d) any other discoveries.
  - [x] Cross-reference Story 1.12 (CI workflow + smoke test) — the stdio-discipline smoke test will exercise this story's startup ladder in a real subprocess.

## Dev Notes

### Architectural source-of-truth

This is story **#12** in the implementation sequence (`architecture.md:824`, item 12: "Startup sequence + lifecycle — wires steps 1–11; runs the D5 startup ladder; installs SIGINT/SIGTERM handlers and the D7 shutdown sequence."). It is the FIRST story that imports `@modelcontextprotocol/sdk` at runtime — every prior story carefully kept the SDK out of its imports so the test surface stayed pure (`epics.md:101` / NFR21).

It depends on:

- Story 1.4's `loadConfigOrExit` (`src/config/config.ts:262`) — env-var validation + AR39 startup error format + `process.exit(1)` on failure. **Reused as-is.**
- Story 1.4's `wrapConfig` (`src/config/secret-scrubber.ts`) — applied automatically inside `loadConfigOrExit`.
- Story 1.3's `createLogger` and the production `logger` const (`src/diagnostic/logger.ts:68,93`) — production wiring uses the const; tests inject a fake logger.
- Story 1.5's `openAuditLogger` (`src/audit/audit-logger.ts:502`) — composition that resolves path, ensures directory, opens stream, constructs the logger. **Reused as-is.**
- Story 1.5's `AuditLogger.close()` contract — drain + `stream.end()` within NFR9's 1s budget.
- Story 1.7's `createRuntimeClient` (`src/silverbullet/client.ts:145`) and `RUNTIME_ERROR_CODE` (`src/silverbullet/client.ts:29-40`) — the closed-set codes are switched on in `formatStartupError` to render AR39's distinct messages.
- Story 1.7's `client.ping()` and `client.probe()` — startup ladder steps 4 and 5.
- Story 1.9's `createFreshnessState()` (`src/freshness/state.ts:55`) — production `HandlerContext.freshness`.
- Story 1.10's `defaultPermissionEngine`, `HandlerContext`, `formatToolError`, `infrastructureError`, `isDomainError` (`src/mcp/handler-template.ts`) — composed into the production context and used by the registry wrapper.
- Story 1.10's three handlers (`handleListPages`, `handleSearchPages`, `handleReadPage`) — wired into the SDK via `registerTools`.

It does **NOT** depend on:

- Stories 2.x's write-side handlers (`append_to_page`, `edit_page`, `create_page`, `delete_page`) — they will be registered alongside the read-side three when those stories land. Story 1.11 ships only the three Epic 1 read-side handlers; Stories 2.x extend the registry's `TOOL_DEFS` array.
- The latency-baseline harness — separate `scripts/latency-baseline.ts` with its own entry point.

**Primary specs (read these first):**

- AC source: `_bmad-output/planning-artifacts/epics.md:605-635` (Story 1.11 ACs).
- D5 startup sequence + error format: `architecture.md:470-525` (the AR38/AR39 ladder this story implements).
- D7 process discipline + shutdown: `architecture.md:642-712` (the AR51/AR52 cooperative shutdown this story implements).
- Implementation sequence (this story = #12): `architecture.md:824`.
- Cross-component dependency map: `architecture.md:830-844`.
- AR38 — startup ladder: `epics.md:155`.
- AR39 — distinct error messages: `epics.md:156`.
- AR50 — diagnostic log captures lifecycle events: `epics.md:171`.
- AR51 — cooperative shutdown signals + sequence: `epics.md:172`.
- AR52 — top-level catch for unhandled exceptions: `epics.md:173`.
- NFR3 — cold start ≤ 3s: `epics.md:73`.
- NFR9 — shutdown ≤ 1s: `epics.md:83`.
- NFR12 — per-call failure does not poison: `epics.md:86`.
- NFR15 — use the official MCP SDK: `epics.md:91`.

### What this story owns (and does NOT own)

**Owns:**

- `src/index.ts` — full rewrite from the 5-line stub. `runServer`, `productionDeps`, `formatStartupError`, `createLifecycle`, lifecycle / shutdown / signal-handler wiring, `main()` invocation.
- `src/mcp/registry.ts` — `LifecycleHandle`, `RegisterToolsOptions`, `registerTools`. The single SDK-facing wiring point inside `src/mcp/`.
- `tests/integration/startup-ladder.test.ts` — ≥ 17 cases per AC9.

**Does NOT own (these land in later stories):**

- Stories 2.x's write-side handlers + their registry entries — Stories 2.2 / 2.3 / 2.4 / 2.5.
- `tests/smoke/stdout-discipline.test.ts` + the `.github/workflows/ci.yml` workflow + `.github/dependabot.yml` — Story 1.12.
- `README.md` / `docs/permissions.md` / `docs/threat-model.md` — Story 1.13.
- `AbortController` / fetch-timeout in `RuntimeClient` — `deferred-work.md:27` (revisit when the latency baseline reveals a tail-latency pathology or an operator reports a hung server).
- A startup-time silversearch-plug probe — `deferred-work.md:29`.
- A `closeRuntime` real implementation — currently a no-op stub; lands when the runtime client gains a connection pool / `AbortController`.
- Distinct exit codes per startup-failure category (AR39 says "exit code `1` for all in MVP"; AR77 defers).
- Hot-reload of config — explicitly out per `architecture.md:523-525` (AR41).
- Persistent freshness state across restarts — AR76.
- A `health_check` MCP tool — Growth (NFR8 forbids exposing internal state via the tool surface in MVP).
- Extracting `createLifecycle` to its own module — defer until Stories 2.x have a second consumer.

### Files this story creates / modifies / deletes

**NEW:**

- `src/mcp/registry.ts`
- `tests/integration/startup-ladder.test.ts`

**MODIFY:**

- `src/index.ts` — full rewrite of the existing 5-line stub.

**DELETE:**

- None.

**UNCHANGED (do not touch):**

- All of `src/audit/`, `src/config/`, `src/diagnostic/`, `src/domain/`, `src/edits/`, `src/freshness/`, `src/permissions/`, `src/silverbullet/`. **In particular: do NOT modify `openAuditLogger`'s signature; do NOT add `mkdir` / `createWriteStream` injection there. The DI seam for tests is `auditLoggerFactory` at the `StartupDeps` level.**
- `src/mcp/handler-template.ts`, `src/mcp/handler-template.test.ts`, `src/mcp/handlers/{list,search,read}-pages.ts`, the three handler integration tests under `tests/integration/`.
- `eslint.config.js`, `tsconfig.json`, `.gitignore`, `.npmignore`, `.prettierrc.json`, `.editorconfig`, `LICENSE`, `README.md`, `package.json`, `package-lock.json`.
- `scripts/latency-baseline.ts`.
- `tests/smoke/` — empty in the post-1.10 state; Story 1.12 populates.
- All `_bmad/`, `.claude/`, `docs/` — except `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transition) and `_bmad-output/implementation-artifacts/deferred-work.md` (post-implementation appends).

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: `tests/integration/startup-ladder.test.ts` — multi-module composition; integration is the right scope.
- Test invocation: `npm test` — picks up `tests/integration/**/*.test.ts` per `package.json:22`.
- **Top-level `await test(...)`** for each case (no `describe` blocks — established Stories 1.3-1.10 pattern).
- **No real `process` / `setTimeout` / `os.homedir` / `fs.*` / `globalThis.fetch` / signal handling.** Every external surface is injected through `StartupDeps` and faked in the test harness.
- **No real `process.exit`.** The test harness's `deps.process.exit` throws an `ExitSentinel(code)` error so the test can intercept the exit code without ending the test process.
- **No real timers.** `node:test`'s `mock.timers.enable({ apis: ['setTimeout'] })` for the hard-stop test (AC9 #14); the 900ms boundary is advanced via `mock.timers.tick(900)`.
- **`Date` fixtures use fixed-millisecond literals** — `new Date('2026-05-01T12:00:00Z')`. No `Date.now()` invocations.
- **Audit-shape assertions:** the fake `AuditLogger` records every `write(entry)` call into an array; tests inspect `tool`, `args`, `decision`, `response`, `durationMs`, plus `reason` / `details` on rejection.
- **No fs / network side effects** — purity is a contract.
- Assertions:
  - `assert.deepStrictEqual` for response payload + audit-entry shape.
  - `assert.strictEqual` for primitives (`exitCode === 1`, `audit.writes.length === 1`, `state === 'shutdown'`).
  - `assert.match` for log lines (`/SilverBullet Runtime API not enabled/`, `/server shutting down/`).
  - `assert.rejects(promise, ExitSentinel)` for ladder calls that hit `deps.process.exit(...)`.

### Library / framework requirements

**No new dependencies.** All needed primitives are stdlib + previously-locked tooling:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:47`) | `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; `node --test` test runner; `node:test`'s `mock.timers` |
| `node:test` | built-in | Test framework; `mock.timers` for the hard-stop test |
| `node:assert/strict` | built-in | Assertions |
| `node:os` | built-in | `os.homedir()` for the audit-path resolution (only used in `productionDeps`) |
| `node:fs` | built-in | Used only inside `openAuditLogger` (Story 1.5) — this story does NOT import `fs` directly |
| `node:stream` | built-in | `PassThrough` for the test harness's fake stdin |
| `node:events` | built-in | `EventEmitter` for the test harness's fake `process` |
| `@modelcontextprotocol/sdk` | `^1.29.0` (`package.json:37`) | `McpServer`, `StdioServerTransport` — first usage in the project |
| `zod` | `^4.4.1` (`package.json:38`) | Already used by Story 1.10 handlers; not directly imported by Story 1.11 |

**Push back on:**

- A new test-harness module (`tests/integration/_startup-helpers.ts`) — defer until Stories 2.x have a second consumer of `StartupDeps`-shaped fakes (e.g., a write-side end-to-end test). Story 1.11 keeps the harness inline in the test file.
- A signal-handling library (e.g., `signal-exit`) — Node's native `process.on('SIGINT'/'SIGTERM')` is sufficient; adding a dep on a tiny wrapper is anti-AR2 (minimal-deps stance).
- An MCP-SDK-shape adapter — Story 1.10's `ToolResult` is structurally compatible with the SDK's `CallToolResult`. Story 1.11's registry wrapper passes the handler's return value through unchanged. If the SDK rejects the shape at runtime (e.g., requires explicit `isError: false`), a small `adaptToCallToolResult` lands in `src/mcp/registry.ts`. Currently believed unnecessary; verify at implementation time.
- `dotenv` for env loading — `process.env` is read directly per `architecture.md:472-481` (env vars only, no config file).
- Removing the `loadConfigOrExit` `process.exit` call so tests don't have to inject `exitFn` — Story 1.4 already pinned the contract; this story passes `deps.process.exit` through.

### File-structure requirements

After this story, the changed files look like:

```
src/
├── index.ts                     # MODIFIED: full rewrite from stub
├── mcp/
│   ├── handler-template.ts      # UNCHANGED
│   ├── handler-template.test.ts # UNCHANGED
│   ├── registry.ts              # NEW
│   └── handlers/                # UNCHANGED
│       ├── list-pages.ts
│       ├── search-pages.ts
│       └── read-page.ts
└── (every other src/ file UNCHANGED)

tests/
└── integration/
    ├── startup-ladder.test.ts   # NEW
    ├── handler-list-pages.test.ts   # UNCHANGED
    ├── handler-search-pages.test.ts # UNCHANGED
    └── handler-read-page.test.ts    # UNCHANGED
```

**No barrel files** — `src/mcp/registry.ts` imports each handler by file directly: `import { handleReadPage } from './handlers/read-page.ts';` etc. (AR57 / `architecture.md:999`).

**`src/index.ts` is a boundary module** — it imports from `@modelcontextprotocol/sdk` (the only SDK import site outside `src/mcp/registry.ts`), `node:os`, and every other `src/` module that needs production wiring. Pure-domain modules MUST NOT import from `src/index.ts` (verified by the existing acyclic-dependency rule).

### Latest tech information (researched 2026-05-01)

- **`@modelcontextprotocol/sdk` v1.29** ships `McpServer` (`server/mcp.js`) with the new `registerTool(name, config, cb)` API replacing the deprecated `tool(name, ..., cb)` overloads. Use `registerTool` per AC7. The `cb` signature when `inputSchema` is omitted is `(extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>`; when `inputSchema` is provided as a `ZodRawShapeCompat`, it becomes `(args: ShapeOutput<Args>, extra) => ...`. Story 1.11 omits `inputSchema` so the args arrive raw — handlers re-validate via their own zod schemas (Story 1.10 contract).
- **`StdioServerTransport`** (`server/stdio.js`) constructs with no required arguments; defaults to `process.stdin` / `process.stdout`. Tests inject via `stdioTransportFactory` so the constructor is mockable.
- **`McpServer.connect(transport): Promise<void>`** attaches the transport, starts it, and begins the read loop. Resolves once the transport has been initialised. Once resolved, the server is "live" — incoming JSON-RPC messages are dispatched to registered tool callbacks.
- **`McpServer.close(): Promise<void>`** closes the underlying transport and tears down protocol state. **Wrap with try/catch in the shutdown sequence** — a transport-close failure should not prevent the process from exiting.
- **`node:test`'s `mock.timers`** — `mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'setInterval', 'Date'] })` enables fake timers; `mock.timers.tick(ms)` advances; `mock.timers.reset()` restores. Story 1.11's hard-stop test uses `setTimeout` only; **do NOT mock `Date`** — the lifecycle banners include the wall-clock-derived `auditFilePath` resolution which is `Date`-independent, but mocking `Date` could break unrelated handlers' clock injection contracts (Story 1.10 uses fixed `new Date('...')` literals, NOT `Date.now()` — robust to either choice; default to leaving `Date` real).
- **`process.on('uncaughtException', cb)`** — `cb(err: Error, origin: 'uncaughtException' | 'unhandledRejection')`. Per Node docs, the default behaviour without a listener is to print the stack to stderr and exit with code 1; installing a listener that does NOT call `process.exit` makes the process keep running (NFR12). Multiple listeners are allowed; the test harness emits via `process.emit('uncaughtException', err)` to fire the registered listener without an actual throw.
- **`process.on('unhandledRejection', cb)`** — `cb(reason: unknown, promise: Promise<unknown>)`. As of Node 20+, the default behaviour is `'throw'` (the rejection is escalated to `uncaughtException` and crashes the process unless a handler is installed). Installing a listener that swallows + logs is the documented NFR12-conformant pattern.
- **ESM `import.meta.url` vs. `require.main`** — ESM modules don't have `require.main`. The pattern `if (import.meta.url === \`file://${process.argv[1]}\`)` checks "this file is the entry point" but is fragile across symlinks and the `bin` resolution. The looser `import.meta.url.endsWith(process.argv[1] ?? '')` covers more cases. **Verify with a manual smoke at implementation time.**
- **`tsconfig.json`'s `verbatimModuleSyntax: true`** — type-only imports use `import type`. Runtime classes (`McpServer`, `StdioServerTransport`) are imported as values; their types come along automatically. The mixed `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'` works for both — it's a value import that also brings the type.
- **`@typescript-eslint/no-misused-promises` on signal handlers** — signal handlers must be sync void-returning. The `(reason) => { shutdown(reason); }` lambda satisfies this; the inner `shutdown` is also sync (void-returning) but spawns an async IIFE for the actual work. Tests verify the sync-ness by asserting that `process.emit('SIGINT')` returns synchronously (no awaitable promise leak).
- **`@typescript-eslint/unbound-method`** — calls like `process.on(event, cb)` work fine, but `on: process.on` (assigning the method to a property) would lose its `this`-binding and trip the lint. The wrapper `on: (event, cb) => { process.on(event, cb); }` re-establishes the binding. Story 1.4's `productionExit: ExitFn = (code) => process.exit(code)` (`src/config/config.ts:260`) is the established pattern; mirror it.

### Previous story intelligence (from Stories 1.1-1.10)

Distilled patterns to apply:

1. **Top-level `await test(...)`** is the established test pattern (Stories 1.3-1.10). Do NOT introduce `describe` blocks.
2. **Factory + closure** is the established stateful-module pattern. Story 1.11's `createLifecycle` follows it: closure variables for `state` + `inflight`, returned object as the public surface.
3. **Pure-domain isolation grep** (Story 1.8 lesson) — verify `src/index.ts` does NOT import from `src/mcp/handlers/` directly (it goes through `src/mcp/registry.ts`); verify pure-domain modules (`src/domain/`, `src/permissions/`, `src/edits/`, `src/freshness/`, `src/audit/schema`) don't import from `src/index.ts`.
4. **Imports use `.ts` extension** (`tsconfig.json:14`). `from '../mcp/handler-template.ts'`, etc. The MCP SDK imports use `.js` because that's how the SDK ships its `.d.ts` declarations (CommonJS-style with a `.js` resolution suffix on its ES-module exports — verified at implementation time).
5. **No barrel re-exports** (AR57 / `architecture.md:999`). `src/mcp/registry.ts` imports each handler by file.
6. **Story 1.4's `loadConfigOrExit` injection pattern** — pass `exitFn` from `deps.process.exit`. Mirrored throughout the new `runServer`.
7. **Story 1.5's `void`-return / fire-and-forget pattern for `audit.write`** — Story 1.10's handlers already enforce; Story 1.11's registry wrapper does the same.
8. **Story 1.5's `AuditLogger.close()` returns a `Promise<void>`** — `await audit.close();` in the shutdown sequence.
9. **Story 1.7's `infrastructureError(err)` already scrubs secrets** — the startup-ladder error formatter passes the raw `err` through; no double-scrub needed.
10. **Story 1.7's `RUNTIME_ERROR_CODE`** — switch on these literal values in `formatStartupError` to render AR39's distinct messages.
11. **Story 1.7's runtime client throws `DomainError` (NOT `Error` subclass)** — the `isDomainError` structural test from `src/mcp/handler-template.ts:182` is the pattern; reuse it in `formatStartupError`.
12. **Story 1.9's lesson on `@typescript-eslint/unbound-method`** (`1-9-...md:548`) — do NOT destructure or assign methods directly. Wrap in lambdas (`on: (event, cb) => { process.on(event, cb); }`).
13. **Story 1.10's `HandlerContext` injection** — Story 1.11 builds the production context by composing the real factories (`createRuntimeClient`, `createFreshnessState`, `openAuditLogger`, `defaultPermissionEngine`, the production `logger`, `() => new Date()`).
14. **Story 1.10's `formatToolError` and `infrastructureError`** — re-used directly by the registry's draining-state branch.
15. **Story 1.10's `handle*Pages` functions** — wired into the registry's SDK callbacks unchanged.

### Git intelligence

Recent commits (`git log --oneline -10`):

- `df9f3ae feat(mcp): read-side handlers (list_pages, search_pages, read_page) (story 1.10)`
- `447692f feat(freshness): in-memory bounded state with LRU eviction (story 1.9)`
- `103e063 feat(permissions): access-mode, block parser, engine (story 1.8)`
- `23ba910 feat(silverbullet): runtime client, envelope, lua templates (story 1.7)`
- `e111c8c feat(domain): DomainError, formatToolError, serializeForAudit (story 1.6)`
- `ef16952 feat(audit): JSONL logger with ULID, digest, drain (story 1.5)`
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`
- `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`

**Expected commit footprint for this story:** 2 new files (`src/mcp/registry.ts`, `tests/integration/startup-ladder.test.ts`), 1 modified file (`src/index.ts` — full rewrite). Net: +2 files in the working tree. Pack manifest +1 (the registry; `src/index.ts` is already in the manifest).

**Conventional Commits gate** (`a867ada`). This story's commit message:

`feat(mcp): startup ladder, lifecycle, cooperative shutdown (story 1.11)`

### Critical guardrails (do not rediscover)

1. **stdout reserved for MCP JSON-RPC traffic only** (D7 / AR47 / `architecture.md:646-654`). The startup ladder's banners go to STDERR via `deps.logger` (which writes to `process.stderr` in production). NEVER `console.log` / `process.stdout.write` from `src/index.ts` or `src/mcp/registry.ts`. The `eslint-no-console` rule catches `console.log`; manual review catches `process.stdout.write`.

2. **Token never echoed** (NFR5 / AR40). Startup banners log `config.silverbulletUrl` (NOT a secret) and the resolved audit path. The token is wrapped by `wrapConfig` so any accidental `JSON.stringify(config)` masks it as `***redacted***`. **The `EUNAUTHORIZED` FATAL line names the variable `SILVERBULLET_TOKEN`, NEVER its value.**

3. **AR39 — exit code `1` for all startup failures in MVP** (`architecture.md:521`). Distinct codes per category is AR77 (Growth).

4. **NFR3 — cold start ≤ 3s on healthy SB** (`epics.md:73`). The synthetic test pins this at the ladder layer; real-network NFR3 is operator territory.

5. **NFR9 — shutdown ≤ 1s** (`epics.md:83`). The hard-stop force-exit at 900ms is the safety net; the cooperative path should complete well within 900ms on a healthy state.

6. **AR51 — cooperative shutdown sequence is non-negotiable** (`epics.md:172`, `architecture.md:695-704`):
   1. Mark draining → reject new tool calls with `infrastructure_error: server shutting down`.
   2. Await in-flight tool calls.
   3. Flush audit (`stream.end()` via `audit.close()`).
   4. Close runtime client (no-op stub for now).
   5. Close MCP transport.
   6. `process.exit(0)`.

7. **AR52 — top-level catch does NOT exit the process** (`epics.md:173`, `architecture.md:706`). NFR12 is load-bearing. The catch logs at ERROR via the diagnostic logger and returns; in-flight tool calls are converted to `infrastructure_error` by the per-handler `try/catch/finally` (Story 1.10 already pins this).

8. **Exactly-one-audit-entry-per-tool-call** (AR53 / `epics.md:176`). The registry's draining-state branch writes the audit entry directly (NOT through the handler). The handler's `finally` is bypassed because the handler is never invoked. The audit entry is structurally identical to what a normal infrastructure-error rejection would produce.

9. **Idempotent shutdown** — multiple signals fire `shutdown` once. The `shuttingDown` flag is the gate.

10. **Hard-stop timer is the FIRST thing the shutdown sets** (after the idempotency gate). A shutdown that hangs at any step still terminates within 900ms via the timer.

11. **`hardStopTimer.unref()`** is required so a fast shutdown doesn't wait for the timer to fire.

12. **`process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` are installed AFTER `transitionToServing()`**, NOT during the startup ladder. Earlier installation would intercept startup-ladder failures the ladder is supposed to handle deterministically (the ladder's `try/catch` per step is the canonical path).

13. **Signal handlers must be sync void-returning** (`@typescript-eslint/no-misused-promises`). The `(reason) => { shutdown(reason); }` lambda is sync; `shutdown` itself is sync (it spawns an async IIFE for the actual work).

14. **`@typescript-eslint/unbound-method`** — `productionDeps.process.on/off/exit` are wrapped in lambdas, NOT assigned the bare `process.on` reference. Story 1.4's `productionExit` is the established pattern (`src/config/config.ts:260`).

15. **`@typescript-eslint/no-floating-promises`** — every `await` site checks. The shutdown's async IIFE (`void (async () => { ... })();`) uses `void` to silence; this is the documented exception (audit-write is the other one).

16. **`stdin.once('end', ...)` AND `stdin.once('close', ...)`** — both are wired. `'end'` fires when the parent client closes its write side cleanly; `'close'` fires after `'end'` or on abrupt termination. The idempotency guard handles the duplicate firing.

17. **Test harness's `process.exit` throws `ExitSentinel`** — the only way to simulate `process.exit`'s `never` return without ending the test process. Tests `await assert.rejects(runServer(...), ExitSentinel)` for failure-path cases.

18. **Mocked timers use `node:test`'s `mock.timers`** — NOT `sinon`-style libraries. The hard-stop test (#14) is the only consumer; the rest of the suite uses real timers.

19. **`runServer` does NOT throw after `transitionToServing()`** — all post-startup errors route to either the per-handler boundary (Story 1.10) or the top-level catch handler. `runServer` returns `Promise<void>` and resolves cleanly; the process keeps running via the SDK transport's read loop.

20. **`HandlerContext.permissionEngine` is the FROZEN `defaultPermissionEngine`** — production wiring uses Story 1.10's exported `defaultPermissionEngine: PermissionEngine = Object.freeze({ resolve: resolveAccess })`. NO new construction; NO `Object.assign({}, defaultPermissionEngine, ...)`.

21. **Imports use `.ts` extension for project files** (`tsconfig.json:14`); SDK imports use `.js` (the SDK's own resolution suffix). The mismatch is intentional and handled by Node's module resolver + TypeScript's `allowImportingTsExtensions`.

22. **`src/index.ts` is the ONLY file in the repo that calls the production `process.exit`** (via `productionDeps.process.exit`). All other modules either don't exit (handlers, pure functions) or exit via injection (`loadConfigOrExit` takes `exitFn`).

23. **NFR8 — no internal state via the MCP tool surface.** The lifecycle's `state`, the in-flight `Set`, the audit file path, etc. are NEVER exposed via a registered tool. (No new tools in this story; the three Story 1.10 tools have the same surface they always had.)

24. **The `closeRuntime` hook is an empty async function** for now — the architecture mandates step 4 of the shutdown sequence ("close runtime HTTP client"); we honor the contract by calling a hook that's a no-op today and a real implementation when `AbortController` lands. Future stories add the real implementation; this story ships the seam.

25. **Smoke-test the binary manually after the dev pass.** `node ./src/index.ts` with valid env should reach `'ready'` within a second; SIGINT should produce `'received SIGINT; flushing'` + `'shutdown complete'` and exit 0. Invalid token should produce `EUNAUTHORIZED` FATAL + hint within sub-second. The CI smoke test (Story 1.12) automates this.

### Story scope boundaries (DO NOT include)

- **Stories 2.x's write-side handlers** — `append_to_page`, `edit_page`, `create_page`, `delete_page`. Story 1.11's registry ships only the three Epic 1 read-side tools.
- **The stdout-discipline smoke test + the CI workflow** — Story 1.12 owns `tests/smoke/stdout-discipline.test.ts`, `.github/workflows/ci.yml`, `.github/dependabot.yml`.
- **README + permissions doc + threat model** — Story 1.13.
- **Real `AbortController` / fetch timeout in `RuntimeClient`** — `deferred-work.md:27`.
- **Distinct exit codes per startup-failure category** — AR77.
- **Hot-reload of config** — AR41.
- **Persistent freshness state across restarts** — AR76.
- **Log-level env var** — AR49 (closed-set MVP: `INFO` / `WARN` / `ERROR`).
- **A `health_check` MCP tool** — NFR8 forbids; Growth.
- **HTTP/SSE transport** — AR73, Growth.
- **Audit log rotation** — AR77, Growth.
- **A startup-time silversearch-plug probe** — `deferred-work.md:29`.
- **Extracting `createLifecycle` to its own module** — defer until Stories 2.x have a second consumer.
- **Property-based testing of the startup ladder** — restricted to the edit-batch validator (`architecture.md:1161`).

### Deferred-from-this-story candidates (proposed deferred-work entries — review post-implementation)

Append to `_bmad-output/implementation-artifacts/deferred-work.md` after the story lands, IF they feel real after the implementation pass:

1. **`closeRuntime` hook is a no-op stub** — The shutdown sequence calls a placeholder `closeRuntime` to honor architecture step 4 ("close runtime HTTP client"). Currently `globalThis.fetch` manages its own connection lifecycle and there's no per-request `AbortController`. When `deferred-work.md:27`'s timeout work lands, this hook gains a real implementation. Re-affirm as a Story 2.x cross-reference.

2. **Hard-stop force-exit may drop the audit-stream's last buffered line** — `process.exit(1)` from the hard-stop timer doesn't give `audit.close()` time to flush. Operationally acceptable (force-exit is by definition degraded; the missed line is bounded to one tool call), but the trade-off should be documented in `docs/audit-log.md` (Story 2.7). Audit-stream consumers should expect "the last line may be incomplete" for a force-exited process.

3. **`import.meta.url === \`file://${process.argv[1]}\`` is fragile** — symlinks (e.g., `npx`'s `bin` shim) and Windows paths break the equality check. The looser `endsWith` fallback works for most cases but misses the symlink edge. Revisit when an operator reports the bin not auto-running, or extract to a small `isMainModule()` helper that handles both ESM symlink resolution AND the `npm_lifecycle_event` env hint.

4. **`tests/integration/_startup-helpers.ts` shared harness module** — Story 1.11's test file inlines a ~100-line `buildFakeDeps` + `runUntilExit` helper. Stories 2.x integration tests may want to construct `StartupDeps`-shaped fakes for end-to-end "run the server and exercise an edit flow" tests. Extract when the 2nd consumer lands.

5. **`runtimeClientFactory` injection is asymmetric with `auditLoggerFactory`** — `runtimeClientFactory` takes `CreateRuntimeClientOptions` (config + optional fetch); `auditLoggerFactory` takes `OpenAuditLoggerOptions` (env + platform + homeDir + clock + logger). The shapes diverge because the underlying factories diverge. A future refactor that unifies the two seams (e.g., a `ServerWiring` type that bundles all factories) might emerge once write-side handlers land. Defer until a real symmetry pain-point shows up.

6. **`process.on('SIGINT' | 'SIGTERM' | ...)` listener leak in tests** — `node:test` runs each `await test(...)` in a shared process. Tests that emit `SIGINT` on a fake `process` are isolated, but a test that accidentally registers on the REAL `process` would leak listeners. Story 1.11's harness uses a fake `process` everywhere; verify with `process.listenerCount('SIGINT')` before/after each test if a leak is ever suspected.

7. **No exit-code differentiation between "shutdown completed cleanly" and "shutdown timed out"** at the cooperative-path level — only the hard-stop force-exit (AC5) emits exit code 1. A cooperative shutdown that hits an inner async error (e.g., `audit.close()` throws — guarded by the inner try/catch, but the catch logs WARN and exits 1) also surfaces as exit code 1. The two paths are observationally identical to the operator. A future enhancement could log distinct WARN lines or environment-tag the exit code, but the MVP behavior is "any non-clean shutdown exits 1".

8. **`McpServer.close()` is best-effort** — the SDK's current implementation closes the transport but does not guarantee in-flight protocol notifications are flushed to stdout before the close completes. A graceful shutdown that issues a final notification (e.g., `notifications/cancelled`) would need additional sequencing. Out of scope for MVP; revisit when MCP SDK adds explicit drain semantics.

### Project Structure Notes

- **Alignment with unified project structure:** `src/index.ts` (entry point: startup ladder + MCP transport wiring) matches the architecture's `src/` tree (`architecture.md:1239`) one-to-one. `src/mcp/registry.ts` matches `architecture.md:1288` (`src/mcp/registry.ts` — registers tools with `@modelcontextprotocol/sdk`). The architecture lists `registry.ts` as a sibling of `handler-template.ts` and `handlers/`; this story creates exactly that file.
- **Detected variances:** none. `src/index.ts` has been a 5-line stub since Story 1.1's scaffold (the stub explicitly notes "Entry point — startup ladder + MCP transport wiring lands in Story 1.11."). The rewrite is the long-planned content drop.
- **No `index.ts` re-export barrel** under `src/mcp/` or `src/` (AR57). The new `registry.ts` imports each handler by file directly.
- **MCP-layer is a boundary module** (AR58 / `epics.md:183`). `src/mcp/registry.ts` imports from `@modelcontextprotocol/sdk` (the only sanctioned SDK import outside `src/index.ts`); pure-domain modules MUST NOT import from `src/mcp/registry.ts`.
- **`src/index.ts` sits at the apex of the dependency graph** — it imports from EVERY major architectural seam (`config/`, `diagnostic/`, `audit/`, `silverbullet/`, `freshness/`, `mcp/handler-template`, `mcp/registry`). Pure-domain modules MUST NOT import from `src/index.ts` (the acyclic dependency rule per AR58).

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.11] (lines 605-635)
- D5 — Configuration & Startup Validation (the AR38/AR39 ladder this story implements): [Source: _bmad-output/planning-artifacts/architecture.md#D5] (lines 470-525)
- D7 — Process & Diagnostic Logging Discipline (the AR51/AR52 cooperative shutdown this story implements): [Source: _bmad-output/planning-artifacts/architecture.md#D7] (lines 642-712)
- Implementation sequence (this story = #12): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 824)
- Cross-component dependency map: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 830-844)
- Mandatory rules summary: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1167-1180)
- Anti-patterns explicitly forbidden: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1182-1193)
- Architectural boundaries (`src/index.ts` is the lifecycle owner): [Source: _bmad-output/planning-artifacts/architecture.md#Architectural Boundaries] (lines 1300-1337)
- AR36 — env-var-only configuration: [Source: _bmad-output/planning-artifacts/epics.md] (line 153)
- AR37 — zod validation, redacted on failure: [Source: _bmad-output/planning-artifacts/epics.md] (line 154)
- AR38 — startup ladder (env-read → zod → audit path → audit stream → /.ping → /.runtime/lua → connect): [Source: _bmad-output/planning-artifacts/epics.md] (line 155)
- AR39 — distinct startup error messages per category: [Source: _bmad-output/planning-artifacts/epics.md] (line 156)
- AR40 — secret-scrubber wraps the config: [Source: _bmad-output/planning-artifacts/epics.md] (line 157)
- AR41 — no hot-reload in MVP: [Source: _bmad-output/planning-artifacts/epics.md] (line 158)
- AR47 — stdout reserved for MCP JSON-RPC: [Source: _bmad-output/planning-artifacts/epics.md] (line 168)
- AR48 — single approved diagnostic logger module (only sanctioned stderr writer): [Source: _bmad-output/planning-artifacts/epics.md] (line 169)
- AR49 — closed level set (INFO/WARN/ERROR): [Source: _bmad-output/planning-artifacts/epics.md] (line 170)
- AR50 — diagnostic log captures lifecycle events: [Source: _bmad-output/planning-artifacts/epics.md] (line 171)
- AR51 — cooperative shutdown signals + sequence: [Source: _bmad-output/planning-artifacts/epics.md] (line 172)
- AR52 — top-level catch for unhandled exceptions: [Source: _bmad-output/planning-artifacts/epics.md] (line 173)
- AR53 — exactly-one audit entry per tool call: [Source: _bmad-output/planning-artifacts/epics.md] (line 176)
- AR58 — acyclic dependency rule: [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 — type-safety patterns (no `any`, structural narrowing): [Source: _bmad-output/planning-artifacts/epics.md] (line 186)
- AR61 — async patterns (`void someAsync()` only with inline justification): [Source: _bmad-output/planning-artifacts/epics.md] (line 188)
- NFR3 — cold start ≤ 3s: [Source: _bmad-output/planning-artifacts/epics.md] (line 73)
- NFR5 — token never logged: [Source: _bmad-output/planning-artifacts/epics.md] (line 77)
- NFR8 — no internal state via MCP surface: [Source: _bmad-output/planning-artifacts/epics.md] (line 80)
- NFR9 — shutdown ≤ 1s, no orphan child processes: [Source: _bmad-output/planning-artifacts/epics.md] (line 83)
- NFR12 — per-call failure does not poison the session: [Source: _bmad-output/planning-artifacts/epics.md] (line 86)
- NFR15 — use the official `@modelcontextprotocol/sdk`: [Source: _bmad-output/planning-artifacts/epics.md] (line 91)
- Existing `src/index.ts` stub (the file this story rewrites): [Source: src/index.ts] (lines 1-5)
- Existing `loadConfigOrExit` (consumed by the ladder): [Source: src/config/config.ts] (lines 262-273)
- Existing `formatConfigError` (the AR39 pattern this story extends to non-config errors): [Source: src/config/config.ts] (lines 208-239)
- Existing `productionExit` (the unbound-method-safe wrapper pattern): [Source: src/config/config.ts] (line 260)
- Existing `wrapConfig` (applied inside `loadConfigOrExit`): [Source: src/config/secret-scrubber.ts]
- Existing `Logger` interface + `logger` const + `createLogger`: [Source: src/diagnostic/logger.ts] (lines 15-93)
- Existing `openAuditLogger` (consumed by the ladder): [Source: src/audit/audit-logger.ts] (lines 502-522)
- Existing `AuditLogger.close()` contract: [Source: src/audit/audit-logger.ts] (lines 430-481)
- Existing `RuntimeClient`, `RUNTIME_ERROR_CODE`, `createRuntimeClient`: [Source: src/silverbullet/client.ts] (lines 29-40, 70-74, 145-258)
- Existing `createFreshnessState`: [Source: src/freshness/state.ts] (lines 55-87)
- Existing `defaultPermissionEngine`, `HandlerContext`, `formatToolError`, `infrastructureError`, `isDomainError`: [Source: src/mcp/handler-template.ts] (lines 76-78, 95-102, 130-132, 182-189, plus re-exports lines 41-49)
- Existing `handleListPages`, `handleSearchPages`, `handleReadPage`: [Source: src/mcp/handlers/list-pages.ts] (line 65), [Source: src/mcp/handlers/search-pages.ts] (line 63), [Source: src/mcp/handlers/read-page.ts] (line 66)
- Existing `MCPToolResult` shape (structurally compatible with the SDK's `CallToolResult`): [Source: src/domain/error.ts] (lines 75-78)
- Existing `infrastructureError` (used by the registry's draining-state branch): [Source: src/domain/error.ts] (lines 323-334)
- MCP SDK `McpServer` API: [Source: node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts] (lines 14-211)
- MCP SDK `StdioServerTransport` API: [Source: node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts] (lines 9-27)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-10-read-side-tool-handlers-list-pages-search-pages-read-page.md], [Source: _bmad-output/implementation-artifacts/1-9-freshness-state-module.md], [Source: _bmad-output/implementation-artifacts/1-7-silverbullet-runtime-client-and-latency-baseline.md], [Source: _bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md], [Source: _bmad-output/implementation-artifacts/1-4-configuration-module-and-secret-scrubber.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **MCP SDK `inputSchema` decision** — AC7's "omit `inputSchema`" guidance was incorrect at runtime: the SDK source at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:230-238` calls `typedHandler(extra)` with ONLY `extra` when `inputSchema` is absent, dropping the request's `arguments` field entirely. Resolved by setting `inputSchema: z.unknown()` on each tool — the SDK validates trivially, the handler retains its strict `z.object({...}).strict()` validation contract from Story 1.10. Decision recorded as a deferred-work entry below.
- **`@typescript-eslint/no-duplicate-type-constituents`** — initial `ProcessLike.exit(code?: number | string | null | undefined)` flagged the redundant `| undefined`. Dropped per the rule (optional + `undefined` is duplicative).
- **`@typescript-eslint/unbound-method`** on `loadConfigOrExit(env, deps.logger, deps.process.exit)` — passing the bound method directly loses the `ProcessLike`-bound `this`. Wrapped in a lambda `(code) => deps.process.exit(code)` per Story 1.4's `productionExit` precedent (`src/config/config.ts:260`).
- **EBADSTATUS status extraction** — `formatStartupError` initially read `details['status']`, but Story 1.6's `infrastructureError` nests the original payload under `details.underlying`. Fixed by reading `(details.underlying as { status? }).status`. Caught by the EBADSTATUS integration test (#5).
- **Shutdown IIFE rejection in tests** — initial design had `process.exit(exitCode)` outside the try/catch but inside the IIFE; the test fake's throw became an unhandled rejection that node:test reported as "asynchronous activity after the test ended". Wrapping the final `exit` call in a defensive try/catch (production rationale: defend the IIFE's settle even if Node ever surfaces a non-terminal `exit`) eliminated the test-time noise and is correct for production too — `process.exit` is documented to halt, so the catch arm is unreachable in real deployments.
- **Test-double lint cleanups** — `tests/integration/startup-ladder.test.ts` carries a top-of-file `eslint-disable @typescript-eslint/only-throw-error, @typescript-eslint/require-await` comment (mirroring `src/silverbullet/client.ts:1-11`'s precedent) because (a) the fake `client.ping`/`probe` throw `DomainError` literals via `infrastructureError(...)` (project pattern), and (b) test-double `async` methods without `await` are inherent. The unused `_transport` parameter inside the fake `mcpServerFactory.connect` was renamed and used via `void transport;` rather than the underscore-prefix dance.
- **Test count delta:** baseline 439 (post-1.10 per `1-10-...md:903`) → 459 (post-1.11) = **+20 net new cases**. Above the AC9 floor of ≥17.
- **Pack manifest verification:** `npm pack --dry-run 2>&1 | tail -5` confirms `total files: 29`, matching AC11 (28 baseline + 1 new source file: `src/mcp/registry.ts`; `src/index.ts` already in the manifest as the rewritten `bin` target; all `*.test.ts` excluded by `package.json:15`).
- **Module-isolation greps green:**
  - `grep -rE "console\.(log|info|debug)" src/index.ts src/mcp/registry.ts` → zero output.
  - `grep -rE "process\.stdout\.write" src/index.ts src/mcp/registry.ts` → zero output.
  - `grep -rE "@modelcontextprotocol/sdk" src/` → matches ONLY `src/index.ts` (constructor imports) and `src/mcp/registry.ts` (type-only imports), plus two JSDoc comment matches in `src/mcp/handler-template.ts` and `src/domain/error.ts`. NO match in handler files or pure-domain modules.
  - `grep -rE "Date\.now\(\)|new Date\(\)" src/mcp/registry.ts` → zero output (registry uses ctx-injected resources only; no clock at all in this module since draining-rejected calls record `durationMs: 0`).
  - `grep -nE "process\." src/index.ts` → matches ONLY in `productionProcess` wrappers (lines 541-547), `productionDeps` wiring (line 558), the bottom-of-file `main()` invocation (lines 568+), and JSDoc comments. The `runServer` body and `installShutdownTriggers` route every `process` access through `deps.process` — never bare.

### Completion Notes List

- ✅ AC1: Startup ladder at `src/index.ts` executes the D5 sequence in order (env-snapshot → `loadConfigOrExit` → `openAuditLogger` → `client.ping()` → `client.probe()` → `mcpServerFactory` + `registerTools` + `stdioTransportFactory` + `server.connect`). All three lifecycle banners (`'starting up (...)'`, `'connected — runtime API ok'`, `'ready (transport=stdio, audit=...)'`) are emitted in order on the success path.
- ✅ AC2: `formatStartupError` maps `ESBRUNTIME`, `EUNAUTHORIZED`, `EBADSTATUS`, `EBADRESPONSE`, `ECONNREFUSED`, `ENOTFOUND`, and the default arm to AR39's distinct fatal+hint pairs. The token VALUE never appears in any FATAL or hint line (verified by integration test #4 which asserts the leaky `'TEST-TOKEN'` literal does NOT appear in any captured error). All paths exit with code `1`.
- ✅ AC3: Synthetic ladder duration test (#2) asserts wall-clock < 3000 ms with mocked SB calls. The actual measured duration is sub-millisecond on the dev machine (mocks resolve immediately).
- ✅ AC4: Cooperative shutdown sequence covers `'stdin end'`, `'stdin close'`, `'SIGINT'`, `'SIGTERM'` triggers; markDraining → awaitInflight → audit.close → closeRuntime (no-op stub) → server.close → transitionToShutdown → exit(0). Idempotency tests (#15, #16) confirm double signals run the sequence ONCE. Draining-state test (#11) confirms new tool calls during draining are rejected with `infrastructure_error: server shutting down` and the underlying handler is NEVER invoked. In-flight test (#13) confirms the shutdown awaits the in-flight call before exiting.
- ✅ AC5: Hard-stop force-exit timer (`setTimeout(forceExit, 900).unref()`) fires `process.exit(1)` and a WARN line `'shutdown exceeded 900ms — forcing exit'` if the cooperative path hangs. Test #14 captures the timer via the fake `setTimeout`, asserts `unref()` was called, then invokes the captured callback directly — verifies `exit(1)` and the WARN line.
- ✅ AC6: Top-level `uncaughtException` and `unhandledRejection` handlers log at ERROR via `deps.logger.error(message, err)` with the full stack trace (per `src/diagnostic/logger.ts:35-42`). Neither calls `deps.process.exit` — NFR12 preserved. Tests #12 and #13 emit synthetic exceptions on the fake `process` and assert no exit + the ERROR line is recorded.
- ✅ AC7: `src/mcp/registry.ts` registers all three Story 1.10 handlers via `server.registerTool(name, { description, inputSchema: z.unknown(), annotations }, callback)`. The callback short-circuits to `formatToolError(infrastructureError('server shutting down'))` + direct audit-write when `lifecycle.isDraining()`. **Deviation from AC7's "omit inputSchema" guidance:** the SDK drops `arguments` when no schema is provided, so `z.unknown()` is the permissive passthrough that keeps args flowing without duplicating Story 1.10's strict validation. Documented in registry JSDoc and the deferred-work entry below.
- ✅ AC8: `createLifecycle()` factory owns `state` (`'starting' | 'serving' | 'draining' | 'shutdown'`) and the in-flight `Set<Promise<unknown>>`. `handle.isDraining()` returns `true` for `'draining'` and `'shutdown'`. `trackInflight` registers + auto-removes via `.finally`. `awaitInflight()` returns `Promise.allSettled([...])`.
- ✅ AC9: 20 integration test cases shipped (≥17 floor) covering happy path + cold-start budget, six error paths (ESBRUNTIME, EUNAUTHORIZED, EBADSTATUS, ECONNREFUSED, missing env, audit factory failure), three signal triggers (stdin end, SIGINT, SIGTERM), draining rejection, in-flight await, hard-stop, two top-level catches, two idempotency cases, registry tool-config check, and the no-leaked-rejections finalizer. All use top-level `await test(...)` (no `describe` blocks) and fixed-millisecond `Date` literals; no real fs / network / process / signals.
- ✅ AC10: `runServer(deps: StartupDeps): Promise<void>` is the testable seam. `productionDeps` wires every field. `StartupDeps` exposes `auditLoggerFactory` and `runtimeClientFactory` (per the dev-notes refinement) so tests inject fakes without touching `openAuditLogger`'s internals. The bottom-of-file `main()` uses `import.meta.url` comparison + a loose `endsWith` fallback to detect the entry-point context.
- ✅ AC11: All four gates green: `npm run typecheck` → exit 0, `npm run lint -- --max-warnings=0` → exit 0, `npx prettier --check .` → exit 0, `npm test` → 459/459 passing. Pack manifest = 29 files exactly. Module-isolation greps clean. No new dependencies.
- **No new dependencies.** `@modelcontextprotocol/sdk` was already a runtime dep at `^1.29.0` (`package.json:37`); first runtime usage in this story.
- **`scrubSecrets` import** — used inside `extractUnderlyingMessage`'s default-arm fallback to defend against any residual token-shaped field in arbitrary `details.underlying` payloads. The DomainError construction already scrubs at `infrastructureError(...)`-time, so this is belt-and-suspenders.
- **`TimerHandle = { unref(): void }`** narrows Node's `Timeout` to just the `unref` method we use, satisfying the `StartupDeps.setTimeout` contract without leaking Node's `Timeout` interface to test fakes.

### File List

**NEW:**

- `src/mcp/registry.ts`
- `tests/integration/startup-ladder.test.ts`

**MODIFIED:**

- `src/index.ts` — full rewrite from the 5-line stub to the production startup ladder + lifecycle + shutdown + signal handlers + `runServer` / `productionDeps` exports.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.11 status transitions (backlog → ready-for-dev → in-progress → review).
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended new entries from this dev pass.

**DELETED:**

- None.

### Change Log

| Date       | Change                                                                                       | Files                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2026-05-01 | feat(mcp): startup ladder, lifecycle, cooperative shutdown (story 1.11)                       | `src/index.ts`, `src/mcp/registry.ts`, `tests/integration/startup-ladder.test.ts` |
