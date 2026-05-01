import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { AuditLogger } from '../../src/audit/audit-logger.ts';
import type { AuditEntryInput } from '../../src/audit/schema.ts';
import type { Logger } from '../../src/diagnostic/logger.ts';
import { makeRef, type Ref } from '../../src/domain/ref.ts';
import { createFreshnessState, type FreshnessState } from '../../src/freshness/state.ts';
import type { AccessMode } from '../../src/permissions/access-mode.ts';
import type { RuntimeClient } from '../../src/silverbullet/client.ts';
import {
  readPageScript,
  type ReadPageResult,
} from '../../src/silverbullet/scripts/read-page.lua.ts';
import { queryConfigBlocksScript } from '../../src/silverbullet/scripts/query-config-blocks.lua.ts';

import { type HandlerContext, type PermissionEngine } from '../../src/mcp/handler-template.ts';
import { handleReadPage } from '../../src/mcp/handlers/read-page.ts';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const ref = (n: string) => makeRef(n);

type ScriptHandler<T = unknown> = (params?: Readonly<Record<string, unknown>>) => Promise<T> | T;

function makeMockClient(
  handlers: Map<string, ScriptHandler>,
  callLog?: { calls: Array<{ script: string; params?: Readonly<Record<string, unknown>> }> },
): RuntimeClient {
  return {
    exec: async <T>(script: string, params?: Readonly<Record<string, unknown>>): Promise<T> => {
      callLog?.calls.push(params !== undefined ? { script, params } : { script });
      const handler = handlers.get(script);
      if (handler === undefined) throw new Error(`unexpected script: ${script.slice(0, 40)}...`);
      return (await handler(params)) as T;
    },
    ping: async () => {},
    probe: async () => {},
  };
}

type CapturedAudit = AuditEntryInput[];

function makeMockAudit(captured: CapturedAudit): AuditLogger {
  return {
    write(entry) {
      captured.push(entry);
    },
    close: async () => {},
  };
}

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

const FIXED_DATE = new Date('2026-05-01T12:00:00Z');

type ContextOverrides = {
  client?: RuntimeClient;
  permissionEngine?: PermissionEngine;
  audit?: AuditLogger;
  logger?: Logger;
  clock?: () => Date;
  freshness?: FreshnessState;
};

function buildContext(overrides: ContextOverrides = {}): {
  ctx: HandlerContext;
  audits: CapturedAudit;
  logs: CapturedLogger;
  callLog: { calls: Array<{ script: string; params?: Readonly<Record<string, unknown>> }> };
  freshness: FreshnessState;
} {
  const audits: CapturedAudit = [];
  const logs: CapturedLogger = { info: [], warn: [], error: [] };
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const freshness = overrides.freshness ?? createFreshnessState({ capacity: 16 });
  const ctx: HandlerContext = {
    client: overrides.client ?? makeMockClient(new Map(), callLog),
    permissionEngine: overrides.permissionEngine ?? { resolve: () => 'none' },
    freshness,
    audit: overrides.audit ?? makeMockAudit(audits),
    logger: overrides.logger ?? makeMockLogger(logs),
    clock: overrides.clock ?? (() => FIXED_DATE),
  };
  return { ctx, audits, logs, callLog, freshness };
}

function modeMapEngine(map: ReadonlyMap<Ref, AccessMode>): PermissionEngine {
  return { resolve: (r) => map.get(r) ?? 'none' };
}

function readResult(content: string, lastModified = '2026-04-30T00:00:00Z'): ReadPageResult {
  return { content, lastModified };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

await test('read_page: happy path with `read` access — returns body, touches freshness with handler clock', async () => {
  const target = ref('Projects/Foo');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [readPageScript, () => readResult('hello')],
  ]);
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
  });

  const result = await handleReadPage({ ref: 'Projects/Foo' }, ctx);

  assert.strictEqual('isError' in result, false);
  assert.deepStrictEqual(result.content, [{ type: 'text', text: 'hello' }]);
  assert.strictEqual(audits[0]?.decision, 'allowed');
  assert.deepStrictEqual(audits[0]?.response, {
    size: 5,
    sha256: createHash('sha256').update('hello', 'utf8').digest('hex'),
  });
  assert.strictEqual(freshness.get(target)?.toISOString(), FIXED_DATE.toISOString());
});

await test('read_page: happy path with `append` access — read still works', async () => {
  const target = ref('Daily/2026-05-01');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [readPageScript, () => readResult('append-only content')],
  ]);
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'append']])),
  });

  const result = await handleReadPage({ ref: 'Daily/2026-05-01' }, ctx);
  assert.strictEqual('isError' in result, false);
  assert.strictEqual(audits[0]?.decision, 'allowed');
  assert.strictEqual(freshness.get(target)?.toISOString(), FIXED_DATE.toISOString());
});

await test('read_page: happy path with `write` access — read still works', async () => {
  const target = ref('Projects/Active/Foo');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [readPageScript, () => readResult('writable content')],
  ]);
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'write']])),
  });

  const result = await handleReadPage({ ref: 'Projects/Active/Foo' }, ctx);
  assert.strictEqual('isError' in result, false);
  assert.strictEqual(audits[0]?.decision, 'allowed');
  assert.strictEqual(freshness.get(target)?.toISOString(), FIXED_DATE.toISOString());
});

await test('read_page: `none`-mode → not_found, NO SB read, NO freshness touch', async () => {
  const target = ref('Personal/Journal/2026-04-21');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      readPageScript,
      () => {
        throw new Error('readPageScript should not be called for none-mode');
      },
    ],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers, callLog),
    permissionEngine: modeMapEngine(new Map([[target, 'none']])),
  });

  const result = await handleReadPage({ ref: 'Personal/Journal/2026-04-21' }, ctx);

  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.match(result.content[0]?.text ?? '', /not found/i);
  assert.strictEqual(audits[0]?.decision, 'rejected');
  assert.strictEqual(audits[0]?.reason, 'not_found');
  assert.deepStrictEqual(audits[0]?.args, { ref: 'Personal/Journal/2026-04-21' });
  assert.strictEqual(
    callLog.calls.some((c) => c.script === readPageScript),
    false,
  );
  assert.strictEqual(freshness.get(target), undefined);
});

await test('read_page: default-deny (no matching block) → not_found', async () => {
  const target = ref('Unknown/Page');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers, callLog),
    permissionEngine: { resolve: () => 'none' },
  });

  const result = await handleReadPage({ ref: 'Unknown/Page' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'not_found');
  assert.strictEqual(freshness.get(target), undefined);
});

await test('read_page: validation error on missing `ref` — no SB call', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleReadPage({}, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.strictEqual(callLog.calls.length, 0);
});

await test('read_page: validation error on extraneous fields', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleReadPage({ ref: 'Foo', extra: 1 }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.match(audits[0]?.details?.failure as string, /unexpected fields/);
  assert.strictEqual(callLog.calls.length, 0);
});

await test('read_page: validation error on empty ref', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleReadPage({ ref: '' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.strictEqual(callLog.calls.length, 0);
});

await test('read_page: RefValidationError on path-traversal — validation_error, no SB call, no freshness touch', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits, freshness } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleReadPage({ ref: '..' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.match(audits[0]?.details?.failure as string, /not a valid SilverBullet page name/);
  assert.strictEqual(callLog.calls.length, 0);
  // No Ref ever existed; nothing could be touched.
  assert.strictEqual(freshness.get(makeRef('Foo')), undefined);
});

await test('read_page: queryConfigBlocks failure → infrastructure_error, no read, no freshness touch', async () => {
  const target = ref('Projects/Foo');
  const handlers = new Map<string, ScriptHandler>([
    [
      queryConfigBlocksScript,
      () => {
        throw new Error('SB index unreachable');
      },
    ],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers, callLog),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
  });

  const result = await handleReadPage({ ref: 'Projects/Foo' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
  assert.strictEqual(
    callLog.calls.some((c) => c.script === readPageScript),
    false,
  );
  assert.strictEqual(freshness.get(target), undefined);
});

await test('read_page: readPageScript failure → infrastructure_error, NO freshness touch', async () => {
  const target = ref('Projects/Foo');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      readPageScript,
      () => {
        throw new Error('page read failed');
      },
    ],
  ]);
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
  });

  const result = await handleReadPage({ ref: 'Projects/Foo' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
  assert.strictEqual(freshness.get(target), undefined);
});

await test('read_page: audit response is digest{size,sha256} for content with multi-byte UTF-8', async () => {
  const target = ref('Café');
  const content = 'café';
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [readPageScript, () => readResult(content)],
  ]);
  const { ctx, audits } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
  });

  await handleReadPage({ ref: 'Café' }, ctx);
  const expectedSha = createHash('sha256').update(content, 'utf8').digest('hex');
  assert.deepStrictEqual(audits[0]?.response, { size: 5, sha256: expectedSha });
});

await test('read_page: freshness `at` is the handler clock, NOT the SB lastModified', async () => {
  const target = ref('Projects/Foo');
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [readPageScript, () => readResult('content', '2020-01-01T00:00:00Z')],
  ]);
  const handlerClockDate = new Date('2026-05-01T12:00:00Z');
  const { ctx, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
    clock: () => handlerClockDate,
  });

  await handleReadPage({ ref: 'Projects/Foo' }, ctx);
  assert.strictEqual(freshness.get(target)?.toISOString(), handlerClockDate.toISOString());
  // Sanity: NOT the SB-side lastModified.
  assert.notStrictEqual(freshness.get(target)?.toISOString(), '2020-01-01T00:00:00.000Z');
});

await test('read_page: NFR12 — context survives a thrown SB error and serves the next call', async () => {
  const target = ref('Projects/Foo');
  let firstCall = true;
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      readPageScript,
      () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('transient SB error');
        }
        return readResult('second-call body');
      },
    ],
  ]);
  const { ctx, audits, freshness } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(new Map([[target, 'read']])),
  });

  const first = await handleReadPage({ ref: 'Projects/Foo' }, ctx);
  assert.strictEqual('isError' in first && first.isError === true, true);
  assert.strictEqual(freshness.get(target), undefined);

  const second = await handleReadPage({ ref: 'Projects/Foo' }, ctx);
  assert.strictEqual('isError' in second, false);
  assert.strictEqual(freshness.get(target)?.toISOString(), FIXED_DATE.toISOString());

  assert.strictEqual(audits.length, 2);
  assert.strictEqual(audits[0]?.decision, 'rejected');
  assert.strictEqual(audits[1]?.decision, 'allowed');
});
