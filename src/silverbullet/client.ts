/* eslint-disable @typescript-eslint/only-throw-error --
 * The runtime client is the boundary module that translates SB / network
 * failures into `DomainError` values per AR11 (`epics.md:118`) — "throws
 * are reserved for invariant violations and infrastructure errors". The
 * `infrastructureError(err)` constructor produces a plain DomainError
 * object (not an Error subclass) by deliberate design (Story 1.6); the
 * tool-handler boundary in Story 1.10 detects it via the `reason` field
 * shape rather than `instanceof`. ESLint's `only-throw-error` would force
 * an Error subclass wrapper, breaking the structural-projection contract
 * shared with the audit serializer. Disabled here, justified per architecture.
 */
import { type Config } from '../config/config.ts';
import { type DomainError, infrastructureError } from '../domain/error.ts';

import { buildScript } from './envelope.ts';

/**
 * Closed mini-vocabulary for the `code` field of `infrastructure_error`s
 * raised by the runtime client. Story 1.11's startup ladder switches on
 * these constants to render AR39's distinct fatal messages
 * (`architecture.md:512-521`); downstream handlers (Story 1.10+) may also
 * inspect them to differentiate retry strategies.
 *
 * Native Node networking errors (e.g. `'ECONNREFUSED'`, `'ENOTFOUND'`)
 * pass through unchanged via `infrastructureError(err)`'s code-promotion
 * path (`src/domain/error.ts:299-304`); the table below is restricted to
 * codes the runtime client itself fabricates.
 */
export const RUNTIME_ERROR_CODE = {
  /** SilverBullet returned `503` — Runtime API not enabled (Chrome / `-runtime-api` Docker variant). */
  ESBRUNTIME: 'ESBRUNTIME',
  /** SilverBullet returned `401` / `403` — bearer token rejected. */
  EUNAUTHORIZED: 'EUNAUTHORIZED',
  /** SilverBullet returned a non-2xx status not covered by the codes above. */
  EBADSTATUS: 'EBADSTATUS',
  /** SilverBullet returned a `200` whose body did not parse as JSON or lacked a `result` key. */
  EBADRESPONSE: 'EBADRESPONSE',
} as const satisfies Record<string, string>;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODE)[keyof typeof RUNTIME_ERROR_CODE];

/**
 * Minimal SilverBullet runtime-API client. The **only** module in the
 * project that performs network I/O (AR21 / AR58, `epics.md:134,183`).
 *
 * - {@link RuntimeClient.exec} — `POST /.runtime/lua` with a base64+JSON
 *   parameter envelope (`./envelope.ts`); the response's `result` field is
 *   parsed and returned as the caller-supplied `T`. Higher-level operations
 *   (read-page, list-pages, etc.) are not methods on this interface — they
 *   are tool-handler concerns (Story 1.10+) that pass the appropriate Lua
 *   template + params to `exec`.
 * - {@link RuntimeClient.ping} — `GET /.ping` for liveness; **carries the
 *   bearer token in `Authorization`** because this SB version serves
 *   `/.ping` only to authenticated clients (verified at story-1.7
 *   implementation time per Critical guardrail #15). Resolves on `200`,
 *   rejects with `infrastructure_error` otherwise.
 * - {@link RuntimeClient.probe} — `POST /.runtime/lua` with body `1` to
 *   verify both the Runtime API surface and the bearer token in a single
 *   round-trip; resolves only when the response is `{"result":1}`.
 *
 * The `Content-Type: text/x-lua` MIME on `POST /.runtime/lua` was verified
 * against SB's runtime API source at story-1.7 implementation time (per
 * Critical guardrail #16). SB accepts the body as raw Lua source — NOT
 * JSON-wrapped — per D3 (`architecture.md:295`).
 *
 * @see D3 (`architecture.md:290-377`) — integration strategy.
 * @see AR25 (`epics.md:138`) — same `SILVERBULLET_TOKEN` bearer on every
 *   `/.runtime/*` request.
 */
export type RuntimeClient = {
  exec<T>(script: string, params?: Readonly<Record<string, unknown>>): Promise<T>;
  ping(): Promise<void>;
  probe(): Promise<void>;
};

/**
 * Inputs for {@link createRuntimeClient}. `config` is `Pick<Config, ...>`
 * so tests can pass a plain object without invoking `wrapConfig`; production
 * passes the wrapped instance from Story 1.11's startup ladder. `fetch` is
 * injected for tests so the runtime client never touches `globalThis.fetch`
 * mutably — defaults to the native Node ≥ 24 `globalThis.fetch`.
 */
export type CreateRuntimeClientOptions = {
  readonly config: Pick<Config, 'silverbulletUrl' | 'silverbulletToken'>;
  readonly fetch?: typeof globalThis.fetch;
};

/**
 * Maximum number of UTF-16 code units of a non-2xx response body to retain
 * in the `details.body` / `details.underlying` projection. Capped to defend
 * the audit log (and agent-facing error text) against multi-MB SB error
 * pages. Picked to match a typical SB error response while staying well
 * below the audit log's per-line tolerance.
 *
 * Note: this is a character cap, not a byte cap — `String.prototype.slice`
 * operates on UTF-16 code units, so a body containing multi-byte UTF-8
 * sequences may occupy up to 4× this size on the wire. The intent is to
 * bound the in-memory string the audit logger renders, which is a
 * char-budget concern, not a byte-budget one.
 */
const MAX_ERROR_BODY_CHARS = 2048;

function authHeader(token: string): string {
  return `Bearer ${token}`;
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}

function classifyStatus(status: number): RuntimeErrorCode {
  if (status === 503) return RUNTIME_ERROR_CODE.ESBRUNTIME;
  if (status === 401 || status === 403) return RUNTIME_ERROR_CODE.EUNAUTHORIZED;
  return RUNTIME_ERROR_CODE.EBADSTATUS;
}

/**
 * Best-effort JSON parse of a response body. Returns `undefined` (signalling
 * "drop the body") when the truncated text fails to parse — preserving the
 * `scrubSecrets` invariant in `infrastructureError`: the structural scrubber
 * only redacts known-secret keys inside parsed objects, NOT inside arbitrary
 * strings. A truncated body like `'{"token":"SECRET",...'` cut mid-token
 * would otherwise reach the agent unscrubbed; dropping it leaves the caller
 * with `code` + `status` (already informative) and zero secret-leak surface.
 */
function parseErrorBody(text: string): unknown {
  const truncated = text.length > MAX_ERROR_BODY_CHARS ? text.slice(0, MAX_ERROR_BODY_CHARS) : text;
  try {
    return JSON.parse(truncated) as unknown;
  } catch {
    return undefined;
  }
}

type FetchLike = typeof globalThis.fetch;

/**
 * Construct a {@link RuntimeClient} bound to a config + fetch
 * implementation. Pure factory (no I/O) — the network only happens when
 * the returned methods are awaited. Production wires `globalThis.fetch`;
 * tests inject a hand-rolled double via `opts.fetch`.
 */
export function createRuntimeClient(opts: CreateRuntimeClientOptions): RuntimeClient {
  const baseUrl = opts.config.silverbulletUrl;
  const token = opts.config.silverbulletToken;
  const fetchFn: FetchLike = opts.fetch ?? globalThis.fetch;

  async function postLua<T>(scriptSource: string): Promise<T> {
    const url = joinUrl(baseUrl, '/.runtime/lua');

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader(token),
          'Content-Type': 'text/x-lua',
        },
        body: scriptSource,
      });
    } catch (err) {
      // Native fetch / DNS / network failures bubble through the
      // domain-error constructor, which scrubs token-bearing fields and
      // promotes any errno (`ECONNREFUSED` etc.) into `details.code`.
      throw infrastructureError(err);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      const body = parseErrorBody(text);
      const code = classifyStatus(response.status);
      const wrapped: Record<string, unknown> = {
        message: `silverbullet runtime API returned ${String(response.status)}`,
        status: response.status,
        code,
      };
      if (body !== undefined && body !== '') wrapped.body = body;
      throw infrastructureError(wrapped);
    }

    const text = await safeReadText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw infrastructureError({
        message: 'invalid JSON in /.runtime/lua response',
        code: RUNTIME_ERROR_CODE.EBADRESPONSE,
      });
    }

    if (parsed === null || typeof parsed !== 'object' || !('result' in parsed)) {
      throw infrastructureError({
        message: '/.runtime/lua response missing `result` field',
        code: RUNTIME_ERROR_CODE.EBADRESPONSE,
      });
    }

    // Boundary cast (AR59 permitted): the parsed JSON is structurally
    // unknown until the call site supplies its `T` type. Analogous to a
    // zod-parsed boundary; the caller owns the type contract.
    return parsed.result as T;
  }

  return {
    async exec<T>(script: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
      let envelope: string;
      try {
        envelope = buildScript(script, params);
      } catch (err) {
        // `buildScript` calls `JSON.stringify(params)`, which throws on
        // BigInt / circular references / Symbol-typed values that slip
        // through the call-site type contract. Translate to the runtime
        // client's boundary contract (AR11) before the failure escapes as
        // a raw `TypeError`.
        throw infrastructureError(err);
      }
      return postLua<T>(envelope);
    },

    async ping(): Promise<void> {
      const url = joinUrl(baseUrl, '/.ping');
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'GET',
          headers: { Authorization: authHeader(token) },
        });
      } catch (err) {
        throw infrastructureError(err);
      }
      if (!response.ok) {
        const text = await safeReadText(response);
        const body = parseErrorBody(text);
        const code = classifyStatus(response.status);
        const wrapped: Record<string, unknown> = {
          message: `silverbullet /.ping returned ${String(response.status)}`,
          status: response.status,
          code,
        };
        if (body !== undefined && body !== '') wrapped.body = body;
        throw infrastructureError(wrapped);
      }
    },

    async probe(): Promise<void> {
      const result = await postLua<unknown>('1');
      if (result !== 1) {
        throw infrastructureError({
          message: `silverbullet runtime API probe expected result=1, got ${JSON.stringify(result)}`,
          code: RUNTIME_ERROR_CODE.ESBRUNTIME,
        });
      }
    },
  };
}

/**
 * Read a `Response` body as text. Catches a `text()` rejection (e.g. the
 * underlying stream errors mid-read) and returns `''` so a body-read
 * failure does not escape the runtime client's classification path. The
 * downstream caller treats `''` as "body absent" — consistent with
 * `parseErrorBody`'s `body !== ''` skip.
 */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// Re-exports for handlers that want to assert against the closed code set.
export type { DomainError };
