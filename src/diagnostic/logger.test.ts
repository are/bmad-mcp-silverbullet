import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { createLogger, logger, type Logger } from './logger.ts';

type FakeStream = { stream: NodeJS.WritableStream; writes: string[] };

function makeFakeStream(): FakeStream {
  const writes: string[] = [];
  // Minimal NodeJS.WritableStream surface — Logger only invokes .write(string).
  // Other methods throw if called so accidental coupling is caught loudly.
  // The `as NodeJS.WritableStream` cast is test-only scaffolding (AR59 allows
  // `as` at boundaries; this is the test's boundary into the Logger contract).
  const notImplemented = (name: string) => () => {
    throw new Error(`fake stream: ${name} not implemented`);
  };
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
    end(): NodeJS.WritableStream {
      return stream;
    },
    on: notImplemented('on'),
    once: notImplemented('once'),
    emit: notImplemented('emit'),
    pipe: notImplemented('pipe'),
    unpipe: notImplemented('unpipe'),
    cork: notImplemented('cork'),
    uncork: notImplemented('uncork'),
    destroy: notImplemented('destroy'),
    setDefaultEncoding: notImplemented('setDefaultEncoding'),
    addListener: notImplemented('addListener'),
    removeListener: notImplemented('removeListener'),
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
  } as unknown as NodeJS.WritableStream;
  return { stream, writes };
}

await test('info: prefix + 5-char left-padded level + single space + message + \\n', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.info('starting up');
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] INFO  starting up\n']);
});

await test('warn: same shape with WARN level (two visible spaces between level token and message)', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.warn('audit write failed: ENOSPC; continuing');
  assert.deepStrictEqual(writes, [
    '[mcp-silverbullet] WARN  audit write failed: ENOSPC; continuing\n',
  ]);
});

await test('error without err: ERROR is 5 chars (no padding), single space before message', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('handler crashed');
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR handler crashed\n']);
});

await test('error with Error: single write, primary line then stack body, trailing \\n', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  const e = new Error('boom');
  log.error('handler crashed', e);
  assert.strictEqual(writes.length, 1, 'must be exactly one write (atomicity)');
  const payload = writes[0]!;
  assert.match(payload, /^\[mcp-silverbullet\] ERROR handler crashed\n/);
  assert.match(payload, /boom/, 'stack must include the underlying error message');
  assert.match(payload, /\n$/, 'payload must end with a newline');
});

await test('error with undefined err: identical to no-arg form', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('handler crashed', undefined);
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR handler crashed\n']);
});

await test('error with non-Error string: primary line + String(err) + \\n', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('handler crashed', 'string thrown');
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR handler crashed\nstring thrown\n']);
});

await test('error with non-Error object: String(err) renders as [object Object]', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('handler crashed', { foo: 'bar' });
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR handler crashed\n[object Object]\n']);
});

await test('error with Error whose .stack is undefined: falls back to .message', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  const e = new Error('m');
  // Force the no-stack branch — some Error subclasses (and engines without
  // V8) leave .stack undefined. We must still emit something useful.
  Object.defineProperty(e, 'stack', { value: undefined, configurable: true });
  log.error('e', e);
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR e\nm\n']);
});

await test('error with Error whose .stack and .message are both empty: falls back to String(err)', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  const e = new Error('');
  Object.defineProperty(e, 'stack', { value: undefined, configurable: true });
  log.error('e', e);
  assert.strictEqual(writes.length, 1);
  // String(new Error('')) is 'Error' on Node.
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] ERROR e\nError\n']);
});

await test('atomicity: stack-bearing error produces exactly one write call', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('crash', new Error('boom'));
  assert.strictEqual(writes.length, 1);
});

await test('Logger shape is closed: no `debug` method (compile-time)', () => {
  // AC1: closed level set, no debug method per AR49 (architecture.md:670).
  // This `@ts-expect-error` directive must be necessary — if Logger ever grows
  // a `debug` method, tsc will flag the directive as unused and break the
  // build, surfacing the regression.
  const { stream } = makeFakeStream();
  const log: Logger = createLogger(stream);
  // @ts-expect-error AC1: Logger has no `debug` method (AR49 closed level set).
  void log.debug;
});

await test('default `logger` writes to process.stderr', () => {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Shim process.stderr.write so we can verify the default `logger` is wired
  // to it. Restored in `finally` even on assertion failure.
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    logger.info('x');
    assert.deepStrictEqual(captured, ['[mcp-silverbullet] INFO  x\n']);
  } finally {
    process.stderr.write = original;
  }
});

await test('sanitize: \\n in message is escaped so one call still yields one log record', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.info('a\nb');
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] INFO  a\\nb\n']);
});

await test('sanitize: \\r in message is escaped (carriage returns also split records on some scrapers)', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.warn('a\rb');
  assert.deepStrictEqual(writes, ['[mcp-silverbullet] WARN  a\\rb\n']);
});

await test('sanitize: error message escapes \\n but the stack body retains its multi-line frames', () => {
  const { stream, writes } = makeFakeStream();
  const log = createLogger(stream);
  log.error('crash\nhere', new Error('boom'));
  assert.strictEqual(writes.length, 1);
  const payload = writes[0]!;
  assert.match(payload, /^\[mcp-silverbullet\] ERROR crash\\nhere\n/);
  assert.match(payload, /boom/);
  // Stack bodies are intentionally multi-line — at least 3 lines (primary +
  // 'Error: boom' + at-least-one frame) before the trailing newline.
  assert.ok(payload.split('\n').length > 2, 'stack must keep its multi-line structure');
});

await test('safe write: stream.write throws (EPIPE / ERR_STREAM_DESTROYED) — logger never propagates', () => {
  const throwingStream = {
    write(): boolean {
      throw new Error('EPIPE: simulated');
    },
  } as unknown as NodeJS.WritableStream;
  const log = createLogger(throwingStream);
  assert.doesNotThrow(() => log.info('x'));
  assert.doesNotThrow(() => log.warn('x'));
  assert.doesNotThrow(() => log.error('x'));
  assert.doesNotThrow(() => log.error('x', new Error('boom')));
});

await test('AC5: nothing is written to stdout for any level', () => {
  const captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const { stream } = makeFakeStream();
    const log = createLogger(stream);
    log.info('i');
    log.warn('w');
    log.error('e');
    log.error('e2', new Error('boom'));
    assert.deepStrictEqual(captured, [], 'stdout must remain untouched by Logger');
    // Positive control: confirm the shim is functioning.
    process.stdout.write('control');
    assert.deepStrictEqual(captured, ['control']);
  } finally {
    process.stdout.write = original;
  }
});
