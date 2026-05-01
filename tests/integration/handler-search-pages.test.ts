import test from 'node:test';
import assert from 'node:assert/strict';

import type { AuditLogger } from '../../src/audit/audit-logger.ts';
import type { AuditEntryInput } from '../../src/audit/schema.ts';
import type { Logger } from '../../src/diagnostic/logger.ts';
import { makeRef, type Ref } from '../../src/domain/ref.ts';
import { createFreshnessState } from '../../src/freshness/state.ts';
import type { AccessMode } from '../../src/permissions/access-mode.ts';
import type { RuntimeClient } from '../../src/silverbullet/client.ts';
import { searchPagesScript } from '../../src/silverbullet/scripts/search-pages.lua.ts';
import { queryConfigBlocksScript } from '../../src/silverbullet/scripts/query-config-blocks.lua.ts';

import {
  defaultPermissionEngine,
  type HandlerContext,
  type PermissionEngine,
} from '../../src/mcp/handler-template.ts';
import { handleSearchPages } from '../../src/mcp/handlers/search-pages.ts';

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
    freshness: createFreshnessState({ capacity: 16 }),
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

await test('search_pages: happy path returns refs + scores filtered by access', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      searchPagesScript,
      () => ({
        hits: [
          { ref: 'A', score: 0.9 },
          { ref: 'B', score: 0.8 },
          { ref: 'C', score: 0.7 },
        ],
      }),
    ],
  ]);
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers, callLog) });

  const result = await handleSearchPages({ q: 'kanban' }, ctx);

  assert.strictEqual('isError' in result, false);
  assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), {
    hits: [
      { ref: 'A', score: 0.9 },
      { ref: 'B', score: 0.8 },
      { ref: 'C', score: 0.7 },
    ],
  });
  assert.strictEqual(audits[0]?.decision, 'allowed');
  assert.deepStrictEqual(audits[0]?.args, { q: 'kanban' });
  // Verify the script param key is `q` (not `query`).
  const searchCall = callLog.calls.find((c) => c.script === searchPagesScript);
  assert.deepStrictEqual(searchCall?.params, { q: 'kanban' });
});

await test('search_pages: filters out `none`-mode hits', async () => {
  const modes = new Map<Ref, AccessMode>([
    [ref('A'), 'read'],
    [ref('B'), 'none'],
    [ref('C'), 'append'],
  ]);
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [] })],
    [
      searchPagesScript,
      () => ({
        hits: [
          { ref: 'A', score: 0.9 },
          { ref: 'B', score: 0.8 },
          { ref: 'C', score: 0.7 },
        ],
      }),
    ],
  ]);
  const { ctx, audits } = buildContext({
    client: makeMockClient(handlers),
    permissionEngine: modeMapEngine(modes),
  });

  const result = await handleSearchPages({ q: 'foo' }, ctx);
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as { hits: Array<{ ref: string }> };
  assert.deepStrictEqual(
    payload.hits.map((h) => h.ref),
    ['A', 'C'],
  );
  const auditHits =
    (audits[0]?.response as { hits?: Array<{ ref: string }> } | undefined)?.hits ?? [];
  assert.deepStrictEqual(
    auditHits.map((h) => h.ref),
    ['A', 'C'],
  );
});

await test('search_pages: rejects empty `q` with validation_error, no SB call', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleSearchPages({ q: '' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.match(audits[0]?.details?.failure as string, /non-empty/);
  assert.strictEqual(callLog.calls.length, 0);
});

await test('search_pages: rejects non-string `q` with validation_error', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleSearchPages({ q: 123 }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.strictEqual(callLog.calls.length, 0);
});

await test('search_pages: rejects extraneous fields with validation_error', async () => {
  const callLog = {
    calls: [] as Array<{ script: string; params?: Readonly<Record<string, unknown>> }>,
  };
  const { ctx, audits } = buildContext({ client: makeMockClient(new Map(), callLog) });

  const result = await handleSearchPages({ q: 'foo', filter: 'archived' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'validation_error');
  assert.match(audits[0]?.details?.failure as string, /unexpected fields/);
  assert.strictEqual(callLog.calls.length, 0);
});

await test('search_pages: silversearch failure → infrastructure_error', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      searchPagesScript,
      () => {
        throw new Error('silversearch plug missing');
      },
    ],
  ]);
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleSearchPages({ q: 'foo' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
});

await test('search_pages: queryConfigBlocks failure → infrastructure_error, search NEVER invoked', async () => {
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
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers, callLog) });

  const result = await handleSearchPages({ q: 'foo' }, ctx);
  assert.strictEqual('isError' in result && result.isError === true, true);
  assert.strictEqual(audits[0]?.reason, 'infrastructure_error');
  assert.strictEqual(
    callLog.calls.some((c) => c.script === searchPagesScript),
    false,
  );
});

await test('search_pages: snippet hygiene — extra silversearch fields NEVER reach response or audit', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      searchPagesScript,
      () => ({
        hits: [{ ref: 'A', score: 0.9, content: 'LEAK', excerpts: ['LEAK'], matches: ['LEAK'] }],
      }),
    ],
  ]);
  const { ctx, audits } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleSearchPages({ q: 'foo' }, ctx);
  const responsePayload = JSON.parse(result.content[0]?.text ?? '{}') as { hits: unknown[] };
  assert.deepStrictEqual(responsePayload, { hits: [{ ref: 'A', score: 0.9 }] });
  assert.match(JSON.stringify(audits[0]?.response), /^[^L]*$/); // no 'LEAK' anywhere
  assert.deepStrictEqual(audits[0]?.response, { hits: [{ ref: 'A', score: 0.9 }] });
});

await test('search_pages: defensively drops malformed hit refs and warns', async () => {
  const handlers = new Map<string, ScriptHandler>([
    [queryConfigBlocksScript, () => ({ blocks: [{ page: 'CONFIG', access: 'read' }] })],
    [
      searchPagesScript,
      () => ({
        hits: [
          { ref: '../etc/passwd', score: 0.99 },
          { ref: 'Foo', score: 0.5 },
        ],
      }),
    ],
  ]);
  const { ctx, audits, logs } = buildContext({ client: makeMockClient(handlers) });

  const result = await handleSearchPages({ q: 'foo' }, ctx);
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as { hits: Array<{ ref: string }> };
  assert.deepStrictEqual(payload.hits, [{ ref: 'Foo', score: 0.5 }]);
  assert.deepStrictEqual(audits[0]?.response, { hits: [{ ref: 'Foo', score: 0.5 }] });
  assert.match(logs.warn[0] ?? '', /dropping malformed ref/);
});
