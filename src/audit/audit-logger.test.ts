import { test } from 'node:test';
import assert from 'node:assert/strict';

import { type Logger } from '../diagnostic/logger.ts';

import {
  createAuditLogger,
  makeUlidGenerator,
  resolveAuditLogPath,
  type AuditLogger,
} from './audit-logger.ts';
import { AUDIT_SCHEMA_VERSION, type AuditEntryInput } from './schema.ts';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers — fakes for the four DI seams of `createAuditLogger`
// ─────────────────────────────────────────────────────────────────────────

type StreamListener = (...args: unknown[]) => void;

type FakeStream = {
  stream: NodeJS.WritableStream;
  writes: string[];
  endCalls: number;
  endCallbacks: Array<() => void>;
  drainListeners: StreamListener[];
  errorListeners: StreamListener[];
  removedDrainListeners: StreamListener[];
  /** Queue of return values for `stream.write`; defaults to `true` once empty. */
  nextWriteReturns: boolean[];
  /** Fire a `'drain'` synthetically. */
  emitDrain: () => void;
  /** Fire an `'error'` synthetically. */
  emitError: (err: unknown) => void;
};

function makeFakeStream(): FakeStream {
  const writes: string[] = [];
  const endCallbacks: Array<() => void> = [];
  const drainListeners: StreamListener[] = [];
  const errorListeners: StreamListener[] = [];
  const removedDrainListeners: StreamListener[] = [];
  const nextWriteReturns: boolean[] = [];
  let endCalls = 0;

  const notImplemented = (name: string) => () => {
    throw new Error(`fake stream: ${name} not implemented`);
  };

  const stream = {
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return nextWriteReturns.length > 0 ? (nextWriteReturns.shift() ?? true) : true;
    },
    end(cb?: () => void): NodeJS.WritableStream {
      endCalls += 1;
      if (cb !== undefined) endCallbacks.push(cb);
      return stream;
    },
    on(event: string, listener: StreamListener): NodeJS.WritableStream {
      if (event === 'drain') drainListeners.push(listener);
      else if (event === 'error') errorListeners.push(listener);
      else throw new Error(`fake stream: unexpected on('${event}', ...)`);
      return stream;
    },
    once: notImplemented('once'),
    removeListener(event: string, listener: StreamListener): NodeJS.WritableStream {
      if (event === 'drain') {
        const idx = drainListeners.indexOf(listener);
        if (idx >= 0) {
          drainListeners.splice(idx, 1);
          removedDrainListeners.push(listener);
        }
      }
      return stream;
    },
    emit: notImplemented('emit'),
    pipe: notImplemented('pipe'),
    unpipe: notImplemented('unpipe'),
    cork: notImplemented('cork'),
    uncork: notImplemented('uncork'),
    destroy: notImplemented('destroy'),
    setDefaultEncoding: notImplemented('setDefaultEncoding'),
    addListener: notImplemented('addListener'),
    removeAllListeners: notImplemented('removeAllListeners'),
    eventNames: notImplemented('eventNames'),
    listenerCount: notImplemented('listenerCount'),
    listeners: notImplemented('listeners'),
    prependListener: notImplemented('prependListener'),
    prependOnceListener: notImplemented('prependOnceListener'),
    rawListeners: notImplemented('rawListeners'),
    getMaxListeners: notImplemented('getMaxListeners'),
    setMaxListeners: notImplemented('setMaxListeners'),
    off: notImplemented('off'),
    // AR59: fake-stream cast at the test boundary; the Logger contract
    // surface accepts a writable stream, and the test only exercises
    // `write`, `end`, `on`, `removeListener` paths.
  } as unknown as NodeJS.WritableStream;

  return {
    stream,
    writes,
    get endCalls() {
      return endCalls;
    },
    endCallbacks,
    drainListeners,
    errorListeners,
    removedDrainListeners,
    nextWriteReturns,
    emitDrain: () => {
      for (const l of [...drainListeners]) l();
    },
    emitError: (err: unknown) => {
      for (const l of [...errorListeners]) l(err);
    },
  };
}

function fakeClock(initialMs: number): { now: () => Date; tick: (deltaMs: number) => void } {
  let nowMs = initialMs;
  return {
    now: () => new Date(nowMs),
    tick: (delta: number) => {
      nowMs += delta;
    },
  };
}

function fakeRandomBytes(...buffers: Uint8Array[]): (n: number) => Uint8Array {
  let i = 0;
  return (n: number) => {
    if (i < buffers.length) {
      const b = buffers[i++];
      if (b !== undefined) {
        if (b.length !== n)
          throw new Error(`fakeRandomBytes: requested ${n}, supplied ${b.length}`);
        return b;
      }
    }
    return new Uint8Array(n);
  };
}

type FakeLogger = {
  logger: Logger;
  info: string[];
  warn: string[];
  error: Array<{ message: string; err: unknown }>;
};

function fakeLogger(): FakeLogger {
  const info: string[] = [];
  const warn: string[] = [];
  const errorCalls: Array<{ message: string; err: unknown }> = [];
  return {
    info,
    warn,
    error: errorCalls,
    logger: {
      info: (m) => info.push(m),
      warn: (m) => warn.push(m),
      error: (m, err) => errorCalls.push({ message: m, err }),
    },
  };
}

function makeLoggerWith(
  fake: FakeStream,
  log: FakeLogger,
  clockMs = Date.UTC(2026, 3, 30, 14, 23, 51, 123),
  randomness: Uint8Array = new Uint8Array(10).fill(0x7f),
): { audit: AuditLogger; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock(clockMs);
  const audit = createAuditLogger({
    stream: fake.stream,
    clock: clock.now,
    randomBytes: fakeRandomBytes(randomness, randomness, randomness, randomness, randomness),
    logger: log.logger,
    filePath: '/var/log/audit.jsonl',
  });
  return { audit, clock };
}

const ALLOWED_ENTRY: AuditEntryInput = {
  tool: 'list_pages',
  args: { query: 'foo' },
  decision: 'allowed',
  response: { refs: [] },
  durationMs: 12,
};

const REJECTED_ENTRY: AuditEntryInput = {
  tool: 'edit_page',
  args: { ref: 'Projects/Foo' },
  decision: 'rejected',
  response: { error: 'page_modified_since_read' },
  durationMs: 87,
  reason: 'freshness_violation',
  details: { lastModified: '2026-04-30T14:20:01Z', lastReadAt: '2026-04-30T13:45:00Z' },
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// resolveAuditLogPath — pure path resolution, ≥ 8 cases
// ─────────────────────────────────────────────────────────────────────────

await test('resolveAuditLogPath: env override (Unix absolute) returns the override verbatim', () => {
  const out = resolveAuditLogPath({
    env: { MCP_SILVERBULLET_AUDIT_LOG_PATH: '/var/log/x/audit.jsonl' },
    platform: 'linux',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/var/log/x/audit.jsonl');
});

await test('resolveAuditLogPath: env override (Windows absolute) returns the override verbatim', () => {
  const out = resolveAuditLogPath({
    env: { MCP_SILVERBULLET_AUDIT_LOG_PATH: 'C:\\ProgramData\\x\\audit.jsonl' },
    platform: 'win32',
    homeDir: 'C:\\Users\\Maya',
  });
  assert.strictEqual(out, 'C:\\ProgramData\\x\\audit.jsonl');
});

await test('resolveAuditLogPath: relative env override falls through to platform default', () => {
  const out = resolveAuditLogPath({
    env: { MCP_SILVERBULLET_AUDIT_LOG_PATH: './relative.jsonl' },
    platform: 'linux',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/home/u/.local/state/mcp-silverbullet/audit.jsonl');
});

await test('resolveAuditLogPath: empty-string env override is treated as unset', () => {
  const out = resolveAuditLogPath({
    env: { MCP_SILVERBULLET_AUDIT_LOG_PATH: '' },
    platform: 'linux',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/home/u/.local/state/mcp-silverbullet/audit.jsonl');
});

await test('resolveAuditLogPath: Unix XDG_STATE_HOME set → joined under that root', () => {
  const out = resolveAuditLogPath({
    env: { XDG_STATE_HOME: '/x/state' },
    platform: 'linux',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/x/state/mcp-silverbullet/audit.jsonl');
});

await test('resolveAuditLogPath: Unix XDG_STATE_HOME unset → ~/.local/state fallback', () => {
  const out = resolveAuditLogPath({
    env: {},
    platform: 'darwin',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/home/u/.local/state/mcp-silverbullet/audit.jsonl');
});

await test('resolveAuditLogPath: Windows LOCALAPPDATA set → backslash-joined path even on POSIX runner', () => {
  const out = resolveAuditLogPath({
    env: {},
    platform: 'win32',
    homeDir: 'C:\\Users\\Maya',
    localAppData: 'C:\\Users\\Maya\\AppData\\Local',
  });
  assert.strictEqual(out, 'C:\\Users\\Maya\\AppData\\Local\\mcp-silverbullet\\audit.jsonl');
});

await test('resolveAuditLogPath: Windows LOCALAPPDATA unset → AppData/Local fallback under homeDir', () => {
  const out = resolveAuditLogPath({
    env: {},
    platform: 'win32',
    homeDir: 'C:\\Users\\Maya',
  });
  assert.strictEqual(out, 'C:\\Users\\Maya\\AppData\\Local\\mcp-silverbullet\\audit.jsonl');
});

await test('resolveAuditLogPath: empty-string XDG_STATE_HOME treated as unset', () => {
  const out = resolveAuditLogPath({
    env: { XDG_STATE_HOME: '' },
    platform: 'linux',
    homeDir: '/home/u',
  });
  assert.strictEqual(out, '/home/u/.local/state/mcp-silverbullet/audit.jsonl');
});

// ─────────────────────────────────────────────────────────────────────────
// ULID generator — ≥ 7 cases
// ─────────────────────────────────────────────────────────────────────────

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

await test('ULID format: 26 chars, Crockford alphabet', () => {
  const next = makeUlidGenerator({
    clock: () => new Date(0),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0x42)),
  });
  const id = next();
  assert.strictEqual(id.length, 26);
  assert.match(id, ULID_REGEX);
});

await test('ULID time prefix: clock = epoch 0 → first 10 chars are all "0"', () => {
  const next = makeUlidGenerator({
    clock: () => new Date(0),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
  });
  const id = next();
  assert.strictEqual(id.slice(0, 10), '0000000000');
});

await test('ULID time prefix: different clock → different time prefix', () => {
  const aNext = makeUlidGenerator({
    clock: () => new Date(1_700_000_000_000),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
  });
  const bNext = makeUlidGenerator({
    clock: () => new Date(1_700_000_000_001),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
  });
  const a = aNext();
  const b = bNext();
  assert.notStrictEqual(a.slice(0, 10), b.slice(0, 10));
  assert.ok(b > a, 'later millisecond must produce lexically greater ULID');
});

await test('ULID monotonicity: same ms → second ULID is strictly greater (random increment)', () => {
  const next = makeUlidGenerator({
    clock: () => new Date(1_700_000_000_000),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0x10)),
  });
  const a = next();
  const b = next();
  assert.ok(b > a, 'monotonic increment must yield lexically greater ULID');
  assert.strictEqual(a.slice(0, 10), b.slice(0, 10));
});

await test('ULID monotonicity holds across 100 consecutive calls in the same ms', () => {
  const next = makeUlidGenerator({
    clock: () => new Date(1_700_000_000_000),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
  });
  let prev = next();
  for (let i = 0; i < 100; i++) {
    const cur = next();
    assert.ok(cur > prev, `ULID #${i} must be > previous (${prev} vs ${cur})`);
    prev = cur;
  }
});

await test('ULID overflow: random part 0xFF…FF → re-draws fresh randomness on next same-ms call', () => {
  const max = new Uint8Array(10).fill(0xff);
  const fresh = new Uint8Array(10).fill(0x00);
  const next = makeUlidGenerator({
    clock: () => new Date(1_700_000_000_000),
    randomBytes: fakeRandomBytes(max, fresh),
  });
  const a = next();
  // Increment of 0xFF…FF overflows → caller re-draws → randomBytes returns
  // `fresh`. ULID must remain valid (length, alphabet) and not throw.
  const b = next();
  assert.match(a, ULID_REGEX);
  assert.match(b, ULID_REGEX);
  assert.strictEqual(a.slice(0, 10), b.slice(0, 10));
});

await test('ULID brand: runtime length is exactly 26', () => {
  const next = makeUlidGenerator({
    clock: () => new Date(0),
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
  });
  const id: string = next();
  assert.strictEqual(id.length, 26);
});

// ─────────────────────────────────────────────────────────────────────────
// Schema constant
// ─────────────────────────────────────────────────────────────────────────

await test('AUDIT_SCHEMA_VERSION is locked at 1', () => {
  assert.strictEqual(AUDIT_SCHEMA_VERSION, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// createAuditLogger — write / drain / close / error
// ─────────────────────────────────────────────────────────────────────────

await test('createAuditLogger: schema-v1 round-trip with required fields and stable key order', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(ALLOWED_ENTRY);

  assert.strictEqual(fake.writes.length, 1);
  const line = fake.writes[0] ?? '';
  assert.ok(line.endsWith('\n'), 'JSONL invariant: line must end with \\n');

  const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
  assert.strictEqual(parsed.v, 1);
  assert.match(parsed.t as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(parsed.id as string, ULID_REGEX);
  assert.strictEqual(parsed.tool, 'list_pages');
  assert.deepStrictEqual(parsed.args, { query: 'foo' });
  assert.strictEqual(parsed.decision, 'allowed');
  assert.deepStrictEqual(parsed.response, { refs: [] });
  assert.strictEqual(parsed.durationMs, 12);
  assert.ok(!('reason' in parsed), 'allowed entries must not carry `reason`');
  assert.ok(!('details' in parsed), 'allowed entries must not carry `details`');
  assert.ok(!('failedOperation' in parsed), 'allowed entries must not carry `failedOperation`');

  // Stable insertion order — required for jq-greppable JSONL (NFR18).
  assert.deepStrictEqual(Object.keys(parsed), [
    'v',
    't',
    'id',
    'tool',
    'args',
    'decision',
    'response',
    'durationMs',
  ]);
});

await test('createAuditLogger: t is ISO 8601 UTC reflecting clock at write-time', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(ALLOWED_ENTRY);
  const parsed = JSON.parse((fake.writes[0] ?? '').trimEnd()) as { t: string };
  assert.strictEqual(parsed.t, '2026-04-30T14:23:51.123Z');
});

await test('createAuditLogger: id is monotonic across consecutive writes within the same clock tick', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(ALLOWED_ENTRY);
  audit.write(ALLOWED_ENTRY);
  audit.write(ALLOWED_ENTRY);
  const ids = fake.writes.map((line) => (JSON.parse(line.trimEnd()) as { id: string }).id);
  assert.strictEqual(ids.length, 3);
  assert.ok(ids[1]! > ids[0]!, 'second id must be > first');
  assert.ok(ids[2]! > ids[1]!, 'third id must be > second');
});

await test('createAuditLogger: rejected entries serialize reason + details', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(REJECTED_ENTRY);
  const parsed = JSON.parse((fake.writes[0] ?? '').trimEnd()) as Record<string, unknown>;
  assert.strictEqual(parsed.decision, 'rejected');
  assert.strictEqual(parsed.reason, 'freshness_violation');
  assert.deepStrictEqual(parsed.details, {
    lastModified: '2026-04-30T14:20:01Z',
    lastReadAt: '2026-04-30T13:45:00Z',
  });
});

await test('createAuditLogger: failedOperation field round-trips when present', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write({
    tool: 'edit_page',
    args: { ref: 'Foo' },
    decision: 'rejected',
    response: { error: 'overlap' },
    durationMs: 5,
    reason: 'validation_error',
    details: {},
    failedOperation: { index: 1, operation: { type: 'replace_lines', from_line: 1, to_line: 2 } },
  });
  const parsed = JSON.parse((fake.writes[0] ?? '').trimEnd()) as Record<string, unknown>;
  assert.deepStrictEqual(parsed.failedOperation, {
    index: 1,
    operation: { type: 'replace_lines', from_line: 1, to_line: 2 },
  });
});

await test('createAuditLogger: backpressure happy path — every write returns true → no queueing', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  for (let i = 0; i < 10; i++) audit.write(ALLOWED_ENTRY);
  assert.strictEqual(fake.writes.length, 10);
  assert.strictEqual(log.warn.length, 0);
});

await test('createAuditLogger: backpressure paused path — entries queue until drain AND `t` is captured at write-time, not drain-time (AC12 case 7)', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const initialMs = Date.UTC(2026, 3, 30, 14, 23, 51, 123);
  const { audit, clock } = makeLoggerWith(fake, log, initialMs);

  fake.nextWriteReturns.push(false); // first write fills the buffer
  audit.write({ ...ALLOWED_ENTRY, tool: 'list_pages_a' });

  // Advance the clock between writes A and B. If the audit logger captured
  // `t` at drain-time instead of write-time, line B's `t` would track the
  // post-drain clock value below — the AC12 case 7 invariant would break.
  clock.tick(50);
  audit.write({ ...ALLOWED_ENTRY, tool: 'list_pages_b' });

  // Stream has only line A so far.
  assert.strictEqual(fake.writes.length, 1);
  assert.match(fake.writes[0] ?? '', /"tool":"list_pages_a"/);

  // Advance clock again between queue-time and drain-time — proves `t` was
  // frozen at write-time, not drain-time.
  clock.tick(50);
  fake.emitDrain();

  assert.strictEqual(fake.writes.length, 2);
  const a = JSON.parse((fake.writes[0] ?? '').trimEnd()) as { t: string; tool: string };
  const b = JSON.parse((fake.writes[1] ?? '').trimEnd()) as { t: string; tool: string };
  assert.strictEqual(a.tool, 'list_pages_a');
  assert.strictEqual(b.tool, 'list_pages_b');
  assert.strictEqual(a.t, new Date(initialMs).toISOString());
  // Line B was written 50ms after line A, queued, then drained 50ms later.
  // `t` reflects the call-time (initialMs + 50), NOT the drain-time
  // (initialMs + 100).
  assert.strictEqual(b.t, new Date(initialMs + 50).toISOString());
});

await test('createAuditLogger: backpressure across multiple drain cycles preserves FIFO order', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  // Pattern: write false, false, true, false, true.
  fake.nextWriteReturns.push(false, false, true, false, true);

  for (let i = 0; i < 5; i++) audit.write({ ...ALLOWED_ENTRY, tool: `t${i}` });

  // Only first entry was sent before backpressure kicked in (subsequent
  // writes saw paused=true and went to the queue). Drain twice to flush.
  assert.strictEqual(fake.writes.length, 1);

  // Drain pattern: with [false, false, true, false, true], flushing 4
  // queued entries (t1..t4) needs three drain cycles —
  //   1st drain pops t1 (false → repause); writes=[t0, t1]
  //   2nd drain pops t2 (true), then t3 (false → repause); writes=[…, t2, t3]
  //   3rd drain pops t4 (true → done); writes=[…, t4]
  fake.emitDrain();
  fake.emitDrain();
  fake.emitDrain();

  assert.strictEqual(fake.writes.length, 5);
  const tools = fake.writes.map((line) => (JSON.parse(line.trimEnd()) as { tool: string }).tool);
  assert.deepStrictEqual(tools, ['t0', 't1', 't2', 't3', 't4']);
});

await test('createAuditLogger: close() with empty queue calls stream.end exactly once and resolves', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(ALLOWED_ENTRY);

  const closing = audit.close();
  // Drain end callback so the promise can resolve.
  for (const cb of fake.endCallbacks) cb();
  await closing;

  assert.strictEqual(fake.endCalls, 1);
  // Subsequent writes are no-ops.
  audit.write(ALLOWED_ENTRY);
  assert.strictEqual(fake.writes.length, 1);
});

await test('createAuditLogger: close() waits for queue to drain before ending the stream', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  // Keep the stream paused through close()'s synchronous flushQueue: every
  // stream.write call returns false until we explicitly drain. Pushes are
  // consumed as `[t0=false, queue-drain-attempt-1=false, queue-drain-attempt-
  // 2=false, ...]`.
  fake.nextWriteReturns.push(false, false, false, false, false);
  audit.write({ ...ALLOWED_ENTRY, tool: 'a' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'b' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'c' });

  const closing = audit.close();

  // Queue is non-empty AND the stream stays paused → end has NOT been called.
  assert.strictEqual(fake.endCalls, 0);

  // Allow subsequent writes to succeed, then drain → queue empties → end fires.
  fake.nextWriteReturns.length = 0;
  fake.emitDrain();
  assert.strictEqual(fake.endCalls, 1);
  for (const cb of fake.endCallbacks) cb();
  await closing;

  assert.strictEqual(fake.writes.length, 3);
  const tools = fake.writes.map((line) => (JSON.parse(line.trimEnd()) as { tool: string }).tool);
  assert.deepStrictEqual(tools, ['a', 'b', 'c']);
});

await test('createAuditLogger: close() is idempotent — second call resolves without re-ending', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  const closing1 = audit.close();
  const closing2 = audit.close();
  for (const cb of fake.endCallbacks) cb();
  await closing1;
  await closing2;

  assert.strictEqual(fake.endCalls, 1);
});

await test('createAuditLogger: stream "error" emits a single WARN, drops the queue, and turns subsequent writes into no-ops', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  fake.nextWriteReturns.push(false);
  audit.write({ ...ALLOWED_ENTRY, tool: 'first' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'queued' });

  fake.emitError(new Error('disk full'));

  assert.strictEqual(log.warn.length, 1);
  assert.match(log.warn[0] ?? '', /audit log write failed: disk full/);
  assert.match(log.warn[0] ?? '', /\/var\/log\/audit\.jsonl/);

  // Second error does NOT emit a second WARN.
  fake.emitError(new Error('still broken'));
  assert.strictEqual(log.warn.length, 1);

  // Subsequent write is a no-op.
  const writesBefore = fake.writes.length;
  audit.write({ ...ALLOWED_ENTRY, tool: 'after-error' });
  assert.strictEqual(fake.writes.length, writesBefore);

  // 'drain' after error does NOT cause queue to flush (queue was dropped).
  fake.emitDrain();
  assert.strictEqual(fake.writes.length, writesBefore);
});

await test('createAuditLogger: close() after stream "error" resolves without calling stream.end', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  fake.emitError(new Error('disk gone'));
  await audit.close();
  assert.strictEqual(fake.endCalls, 0);
});

await test('createAuditLogger: circular `args` triggers WARN and falls back to placeholder entry (preserves AR33)', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  type Circ = { tool: string; self?: Circ };
  const circular: Circ = { tool: 'edit_page' };
  circular.self = circular;

  audit.write({
    tool: 'edit_page',
    args: circular,
    decision: 'rejected',
    response: { error: 'broken' },
    durationMs: 0,
  });

  assert.strictEqual(fake.writes.length, 1);
  const parsed = JSON.parse((fake.writes[0] ?? '').trimEnd()) as Record<string, unknown>;
  assert.strictEqual(parsed.tool, 'edit_page');
  assert.strictEqual(parsed.args, '<serialization_failed>');
  assert.strictEqual(parsed.response, '<serialization_failed>');
  assert.strictEqual(log.warn.length, 1);
  assert.match(log.warn[0] ?? '', /serialization failed for tool=edit_page/);
});

await test('createAuditLogger: line ends with newline; never split across multiple stream.write calls', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);
  audit.write(ALLOWED_ENTRY);
  audit.write(REJECTED_ENTRY);
  await flushMicrotasks();

  assert.strictEqual(fake.writes.length, 2);
  for (const line of fake.writes) {
    assert.ok(line.endsWith('\n'), 'every record ends with \\n');
    // Exactly one '\n' per line — the JSONL terminator.
    const newlineCount = (line.match(/\n/g) ?? []).length;
    assert.strictEqual(newlineCount, 1);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Regression coverage — story 1.5 review patches P1 / P2 / P4
// ─────────────────────────────────────────────────────────────────────────

await test('createAuditLogger: stream "error" during in-flight close() settles the closing promise (P1, NFR9)', async () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  // Keep the stream paused for every write — close()'s synchronous
  // flushQueue pops one queued entry on each `false` return, so to keep
  // the queue non-empty across close()'s flush we need at least three
  // queued entries (one for the live stream, one popped by flushQueue,
  // one to remain pending for drain).
  fake.nextWriteReturns.push(false, false, false, false, false);
  audit.write({ ...ALLOWED_ENTRY, tool: 'a' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'b' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'c' });

  const closing = audit.close();

  // Stream errors while close() is still waiting for drain. Without the
  // P1 fix, the closing promise hangs indefinitely (no drain will fire on
  // a destroyed stream).
  fake.emitError(new Error('disk gone mid-close'));

  await closing;
  // close() resolved via the error path — stream.end was never invoked.
  assert.strictEqual(fake.endCalls, 0);
  assert.strictEqual(log.warn.length, 1);
  assert.match(log.warn[0] ?? '', /audit log write failed: disk gone mid-close/);
});

await test('createAuditLogger: synchronous throw in clock() is caught, logs WARN once, and disables further writes (P2, AR61)', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  let throwOnNext = false;
  const audit = createAuditLogger({
    stream: fake.stream,
    clock: () => {
      if (throwOnNext) throw new Error('clock dead');
      return new Date(Date.UTC(2026, 3, 30));
    },
    randomBytes: fakeRandomBytes(new Uint8Array(10).fill(0)),
    logger: log.logger,
    filePath: '/var/log/audit.jsonl',
  });

  // First write succeeds with the live clock.
  audit.write(ALLOWED_ENTRY);
  assert.strictEqual(fake.writes.length, 1);

  // Second write hits the throwing clock — must NOT escape write().
  throwOnNext = true;
  assert.doesNotThrow(() => {
    audit.write(ALLOWED_ENTRY);
  });

  // Subsequent writes are no-ops even after the throwing clock recovers.
  throwOnNext = false;
  audit.write(ALLOWED_ENTRY);
  assert.strictEqual(fake.writes.length, 1);

  // Exactly one WARN, and it names the synchronous failure.
  assert.strictEqual(log.warn.length, 1);
  assert.match(log.warn[0] ?? '', /audit log write failed: clock dead/);
});

await test('createAuditLogger: synchronous throw from stream.write inside flushQueue is caught (P2, AR61)', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  // First write fills the buffer (paused). Second write goes to the queue.
  fake.nextWriteReturns.push(false);
  audit.write({ ...ALLOWED_ENTRY, tool: 'a' });
  audit.write({ ...ALLOWED_ENTRY, tool: 'queued' });
  assert.strictEqual(fake.writes.length, 1);

  // Now make the next stream.write call throw synchronously — simulating a
  // "write after end" / destroyed-stream scenario hit during drain.
  const realWrite = fake.stream.write.bind(fake.stream);
  fake.stream.write = () => {
    throw new Error('stream destroyed');
  };

  // Drain must NOT escape the throw (the drain handler is invoked by the
  // event emitter — an uncaught throw there would crash the process).
  assert.doesNotThrow(() => {
    fake.emitDrain();
  });

  // Logger captured the failure.
  assert.strictEqual(log.warn.length, 1);
  assert.match(log.warn[0] ?? '', /audit log write failed: stream destroyed/);

  // Restore for cleanup; subsequent writes are no-ops because errored=true.
  fake.stream.write = realWrite;
  audit.write({ ...ALLOWED_ENTRY, tool: 'after-throw' });
  assert.strictEqual(fake.writes.length, 1);
});

await test('createAuditLogger: secondary serialisation failure logs a second WARN before dropping the entry (P4)', () => {
  const fake = makeFakeStream();
  const log = fakeLogger();
  const { audit } = makeLoggerWith(fake, log);

  // BigInt is not JSON-serialisable. Both the primary entry AND the
  // placeholder fallback carry `durationMs` from the input, so both
  // serialisation attempts will throw TypeError.
  const entry = {
    tool: 'edit_page',
    args: { ref: 'Foo' },
    decision: 'rejected' as const,
    response: { error: 'broken' },
    durationMs: 42n,
  } as unknown as AuditEntryInput;

  audit.write(entry);

  // No line written — the entry was dropped.
  assert.strictEqual(fake.writes.length, 0);
  // Two WARNs: primary failure, then placeholder failure.
  assert.strictEqual(log.warn.length, 2);
  assert.match(log.warn[0] ?? '', /serialization failed for tool=edit_page/);
  assert.match(log.warn[1] ?? '', /placeholder also failed for tool=edit_page/);
  assert.match(log.warn[1] ?? '', /entry dropped/);
});
