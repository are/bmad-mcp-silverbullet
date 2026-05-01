/**
 * Story 1.12 — stdout-discipline smoke test (D7 / AR47).
 *
 * Black-box test of the published `node ./src/index.ts` binary. Spawns a
 * fake SilverBullet HTTP server on an ephemeral port, runs the server with
 * env vars pointing at the fake, drives the MCP stdio transport with a
 * sequence of valid JSON-RPC requests, then asserts:
 *
 * 1. Every non-empty line on the child's stdout parses as JSON-RPC 2.0
 *    (presence of `jsonrpc: '2.0'` plus either `id` or `method`).
 * 2. The cooperative shutdown lands cleanly on SIGINT (`exit code === 0`,
 *    diagnostic banners on stderr).
 * 3. The protocol traffic actually happened (`responses.length >= 1`) —
 *    defends against the false-positive "stdout is empty" case.
 *
 * The smoke test is the gate that catches regressions ESLint's `no-console`
 * rule cannot — e.g., a transitive npm dep that prints to stdout at import
 * time.
 *
 * @see Story 1.12 AC source: `_bmad-output/planning-artifacts/epics.md:637-663`.
 * @see D7 — stream-discipline rules: `architecture.md:642-712`.
 * @see AR47 — stdout reserved for MCP JSON-RPC: `epics.md:168`.
 * @see NFR21 — test runs without live SB / network beyond loopback: `epics.md:101`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Fake SilverBullet HTTP server.
// ---------------------------------------------------------------------------

type FakeSilverBullet = {
  readonly url: string;
  close(): Promise<void>;
};

async function startFakeSilverBullet(expectedToken: string): Promise<FakeSilverBullet> {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');

    // AR25 verification — assert the bearer token is forwarded by the
    // runtime client. A regression that strips Authorization would
    // otherwise pass the smoke silently.
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(`{"error":"missing or wrong bearer; got=${String(auth)}"}`);
      return;
    }

    if (req.method === 'GET' && req.url === '/.ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"version":"fake-sb-for-smoke"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/.runtime/lua') {
      if (body === '1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"result":1}');
        return;
      }
      // Polymorphic shape that satisfies query-config-blocks, list-pages,
      // search-pages, and read-page response contracts at runtime. The
      // empty arrays / strings produce semantically vacuous tool results
      // (no pages visible) — fine for stdout-discipline verification.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        '{"result":{"pages":[],"hits":[],"blocks":[],"content":"","lastModified":"1970-01-01T00:00:00.000Z"}}',
      );
      return;
    }
    res.writeHead(404);
    res.end();
  };

  const server: Server = http.createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // Defensive: the handler shouldn't throw, but log to stderr so a
      // surprise failure is debuggable rather than silent.
      console.error('fake-sb handler error:', err);
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        /* response already destroyed */
      }
    });
  });

  // Race the listening event against an error event so a sandbox / port
  // allocation failure surfaces as a thrown error instead of hanging
  // forever on `once(server, 'listening')`.
  const listening = once(server, 'listening');
  const erroring = once(server, 'error').then(([err]) => {
    throw err as Error;
  });
  server.listen(0);
  await Promise.race([listening, erroring]);

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake SB server did not bind to an inet address');
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Drop keep-alive sockets first; otherwise `server.close` waits for
        // them to drain and the test process holds the event loop open.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Polling helpers — wait for stderr / stdout patterns within a budget.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 50;

async function waitForStderrPattern(
  stderrChunks: Buffer[],
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const decoded = Buffer.concat(stderrChunks).toString('utf8');
    if (pattern.test(decoded)) return;
    await delay(POLL_INTERVAL_MS);
  }
  const captured = Buffer.concat(stderrChunks).toString('utf8');
  throw new Error(
    `timed out after ${String(timeoutMs)}ms waiting for stderr to match ${pattern.toString()}\n` +
      `--- captured stderr ---\n${captured}\n--- end stderr ---`,
  );
}

type JsonRpcMessage = Record<string, unknown>;

function decodeStdoutLines(stdoutChunks: readonly Buffer[]): string[] {
  return Buffer.concat(stdoutChunks)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

async function waitForJsonRpcResponse(
  stdoutChunks: Buffer[],
  id: number,
  timeoutMs: number,
): Promise<JsonRpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of decodeStdoutLines(stdoutChunks)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['id'] === id
      ) {
        return parsed as JsonRpcMessage;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  const captured = Buffer.concat(stdoutChunks).toString('utf8');
  throw new Error(
    `timed out after ${String(timeoutMs)}ms waiting for JSON-RPC response id=${String(id)}\n` +
      `--- captured stdout ---\n${captured}\n--- end stdout ---`,
  );
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null> {
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const timeout = delay(timeoutMs).then(() => 'timeout' as const);
  const result = await Promise.race([exited, timeout]);
  if (result === 'timeout') return null;
  return result[0];
}

// ---------------------------------------------------------------------------
// The smoke test.
// ---------------------------------------------------------------------------

await test('stdout discipline: every line on stdout is parseable JSON-RPC', async () => {
  // `${pid}-${Date.now()}-${randomUUID()}` is the project-wide collision-proof
  // temp-path shape — two runners spawning in the same millisecond on the
  // same host can otherwise unlink each other's audit files.
  const tempAuditPath = path.join(
    os.tmpdir(),
    `mcp-smoke-${String(process.pid)}-${String(Date.now())}-${randomUUID()}.jsonl`,
  );

  const SMOKE_TOKEN = 'SMOKE-TOKEN';
  const fakeSB = await startFakeSilverBullet(SMOKE_TOKEN);

  let child: ChildProcessWithoutNullStreams | undefined;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  try {
    child = spawn('node', ['./src/index.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SILVERBULLET_URL: fakeSB.url,
        SILVERBULLET_TOKEN: SMOKE_TOKEN,
        MCP_SILVERBULLET_AUDIT_LOG_PATH: tempAuditPath,
      },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    // Stream-level 'error' events would otherwise escalate to an
    // uncaughtException that kills the test process before assertions
    // can capture diagnostic state. Swallow them — any meaningful
    // failure surfaces via missing stderr banners or exit-code asserts.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});

    // 1. Wait for the server to reach the 'serving' state.
    await waitForStderrPattern(stderrChunks, /ready \(transport=stdio, audit=/, 5000);

    // 2. Drive the MCP protocol with valid JSON-RPC.
    const messages: readonly string[] = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_pages', arguments: {} },
      }),
    ];
    // If the child has already exited (e.g., env-var validation rejected),
    // surface that via the captured stderr instead of an opaque EPIPE.
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(
        `child exited before JSON-RPC drive (exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})\n--- stderr ---\n${Buffer.concat(stderrChunks).toString('utf8')}`,
      );
    }
    for (const msg of messages) {
      child.stdin.write(`${msg}\n`);
    }

    // 3. Await the three id-bearing responses (notifications/initialized
    //    is a notification, no response). Total budget: 5000ms.
    const responseDeadline = Date.now() + 5000;
    const responses: JsonRpcMessage[] = [];
    for (const id of [1, 2, 3]) {
      const remaining = Math.max(0, responseDeadline - Date.now());
      responses.push(await waitForJsonRpcResponse(stdoutChunks, id, remaining));
    }

    // 4. Cooperative shutdown via SIGINT.
    child.kill('SIGINT');
    const exitCode = await waitForExit(child, 2000);

    // 5. Assertions.
    assert.equal(exitCode, 0, 'child exited cleanly under SIGINT');

    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    assert.match(stderrText, /received SIGINT; flushing/, 'stderr has SIGINT banner');
    assert.match(stderrText, /shutdown complete/, 'stderr has shutdown-complete banner');

    // 6. Stdout-discipline assertion — every non-empty line is JSON-RPC.
    const lines = decodeStdoutLines(stdoutChunks);
    assert.ok(lines.length >= 1, 'at least one JSON-RPC message appeared on stdout');

    for (const [i, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        assert.fail(`stdout line ${String(i)} not parseable JSON: ${line.slice(0, 200)}`);
      }
      assert.ok(
        typeof parsed === 'object' && parsed !== null,
        `stdout line ${String(i)} not an object: ${line.slice(0, 200)}`,
      );
      const obj = parsed as Record<string, unknown>;
      assert.equal(
        obj['jsonrpc'],
        '2.0',
        `stdout line ${String(i)} missing jsonrpc=2.0: ${line.slice(0, 200)}`,
      );
      assert.ok(
        'id' in obj || 'method' in obj,
        `stdout line ${String(i)} missing id and method: ${line.slice(0, 200)}`,
      );
    }

    // Sanity: we expect at least the three responses plus possibly some
    // server-emitted notifications. Three is the floor.
    assert.ok(
      responses.length === 3,
      `expected 3 JSON-RPC responses (id=1,2,3), got ${String(responses.length)}`,
    );
  } finally {
    if (
      child !== undefined &&
      !child.killed &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      // TOCTOU: the child may exit between the predicate above and the
      // kill call; an ESRCH from a stale kill is harmless but noisy.
      try {
        child.kill('SIGKILL');
      } catch {
        /* child already exited */
      }
      // Best-effort drain so the test process doesn't hold the child's
      // file descriptors open longer than necessary.
      await Promise.race([once(child, 'exit'), delay(500)]);
    }
    await fakeSB.close().catch(() => undefined);
    await unlink(tempAuditPath).catch(() => undefined);
  }
});
