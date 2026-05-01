import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RUNTIME_ERROR_CODE, createRuntimeClient, type RuntimeClient } from './client.ts';

type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
};

type FetchResponseSpec = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
};

type FetchBehaviour =
  | { readonly kind: 'response'; readonly response: FetchResponseSpec }
  | { readonly kind: 'throw'; readonly error: unknown };

function makeFetch(behaviours: ReadonlyArray<FetchBehaviour>): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchFn: typeof globalThis.fetch = (input, init) => {
    const behaviour = behaviours[cursor] ?? behaviours[behaviours.length - 1];
    if (behaviour === undefined) {
      return Promise.reject(new Error('makeFetch: no behaviours configured'));
    }
    cursor += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? {});
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? rawBody : undefined;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    });
    if (behaviour.kind === 'throw') {
      // The runtime client treats any thrown value as an unknown failure to
      // wrap via `infrastructureError`; tests intentionally throw non-Error
      // values (e.g. plain objects with errno-like `code`) to exercise that
      // path. eslint's `prefer-promise-reject-errors` rule is overly strict
      // for this narrow boundary-test scenario.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional: exercises the runtime client's unknown-error path
      return Promise.reject(behaviour.error);
    }
    const spec = behaviour.response;
    const response = {
      ok: spec.ok,
      status: spec.status,
      statusText: '',
      headers: new Headers(),
      redirected: false,
      type: 'basic' as const,
      url,
      bodyUsed: false,
      body: null,
      text: () => Promise.resolve(spec.text),
      json: () => Promise.resolve(JSON.parse(spec.text) as unknown),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.reject(new Error('not implemented')),
      bytes: () => Promise.resolve(new Uint8Array()),
      formData: () => Promise.reject(new Error('not implemented')),
      clone(): Response {
        return this as unknown as Response;
      },
    } satisfies Partial<Response> & { ok: boolean; status: number };
    return Promise.resolve(response as unknown as Response);
  };
  return { fetch: fetchFn, calls };
}

const TEST_TOKEN = 'TEST-TOKEN-VALUE';
const TEST_URL = 'https://sb.example.com';

function makeClient(
  behaviours: ReadonlyArray<FetchBehaviour>,
  url: string = TEST_URL,
): { readonly client: RuntimeClient; readonly calls: FetchCall[] } {
  const { fetch, calls } = makeFetch(behaviours);
  const client = createRuntimeClient({
    config: { silverbulletUrl: url, silverbulletToken: TEST_TOKEN },
    fetch,
  });
  return { client, calls };
}

const PRELUDE_RE =
  /^\(function\(\)\nlocal _p = js\.tolua\(js\.window\.JSON\.parse\(encoding\.utf8Decode\(encoding\.base64Decode\("([A-Za-z0-9+/=]+)"\)\)\)\)\n/;

function decodePayload(scriptBody: string): unknown {
  const match = PRELUDE_RE.exec(scriptBody);
  if (match === null) throw new Error(`script did not match prelude: ${scriptBody.slice(0, 80)}`);
  const payload = match[1];
  if (payload === undefined) throw new Error('payload capture group missing');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

// ---------------------------------------------------------------------------
// Envelope construction (cross-checks with envelope.test.ts).
// ---------------------------------------------------------------------------

await test('exec: posts a base64+JSON envelope embedding the params', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":{"x":42}}' } },
  ]);
  const result = await client.exec<{ x: number }>('return { x = _p.n }', { n: 42 });
  assert.deepStrictEqual(result, { x: 42 });
  assert.strictEqual(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.ok(call.body !== undefined);
  assert.deepStrictEqual(decodePayload(call.body), { n: 42 });
  assert.ok(call.body.includes('\nreturn { x = _p.n }\nend)()'));
  assert.ok(call.body.endsWith('\nend)()'));
});

await test('exec: encodes {} when params are omitted', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
  ]);
  await client.exec<number>('return 1');
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.ok(call.body !== undefined);
  assert.deepStrictEqual(decodePayload(call.body), {});
});

// ---------------------------------------------------------------------------
// Success-path response parsing.
// ---------------------------------------------------------------------------

await test('exec: parses a JSON object result', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":{"x":42}}' } },
  ]);
  const result = await client.exec<{ x: number }>('return _p', {});
  assert.deepStrictEqual(result, { x: 42 });
});

await test('exec: returns null when result is null', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":null}' } },
  ]);
  const result = await client.exec<null>('return nil', {});
  assert.strictEqual(result, null);
});

await test('exec: returns a string when result is a string', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":"hello"}' } },
  ]);
  const result = await client.exec<string>('return "hello"', {});
  assert.strictEqual(result, 'hello');
});

// ---------------------------------------------------------------------------
// Error-path classification.
// ---------------------------------------------------------------------------

await test('exec: 503 → infrastructure_error code=ESBRUNTIME', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 503, text: '{}' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.ESBRUNTIME
      );
    },
  );
});

await test('exec: 401 → infrastructure_error code=EUNAUTHORIZED', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 401, text: 'unauthorised' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EUNAUTHORIZED
      );
    },
  );
});

await test('exec: 403 → infrastructure_error code=EUNAUTHORIZED', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 403, text: 'forbidden' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EUNAUTHORIZED
      );
    },
  );
});

await test('exec: 500 → infrastructure_error code=EBADSTATUS', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 500, text: 'oops' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EBADSTATUS
      );
    },
  );
});

await test('exec: 200 with non-JSON body → infrastructure_error code=EBADRESPONSE', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: 'NOT JSON' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EBADRESPONSE
      );
    },
  );
});

await test('exec: 200 with JSON missing `result` → infrastructure_error code=EBADRESPONSE', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"other":1}' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EBADRESPONSE
      );
    },
  );
});

await test('exec: fetch throwing an errno-bearing error promotes the code', async () => {
  const networkErr = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const { client } = makeClient([{ kind: 'throw', error: networkErr }]);
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return e.reason === 'infrastructure_error' && e.details?.code === 'ECONNREFUSED';
    },
  );
});

// ---------------------------------------------------------------------------
// Auth header / hygiene.
// ---------------------------------------------------------------------------

await test('exec: every successful POST carries the Bearer token', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
  ]);
  await client.exec<number>('return 1');
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.strictEqual(call.headers.get('Authorization'), `Bearer ${TEST_TOKEN}`);
  assert.strictEqual(call.headers.get('Content-Type'), 'text/x-lua');
});

await test('exec: token never leaks via a 503 body containing Authorization', async () => {
  const adversarialBody = JSON.stringify({
    error: 'denied',
    headers: { Authorization: 'Bearer SECRET-FROM-BODY' },
  });
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 503, text: adversarialBody } },
  ]);
  let captured: unknown;
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      captured = err;
      return true;
    },
  );
  const stringified = JSON.stringify(captured);
  assert.ok(!stringified.includes('SECRET-FROM-BODY'), `body secret leaked: ${stringified}`);
  assert.ok(!stringified.includes(TEST_TOKEN), `bearer token leaked: ${stringified}`);
});

await test('exec: token never leaks via a 401 body containing a token field', async () => {
  const adversarialBody = JSON.stringify({ error: 'auth failed', token: 'SECRET-FROM-BODY-2' });
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 401, text: adversarialBody } },
  ]);
  let captured: unknown;
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      captured = err;
      return true;
    },
  );
  const stringified = JSON.stringify(captured);
  assert.ok(!stringified.includes('SECRET-FROM-BODY-2'), `body secret leaked: ${stringified}`);
  assert.ok(!stringified.includes(TEST_TOKEN), `bearer token leaked: ${stringified}`);
});

// Truncated / unparseable bodies must NOT surface their content into
// `details.body` — `scrubSecrets` does not recurse into raw strings, so a
// body cut mid-token would otherwise reach the agent unscrubbed.
await test('exec: unparseable error body is dropped (not surfaced as a raw string)', async () => {
  const truncatedBody = '{"error":"x","token":"SECRET-IN-UNPARSEABLE-BODY",';
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 503, text: truncatedBody } },
  ]);
  let captured: unknown;
  await assert.rejects(
    () => client.exec<unknown>('return 1'),
    (err: unknown): boolean => {
      captured = err;
      return true;
    },
  );
  const stringified = JSON.stringify(captured);
  assert.ok(
    !stringified.includes('SECRET-IN-UNPARSEABLE-BODY'),
    `string body leaked unscrubbed: ${stringified}`,
  );
});

// ---------------------------------------------------------------------------
// ping().
// ---------------------------------------------------------------------------

await test('ping: GETs /.ping with the bearer header', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: 'OK' } },
  ]);
  await client.ping();
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.strictEqual(call.method, 'GET');
  assert.strictEqual(call.url, `${TEST_URL}/.ping`);
  assert.strictEqual(call.headers.get('Authorization'), `Bearer ${TEST_TOKEN}`);
});

await test('ping: non-200 rejects as infrastructure_error with classified code', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: false, status: 502, text: 'bad gateway' } },
  ]);
  await assert.rejects(
    () => client.ping(),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.EBADSTATUS
      );
    },
  );
});

// ---------------------------------------------------------------------------
// probe().
// ---------------------------------------------------------------------------

await test('probe: POSTs /.runtime/lua and resolves on result=1', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
  ]);
  await client.probe();
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.url, `${TEST_URL}/.runtime/lua`);
  assert.strictEqual(call.headers.get('Authorization'), `Bearer ${TEST_TOKEN}`);
  assert.strictEqual(call.body, '1');
});

await test('probe: result !== 1 rejects with code=ESBRUNTIME', async () => {
  const { client } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":0}' } },
  ]);
  await assert.rejects(
    () => client.probe(),
    (err: unknown): boolean => {
      const e = err as { reason?: string; details?: { code?: string } };
      return (
        e.reason === 'infrastructure_error' && e.details?.code === RUNTIME_ERROR_CODE.ESBRUNTIME
      );
    },
  );
});

// ---------------------------------------------------------------------------
// URL composition.
// ---------------------------------------------------------------------------

await test('createRuntimeClient: trailing-slash URL produces clean composed paths', async () => {
  const { client, calls } = makeClient(
    [
      { kind: 'response', response: { ok: true, status: 200, text: 'OK' } },
      { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
    ],
    'https://sb.example.com/',
  );
  await client.ping();
  await client.probe();
  const ping = calls[0];
  const probe = calls[1];
  assert.ok(ping !== undefined);
  assert.ok(probe !== undefined);
  assert.strictEqual(ping.url, 'https://sb.example.com/.ping');
  assert.strictEqual(probe.url, 'https://sb.example.com/.runtime/lua');
});

// ---------------------------------------------------------------------------
// Envelope-build failure boundary — non-JSON-serialisable params must
// translate to a `DomainError` instead of escaping as a raw `TypeError`.
// ---------------------------------------------------------------------------

await test('exec: BigInt in params translates to infrastructure_error (no raw TypeError)', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
  ]);
  await assert.rejects(
    () => client.exec<unknown>('return 1', { n: 1n }),
    (err: unknown): boolean => {
      const e = err as { reason?: string };
      return e.reason === 'infrastructure_error';
    },
  );
  // The fetch should never have been issued — the failure happens at the
  // envelope-build boundary before any network I/O.
  assert.strictEqual(calls.length, 0);
});

await test('exec: circular-reference params translate to infrastructure_error', async () => {
  const { client, calls } = makeClient([
    { kind: 'response', response: { ok: true, status: 200, text: '{"result":1}' } },
  ]);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    () => client.exec<unknown>('return 1', circular),
    (err: unknown): boolean => {
      const e = err as { reason?: string };
      return e.reason === 'infrastructure_error';
    },
  );
  assert.strictEqual(calls.length, 0);
});
