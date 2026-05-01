/* eslint-disable @typescript-eslint/only-throw-error --
 * Tests deliberately throw `DomainError` values (NOT Error subclasses) to
 * mirror the runtime client's contract from `src/silverbullet/client.ts:1-11`.
 * The handler boundary detects DomainErrors via `isDomainError`'s structural
 * test, NOT `instanceof`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRef } from '../domain/ref.ts';
import { resolveAccess } from '../permissions/engine.ts';
import type { ConfigBlock } from '../permissions/config-block-parser.ts';
import { notFoundError, validationError, infrastructureError } from '../domain/error.ts';
import type { RuntimeClient } from '../silverbullet/client.ts';
import { queryConfigBlocksScript } from '../silverbullet/scripts/query-config-blocks.lua.ts';

import {
  defaultPermissionEngine,
  fetchConfigBlocks,
  formatToolError,
  formatToolSuccess,
  isDomainError,
  projectOutcome,
  summarizeParseErrors,
} from './handler-template.ts';

const ref = (n: string) => makeRef(n);

function makeMockClient(
  execImpl: <T>(script: string, params?: Readonly<Record<string, unknown>>) => Promise<T>,
): RuntimeClient {
  return {
    exec: execImpl,
    ping: async () => {},
    probe: async () => {},
  };
}

// ---------------------------------------------------------------------------
// defaultPermissionEngine — parity with resolveAccess
// ---------------------------------------------------------------------------

await test('defaultPermissionEngine.resolve matches resolveAccess on a representative fixture', () => {
  const blocks: ConfigBlock[] = [
    { page: ref('CONFIG'), access: 'read', exact: false },
    { page: ref('Personal'), access: 'none', exact: false },
    { page: ref('Personal/Public'), access: 'write', exact: false },
  ];
  const refs = ['Foo', 'Personal', 'Personal/Journal', 'Personal/Public', 'Personal/Public/Notes'];
  for (const r of refs) {
    const branded = ref(r);
    assert.strictEqual(
      defaultPermissionEngine.resolve(branded, blocks),
      resolveAccess(branded, blocks),
      `parity failure for ${r}`,
    );
  }
});

await test('defaultPermissionEngine is frozen at runtime', () => {
  assert.strictEqual(Object.isFrozen(defaultPermissionEngine), true);
});

// ---------------------------------------------------------------------------
// formatToolSuccess
// ---------------------------------------------------------------------------

await test('formatToolSuccess returns { content: [{ type: "text", text }] } with no isError field', () => {
  const result = formatToolSuccess('hello');
  assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'hello' }] });
  assert.strictEqual('isError' in result, false);
});

await test('formatToolSuccess preserves multi-line text verbatim', () => {
  const text = 'line one\nline two\n';
  const result = formatToolSuccess(text);
  assert.deepStrictEqual(result, { content: [{ type: 'text', text }] });
});

// ---------------------------------------------------------------------------
// formatToolError — re-export delegates to domain/error renderer
// ---------------------------------------------------------------------------

await test('formatToolError(notFoundError) renders the not_found template', () => {
  const result = formatToolError(notFoundError(ref('Personal/Journal')));
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.content.length, 1);
  assert.strictEqual(result.content[0]?.type, 'text');
  assert.match(result.content[0]?.text ?? '', /not found/i);
  assert.match(result.content[0]?.text ?? '', /Personal\/Journal/);
});

await test('formatToolError(validationError) renders the validation template', () => {
  const result = formatToolError(validationError({ failure: 'q must be a non-empty string' }));
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /q must be a non-empty string/);
});

// ---------------------------------------------------------------------------
// projectOutcome — allowed / rejected projection
// ---------------------------------------------------------------------------

await test('projectOutcome on allowed sets response to responsePayload', () => {
  const projected = projectOutcome({
    decision: 'allowed',
    responsePayload: { pages: ['Foo', 'Bar'] },
  });
  assert.deepStrictEqual(projected, {
    decision: 'allowed',
    response: { pages: ['Foo', 'Bar'] },
  });
});

await test('projectOutcome on rejected sets response to undefined and spreads serializeForAudit', () => {
  const projected = projectOutcome({
    decision: 'rejected',
    error: notFoundError(ref('Personal/Journal')),
  });
  assert.strictEqual(projected.decision, 'rejected');
  assert.strictEqual(projected.response, undefined);
  assert.strictEqual(projected.reason, 'not_found');
  assert.deepStrictEqual(projected.details, {});
});

// ---------------------------------------------------------------------------
// isDomainError — structural shape guard
// ---------------------------------------------------------------------------

await test('isDomainError accepts a real DomainError', () => {
  assert.strictEqual(isDomainError(notFoundError(ref('Foo'))), true);
  assert.strictEqual(isDomainError(infrastructureError(new Error('boom'))), true);
});

await test('isDomainError rejects plain objects, primitives, null', () => {
  assert.strictEqual(isDomainError(null), false);
  assert.strictEqual(isDomainError(undefined), false);
  assert.strictEqual(isDomainError('error'), false);
  assert.strictEqual(isDomainError(42), false);
  assert.strictEqual(isDomainError({}), false);
  assert.strictEqual(isDomainError({ reason: 'x' }), false); // missing details
  assert.strictEqual(isDomainError({ details: {} }), false); // missing reason
  assert.strictEqual(isDomainError({ reason: 42, details: {} }), false); // wrong type
});

// ---------------------------------------------------------------------------
// fetchConfigBlocks — happy path + parseErrors + rejection propagation
// ---------------------------------------------------------------------------

await test('fetchConfigBlocks parses well-formed blocks into validated ConfigBlock[]', async () => {
  const client = makeMockClient((script) => {
    assert.strictEqual(script, queryConfigBlocksScript);
    return Promise.resolve({ blocks: [{ page: 'CONFIG', access: 'read' }] } as unknown as never);
  });
  const out = await fetchConfigBlocks(client);
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.blocks[0]?.page, 'CONFIG');
  assert.strictEqual(out.blocks[0]?.access, 'read');
  assert.strictEqual(out.blocks[0]?.exact, false);
  assert.strictEqual(out.parseErrors.length, 0);
});

await test('fetchConfigBlocks separates malformed rows into parseErrors', async () => {
  const client = makeMockClient(() =>
    Promise.resolve({
      blocks: [
        { page: 'CONFIG', access: 'read' },
        { page: 'Bad', access: 'WRITE' /* uppercase — invalid */ },
        { access: 'read' /* missing page */ },
      ],
    } as unknown as never),
  );
  const out = await fetchConfigBlocks(client);
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.parseErrors.length, 2);
  const reasons = out.parseErrors.map((e) => e.reason).sort();
  assert.deepStrictEqual(reasons, ['access_invalid', 'page_missing']);
});

await test('fetchConfigBlocks propagates client.exec rejection unchanged', async () => {
  const boom = infrastructureError(new Error('SB unreachable'));
  const client = makeMockClient(() => {
    throw boom;
  });
  await assert.rejects(
    () => fetchConfigBlocks(client),
    (err: unknown) => err === boom,
  );
});

// ---------------------------------------------------------------------------
// summarizeParseErrors
// ---------------------------------------------------------------------------

await test('summarizeParseErrors formats each error as "<reason> on <page>"', () => {
  const summary = summarizeParseErrors([
    { raw: { page: 'Foo', access: 'WRITE' }, reason: 'access_invalid', message: '' },
    { raw: { page: 'Bar' }, reason: 'access_missing', message: '' },
  ]);
  assert.strictEqual(summary, 'access_invalid on Foo; access_missing on Bar');
});

await test('summarizeParseErrors falls back to <unknown page> when raw.page missing', () => {
  const summary = summarizeParseErrors([
    { raw: { access: 'read' }, reason: 'page_missing', message: '' },
  ]);
  assert.strictEqual(summary, 'page_missing on <unknown page>');
});

await test('summarizeParseErrors returns empty string for an empty array', () => {
  assert.strictEqual(summarizeParseErrors([]), '');
});
