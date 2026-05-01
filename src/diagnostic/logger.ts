/**
 * Closed set of operator-visible severities.
 *
 * The `Logger` is the **only sanctioned writer to stderr** — see
 * `_bmad-output/planning-artifacts/architecture.md` D7 (lines 642–712).
 * Direct `process.stderr.write(...)`, `console.error(...)`, and
 * `console.warn(...)` outside this module are discouraged: they bypass the
 * `[mcp-silverbullet]` prefix and the single-write atomicity guarantee that
 * keeps concurrent handler diagnostics readable.
 *
 * Levels are a closed set per AR49: `INFO`, `WARN`, `ERROR`. There is no
 * `DEBUG` / `TRACE` method and no log-level env var — adding a level is a
 * deliberate new story, not a runtime toggle.
 */
export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
};

const PREFIX = '[mcp-silverbullet]';

// Replace `\n` / `\r` with the two-character escapes `\\n` / `\\r` so a
// caller-supplied `message` (or non-stack error rendering) cannot split one
// log record across multiple stderr lines. Stack bodies are exempt — their
// newlines are part of the documented multi-frame contract.
function sanitize(s: string): string {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function format(level: 'INFO' | 'WARN' | 'ERROR', message: string): string {
  return `${PREFIX} ${level.padEnd(5)} ${sanitize(message)}`;
}

function renderError(err: unknown): string {
  if (err instanceof Error) {
    if (err.stack !== undefined && err.stack !== '') return err.stack;
    if (err.message !== undefined && err.message !== '') return sanitize(err.message);
    return sanitize(String(err));
  }
  return sanitize(String(err));
}

// NFR12 / D7: diagnostics must never destabilise the process. A closed
// stderr pipe (EPIPE / ERR_STREAM_DESTROYED) is a deeply degraded state —
// silent drop here keeps a logging call from crashing the handler that
// was just trying to log.
function safeWrite(stream: NodeJS.WritableStream, payload: string): void {
  try {
    stream.write(payload);
  } catch {
    /* swallow */
  }
}

/**
 * Construct a {@link Logger} bound to a writable stream. Tests pass a fake
 * stream and assert against captured chunks; production wires
 * `process.stderr` (see the default {@link logger} export below).
 *
 * Each `info` / `warn` / `error` call performs **at most one** `stream.write`
 * — payload is fully assembled before the write so concurrent handlers
 * cannot interleave partial lines. `\n` / `\r` in the user-supplied
 * `message` are escaped so each call emits exactly one log record; stack
 * bodies retain their newlines by design. Stream errors are silently
 * swallowed (NFR12).
 */
export function createLogger(stream: NodeJS.WritableStream): Logger {
  return {
    info(message) {
      safeWrite(stream, format('INFO', message) + '\n');
    },
    warn(message) {
      safeWrite(stream, format('WARN', message) + '\n');
    },
    error(message, err) {
      const primary = format('ERROR', message);
      if (err === undefined) {
        safeWrite(stream, primary + '\n');
        return;
      }
      safeWrite(stream, primary + '\n' + renderError(err) + '\n');
    },
  };
}

/**
 * Default {@link Logger} bound to `process.stderr`. Used by code paths that
 * run before a `HandlerContext` exists (the startup ladder lands in story
 * 1.11). Inside tool handlers, prefer `ctx.logger` — see the canonical
 * handler shape at `architecture.md:1106`.
 */
export const logger: Logger = createLogger(process.stderr);
