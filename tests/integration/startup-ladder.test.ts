/* eslint-disable @typescript-eslint/only-throw-error, @typescript-eslint/require-await --
 * Throwing DomainError values is the project's documented pattern (see
 * `src/silverbullet/client.ts:1-11` for the precedent). Test-double async
 * methods are inherently `async` without `await`. Disabling per-file is the
 * established `tests/integration/` convention. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runServer, type StartupDeps } from '../../src/index.ts';
import type { AuditLogger, OpenAuditLoggerOptions } from '../../src/audit/audit-logger.ts';
import type { AuditEntryInput } from '../../src/audit/schema.ts';
import type { Logger } from '../../src/diagnostic/logger.ts';
import { infrastructureError } from '../../src/domain/error.ts';
import type { CreateRuntimeClientOptions } from '../../src/silverbullet/client.ts';

// ---------------------------------------------------------------------------
// Suppress the harmless ExitSentinel rejections that surface when the
// shutdown IIFE calls our fake `process.exit`. Real unhandled rejections are
// captured separately and assertion-checked at the end of the file.
// ---------------------------------------------------------------------------

class ExitSentinel extends Error {
  override readonly name = 'ExitSentinel';
  readonly code: number;
  constructor(code: number) {
    super(`exit(${String(code)})`);
    this.code = code;
  }
}

const unexpectedRejections: unknown[] = [];
process.on('unhandledRejection', (reason: unknown) => {
  if (!(reason instanceof ExitSentinel)) unexpectedRejections.push(reason);
});

// ---------------------------------------------------------------------------
// Test harness — fakes for every StartupDeps field.
// ---------------------------------------------------------------------------

type CapturedLogger = {
  info: string[];
  warn: string[];
  error: Array<{ message: string; err?: unknown }>;
};

function makeMockLogger(captured: CapturedLogger): Logger {
  return {
    info(msg) {
      captured.info.push(msg);
    },
    warn(msg) {
      captured.warn.push(msg);
    },
    error(msg, err) {
      captured.error.push(err !== undefined ? { message: msg, err } : { message: msg });
    },
  };
}

type CapturedAudit = {
  writes: AuditEntryInput[];
  closes: number;
  closeShouldThrow?: boolean;
};

function makeMockAudit(captured: CapturedAudit): AuditLogger {
  return {
    write(entry) {
      captured.writes.push(entry);
    },
    close: async () => {
      captured.closes += 1;
      if (captured.closeShouldThrow === true) {
        throw new Error('audit close failed');
      }
    },
  };
}

type CapturedRegisteredTool = {
  readonly name: string;
  // The SDK's `registerTool` callback shape — args + extra. We capture the
  // callback so tests can directly invoke it (simulating the SDK dispatching
  // a `tools/call` request).
  readonly callback: (args: unknown, extra: unknown) => Promise<unknown>;
  readonly config: { description?: string; annotations?: unknown };
};

type CapturedServer = {
  registeredTools: CapturedRegisteredTool[];
  connectCalls: number;
  closeCalls: number;
  closeShouldThrow?: boolean;
};

function makeMockServer(captured: CapturedServer): McpServer {
  // Construct a fake McpServer whose surface is just enough for runServer.
  // The cast is necessary because we only implement the methods we exercise.
  const fake = {
    registerTool(
      name: string,
      config: { description?: string; annotations?: unknown },
      callback: (args: unknown, extra: unknown) => Promise<unknown>,
    ): unknown {
      captured.registeredTools.push({ name, config, callback });
      return {};
    },
    connect: async (transport: unknown): Promise<void> => {
      void transport;
      captured.connectCalls += 1;
    },
    close: async (): Promise<void> => {
      captured.closeCalls += 1;
      if (captured.closeShouldThrow === true) throw new Error('transport close failed');
    },
  };
  return fake as unknown as McpServer;
}

type CapturedProcess = {
  events: EventEmitter;
  exitCalls: number[];
  whenExited: Promise<number>;
  triggerExit: (code: number) => void;
  process: StartupDeps['process'];
};

function makeMockProcess(): CapturedProcess {
  const events = new EventEmitter();
  const exitCalls: number[] = [];
  let resolveExit: ((c: number) => void) | undefined;
  const whenExited = new Promise<number>((res) => {
    resolveExit = res;
  });
  const triggerExit = (code: number): void => {
    if (exitCalls.length === 0) {
      resolveExit?.(code);
    }
    exitCalls.push(code);
  };
  const proc: StartupDeps['process'] = {
    on(event, cb) {
      events.on(event, cb);
    },
    off(event, cb) {
      events.off(event, cb);
    },
    exit(code) {
      const numCode = typeof code === 'number' ? code : 0;
      triggerExit(numCode);
      throw new ExitSentinel(numCode);
    },
  };
  return { events, exitCalls, whenExited, triggerExit, process: proc };
}

type CapturedTimer = {
  cb: () => void;
  ms: number;
  unrefCalls: number;
};

function makeMockSetTimeout(captured: CapturedTimer[]): StartupDeps['setTimeout'] {
  return (cb, ms) => {
    const entry = { cb, ms, unrefCalls: 0 };
    captured.push(entry);
    return {
      unref(): void {
        entry.unrefCalls += 1;
      },
    };
  };
}

type RuntimeBehaviour = {
  ping?: () => Promise<void> | Promise<never>;
  probe?: () => Promise<void> | Promise<never>;
  exec?: <T>(script: string, params?: Readonly<Record<string, unknown>>) => Promise<T>;
};

function makeMockRuntimeClientFactory(
  behaviour: RuntimeBehaviour,
  capturedConfig: Array<CreateRuntimeClientOptions>,
): StartupDeps['runtimeClientFactory'] {
  return (opts) => {
    capturedConfig.push(opts);
    return {
      ping: behaviour.ping ?? (async () => {}),
      probe: behaviour.probe ?? (async () => {}),
      exec: behaviour.exec ?? (async <T>(): Promise<T> => undefined as T),
    };
  };
}

type AuditFactoryBehaviour = {
  shouldThrow?: boolean;
  filePath?: string;
};

function makeMockAuditFactory(
  audit: AuditLogger,
  behaviour: AuditFactoryBehaviour,
  capturedOpts: OpenAuditLoggerOptions[],
): StartupDeps['auditLoggerFactory'] {
  return (opts) => {
    capturedOpts.push(opts);
    if (behaviour.shouldThrow === true) {
      throw new Error('audit factory failure');
    }
    return { logger: audit, filePath: behaviour.filePath ?? '/tmp/audit.jsonl' };
  };
}

const FIXED_DATE = new Date('2026-05-01T12:00:00Z');

type Harness = {
  deps: StartupDeps;
  logger: CapturedLogger;
  audit: CapturedAudit;
  server: CapturedServer;
  proc: CapturedProcess;
  timers: CapturedTimer[];
  runtimeOpts: CreateRuntimeClientOptions[];
  auditFactoryOpts: OpenAuditLoggerOptions[];
  stdin: PassThrough;
};

type HarnessOverrides = {
  env?: Record<string, string | undefined>;
  ping?: () => Promise<void>;
  probe?: () => Promise<void>;
  exec?: <T>(script: string, params?: Readonly<Record<string, unknown>>) => Promise<T>;
  auditFactoryShouldThrow?: boolean;
  auditCloseShouldThrow?: boolean;
  serverCloseShouldThrow?: boolean;
  auditFilePath?: string;
};

function buildHarness(overrides: HarnessOverrides = {}): Harness {
  const logger: CapturedLogger = { info: [], warn: [], error: [] };
  const audit: CapturedAudit = { writes: [], closes: 0 };
  if (overrides.auditCloseShouldThrow === true) audit.closeShouldThrow = true;
  const server: CapturedServer = { registeredTools: [], connectCalls: 0, closeCalls: 0 };
  if (overrides.serverCloseShouldThrow === true) server.closeShouldThrow = true;
  const proc = makeMockProcess();
  const timers: CapturedTimer[] = [];
  const runtimeOpts: CreateRuntimeClientOptions[] = [];
  const auditFactoryOpts: OpenAuditLoggerOptions[] = [];
  const stdin = new PassThrough();

  const env = overrides.env ?? {
    SILVERBULLET_URL: 'https://test.example',
    SILVERBULLET_TOKEN: 'TEST-TOKEN',
  };

  const deps: StartupDeps = {
    env,
    platform: 'linux',
    homeDir: '/home/test',
    clock: () => FIXED_DATE,
    logger: makeMockLogger(logger),
    auditLoggerFactory: makeMockAuditFactory(
      makeMockAudit(audit),
      {
        ...(overrides.auditFactoryShouldThrow === true ? { shouldThrow: true } : {}),
        ...(overrides.auditFilePath !== undefined ? { filePath: overrides.auditFilePath } : {}),
      },
      auditFactoryOpts,
    ),
    runtimeClientFactory: makeMockRuntimeClientFactory(
      {
        ...(overrides.ping !== undefined ? { ping: overrides.ping } : {}),
        ...(overrides.probe !== undefined ? { probe: overrides.probe } : {}),
        ...(overrides.exec !== undefined ? { exec: overrides.exec } : {}),
      },
      runtimeOpts,
    ),
    stdin,
    process: proc.process,
    setTimeout: makeMockSetTimeout(timers),
    mcpServerFactory: () => makeMockServer(server),
    stdioTransportFactory: () => ({}) as unknown as StdioServerTransport,
  };

  return { deps, logger, audit, server, proc, timers, runtimeOpts, auditFactoryOpts, stdin };
}

async function flushMicrotasks(): Promise<void> {
  // Drain the microtask queue a few times so the shutdown IIFE's awaits
  // settle and `process.exit` is recorded.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ===========================================================================
// AC1 + AC3 — Startup ladder happy path + cold-start budget
// ===========================================================================

await test('startup ladder: happy path reaches `serving`, registers all 3 tools, banners in order', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  // All three lifecycle banners present, in order.
  assert.strictEqual(h.logger.info[0], 'starting up (silverbullet=https://test.example)');
  assert.strictEqual(h.logger.info[1], 'connected — runtime API ok');
  assert.strictEqual(h.logger.info[2], 'ready (transport=stdio, audit=/tmp/audit.jsonl)');

  // No fatal errors on the success path.
  assert.strictEqual(h.logger.error.length, 0);

  // Three tools registered with the SDK.
  assert.strictEqual(h.server.registeredTools.length, 3);
  const names = h.server.registeredTools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['list_pages', 'read_page', 'search_pages']);

  // SDK transport connected exactly once.
  assert.strictEqual(h.server.connectCalls, 1);

  // Process did NOT exit on the success path.
  assert.strictEqual(h.proc.exitCalls.length, 0);
});

await test('startup ladder: synthetic cold-start completes well under NFR3 (3000ms)', async () => {
  const h = buildHarness();
  const startedAt = Date.now();
  await runServer(h.deps);
  const elapsed = Date.now() - startedAt;
  // Synthetic ladder with mocked SB calls should be under 3 seconds. The
  // assertion is a regression floor — without the mocks we cannot exercise
  // real-network NFR3 here.
  assert.ok(elapsed < 3000, `synthetic ladder took ${String(elapsed)} ms (NFR3 budget 3000ms)`);
});

// ===========================================================================
// AC2 — Distinct startup error messages per category
// ===========================================================================

await test('startup ladder: ESBRUNTIME (HTTP 503) emits Runtime-API hint, exits 1', async () => {
  const h = buildHarness({
    probe: async () => {
      throw infrastructureError({
        message: 'silverbullet runtime API returned 503',
        status: 503,
        code: 'ESBRUNTIME',
      });
    },
  });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  assert.deepStrictEqual(h.proc.exitCalls, [1]);
  const fatal = h.logger.error[0]?.message ?? '';
  const hint = h.logger.error[1]?.message ?? '';
  assert.match(fatal, /SilverBullet Runtime API not enabled \(HTTP 503\)/);
  assert.match(hint, /Chrome\/Chromium must be installed|-runtime-api Docker variant/);
  // Audit stream was opened then closed during cleanup.
  assert.strictEqual(h.audit.closes, 1);
});

await test('startup ladder: EUNAUTHORIZED (401) emits auth hint naming SILVERBULLET_TOKEN, exits 1', async () => {
  const h = buildHarness({
    probe: async () => {
      throw infrastructureError({
        message: 'silverbullet runtime API returned 401',
        status: 401,
        code: 'EUNAUTHORIZED',
      });
    },
  });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  assert.deepStrictEqual(h.proc.exitCalls, [1]);
  const fatal = h.logger.error[0]?.message ?? '';
  const hint = h.logger.error[1]?.message ?? '';
  assert.match(fatal, /SilverBullet authentication failed/);
  assert.match(hint, /SILVERBULLET_TOKEN/);
  // Token VALUE never echoed (not even the variable name's value):
  for (const e of h.logger.error) {
    assert.ok(!e.message.includes('TEST-TOKEN'), `token leaked: ${e.message}`);
  }
});

await test('startup ladder: EBADSTATUS (500) emits status in fatal, exits 1', async () => {
  const h = buildHarness({
    ping: async () => {
      throw infrastructureError({
        message: 'silverbullet /.ping returned 500',
        status: 500,
        code: 'EBADSTATUS',
      });
    },
  });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  const fatal = h.logger.error[0]?.message ?? '';
  assert.match(fatal, /HTTP 500/);
});

await test('startup ladder: ECONNREFUSED native errno emits URL in fatal, exits 1', async () => {
  const econnrefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
    code: 'ECONNREFUSED',
  });
  const h = buildHarness({
    ping: async () => {
      throw infrastructureError(econnrefused);
    },
  });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  const fatal = h.logger.error[0]?.message ?? '';
  const hint = h.logger.error[1]?.message ?? '';
  assert.match(fatal, /cannot connect to SilverBullet at https:\/\/test\.example/);
  assert.match(hint, /check the URL and that SilverBullet is running/);
});

await test('startup ladder: missing env exits via loadConfigOrExit (no SB calls made)', async () => {
  const h = buildHarness({ env: {} });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  assert.deepStrictEqual(h.proc.exitCalls, [1]);
  // Runtime client factory was NEVER invoked (we exited before step 4).
  assert.strictEqual(h.runtimeOpts.length, 0);
  // Audit factory was NEVER invoked (we exited before step 3).
  assert.strictEqual(h.auditFactoryOpts.length, 0);
});

await test('startup ladder: audit factory failure exits 1 with FATAL emitted', async () => {
  const h = buildHarness({ auditFactoryShouldThrow: true });
  await assert.rejects(runServer(h.deps), ExitSentinel);
  assert.deepStrictEqual(h.proc.exitCalls, [1]);
  // The audit-factory failure routes to `formatStartupError` → default arm
  // (no `code`); the message includes the underlying error text.
  const fatal = h.logger.error[0]?.message ?? '';
  assert.match(fatal, /SilverBullet unreachable/);
});

// ===========================================================================
// AC4 — Cooperative shutdown sequence
// ===========================================================================

await test('shutdown: stdin end triggers shutdown, audit + server closed, exit(0)', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.stdin.emit('end');
  await flushMicrotasks();
  // Wait for the IIFE to run through all its awaits.
  await h.proc.whenExited;

  assert.deepStrictEqual(h.proc.exitCalls, [0]);
  assert.strictEqual(h.audit.closes, 1);
  assert.strictEqual(h.server.closeCalls, 1);
  // Diagnostic banners: 'stdio closed; flushing' AND 'shutdown complete'.
  assert.ok(
    h.logger.info.some((l) => l === 'stdio closed; flushing'),
    `expected "stdio closed; flushing" in info: ${JSON.stringify(h.logger.info)}`,
  );
  assert.ok(h.logger.info.some((l) => l === 'shutdown complete'));
});

await test('shutdown: SIGINT triggers shutdown with received-SIGINT banner', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.proc.events.emit('SIGINT');
  await flushMicrotasks();
  await h.proc.whenExited;

  assert.deepStrictEqual(h.proc.exitCalls, [0]);
  assert.ok(h.logger.info.some((l) => l === 'received SIGINT; flushing'));
  assert.ok(h.logger.info.some((l) => l === 'shutdown complete'));
});

await test('shutdown: SIGTERM triggers shutdown with received-SIGTERM banner', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.proc.events.emit('SIGTERM');
  await flushMicrotasks();
  await h.proc.whenExited;

  assert.deepStrictEqual(h.proc.exitCalls, [0]);
  assert.ok(h.logger.info.some((l) => l === 'received SIGTERM; flushing'));
});

await test('shutdown: new tool call during draining is rejected with infrastructure_error', async () => {
  // Track which underlying handler was invoked (none should be).
  let listPagesScriptCalls = 0;
  const h = buildHarness({
    exec: async <T>(script: string): Promise<T> => {
      // Track ANY exec call so we can prove the underlying handler wasn't
      // reached. (The handler itself calls exec twice — config blocks then
      // list pages.)
      listPagesScriptCalls += 1;
      void script;
      return undefined as T;
    },
  });
  await runServer(h.deps);

  // Trigger SIGINT — this flips the lifecycle to 'draining' synchronously
  // (before the async IIFE body runs).
  h.proc.events.emit('SIGINT');

  // BEFORE awaiting the shutdown completion, invoke the registered list_pages
  // callback directly. The lifecycle is in 'draining' (markDraining ran sync).
  const listPagesEntry = h.server.registeredTools.find((t) => t.name === 'list_pages');
  assert.ok(listPagesEntry, 'list_pages must be registered');
  const result = (await listPagesEntry.callback({}, {})) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };

  // The wrapper short-circuited; the handler was never invoked.
  assert.strictEqual(listPagesScriptCalls, 0);
  // Response is a tool error containing 'server shutting down'.
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /server shutting down/);
  // Exactly one audit entry: tool=list_pages, decision=rejected,
  // reason=infrastructure_error.
  assert.strictEqual(h.audit.writes.length, 1);
  const entry = h.audit.writes[0];
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.tool, 'list_pages');
  assert.strictEqual(entry.decision, 'rejected');
  assert.strictEqual(entry.reason, 'infrastructure_error');

  // Let the shutdown IIFE settle.
  await flushMicrotasks();
  await h.proc.whenExited;
});

await test('shutdown: in-flight tool call is awaited before exit', async () => {
  let resolveExec: (() => void) | undefined;
  const execGate = new Promise<void>((res) => {
    resolveExec = res;
  });
  let execCallCount = 0;
  const h = buildHarness({
    exec: async <T>(script: string): Promise<T> => {
      execCallCount += 1;
      // First exec is queryConfigBlocks; second is listPagesScript.
      // Only block on the second to keep the test simple.
      if (execCallCount === 2) await execGate;
      void script;
      // Return values shaped for the queryConfigBlocks / listPages contracts.
      if (execCallCount === 1) return { blocks: [] } as unknown as T;
      return { pages: [] } as unknown as T;
    },
  });
  await runServer(h.deps);

  // Kick off list_pages — its second exec call hangs on `execGate`.
  const listPagesEntry = h.server.registeredTools.find((t) => t.name === 'list_pages');
  assert.ok(listPagesEntry);
  const inflight = listPagesEntry.callback({}, {});

  // Let the handler reach the hung exec call.
  await Promise.resolve();
  await Promise.resolve();

  // Trigger SIGINT.
  h.proc.events.emit('SIGINT');
  await flushMicrotasks();

  // exit(0) must NOT have fired yet — the in-flight call is still hung.
  assert.strictEqual(h.proc.exitCalls.length, 0, 'exit fired before in-flight settled');

  // Resolve the gate; in-flight call completes; shutdown proceeds.
  resolveExec?.();
  await inflight;
  await flushMicrotasks();
  await h.proc.whenExited;

  assert.deepStrictEqual(h.proc.exitCalls, [0]);
});

// ===========================================================================
// AC5 — Hard-stop force-exit at 900 ms
// ===========================================================================

await test('shutdown: hard-stop force-exits with code 1 if shutdown hangs past 900ms', async () => {
  // exec hangs forever — in-flight call never resolves.
  const neverResolves = new Promise<never>(() => {});
  let execCallCount = 0;
  const h = buildHarness({
    exec: async <T>(script: string): Promise<T> => {
      execCallCount += 1;
      void script;
      if (execCallCount === 1) return { blocks: [] } as unknown as T;
      return neverResolves;
    },
  });
  await runServer(h.deps);

  // Kick off list_pages — hangs forever.
  const listPagesEntry = h.server.registeredTools.find((t) => t.name === 'list_pages');
  assert.ok(listPagesEntry);
  void listPagesEntry.callback({}, {});
  await Promise.resolve();
  await Promise.resolve();

  // Trigger shutdown — sets a 900ms hard-stop timer via our fake setTimeout.
  h.proc.events.emit('SIGINT');
  await flushMicrotasks();

  // The fake setTimeout captured (cb, 900). Find it and invoke directly.
  const hardStop = h.timers.find((t) => t.ms === 900);
  assert.ok(
    hardStop,
    `expected a 900ms timer; captured: ${JSON.stringify(h.timers.map((t) => t.ms))}`,
  );
  assert.ok(hardStop.unrefCalls > 0, 'hard-stop timer must be .unref()-ed');

  // Fire the hard-stop callback — emits WARN and exit(1).
  assert.throws(() => hardStop.cb(), ExitSentinel);

  assert.deepStrictEqual(h.proc.exitCalls, [1]);
  assert.ok(h.logger.warn.some((l) => l === 'shutdown exceeded 900ms — forcing exit'));
});

// ===========================================================================
// AC6 — Top-level catch for unhandled exceptions and promise rejections
// ===========================================================================

await test('top-level uncaughtException: logs ERROR, does NOT exit (NFR12)', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  // Fire the uncaughtException listener directly.
  h.proc.events.emit('uncaughtException', new Error('boom'));
  await flushMicrotasks();

  assert.strictEqual(h.proc.exitCalls.length, 0, 'NFR12 — must not exit');
  assert.ok(h.logger.error.some((e) => /uncaughtException: boom/.test(e.message)));
});

await test('top-level unhandledRejection: logs ERROR, does NOT exit (NFR12)', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.proc.events.emit('unhandledRejection', new Error('rejected-boom'), Promise.resolve());
  await flushMicrotasks();

  assert.strictEqual(h.proc.exitCalls.length, 0);
  assert.ok(h.logger.error.some((e) => /unhandledRejection: rejected-boom/.test(e.message)));
});

// ===========================================================================
// AC4 — Idempotency
// ===========================================================================

await test('shutdown: double signal (SIGINT then SIGTERM) runs sequence once', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.proc.events.emit('SIGINT');
  h.proc.events.emit('SIGTERM');
  await flushMicrotasks();
  await h.proc.whenExited;

  // Each external surface called exactly once.
  assert.deepStrictEqual(h.proc.exitCalls, [0]);
  assert.strictEqual(h.audit.closes, 1);
  assert.strictEqual(h.server.closeCalls, 1);
});

await test('shutdown: stdin end + close fired together still runs once', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  h.stdin.emit('end');
  h.stdin.emit('close');
  await flushMicrotasks();
  await h.proc.whenExited;

  assert.deepStrictEqual(h.proc.exitCalls, [0]);
  assert.strictEqual(h.audit.closes, 1);
});

// ===========================================================================
// AC7 — Tool registry behaviour (composition with Story 1.10 handlers)
// ===========================================================================

await test('registry: tools registered with readOnlyHint=true and the documented descriptions', async () => {
  const h = buildHarness();
  await runServer(h.deps);

  const list = h.server.registeredTools.find((t) => t.name === 'list_pages');
  assert.ok(list);
  // annotations is unknown-typed; cast for assertion shape.
  const ann = list.config.annotations as { readOnlyHint?: boolean; openWorldHint?: boolean };
  assert.strictEqual(ann.readOnlyHint, true);
  assert.strictEqual(ann.openWorldHint, false);
  assert.match(list.config.description ?? '', /none-mode/);
});

// ===========================================================================
// Final sanity: no unexpected unhandled rejections leaked from any test.
// ===========================================================================

await test('no unexpected unhandled rejections leaked from prior tests', () => {
  // Allow a microtask drain so any pending IIFE rejections settle.
  // (The tests above already drained, but a final pass costs nothing.)
  assert.deepStrictEqual(
    unexpectedRejections,
    [],
    `unexpected rejections: ${unexpectedRejections.map(String).join(', ')}`,
  );
});
