import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomFillSync } from 'node:crypto';

import { type Logger } from '../diagnostic/logger.ts';

import { AUDIT_SCHEMA_VERSION, type AuditEntryId, type AuditEntryInput } from './schema.ts';

// Public API ------------------------------------------------------------------

/**
 * Audit logger surface consumed by tool handlers. `write` is fire-and-forget
 * (returns `void`, NOT a `Promise`) — the tool-call response path never
 * awaits flush. AR32 (`epics.md:147`), AR61 (`epics.md:188` — audit-write
 * is the *only* sanctioned `void someAsync()` use-site).
 *
 * `close` drains the in-memory queue and ends the underlying stream within
 * NFR9's 1s shutdown budget (`epics.md:83`, `architecture.md:457`).
 */
export type AuditLogger = {
  write(entry: AuditEntryInput): void;
  close(): Promise<void>;
};

/**
 * Inputs for {@link resolveAuditLogPath}. All inputs are passed in (no
 * `process.*` / `os.*` reads) to keep the resolver pure (AR58
 * `epics.md:183`).
 */
export type ResolveAuditLogPathOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly localAppData?: string;
};

/**
 * Inputs for {@link createAuditLogger}. The stream / clock / randomBytes /
 * logger are all injected so tests can drive the factory without touching
 * the filesystem, real time, or real randomness.
 */
export type CreateAuditLoggerOptions = {
  readonly stream: NodeJS.WritableStream;
  readonly clock: () => Date;
  readonly randomBytes: (n: number) => Uint8Array;
  readonly logger: Logger;
  readonly filePath?: string;
};

/**
 * Inputs for the production composition {@link openAuditLogger}.
 */
export type OpenAuditLoggerOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly clock: () => Date;
  readonly logger: Logger;
};

// Path resolution -------------------------------------------------------------

const AUDIT_FILE_NAME = 'audit.jsonl';
const AUDIT_DIR_NAME = 'mcp-silverbullet';

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Resolve the audit log file path per D4 (`architecture.md:386-401`) and
 * AR27 (`epics.md:142`). Pure function: no `fs.*`, no `os.*`, no
 * `process.*`. Production wiring (Story 1.11) reads `process.env`,
 * `process.platform`, `os.homedir()`, and `process.env.LOCALAPPDATA` and
 * passes them in.
 *
 * Resolution order:
 *
 * 1. `env.MCP_SILVERBULLET_AUDIT_LOG_PATH` when set, non-empty, AND an
 *    absolute path. Story 1.4 already validated absoluteness at config-load
 *    time (`src/config/config.ts:64-66`); the resolver re-asserts via
 *    `path.isAbsolute` for defence-in-depth.
 * 2. Unix: `${env.XDG_STATE_HOME}/mcp-silverbullet/audit.jsonl` when
 *    `XDG_STATE_HOME` is non-empty and absolute, falling back to
 *    `${homeDir}/.local/state/mcp-silverbullet/audit.jsonl`.
 * 3. Windows: `${localAppData}\mcp-silverbullet\audit.jsonl` when
 *    `localAppData` is non-empty and absolute, falling back to
 *    `${homeDir}\AppData\Local\mcp-silverbullet\audit.jsonl`.
 *
 * Path joining uses `path.win32.join` / `path.posix.join` explicitly so
 * the function is deterministic on POSIX CI runners regardless of the
 * `platform` value.
 */
export function resolveAuditLogPath(opts: ResolveAuditLogPathOptions): string {
  const override = nonEmpty(opts.env.MCP_SILVERBULLET_AUDIT_LOG_PATH);
  const isAbs = (p: string): boolean =>
    opts.platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  if (override !== undefined && isAbs(override)) return override;

  if (opts.platform === 'win32') {
    const localAppData = nonEmpty(opts.localAppData);
    const base =
      localAppData !== undefined && path.win32.isAbsolute(localAppData)
        ? localAppData
        : path.win32.join(opts.homeDir, 'AppData', 'Local');
    return path.win32.join(base, AUDIT_DIR_NAME, AUDIT_FILE_NAME);
  }

  const xdgStateHome = nonEmpty(opts.env.XDG_STATE_HOME);
  const base =
    xdgStateHome !== undefined && path.posix.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.posix.join(opts.homeDir, '.local', 'state');
  return path.posix.join(base, AUDIT_DIR_NAME, AUDIT_FILE_NAME);
}

// Filesystem helpers ----------------------------------------------------------

/**
 * Recursively create the audit log's parent directory with mode `0o700`
 * (owner-only). Mode is applied to each created directory along the path.
 *
 * On Windows, `mode` is largely ignored — POSIX permissions don't apply;
 * isolation comes from the user's profile ACL. That is acceptable for MVP.
 *
 * Errors propagate to the caller (Story 1.11's startup ladder turns them
 * into the AR39 FATAL+hint exit-1 contract per `architecture.md:497-501`).
 */
export function ensureAuditDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/**
 * Open an append-only write stream for the audit log. `{ flags: 'a' }`
 * matches D4 (`architecture.md:448`) and AR32 (`epics.md:147`). The caller
 * (Story 1.11 in production; the test harness in tests) owns the stream's
 * lifecycle — `openAuditStream` does not auto-close.
 */
export function openAuditStream(filePath: string): NodeJS.WritableStream {
  return createWriteStream(filePath, { flags: 'a' });
}

// ULID generator --------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_BYTES = 10;
const RANDOM_LEN = 16;

/**
 * Encode a 48-bit unsigned integer as 10 Crockford-Base32 characters,
 * big-endian. Uses `BigInt` so the bit-packing stays precise above 2^32.
 */
function encodeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 0xffff_ffff_ffff) {
    throw new RangeError(`audit ULID timestamp out of range: ${String(ms)}`);
  }
  let value = BigInt(Math.trunc(ms));
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const idx = Number(value & 0x1fn);
    out[i] = CROCKFORD.charAt(idx);
    value >>= 5n;
  }
  return out.join('');
}

/**
 * Encode 10 random bytes (80 bits) as 16 Crockford-Base32 characters,
 * big-endian. Uses `BigInt` for the same precision reason as
 * {@link encodeTime}.
 */
function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new RangeError(`audit ULID random part must be ${RANDOM_BYTES} bytes`);
  }
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }
  const out = new Array<string>(RANDOM_LEN);
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const idx = Number(value & 0x1fn);
    out[i] = CROCKFORD.charAt(idx);
    value >>= 5n;
  }
  return out.join('');
}

/**
 * Increment a 10-byte big-endian unsigned integer by 1. Returns a NEW
 * `Uint8Array` (does not mutate the input). On overflow (input was
 * `0xFF…FF`) returns `null` so the caller can re-draw fresh randomness.
 */
function incrementRandomness(bytes: Uint8Array): Uint8Array | null {
  const next = new Uint8Array(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    const byte = next[i] ?? 0;
    if (byte < 0xff) {
      next[i] = byte + 1;
      return next;
    }
    next[i] = 0;
  }
  return null;
}

/**
 * Build a stateful ULID generator with monotonicity within a millisecond.
 *
 * - Different milliseconds → fresh randomness drawn via `randomBytes(10)`.
 * - Same millisecond → previous randomness incremented by 1 (preserves
 *   strict lexical monotonicity).
 * - Same millisecond AND randomness already at maximum (`0xFF…FF`) →
 *   re-draw fresh randomness (documented overflow behaviour; the
 *   probability is ~2⁻⁸⁰ per call).
 *
 * The brand cast `value as AuditEntryId` is the only sanctioned `as` site
 * in this module per AR59 (`architecture.md:1031`).
 */
export function makeUlidGenerator(deps: {
  clock: () => Date;
  randomBytes: (n: number) => Uint8Array;
}): () => AuditEntryId {
  let lastMs = -1;
  let lastRandomness: Uint8Array = new Uint8Array(RANDOM_BYTES);
  return () => {
    const ms = deps.clock().getTime();
    let randomness: Uint8Array;
    if (ms === lastMs) {
      const incremented = incrementRandomness(lastRandomness);
      randomness = incremented ?? deps.randomBytes(RANDOM_BYTES);
    } else {
      randomness = deps.randomBytes(RANDOM_BYTES);
      lastMs = ms;
    }
    lastRandomness = randomness;
    const ulid = encodeTime(ms) + encodeRandom(randomness);
    // AR59 brand-constructor exemption — the only sanctioned `as
    // AuditEntryId` site in the codebase, mirroring the `as Ref` pattern in
    // `src/domain/ref.ts:121`.
    return ulid as AuditEntryId;
  };
}

// Audit logger factory --------------------------------------------------------

const SERIALIZATION_FAILED_MARKER = '<serialization_failed>';

/**
 * Construct an {@link AuditEntry} object literal with the documented field
 * order (`v, t, id, tool, args, decision, response, durationMs, reason?,
 * details?, failedOperation?`). Optional fields are added via conditional
 * spread to honour `exactOptionalPropertyTypes: true` (`tsconfig.json:11`).
 */
function buildEntry(
  v: typeof AUDIT_SCHEMA_VERSION,
  t: string,
  id: AuditEntryId,
  input: AuditEntryInput,
): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    v,
    t,
    id,
    tool: input.tool,
    args: input.args,
    decision: input.decision,
    response: input.response,
    durationMs: input.durationMs,
  };
  if (input.reason !== undefined) base.reason = input.reason;
  if (input.details !== undefined) base.details = input.details;
  if (input.failedOperation !== undefined) base.failedOperation = input.failedOperation;
  return base;
}

/**
 * Construct an {@link AuditLogger} bound to an injected stream. Tests
 * provide a fake stream + fake clock + fake `randomBytes` + fake logger
 * for deterministic assertions; production wires `process.stderr`-backed
 * diagnostics, real-time clock, real randomness, and a real
 * `fs.createWriteStream` via {@link openAuditLogger}.
 *
 * Contract guarantees (per D4 / AR32–AR35 / NFR9 / NFR17):
 *
 * - `write(entry)` returns `void` — never a `Promise`. The handler's
 *   tool-call response path never awaits flush. AR61 sanctions audit-write
 *   as the *only* `void someAsync()` site.
 * - Backpressure: when the stream's `write` returns `false`, subsequent
 *   serialised lines are queued FIFO and flushed on `'drain'`.
 * - Stream `'error'` events are non-fatal: a single WARN to the diagnostic
 *   logger, queue dropped, subsequent `write` calls become no-ops. The
 *   tool-call path keeps serving (AR34, `architecture.md:455`).
 * - Synchronous failures inside `write()` or `flushQueue()` (clock
 *   invalid-Date, ULID `RangeError`, `stream.write` throw) are caught
 *   and treated like a stream `'error'`: single WARN, queue dropped,
 *   subsequent writes become no-ops. AR61 fire-and-forget cannot leak a
 *   throw to the handler.
 * - Serialisation fallback: if `JSON.stringify(entry)` throws (e.g.,
 *   circular reference in `args`), the placeholder entry replaces BOTH
 *   `args` AND `response` with `'<serialization_failed>'`. AC12 case
 *   13(a) (`epics.md:235`) describes the placeholder narrowly as
 *   replacing `args` only; the implementation broadens to both fields
 *   because `JSON.stringify(entry)` does not name the failing field, so
 *   wiping both is the conservative reading. If even the placeholder
 *   build fails, a second WARN is emitted and the entry is dropped
 *   (story 1.5 review patches P4 / P5).
 * - `close()` resolves once the queue is empty AND `stream.end()` has
 *   flushed. Idempotent. Designed for NFR9's 1s budget. A stream
 *   `'error'` while `close()` is awaiting drain settles the promise
 *   immediately so shutdown stays inside budget (story 1.5 review
 *   patch P1).
 *
 * Backpressure queue is **unbounded** in MVP. NFR4 (bounded memory) covers
 * freshness state, not the audit queue (`architecture.md:546`). A wedged
 * disk surfaces as memory growth long before it surfaces as data loss —
 * this is the chosen trade-off for forensic completeness.
 */
export function createAuditLogger(opts: CreateAuditLoggerOptions): AuditLogger {
  const { stream, clock, randomBytes, logger } = opts;
  const filePath = opts.filePath ?? '<injected stream>';
  const nextUlid = makeUlidGenerator({ clock, randomBytes });

  const queue: string[] = [];
  let paused = false;
  let errored = false;
  let errorLogged = false;
  let closed = false;
  let closingPromise: Promise<void> | undefined;
  let pendingCloseResolve: (() => void) | undefined;

  function treatAsErrored(reason: string): void {
    errored = true;
    queue.length = 0;
    paused = false;
    if (pendingCloseResolve !== undefined) {
      const settle = pendingCloseResolve;
      pendingCloseResolve = undefined;
      settle();
    }
    if (errorLogged) return;
    errorLogged = true;
    logger.warn(`audit log write failed: ${reason} — continuing without audit (path: ${filePath})`);
  }

  function flushQueue(): void {
    while (queue.length > 0 && !errored) {
      const line = queue[0] ?? '';
      let ok: boolean;
      try {
        ok = stream.write(line);
      } catch (err) {
        // AR61 fire-and-forget: a synchronous throw inside the audit
        // boundary must not escape to the handler / drain emitter.
        treatAsErrored(err instanceof Error ? err.message : String(err));
        return;
      }
      // Pop AFTER write — keeps the queue authoritative if `write` throws
      // synchronously (the throw is caught above; the entry is preserved
      // implicitly since we return without shifting).
      queue.shift();
      if (!ok) {
        paused = true;
        return;
      }
    }
    paused = false;
  }

  stream.on('drain', () => {
    if (errored) return;
    paused = false;
    flushQueue();
  });

  stream.on('error', (err: unknown) => {
    treatAsErrored(err instanceof Error ? err.message : String(err));
  });

  function serialise(input: AuditEntryInput, t: string, id: AuditEntryId): string | null {
    try {
      return JSON.stringify(buildEntry(AUDIT_SCHEMA_VERSION, t, id, input)) + '\n';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `audit log serialization failed for tool=${input.tool}: ${reason} — recording placeholder entry`,
      );
      try {
        const fallback: AuditEntryInput = {
          tool: input.tool,
          args: SERIALIZATION_FAILED_MARKER,
          decision: input.decision,
          response: SERIALIZATION_FAILED_MARKER,
          durationMs: input.durationMs,
          details: { reason: 'serialization_failed', message: reason },
        };
        return JSON.stringify(buildEntry(AUDIT_SCHEMA_VERSION, t, id, fallback)) + '\n';
      } catch (fallbackErr) {
        const fallbackReason =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        logger.warn(
          `audit log placeholder also failed for tool=${input.tool}: ${fallbackReason} — entry dropped`,
        );
        return null;
      }
    }
  }

  function write(entry: AuditEntryInput): void {
    if (errored || closed) return;
    try {
      const t = clock().toISOString();
      const id = nextUlid();
      const line = serialise(entry, t, id);
      if (line === null) return;
      if (paused || queue.length > 0) {
        queue.push(line);
        return;
      }
      const ok = stream.write(line);
      if (!ok) paused = true;
    } catch (err) {
      // AR61 fire-and-forget: synchronous throws from clock(), nextUlid(),
      // or stream.write() must not escape the audit boundary.
      treatAsErrored(err instanceof Error ? err.message : String(err));
    }
  }

  function close(): Promise<void> {
    if (closingPromise !== undefined) return closingPromise;
    closed = true;
    closingPromise = new Promise<void>((resolve) => {
      const settle = (): void => {
        pendingCloseResolve = undefined;
        resolve();
      };
      if (errored) {
        settle();
        return;
      }
      // Hand the resolver to `treatAsErrored` so a stream `'error'` (or a
      // synchronous throw inside `flushQueue`) while close() is awaiting
      // drain still settles the promise inside NFR9's 1s budget instead
      // of hanging forever waiting for a `'drain'` that will never fire.
      pendingCloseResolve = resolve;
      const finish = (): void => {
        // `stream.end` may be untyped on minimal fake streams; production
        // always supplies a Writable.
        stream.end(() => {
          settle();
        });
      };
      if (queue.length === 0) {
        finish();
        return;
      }
      const onDrain = (): void => {
        if (errored) {
          // The 'error' handler already settled via pendingCloseResolve.
          return;
        }
        if (queue.length === 0) {
          stream.removeListener('drain', onDrain);
          finish();
        }
      };
      stream.on('drain', onDrain);
      // Kick the drain handler synchronously in case the queue is already
      // flushable (e.g. the previous in-flight write completed before
      // `close()` was called and no subsequent `'drain'` is pending).
      flushQueue();
      if (queue.length === 0) {
        stream.removeListener('drain', onDrain);
        finish();
      }
    });
    return closingPromise;
  }

  return { write, close };
}

// Production composition ------------------------------------------------------

function defaultRandomBytes(n: number): Uint8Array {
  const buffer = new Uint8Array(n);
  randomFillSync(buffer);
  return buffer;
}

/**
 * Production composition: resolve path → ensure parent directory →
 * open append-only stream → construct the audit logger. Returns the logger
 * plus the resolved file path (for Story 1.11's startup banner).
 *
 * **Only function in this module that touches the filesystem.** Tests do
 * not exercise it directly; they exercise the four building blocks
 * separately. Story 1.11's startup-ladder integration test exercises the
 * end-to-end path.
 */
export function openAuditLogger(opts: OpenAuditLoggerOptions): {
  logger: AuditLogger;
  filePath: string;
} {
  const filePath = resolveAuditLogPath({
    env: opts.env,
    platform: opts.platform,
    homeDir: opts.homeDir,
    ...(opts.env.LOCALAPPDATA !== undefined ? { localAppData: opts.env.LOCALAPPDATA } : {}),
  });
  ensureAuditDir(filePath);
  const stream = openAuditStream(filePath);
  const logger = createAuditLogger({
    stream,
    clock: opts.clock,
    randomBytes: defaultRandomBytes,
    logger: opts.logger,
    filePath,
  });
  return { logger, filePath };
}
