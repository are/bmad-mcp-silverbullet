#!/usr/bin/env node

/**
 * Entry point — D5 startup ladder + MCP transport wiring + D7 cooperative
 * shutdown (Story 1.11). The 5-line stub from Story 1.1 is replaced by the
 * production composition: env-read → zod-validate → audit stream → SB
 * `/.ping` → SB `/.runtime/lua` probe → connect MCP stdio transport, with
 * fail-fast diagnostics on every step (AR38/AR39) and a cooperative
 * cooperative shutdown (AR51) bounded by a 900 ms hard-stop force-exit.
 *
 * The file is split into a testable `runServer(deps)` seam (driven by
 * `StartupDeps`) and a `productionDeps` constant that wires every dep to
 * the real Node API. The bottom-of-file `main()` invocation runs only when
 * this module is the process entry point, so tests can `import { runServer }`
 * without booting a real server.
 *
 * @see D5 — Configuration & Startup (`architecture.md:470-525`).
 * @see D7 — Process & Diagnostic Logging (`architecture.md:642-712`).
 * @see AR38 — startup ladder (`epics.md:155`).
 * @see AR39 — distinct startup error messages (`epics.md:156`).
 * @see AR51 — cooperative shutdown (`epics.md:172`).
 * @see AR52 — top-level catch for unhandled exceptions (`epics.md:173`).
 * @see NFR3 — cold start ≤ 3s (`epics.md:73`).
 * @see NFR9 — shutdown ≤ 1s (`epics.md:83`).
 * @see NFR12 — per-call failure does not poison the session (`epics.md:86`).
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  type AuditLogger,
  openAuditLogger,
  type OpenAuditLoggerOptions,
} from './audit/audit-logger.ts';
import { type Config, loadConfigOrExit } from './config/config.ts';
import { type Logger, logger as productionLogger } from './diagnostic/logger.ts';
import {
  type DomainError,
  infrastructureError,
  type ReasonCode,
  scrubSecrets,
} from './domain/error.ts';
import { createFreshnessState } from './freshness/state.ts';
import {
  defaultPermissionEngine,
  isDomainError,
  type HandlerContext,
} from './mcp/handler-template.ts';
import { type LifecycleHandle, registerTools } from './mcp/registry.ts';
import {
  createRuntimeClient,
  type CreateRuntimeClientOptions,
  type RuntimeClient,
} from './silverbullet/client.ts';

// ---------------------------------------------------------------------------
// Public types — `runServer` and `StartupDeps` are exported for tests.
// ---------------------------------------------------------------------------

type LifecycleState = 'starting' | 'serving' | 'draining' | 'shutdown';

/**
 * Narrow `process`-shaped surface used by `runServer`. The production wiring
 * binds these to the real `process` methods through wrapper lambdas (so
 * `@typescript-eslint/unbound-method` is satisfied — see Story 1.4's
 * `productionExit` precedent at `src/config/config.ts:260`).
 */
export type ProcessLike = {
  on(
    event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection',
    cb: (...args: unknown[]) => void,
  ): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  // Signature matches Node's `process.exit` so it can be passed to
  // `loadConfigOrExit`'s `ExitFn` parameter at `src/config/config.ts:241`.
  exit(code?: number | string | null): never;
};

/**
 * Narrow `setTimeout` surface — `unref()` keeps the hard-stop timer from
 * itself preventing the event loop from draining on a fast cooperative
 * shutdown.
 */
export type TimerHandle = { unref(): void };
export type SetTimeoutLike = (cb: () => void, ms: number) => TimerHandle;

/**
 * Every external surface the startup ladder touches. Tests inject a fully
 * faked dependency bag; production wires {@link productionDeps}.
 */
export type StartupDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly auditLoggerFactory: (opts: OpenAuditLoggerOptions) => {
    readonly logger: AuditLogger;
    readonly filePath: string;
  };
  readonly runtimeClientFactory: (opts: CreateRuntimeClientOptions) => RuntimeClient;
  readonly stdin: NodeJS.ReadableStream;
  readonly process: ProcessLike;
  readonly setTimeout: SetTimeoutLike;
  readonly mcpServerFactory: (info: { name: string; version: string }) => McpServer;
  readonly stdioTransportFactory: () => StdioServerTransport;
};

// ---------------------------------------------------------------------------
// SERVER_VERSION — read once at module load from `package.json`.
// `tsconfig.json` does not set `resolveJsonModule`, so `readFileSync` is the
// portable approach that works under both the typecheck and the runtime.
// ---------------------------------------------------------------------------

const SERVER_VERSION: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// Lifecycle factory — owns `state` and the in-flight Promise set.
// ---------------------------------------------------------------------------

type Lifecycle = {
  readonly handle: LifecycleHandle;
  markDraining(): void;
  awaitInflight(): Promise<void>;
  state(): LifecycleState;
  transitionToServing(): void;
  transitionToShutdown(): void;
};

function createLifecycle(): Lifecycle {
  let state: LifecycleState = 'starting';
  const inflight = new Set<Promise<unknown>>();

  function isDraining(): boolean {
    return state === 'draining' || state === 'shutdown';
  }

  function trackInflight<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise);
    // Fire-and-forget: remove from the set on settle. The original `promise`
    // is returned unchanged so the caller still sees the resolution / rejection.
    void promise.finally(() => inflight.delete(promise));
    return promise;
  }

  return {
    handle: { isDraining, trackInflight },
    markDraining(): void {
      state = 'draining';
    },
    async awaitInflight(): Promise<void> {
      await Promise.allSettled([...inflight]);
    },
    state(): LifecycleState {
      return state;
    },
    transitionToServing(): void {
      state = 'serving';
    },
    transitionToShutdown(): void {
      state = 'shutdown';
    },
  };
}

// ---------------------------------------------------------------------------
// Startup error formatter — AR39 distinct messages per category.
// ---------------------------------------------------------------------------

type StartupErrorContext = {
  readonly silverbulletUrl?: string;
};

/**
 * Pure: `unknown → { fatal, hint }`. Maps the runtime client's
 * `RUNTIME_ERROR_CODE` set + native errno codes into AR39's distinct fatal
 * lines. The token is NEVER inserted into either line — only variable names
 * and the URL appear (NFR5 / AR40).
 *
 * Non-DomainError throws are wrapped via `infrastructureError(err)` first so
 * the `details.code` / `details.underlying` extraction path is uniform.
 */
function formatStartupError(
  err: unknown,
  context: StartupErrorContext,
): { fatal: string; hint: string } {
  const domainErr: DomainError = isDomainError(err) ? err : infrastructureError(err);
  const details = domainErr.details;
  const code = typeof details['code'] === 'string' ? details['code'] : undefined;

  const url = context.silverbulletUrl ?? '<SILVERBULLET_URL>';

  switch (code) {
    case 'ESBRUNTIME':
      return {
        fatal: '[mcp-silverbullet] FATAL: SilverBullet Runtime API not enabled (HTTP 503)',
        hint: '[mcp-silverbullet] hint: see https://silverbullet.md/Runtime%20API — Chrome/Chromium must be installed, or use the -runtime-api Docker variant',
      };
    case 'EUNAUTHORIZED':
      return {
        fatal: '[mcp-silverbullet] FATAL: SilverBullet authentication failed',
        hint: '[mcp-silverbullet] hint: check SILVERBULLET_TOKEN',
      };
    case 'EBADSTATUS': {
      // `infrastructureError` nests the original payload under
      // `details.underlying` (with secrets scrubbed). The runtime client's
      // EBADSTATUS path puts `status` on that wrapped object.
      const underlying = details['underlying'];
      const rawStatus =
        typeof underlying === 'object' && underlying !== null
          ? (underlying as { status?: unknown }).status
          : undefined;
      const status =
        typeof rawStatus === 'number' || typeof rawStatus === 'string' ? String(rawStatus) : '???';
      return {
        fatal: `[mcp-silverbullet] FATAL: SilverBullet returned HTTP ${status}`,
        hint: `[mcp-silverbullet] hint: see ${url}/.ping in a browser to verify the endpoint`,
      };
    }
    case 'EBADRESPONSE':
      return {
        fatal: '[mcp-silverbullet] FATAL: SilverBullet returned an unparseable response',
        hint: '[mcp-silverbullet] hint: verify the Runtime API is enabled and not behind a proxy that rewrites bodies',
      };
    case 'ECONNREFUSED':
      return {
        fatal: `[mcp-silverbullet] FATAL: cannot connect to SilverBullet at ${url}`,
        hint: '[mcp-silverbullet] hint: check the URL and that SilverBullet is running',
      };
    case 'ENOTFOUND':
      return {
        fatal: '[mcp-silverbullet] FATAL: SilverBullet hostname did not resolve',
        hint: '[mcp-silverbullet] hint: check SILVERBULLET_URL',
      };
    default: {
      const underlyingMessage = extractUnderlyingMessage(details);
      return {
        fatal: '[mcp-silverbullet] FATAL: SilverBullet unreachable',
        hint: `[mcp-silverbullet] hint: ${underlyingMessage}`,
      };
    }
  }
}

/**
 * Extract a human-readable message from a `DomainError.details.underlying`
 * field for the AR39 default-arm hint line. The `infrastructureError` wrapper
 * has already scrubbed token-bearing fields per AR45; this helper only
 * truncates and renders.
 */
function extractUnderlyingMessage(details: Readonly<Record<string, unknown>>): string {
  const underlying = details['underlying'];
  if (underlying === undefined) return 'SilverBullet unreachable (no further detail)';
  if (typeof underlying === 'string') return truncate(underlying, 200);
  if (typeof underlying === 'object' && underlying !== null) {
    const message = (underlying as { message?: unknown }).message;
    if (typeof message === 'string') return truncate(message, 200);
  }
  // Fall through: render via `scrubSecrets` to defend against any residual
  // token-shaped field, then JSON-encode + truncate.
  try {
    const safe = scrubSecrets(underlying);
    return truncate(JSON.stringify(safe), 200);
  } catch {
    return 'SilverBullet unreachable';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// runServer — the testable entry-point seam.
// ---------------------------------------------------------------------------

/**
 * Run the MCP server end-to-end: D5 startup ladder, then enter the
 * serving state with cooperative shutdown wired. Resolves once the SDK
 * transport is connected and the listeners are installed; the process stays
 * alive via the stdio transport's read loop.
 *
 * Failures during the ladder route to `deps.process.exit(1)` via the
 * AR39-formatted FATAL+hint emitted on the diagnostic logger. Post-startup
 * failures route to either the per-handler `try/catch/finally` (Story 1.10)
 * or the top-level `uncaughtException`/`unhandledRejection` handlers
 * installed in step 6.
 */
export async function runServer(deps: StartupDeps): Promise<void> {
  // Step 1: capture frozen env snapshot.
  const env: Readonly<Record<string, string | undefined>> = Object.freeze({ ...deps.env });

  // Step 2: validate config (zod). `loadConfigOrExit` returns a wrapped
  // Config (token redacted in serializers per AR40); on failure it calls
  // deps.process.exit(1) directly via the `exitFn` injection. The wrapper
  // here re-throws if `exit` returns (it shouldn't in production, but tests
  // inject an `exitFn` that throws ExitSentinel — surfaced by the catch).
  // Wrap `deps.process.exit` in a lambda to satisfy
  // `@typescript-eslint/unbound-method` — direct method-reference passing
  // would lose the `this`-binding of the underlying ProcessLike.
  const config: Config = loadConfigOrExit(env, deps.logger, (code) => deps.process.exit(code));

  deps.logger.info(`starting up (silverbullet=${config.silverbulletUrl})`);

  // Step 3: resolve audit log path + open audit stream.
  let audit: AuditLogger;
  let auditFilePath: string;
  try {
    const opened = deps.auditLoggerFactory({
      env,
      platform: deps.platform,
      homeDir: deps.homeDir,
      clock: deps.clock,
      logger: deps.logger,
    });
    audit = opened.logger;
    auditFilePath = opened.filePath;
  } catch (err) {
    fatalExit(err, { silverbulletUrl: config.silverbulletUrl }, deps);
  }

  // Step 4 + 5: SB liveness + Runtime-API probe. Both errors route through
  // the same AR39 mapping; the ladder distinguishes only by `details.code`.
  const client: RuntimeClient = deps.runtimeClientFactory({ config });

  try {
    await client.ping();
  } catch (err) {
    await safeAuditClose(audit, deps.logger);
    fatalExit(err, { silverbulletUrl: config.silverbulletUrl }, deps);
  }

  try {
    await client.probe();
  } catch (err) {
    await safeAuditClose(audit, deps.logger);
    fatalExit(err, { silverbulletUrl: config.silverbulletUrl }, deps);
  }

  deps.logger.info('connected — runtime API ok');

  // Step 6: build HandlerContext, register tools, connect transport.
  const ctx: HandlerContext = {
    client,
    permissionEngine: defaultPermissionEngine,
    freshness: createFreshnessState(),
    audit,
    logger: deps.logger,
    clock: deps.clock,
  };
  const lifecycle = createLifecycle();
  const server = deps.mcpServerFactory({ name: 'mcp-silverbullet', version: SERVER_VERSION });
  registerTools({ server, ctx, lifecycle: lifecycle.handle });
  const transport = deps.stdioTransportFactory();
  await server.connect(transport);

  lifecycle.transitionToServing();
  deps.logger.info(`ready (transport=stdio, audit=${auditFilePath})`);

  // Wire signal handlers + stdin-close listeners + top-level exception
  // handlers. The shutdown closure captures `deps`, `audit`, `server`, and
  // `lifecycle` so each trigger calls the same sequence.
  installShutdownTriggers({ deps, audit, server, lifecycle });
  installTopLevelCatches(deps);
}

// ---------------------------------------------------------------------------
// Shutdown sequence (AR51) + hard-stop timer (AR51 / 900 ms).
// ---------------------------------------------------------------------------

type ShutdownReason = 'stdio-end' | 'stdio-close' | 'SIGINT' | 'SIGTERM';

function bannerFor(reason: ShutdownReason): string {
  switch (reason) {
    case 'stdio-end':
    case 'stdio-close':
      return 'stdio closed';
    case 'SIGINT':
      return 'received SIGINT';
    case 'SIGTERM':
      return 'received SIGTERM';
  }
}

type ShutdownContext = {
  readonly deps: StartupDeps;
  readonly audit: AuditLogger;
  readonly server: McpServer;
  readonly lifecycle: Lifecycle;
};

function installShutdownTriggers(opts: ShutdownContext): void {
  let shuttingDown = false;

  function shutdown(reason: ShutdownReason): void {
    if (shuttingDown) return;
    shuttingDown = true;

    // Hard-stop FIRST — a hang at any step still terminates within 900 ms.
    const hardStopTimer = opts.deps.setTimeout(() => {
      opts.deps.logger.warn('shutdown exceeded 900ms — forcing exit');
      opts.deps.process.exit(1);
    }, 900);
    hardStopTimer.unref();

    opts.deps.logger.info(`${bannerFor(reason)}; flushing`);
    opts.lifecycle.markDraining();

    // Async work in a fire-and-forget IIFE; signal handlers must be sync.
    // The `process.exit` call is OUTSIDE the try/catch — a successful shutdown
    // is genuinely terminal in production (real `process.exit(0)` halts), and
    // keeping it out of the catch prevents a test-injected `exit` that throws
    // from being recursively re-caught and re-firing as `exit(1)`.
    void (async () => {
      let exitCode = 0;
      try {
        await opts.lifecycle.awaitInflight();
        await opts.audit.close();
        // closeRuntime hook — no-op for now; future AbortController seam
        // when `deferred-work.md`'s fetch-timeout work lands.
        await closeRuntime();
        try {
          await opts.server.close();
        } catch (closeErr) {
          opts.deps.logger.warn(`mcp transport close failed: ${stringifyError(closeErr)}`);
        }
      } catch (asyncErr) {
        opts.deps.logger.warn(`shutdown sequence error: ${stringifyError(asyncErr)}`);
        exitCode = 1;
      }
      opts.lifecycle.transitionToShutdown();
      opts.deps.logger.info('shutdown complete');
      // Defend against the (unreachable in production) case where
      // `process.exit` returns or throws — keep the IIFE settling cleanly.
      // Real `process.exit` halts the process; control never reaches the
      // catch arm below.
      try {
        opts.deps.process.exit(exitCode);
      } catch {
        /* halted via injected fake (tests) */
      }
    })();
  }

  opts.deps.stdin.once('end', () => {
    shutdown('stdio-end');
  });
  opts.deps.stdin.once('close', () => {
    shutdown('stdio-close');
  });
  opts.deps.process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  opts.deps.process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

/**
 * Stub for the future `RuntimeClient.close()` — `deferred-work.md` defers
 * fetch-timeout / `AbortController` work; once that lands, this hook gains
 * a real implementation. Today `globalThis.fetch` manages its own connection
 * lifecycle, so the no-op is correct.
 */
async function closeRuntime(): Promise<void> {
  // Intentionally empty. See JSDoc above and Story 1.11 deferred-work.
  return Promise.resolve();
}

async function safeAuditClose(audit: AuditLogger, logger: Logger): Promise<void> {
  try {
    await audit.close();
  } catch (err) {
    logger.warn(`audit close failed during startup-failure cleanup: ${stringifyError(err)}`);
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Top-level uncaughtException / unhandledRejection (AR52, NFR12).
// ---------------------------------------------------------------------------

function installTopLevelCatches(deps: StartupDeps): void {
  deps.process.on('uncaughtException', (...args: unknown[]) => {
    const err = args[0];
    deps.logger.error(`uncaughtException: ${stringifyError(err)}`, err);
    // Do NOT exit. NFR12 — per-call failures don't poison the session.
  });
  deps.process.on('unhandledRejection', (...args: unknown[]) => {
    const reason = args[0];
    deps.logger.error(`unhandledRejection: ${stringifyError(reason)}`, reason);
    // Do NOT exit. NFR12.
  });
}

// ---------------------------------------------------------------------------
// fatalExit — emit AR39 FATAL+hint and call `deps.process.exit(1)`.
// ---------------------------------------------------------------------------

/**
 * Type-narrow helper for the ladder's catch arms: format the error per AR39,
 * emit FATAL + hint via the diagnostic logger, then exit. Returns `never` so
 * TS narrows the surrounding flow.
 */
function fatalExit(err: unknown, context: StartupErrorContext, deps: StartupDeps): never {
  const { fatal, hint } = formatStartupError(err, context);
  deps.logger.error(fatal);
  deps.logger.error(hint);
  return deps.process.exit(1);
}

// ---------------------------------------------------------------------------
// productionDeps — wires every StartupDeps field to the real Node API.
// ---------------------------------------------------------------------------

const productionProcess: ProcessLike = {
  on(event, cb) {
    process.on(event, cb);
  },
  off(event, cb) {
    process.off(event, cb);
  },
  exit(code) {
    return process.exit(code);
  },
};

const productionSetTimeout: SetTimeoutLike = (cb, ms) => {
  const timer = setTimeout(cb, ms);
  return {
    unref(): void {
      timer.unref();
    },
  };
};

export const productionDeps: StartupDeps = {
  env: process.env,
  platform: process.platform,
  homeDir: os.homedir(),
  clock: () => new Date(),
  logger: productionLogger,
  auditLoggerFactory: openAuditLogger,
  runtimeClientFactory: createRuntimeClient,
  stdin: process.stdin,
  process: productionProcess,
  setTimeout: productionSetTimeout,
  mcpServerFactory: (info) => new McpServer(info),
  stdioTransportFactory: () => new StdioServerTransport(),
};

// ---------------------------------------------------------------------------
// main() — runs only when this module is the process entry point.
// ESM has no `require.main`; the `import.meta.url` comparison is the
// equivalent. The `endsWith` fallback covers symlinks and the `bin` shim.
// ---------------------------------------------------------------------------

const argv1 = process.argv[1];
const isEntryPoint =
  argv1 !== undefined &&
  (import.meta.url === `file://${argv1}` ||
    import.meta.url === argv1 ||
    import.meta.url.endsWith(argv1));

if (isEntryPoint) {
  void runServer(productionDeps);
}

// Re-exports kept intentional — tests import these from `'../../src/index.ts'`.
// Story 1.11 owns the dependency-injection seam.
export { isDomainError, type DomainError, type ReasonCode };
