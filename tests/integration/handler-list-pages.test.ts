import test from 'node:test';
import assert from 'node:assert/strict';

import type { AuditLogger } from '../../src/audit/audit-logger.ts';
import type { AuditEntryInput } from '../../src/audit/schema.ts';
import type { Logger } from '../../src/diagnostic/logger.ts';
import { makeRef, type Ref } from '../../src/domain/ref.ts';
import { createFreshnessState } from '../../src/freshness/state.ts';
import type { AccessMode } from '../../src/permissions/access-mode.ts';
import type { ConfigBlock } from '../../src/permissions/config-block-parser.ts';
import type { RuntimeClient } from '../../src/silverbullet/client.ts';
import { listPagesScript } from '../../src/silverbullet/scripts/list-pages.lua.ts';
import { queryConfigBlocksScript } from '../../src/silverbullet/scripts/query-config-blocks.lua.ts';

import {
  defaultPermissionEngine,
  type HandlerContext,
  type PermissionEngine,
} from '../../src/mcp/handler-template.ts';
import { handleListPages } from '../../src/mcp/handlers/list-pages.ts';

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
const FIXED_DATE_LATER = new Date('2026-05-01T12:00:00.005Z');

type ContextOverrides = {
  client?: RuntimeClient;
  permissionEngine?: PermissionEngine;
  audit?: AuditLogger;
  logger?: Logger;
  clock?: () => Date;
  freshness?: HandlerContext['freshness'];
};

function buildContext(overrides: ContextOverrides = {}): {
  ctx: HandlerContext;
  audits: CapturedAudit;
  logs: CapturedLogger;
  callLog: { calls: Array<{ script: string; params?: Readonly<Record<string, unknown>> }> };
} {
  const audits: CapturedAudit = [];
  const logs: CapturedLogger = { info: [], warn: [], error: [] };
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  let clockCallCount = 0;
  const defaultClock = () => (clockCallCount++ === 0 ? FIXED_DATE : FIXED_DATE_LATER);

  const ctx: HandlerContext = {
    client: overrides.client ?? makeMockClient(new Map(), callLog),
    permissionEngine: overrides.permissionEngine ?? defaultPermissionEngine,
    freshness: overrides.freshness ?? createFreshnessState({ capacity: 16 }),
    audit: overrides.audit ?? makeMockAudit(audits),
    logger: overrides.logger ?? makeMockLogger(logs),
    clock: overrides.clock ?? defaultClock,
  };
  return { ctx, audits, logs, callLog };
}

function modeMapEngine(map: ReadonlyMap<Ref, AccessMode>): PermissionEngine {
  return { resolve: (r) => map.get(r) ?? 'none' };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

await test('list_pages: happy path with global CONFIG read access — all pages visible', async () => {
  const blocks: ConfigBlock[] = [{ page: ref('CONFIG'), access: 'read', exact: false }];
  const handlers = new Map<string, ScriptHandler>([
    [
      queryConfigBlocksScript,
      () => ({ blocks: blocks.map((b) => ({ page: b.page, access: b.access })) }),
    ],
    [
      listPagesScript,
      () => ({
        pages: [
          { ref: 'A', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'B', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'C', lastModified: '2026-05-01T00:00:00Z' },
        ],
      }),
    ],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers, callLog) });

  const result = await handleListPages({}, ctx);

  assert.strictEqual('isError' in result, false);
  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), { pages: ['A', 'B', 'C'] });
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0]?.tool, 'list_pages');
  assert.strictEqual(audits[0]?.decision, 'allowed');
  assert.deepStrictEqual(audits[0]?.response, { pages: ['A', 'B', 'C'] });
  assert.deepStrictEqual(audits[0]?.args, {});
});

await test('list_pages: filters out `none`-mode refs server-side', async () => {
  const modes = new Map<Ref, AccessMode>([
    [ref('A'), 'read'],
    [ref('B'), 'none'],
    [ref('C'), 'write'],
  ]);
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      listPagesScript,
      () => ({
        pages: [
          { ref: 'A', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'B', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'C', lastModified: '2026-05-01T00:00:00Z' },
        ],
      }),
    ],
  ]);
  const { ctx, audits } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(modes),
  });

  const result = await handleListPages({}, ctx);

  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), { pages: ['A', 'C'] });
  assert.deepStrictEqual(audits[0]?.response, { pages: ['A', 'C'] });
});

await test('list_pages: all-`none` space returns empty pages array (allowed)', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      listPagesScript,
      () => ({
        pages: [
          { ref: 'A', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'B', lastModified: '2026-05-01T00:00:00Z' },
        ],
      }),
    ],
  ]);
  // No CONFIG block → default-deny → all `none` → all filtered.
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleListPages({}, ctx);
  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), { pages: [] });
  assert.strictEqual(audits[0]?.decision, 'allowed');
});

await test('list_pages: empty SB result returns empty pages array', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [listPagesScript, () => ({ pages: [] })],
  ]);
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleListPages({}, ctx);
  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), { pages: [] });
  assert.strictEqual(audits[0]?.decision, 'allowed');
});

await test('list_pages: rejects extraneous fields with validation_error', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({
    client: makeMockClient(new Map(), callLog),
  });

  const result = await handleListPages({ extraneous: 1 }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.match(result.content[0]?.text ?? '', /validation/i);
  assert.match(result.content[0]?.text ?? '', /extraneous/);
  assert.strictEqual(audits[0]?.decision, 'rejected');
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.strictEqual(audits[0]?.response, undefined);
  assert.strictEqual(callLog.calls.length, 0);
});

await test('list_pages: queryConfigBlocks failure → infrastructure_error, listPages NEVER invoked', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [
      queryConfigBlocksScript,
      () => {
        throw new Error('SB unreachable');
      },
    ],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits, logs } = buildContext({ client: makeMockClient(handlers, callLog) });

  const result = await handleListPages({}, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.decision, 'rejected');
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
  assert.strictEqual(
    callLog.calls.some((c) => c.script === listPagesScript),
    false,
  );
  assert.strictEqual(logs.error.length, 1);
});

await test('list_pages: listPagesScript failure → infrastructure_error with scrubbed underlying', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      listPagesScript,
      () => {
        throw new Error('list-pages exploded');
      },
    ],
  ]);
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleListPages({}, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
  // `details.underlying` is the scrubbed string form (Error → message via scrubSecrets)
  const details = audits[0]?.details as { underlying?: unknown } | undefined;
  assert.strictEqual(typeof details?.underlying, 'string');
  assert.match(details?.underlying as string, /list-pages exploded/);
});

await test('list_pages: defensively drops malformed refs returned by SB and warns', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      listPagesScript,
      () => ({
        pages: [
          { ref: '..', lastModified: '2026-05-01T00:00:00Z' },
          { ref: 'Foo', lastModified: '2026-05-01T00:00:00Z' },
        ],
      }),
    ],
  ]);
  const { ctx, audits, logs } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleListPages({}, ctx);
  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), { pages: ['Foo'] });
  assert.deepStrictEqual(audits[0]?.response, { pages: ['Foo'] });
  assert.strictEqual(logs.warn.length, 1);
  assert.match(logs.warn[0] ?? '', /dropping malformed ref/);
});

await test('list_pages: audit shape has args, durationMs >= 0, and visible-ref response', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [listPagesScript, () => ({ pages: [{ ref: 'X', lastModified: '2026-05-01T00:00:00Z' }] })],
  ]);
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  await handleListPages({}, ctx);
  assert.deepStrictEqual(audits[0]?.args, {});
  assert.strictEqual(typeof audits[0]?.durationMs, 'number');
  assert.ok((audits[0]?.durationMs ?? -1) >= 0);
  assert.deepStrictEqual(audits[0]?.response, { pages: ['X'] });
});
