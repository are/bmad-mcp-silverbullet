import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRef } from './ref.ts';
import {
  REASON_CODES,
  configError,
  formatToolError,
  freshnessViolationError,
  infrastructureError,
  notFoundError,
  permissionDeniedError,
  scrubSecrets,
  serializeForAudit,
  validationError,
  type DomainError,
  type ReasonCode,
} from './error.ts';

const REF = makeRef('Projects/Active/Foo');
const PERSONAL_REF = makeRef('Personal/Journal/2026-04-21');

// ---------------------------------------------------------------------------
// REASON_CODES + ReasonCode exhaustiveness
// ---------------------------------------------------------------------------

await test('REASON_CODES locks the value set and order per D6', () => {
  assert.deepStrictEqual(REASON_CODES, [
    'permission_denied',
    'freshness_violation',
    'validation_error',
    'infrastructure_error',
    'config_error',
    'not_found',
  ]);
});

await test('ReasonCode is exhaustively switchable (compile-time check)', () => {
  // If a new ReasonCode value is added without updating this switch, TS
  // surfaces the missing case via the assertExhaustive(never) call. The
  // runtime branch is unreachable for the six known values.
  function describe(reason: ReasonCode): string {
    switch (reason) {
      case 'permission_denied':
      case 'freshness_violation':
      case 'validation_error':
      case 'infrastructure_error':
      case 'config_error':
      case 'not_found':
        return reason;
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }
  for (const code of REASON_CODES) {
    assert.strictEqual(describe(code), code);
  }
});

// ---------------------------------------------------------------------------
// Per-reason constructors
// ---------------------------------------------------------------------------

await test('permissionDeniedError populates required/granted in details', () => {
  const err = permissionDeniedError(REF, 'write', 'none');
  assert.deepStrictEqual(err, {
    reason: 'permission_denied',
    ref: REF,
    details: { required: 'write', granted: 'none' },
  });
  assert.strictEqual('failedOperation' in err, false);
});

await test('freshnessViolationError serializes Date inputs to ISO strings', () => {
  const lastModified = new Date('2026-04-30T14:20:01.000Z');
  const lastReadAt = new Date('2026-04-30T13:45:00.000Z');
  const err = freshnessViolationError(REF, lastModified, lastReadAt);
  assert.deepStrictEqual(err, {
    reason: 'freshness_violation',
    ref: REF,
    details: {
      lastModified: '2026-04-30T14:20:01.000Z',
      lastReadAt: '2026-04-30T13:45:00.000Z',
    },
  });
});

await test('freshnessViolationError coerces undefined lastReadAt to null', () => {
  const lastModified = new Date('2026-04-30T14:20:01.000Z');
  const err = freshnessViolationError(REF, lastModified, undefined);
  assert.deepStrictEqual(err.details, {
    lastModified: '2026-04-30T14:20:01.000Z',
    lastReadAt: null,
  });
});

await test('validationError (non-batch) populates details.failure only', () => {
  const err = validationError({ ref: REF, failure: 'page name empty' });
  assert.deepStrictEqual(err, {
    reason: 'validation_error',
    ref: REF,
    details: { failure: 'page name empty' },
  });
  assert.strictEqual('failedOperation' in err, false);
});

await test('validationError (batch) populates failedOperation and totalEdits', () => {
  const err = validationError({
    ref: REF,
    failure: 'search not found',
    failedOperation: {
      index: 1,
      operation: { type: 'search_and_replace', search: 'TODO' },
      total: 3,
    },
  });
  assert.deepStrictEqual(err, {
    reason: 'validation_error',
    ref: REF,
    details: { failure: 'search not found', totalEdits: 3 },
    failedOperation: { index: 1, operation: { type: 'search_and_replace', search: 'TODO' } },
  });
});

await test('validationError without total does not stamp totalEdits', () => {
  const err = validationError({
    failure: 'invalid edit',
    failedOperation: { index: 0, operation: { type: 'replace_all', content: 'X' } },
  });
  assert.strictEqual('totalEdits' in err.details, false);
  assert.strictEqual('ref' in err, false);
});

await test('infrastructureError extracts Error message and omits stack', () => {
  const err = infrastructureError(new Error('ECONNREFUSED 127.0.0.1:3000'));
  assert.strictEqual(err.reason, 'infrastructure_error');
  assert.strictEqual(err.details.underlying, 'ECONNREFUSED 127.0.0.1:3000');
  assert.strictEqual('ref' in err, false);
});

await test('infrastructureError promotes NodeJS errno code to details.code', () => {
  const cause = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const err = infrastructureError(cause, REF);
  assert.strictEqual(err.reason, 'infrastructure_error');
  assert.strictEqual(err.ref, REF);
  assert.strictEqual(err.details.underlying, 'connection refused');
  assert.strictEqual(err.details.code, 'ECONNREFUSED');
});

await test('configError populates variable/rule/message in details', () => {
  const err = configError({
    variable: 'SILVERBULLET_URL',
    rule: 'must_use_https',
    message: 'SILVERBULLET_URL must use https://',
  });
  assert.deepStrictEqual(err, {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_URL',
      rule: 'must_use_https',
      message: 'SILVERBULLET_URL must use https://',
    },
  });
  assert.strictEqual('ref' in err, false);
});

await test('notFoundError carries empty details (AR45 #2 — no body to leak)', () => {
  const err = notFoundError(PERSONAL_REF);
  assert.deepStrictEqual(err, {
    reason: 'not_found',
    ref: PERSONAL_REF,
    details: {},
  });
});

// ---------------------------------------------------------------------------
// scrubSecrets — structural redaction
// ---------------------------------------------------------------------------

await test('scrubSecrets redacts the lowercase token key', () => {
  assert.deepStrictEqual(scrubSecrets({ token: 'X' }), { token: '***redacted***' });
});

await test('scrubSecrets redacts case-insensitive variants', () => {
  assert.deepStrictEqual(scrubSecrets({ Token: 'X' }), { Token: '***redacted***' });
  assert.deepStrictEqual(scrubSecrets({ TOKEN: 'X' }), { TOKEN: '***redacted***' });
  assert.deepStrictEqual(scrubSecrets({ Authorization: 'Bearer X' }), {
    Authorization: '***redacted***',
  });
});

await test('scrubSecrets redacts every key in the closed set', () => {
  const out = scrubSecrets({
    authorization: 'A',
    token: 'B',
    apiKey: 'C',
    secret: 'D',
    password: 'E',
  });
  assert.deepStrictEqual(out, {
    authorization: '***redacted***',
    token: '***redacted***',
    apiKey: '***redacted***',
    secret: '***redacted***',
    password: '***redacted***',
  });
});

await test('scrubSecrets does not redact non-listed keys (whole-key match)', () => {
  assert.deepStrictEqual(scrubSecrets({ mytoken: 'X', oktokenfine: 'Y' }), {
    mytoken: 'X',
    oktokenfine: 'Y',
  });
});

await test('scrubSecrets recurses into nested plain objects', () => {
  assert.deepStrictEqual(scrubSecrets({ headers: { Authorization: 'Bearer X' } }), {
    headers: { Authorization: '***redacted***' },
  });
});

await test('scrubSecrets recurses into arrays', () => {
  assert.deepStrictEqual(scrubSecrets([{ token: 'X' }, { y: 1 }]), [
    { token: '***redacted***' },
    { y: 1 },
  ]);
});

await test('scrubSecrets renders Date instances as ISO strings', () => {
  const d = new Date('2026-04-30T00:00:00.000Z');
  assert.deepStrictEqual(scrubSecrets({ when: d }), { when: '2026-04-30T00:00:00.000Z' });
});

await test('scrubSecrets returns Error.message (no stack) when given an Error', () => {
  const e = new Error('boom');
  assert.strictEqual(scrubSecrets(e), 'boom');
});

await test('scrubSecrets handles cycles via <cycle> sentinel', () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  const out = scrubSecrets(a) as Record<string, unknown>;
  assert.strictEqual(out.self, '<cycle>');
});

await test('scrubSecrets passes null and undefined through', () => {
  assert.strictEqual(scrubSecrets(null), null);
  assert.strictEqual(scrubSecrets(undefined), undefined);
});

await test('scrubSecrets passes primitives through unchanged', () => {
  assert.strictEqual(scrubSecrets('hello'), 'hello');
  assert.strictEqual(scrubSecrets(42), 42);
  assert.strictEqual(scrubSecrets(true), true);
  assert.strictEqual(scrubSecrets(0n), 0n);
});

await test('scrubSecrets handles deeply nested mixed containers', () => {
  const out = scrubSecrets({
    outer: { authorization: 'A', payload: [{ password: 'P' }, { ok: 1 }] },
  });
  assert.deepStrictEqual(out, {
    outer: {
      authorization: '***redacted***',
      payload: [{ password: '***redacted***' }, { ok: 1 }],
    },
  });
});

await test('scrubSecrets does NOT inspect string values for embedded tokens (structural-only)', () => {
  const out = scrubSecrets({ message: 'auth failed: token=SECRET-VALUE' });
  // Documented limitation — content-scanning is deferred-work.
  assert.deepStrictEqual(out, { message: 'auth failed: token=SECRET-VALUE' });
});

await test('scrubSecrets collapses non-plain class instances to safe sentinel', () => {
  const m = new Map<string, string>([['authorization', 'X']]);
  const out = scrubSecrets({ headers: m });
  assert.deepStrictEqual(out, { headers: '[object Map]' });
});

await test('scrubSecrets does NOT scrub header-array structures (AC9 #12 limitation)', () => {
  // Documented limitation: the closed-list match is on field NAMES, not
  // field VALUES. A header expressed as `[{ name: 'authorization', value:
  // '...' }]` (the shape used by `undici` / `node-fetch`) is NOT scrubbed
  // because neither `name` nor `value` is in SCRUB_KEYS. Documented in
  // the scrubSecrets JSDoc and the deferred-work ledger.
  const input = { headers: [{ name: 'authorization', value: 'X' }] };
  assert.deepStrictEqual(scrubSecrets(input), input);
});

await test('scrubSecrets handles DAGs (same object referenced twice) without false cycle', () => {
  // Enter/exit semantics on the cycle-tracking WeakSet: a DAG (shared
  // sub-object reachable from two distinct keys) is NOT a cycle and must
  // scrub correctly both times. Without the `seen.delete` on the way out,
  // the second visit would collapse to '<cycle>' and silently drop audit
  // detail.
  const shared = { token: 'X' };
  const out = scrubSecrets({ a: shared, b: shared }) as Record<string, unknown>;
  assert.deepStrictEqual(out, {
    a: { token: '***redacted***' },
    b: { token: '***redacted***' },
  });
});

await test('scrubSecrets does not pollute output prototype via __proto__ own key', () => {
  // `JSON.parse('{"__proto__":{"polluted":true}}')` produces an object
  // whose `__proto__` is an OWN enumerable property. Without the
  // `Object.defineProperty` guard, `out['__proto__'] = ...` would invoke
  // the inherited setter and reassign the output's prototype. Verify the
  // output's prototype is untouched and the field is a normal own data
  // property.
  const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
  const out = scrubSecrets(hostile) as Record<string, unknown>;
  assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
  // `polluted` must NOT be reachable via prototype chain on the output.
  assert.strictEqual((out as { polluted?: unknown }).polluted, undefined);
});

await test('scrubSecrets renders Invalid Date as <invalid-date> sentinel (no RangeError)', () => {
  // `new Date('garbage').toISOString()` throws RangeError. Without the
  // guard, an Invalid Date inside a caught error would crash
  // `infrastructureError(err)` mid-construction. Substitute a sentinel.
  const invalid = new Date('garbage');
  assert.deepStrictEqual(scrubSecrets({ when: invalid }), { when: '<invalid-date>' });
});

// ---------------------------------------------------------------------------
// formatToolError — per-reason templates (verbatim)
// ---------------------------------------------------------------------------

const PERMISSION_DENIED_EXPECTED = [
  'Operation rejected — permission denied.',
  '',
  `Page: ${REF}`,
  'Required: write',
  'Granted: none',
  '',
  'To recover: this page is not accessible to you. Choose a different page or ask the user to update its access mode.',
].join('\n');

await test('formatToolError(permission_denied) renders the documented template verbatim', () => {
  const result = formatToolError(permissionDeniedError(REF, 'write', 'none'));
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.content.length, 1);
  assert.strictEqual(result.content[0]?.type, 'text');
  assert.strictEqual(result.content[0]?.text, PERMISSION_DENIED_EXPECTED);
});

await test('formatToolError(freshness_violation) contains verbatim recovery wording (AC2 of epic spec)', () => {
  const lastModified = new Date('2026-04-30T14:20:01.000Z');
  const lastReadAt = new Date('2026-04-30T13:45:00.000Z');
  const text = formatToolError(freshnessViolationError(REF, lastModified, lastReadAt)).content[0]
    ?.text;
  assert.ok(text !== undefined);
  assert.match(text, /call read_page\("[^"]+"\) to refresh, then retry/);
  assert.ok(text.includes(`call read_page("${REF}") to refresh, then retry`));
  assert.match(text, /Last modified: 2026-04-30T14:20:01.000Z/);
  assert.match(text, /Last read by you: 2026-04-30T13:45:00.000Z/);
});

await test('formatToolError(freshness_violation) prints "never" when lastReadAt is undefined', () => {
  const text = formatToolError(
    freshnessViolationError(REF, new Date('2026-04-30T14:20:01.000Z'), undefined),
  ).content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Last read by you: never/);
});

await test('formatToolError(validation_error, non-batch) omits the Failed operation line', () => {
  const text = formatToolError(validationError({ ref: REF, failure: 'page name empty' })).content[0]
    ?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Operation rejected — input validation failed\./);
  assert.match(text, /Failure: page name empty/);
  assert.ok(!text.includes('Failed operation:'));
});

await test('formatToolError(validation_error, batch with total) renders "operation N of M failed"', () => {
  const text = formatToolError(
    validationError({
      ref: REF,
      failure: 'search string "TODO" not found',
      failedOperation: {
        index: 1,
        operation: { type: 'search_and_replace', search: 'TODO', replace: 'DONE' },
        total: 3,
      },
    }),
  ).content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Edit batch rejected — operation 2 of 3 failed\./);
  assert.match(text, /Failed operation: search_and_replace \{ search: "TODO", replace: "DONE" \}/);
  assert.ok(text.includes(`call read_page("${REF}") to verify current content`));
  assert.match(text, /No partial changes were applied\./);
});

await test('formatToolError(validation_error, batch without total) renders "operation N failed" only', () => {
  const text = formatToolError(
    validationError({
      ref: REF,
      failure: 'overlap detected',
      failedOperation: { index: 0, operation: { type: 'replace_all', content: 'X' } },
    }),
  ).content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Edit batch rejected — operation 1 failed\./);
  assert.ok(!text.includes(' of '));
});

await test('formatToolError(infrastructure_error) renders underlying message + retry guidance', () => {
  const text = formatToolError(infrastructureError(new Error('ECONNREFUSED 127.0.0.1:3000')))
    .content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Operation could not be completed — SilverBullet unreachable\./);
  assert.match(text, /Underlying error: ECONNREFUSED 127.0.0.1:3000/);
  assert.match(text, /transient infrastructure issue\. Retry shortly\./);
});

await test('formatToolError(config_error) renders Variable/Rule/Detail lines', () => {
  const text = formatToolError(
    configError({
      variable: 'SILVERBULLET_URL',
      rule: 'must_use_https',
      message: 'SILVERBULLET_URL must use https://',
    }),
  ).content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Variable: SILVERBULLET_URL/);
  assert.match(text, /Rule: must_use_https/);
  assert.match(text, /Detail: SILVERBULLET_URL must use https:\/\//);
});

await test('formatToolError(not_found) keeps recovery deliberately ambiguous (FR13)', () => {
  const text = formatToolError(notFoundError(PERSONAL_REF)).content[0]?.text;
  assert.ok(text !== undefined);
  assert.match(text, /Operation rejected — page not found\./);
  assert.ok(text.includes('page does not exist (or is not accessible)'));
});

// ---------------------------------------------------------------------------
// AR45 information-leak rules — adversarial inputs
// ---------------------------------------------------------------------------

await test('AR45 #1: bearer token in Authorization header is never rendered', () => {
  const cause = { message: 'fetch failed', headers: { Authorization: 'Bearer SECRET-TOKEN' } };
  const text = formatToolError(infrastructureError(cause)).content[0]?.text;
  assert.ok(text !== undefined);
  assert.ok(!text.includes('SECRET-TOKEN'));
  assert.ok(!text.includes('Bearer'));
  assert.match(text, /\*\*\*redacted\*\*\*/);
});

await test('AR45 #1: token / apiKey fields are scrubbed from infrastructure errors', () => {
  const cause = { message: 'auth failed', token: 'SECRET1', apiKey: 'SECRET2' };
  const text = formatToolError(infrastructureError(cause)).content[0]?.text;
  assert.ok(text !== undefined);
  assert.ok(!text.includes('SECRET1'));
  assert.ok(!text.includes('SECRET2'));
});

await test('AR45 #1: secret / password fields are scrubbed from infrastructure errors', () => {
  const cause = { message: 'oops', secret: 'SECRET3', password: 'SECRET4' };
  const text = formatToolError(infrastructureError(cause)).content[0]?.text;
  assert.ok(text !== undefined);
  assert.ok(!text.includes('SECRET3'));
  assert.ok(!text.includes('SECRET4'));
});

await test('AR45 #4: stack traces never appear in agent-facing text', () => {
  const e = new Error('boom');
  // Force a real stack trace to exist on the Error instance.
  assert.ok(typeof e.stack === 'string' && e.stack.length > 0);
  const text = formatToolError(infrastructureError(e)).content[0]?.text;
  assert.ok(text !== undefined);
  assert.ok(text.includes('boom'));
  assert.ok(!text.includes('at Object.<anonymous>'));
  assert.ok(!/^\s+at\s/m.test(text));
});

await test('AR45 #3: permission_denied exposes only required + granted, no internal state', () => {
  const text = formatToolError(permissionDeniedError(REF, 'write', 'none')).content[0]?.text;
  assert.ok(text !== undefined);
  // The rendered text must not contain debugging artefacts from the engine
  // (no block-list, no resolution trace, no cache identifiers).
  assert.ok(!/block/i.test(text));
  assert.ok(!/resolution/i.test(text));
  assert.ok(!/cache/i.test(text));
});

await test('AR45 #2: not_found carries no body — context block is the Page line only', () => {
  const text = formatToolError(notFoundError(PERSONAL_REF)).content[0]?.text;
  assert.ok(text !== undefined);
  // Count only the lines between the summary line and the recovery line.
  const lines = text.split('\n');
  const summaryIdx = lines.indexOf('Operation rejected — page not found.');
  const recoveryIdx = lines.findIndex((l) => l.startsWith('To recover:'));
  const contextLines = lines.slice(summaryIdx + 1, recoveryIdx).filter((l) => l.trim().length > 0);
  assert.deepStrictEqual(contextLines, [`Page: ${PERSONAL_REF}`]);
});

// ---------------------------------------------------------------------------
// serializeForAudit — projection
// ---------------------------------------------------------------------------

await test('serializeForAudit(permission_denied) projects reason + details only (no ref)', () => {
  const projection = serializeForAudit(permissionDeniedError(REF, 'write', 'none'));
  assert.deepStrictEqual(projection, {
    reason: 'permission_denied',
    details: { required: 'write', granted: 'none' },
  });
  assert.strictEqual('ref' in projection, false);
  assert.strictEqual('failedOperation' in projection, false);
});

await test('serializeForAudit(freshness_violation) carries lastModified/lastReadAt', () => {
  const lastModified = new Date('2026-04-30T14:20:01.000Z');
  const lastReadAt = new Date('2026-04-30T13:45:00.000Z');
  const projection = serializeForAudit(freshnessViolationError(REF, lastModified, lastReadAt));
  assert.deepStrictEqual(projection, {
    reason: 'freshness_violation',
    details: {
      lastModified: '2026-04-30T14:20:01.000Z',
      lastReadAt: '2026-04-30T13:45:00.000Z',
    },
  });
});

await test('serializeForAudit(validation_error, batch) includes failedOperation', () => {
  const projection = serializeForAudit(
    validationError({
      ref: REF,
      failure: 'overlap',
      failedOperation: {
        index: 1,
        operation: { type: 'search_and_replace' },
        total: 3,
      },
    }),
  );
  assert.deepStrictEqual(projection, {
    reason: 'validation_error',
    details: { failure: 'overlap', totalEdits: 3 },
    failedOperation: { index: 1, operation: { type: 'search_and_replace' } },
  });
});

await test('serializeForAudit(validation_error, non-batch) omits failedOperation', () => {
  const projection = serializeForAudit(validationError({ failure: 'invalid' }));
  assert.strictEqual('failedOperation' in projection, false);
  assert.deepStrictEqual(projection, {
    reason: 'validation_error',
    details: { failure: 'invalid' },
  });
});

await test('serializeForAudit(infrastructure_error) carries scrubbed underlying', () => {
  const projection = serializeForAudit(
    infrastructureError({ message: 'fetch failed', token: 'SECRET' }),
  );
  assert.strictEqual(projection.reason, 'infrastructure_error');
  const underlying = (projection.details as { underlying: Record<string, unknown> }).underlying;
  assert.deepStrictEqual(underlying, { message: 'fetch failed', token: '***redacted***' });
});

await test('serializeForAudit(config_error) projects details verbatim', () => {
  const projection = serializeForAudit(
    configError({ variable: 'SILVERBULLET_URL', rule: 'invalid_url', message: 'bad url' }),
  );
  assert.deepStrictEqual(projection, {
    reason: 'config_error',
    details: { variable: 'SILVERBULLET_URL', rule: 'invalid_url', message: 'bad url' },
  });
});

await test('serializeForAudit(not_found) projects empty details, no failedOperation', () => {
  const projection = serializeForAudit(notFoundError(PERSONAL_REF));
  assert.deepStrictEqual(projection, {
    reason: 'not_found',
    details: {},
  });
  assert.strictEqual('failedOperation' in projection, false);
});

await test('serializeForAudit projections round-trip through JSON for every reason', () => {
  const fixtures: DomainError[] = [
    permissionDeniedError(REF, 'write', 'none'),
    freshnessViolationError(REF, new Date('2026-04-30T14:20:01Z'), undefined),
    validationError({ ref: REF, failure: 'invalid input' }),
    infrastructureError(new Error('boom')),
    configError({ variable: 'SILVERBULLET_URL', rule: 'missing', message: 'required' }),
    notFoundError(PERSONAL_REF),
  ];
  for (const fixture of fixtures) {
    const projection = serializeForAudit(fixture);
    const round: unknown = JSON.parse(JSON.stringify(projection));
    assert.deepStrictEqual(round, projection);
  }
});

// ---------------------------------------------------------------------------
// MCPToolResult shape invariants
// ---------------------------------------------------------------------------

await test('formatToolError always returns isError:true with one text content block', () => {
  for (const fixture of [
    permissionDeniedError(REF, 'write', 'none'),
    freshnessViolationError(REF, new Date('2026-04-30T14:20:01Z'), undefined),
    validationError({ ref: REF, failure: 'x' }),
    infrastructureError(new Error('y')),
    configError({ variable: 'SILVERBULLET_URL', rule: 'missing', message: 'z' }),
    notFoundError(PERSONAL_REF),
  ]) {
    const result = formatToolError(fixture);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0]?.type, 'text');
    assert.ok(typeof result.content[0]?.text === 'string');
    assert.ok((result.content[0]?.text ?? '').length > 0);
  }
});
