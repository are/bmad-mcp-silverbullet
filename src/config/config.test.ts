import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConfig,
  formatConfigError,
  loadConfigOrExit,
  type Config,
  type ConfigError,
} from './config.ts';
import type { Logger } from '../diagnostic/logger.ts';

const LEAKY_TOKEN = 'leaky-secret-1234';

type Env = Record<string, string | undefined>;

function envOf(overrides: Env = {}): Env {
  return {
    SILVERBULLET_URL: 'https://example.com',
    SILVERBULLET_TOKEN: 'tok',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadConfig — happy path
// ---------------------------------------------------------------------------

await test('loadConfig: happy path with https URL and non-empty token', () => {
  const result = loadConfig(envOf());
  assert.strictEqual(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.deepStrictEqual(result.value, {
      silverbulletUrl: 'https://example.com',
      silverbulletToken: 'tok',
    } satisfies Config);
  }
});

await test('loadConfig: localhost http allowed (NFR7 exemption, hostname=localhost)', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: 'http://localhost:3000' }));
  assert.strictEqual(result.kind, 'ok');
});

await test('loadConfig: 127.0.0.1 http allowed (NFR7 exemption)', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: 'http://127.0.0.1:3000' }));
  assert.strictEqual(result.kind, 'ok');
});

await test('loadConfig: https on localhost still passes', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: 'https://localhost' }));
  assert.strictEqual(result.kind, 'ok');
});

await test('loadConfig: valid absolute audit log path accepted', () => {
  const result = loadConfig(envOf({ MCP_SILVERBULLET_AUDIT_LOG_PATH: '/var/log/x/audit.jsonl' }));
  assert.strictEqual(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.strictEqual(result.value.auditLogPath, '/var/log/x/audit.jsonl');
  }
});

await test('loadConfig: empty MCP_SILVERBULLET_AUDIT_LOG_PATH treated as unset', () => {
  const result = loadConfig(envOf({ MCP_SILVERBULLET_AUDIT_LOG_PATH: '' }));
  assert.strictEqual(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.strictEqual(result.value.auditLogPath, undefined);
  }
});

// ---------------------------------------------------------------------------
// loadConfig — failure paths
// ---------------------------------------------------------------------------

await test('loadConfig: non-localhost http rejected with must_use_https rule', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: 'http://example.com' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_URL');
    assert.strictEqual(result.error.details.rule, 'must_use_https');
  }
});

await test('loadConfig: missing SILVERBULLET_URL → missing rule', () => {
  const env: Env = { SILVERBULLET_TOKEN: 'tok' };
  const result = loadConfig(env);
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_URL');
    assert.strictEqual(result.error.details.rule, 'missing');
  }
});

await test('loadConfig: empty SILVERBULLET_URL treated as missing', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: '' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_URL');
    assert.strictEqual(result.error.details.rule, 'missing');
  }
});

await test('loadConfig: missing SILVERBULLET_TOKEN → missing rule', () => {
  const env: Env = { SILVERBULLET_URL: 'https://example.com' };
  const result = loadConfig(env);
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_TOKEN');
    assert.strictEqual(result.error.details.rule, 'missing');
  }
});

await test('loadConfig: empty SILVERBULLET_TOKEN treated as missing', () => {
  const result = loadConfig(envOf({ SILVERBULLET_TOKEN: '' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_TOKEN');
    assert.strictEqual(result.error.details.rule, 'missing');
  }
});

await test('loadConfig: malformed URL "not-a-url" → invalid_url rule', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: 'not-a-url' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_URL');
    assert.strictEqual(result.error.details.rule, 'invalid_url');
  }
});

await test('loadConfig: malformed URL "://broken" → invalid_url rule', () => {
  const result = loadConfig(envOf({ SILVERBULLET_URL: '://broken' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'SILVERBULLET_URL');
    assert.strictEqual(result.error.details.rule, 'invalid_url');
  }
});

await test('loadConfig: relative audit log path rejected', () => {
  const result = loadConfig(envOf({ MCP_SILVERBULLET_AUDIT_LOG_PATH: './audit.jsonl' }));
  assert.strictEqual(result.kind, 'error');
  if (result.kind === 'error') {
    assert.strictEqual(result.error.details.variable, 'MCP_SILVERBULLET_AUDIT_LOG_PATH');
    assert.strictEqual(result.error.details.rule, 'must_be_absolute_path');
  }
});

// ---------------------------------------------------------------------------
// loadConfig — token-leak guards (AC2: token never echoed, even by zod)
// ---------------------------------------------------------------------------

await test('Token-leak guard: invalid URL with leaky token does NOT echo the token', () => {
  const result = loadConfig({
    SILVERBULLET_URL: 'http://example.com',
    SILVERBULLET_TOKEN: LEAKY_TOKEN,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(LEAKY_TOKEN), `token leaked: ${serialized}`);
});

await test('Token-leak guard: missing SILVERBULLET_URL with leaky token does NOT echo', () => {
  const result = loadConfig({ SILVERBULLET_TOKEN: LEAKY_TOKEN });
  assert.ok(!JSON.stringify(result).includes(LEAKY_TOKEN));
});

await test('Token-leak guard: malformed URL with leaky token does NOT echo', () => {
  const result = loadConfig({
    SILVERBULLET_URL: 'not-a-url',
    SILVERBULLET_TOKEN: LEAKY_TOKEN,
  });
  assert.ok(!JSON.stringify(result).includes(LEAKY_TOKEN));
});

await test('Token-leak guard: relative audit path with leaky token does NOT echo', () => {
  const result = loadConfig({
    SILVERBULLET_URL: 'https://example.com',
    SILVERBULLET_TOKEN: LEAKY_TOKEN,
    MCP_SILVERBULLET_AUDIT_LOG_PATH: './x',
  });
  assert.ok(!JSON.stringify(result).includes(LEAKY_TOKEN));
});

// ---------------------------------------------------------------------------
// formatConfigError — exact-string fixtures per AC3
// (both fatal AND hint asserted byte-for-byte; no value substitution, no
// template variables — drift in either line is caught by these tests)
// ---------------------------------------------------------------------------

const README_HINT =
  '[mcp-silverbullet] hint: see the project README — Configuration / Environment variables';

await test('formatConfigError: missing SILVERBULLET_URL', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_URL',
      rule: 'missing',
      message: 'SILVERBULLET_URL is required',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(fatal, '[mcp-silverbullet] FATAL: SILVERBULLET_URL is required');
  assert.strictEqual(hint, README_HINT);
  assert.ok(!fatal.endsWith('\n'));
  assert.ok(!hint.endsWith('\n'));
});

await test('formatConfigError: missing SILVERBULLET_TOKEN', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_TOKEN',
      rule: 'missing',
      message: 'SILVERBULLET_TOKEN is required',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(fatal, '[mcp-silverbullet] FATAL: SILVERBULLET_TOKEN is required');
  assert.strictEqual(hint, README_HINT);
});

await test('formatConfigError: invalid URL syntax', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_URL',
      rule: 'invalid_url',
      message: 'SILVERBULLET_URL must be a valid URL',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(fatal, '[mcp-silverbullet] FATAL: SILVERBULLET_URL must be a valid URL');
  assert.strictEqual(
    hint,
    '[mcp-silverbullet] hint: SILVERBULLET_URL must parse as an absolute URL (e.g. https://notes.example.com)',
  );
});

await test('formatConfigError: must_use_https mentions localhost exemption', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_URL',
      rule: 'must_use_https',
      message: 'SILVERBULLET_URL must use https://',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(
    fatal,
    '[mcp-silverbullet] FATAL: SILVERBULLET_URL must use https:// (localhost/127.0.0.1 exempt)',
  );
  assert.strictEqual(
    hint,
    '[mcp-silverbullet] hint: NFR7 requires https:// for non-local SilverBullet endpoints',
  );
});

await test('formatConfigError: must_be_non_empty token', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'SILVERBULLET_TOKEN',
      rule: 'must_be_non_empty',
      message: 'SILVERBULLET_TOKEN must be non-empty',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(fatal, '[mcp-silverbullet] FATAL: SILVERBULLET_TOKEN must be non-empty');
  assert.strictEqual(hint, README_HINT);
});

await test('formatConfigError: must_be_absolute_path audit log', () => {
  const err: ConfigError = {
    reason: 'config_error',
    details: {
      variable: 'MCP_SILVERBULLET_AUDIT_LOG_PATH',
      rule: 'must_be_absolute_path',
      message: 'MCP_SILVERBULLET_AUDIT_LOG_PATH must be an absolute path',
    },
  };
  const { fatal, hint } = formatConfigError(err);
  assert.strictEqual(
    fatal,
    '[mcp-silverbullet] FATAL: MCP_SILVERBULLET_AUDIT_LOG_PATH must be an absolute path',
  );
  assert.strictEqual(
    hint,
    '[mcp-silverbullet] hint: MCP_SILVERBULLET_AUDIT_LOG_PATH must be an absolute filesystem path (e.g. /var/log/mcp-silverbullet/audit.jsonl)',
  );
});

// ---------------------------------------------------------------------------
// loadConfigOrExit — DI seam tests (AC5, AC7)
// ---------------------------------------------------------------------------

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit(${String(code)})`);
    this.code = code;
  }
}

function makeFakeLogger(): { logger: Logger; errors: Array<[string, unknown]> } {
  const errors: Array<[string, unknown]> = [];
  const logger: Logger = {
    info() {
      throw new Error('fake logger: info() should not be called');
    },
    warn() {
      throw new Error('fake logger: warn() should not be called');
    },
    error(message, err) {
      errors.push([message, err]);
    },
  };
  return { logger, errors };
}

const fakeExit = (code?: number | string | null): never => {
  throw new ExitCalled(typeof code === 'number' ? code : 0);
};

await test('loadConfigOrExit: success returns wrapped config; logger and exit untouched', () => {
  const { logger, errors } = makeFakeLogger();
  const cfg = loadConfigOrExit(envOf({ SILVERBULLET_TOKEN: LEAKY_TOKEN }), logger, fakeExit);
  assert.strictEqual(cfg.silverbulletUrl, 'https://example.com');
  assert.strictEqual(cfg.silverbulletToken, LEAKY_TOKEN);
  assert.strictEqual(errors.length, 0);
  // Wrapped: JSON.stringify masks the token via toJSON. Discriminating
  // assertion — the live token must NOT appear and the masked marker must.
  const json = JSON.stringify(cfg);
  assert.ok(!json.includes(LEAKY_TOKEN), `live token leaked: ${json}`);
  const parsed = JSON.parse(json) as Record<string, string>;
  assert.strictEqual(parsed.silverbulletToken, '***redacted***');
});

await test('loadConfigOrExit: failure emits FATAL + hint via logger.error and exits 1', () => {
  const { logger, errors } = makeFakeLogger();
  assert.throws(
    () => loadConfigOrExit(envOf({ SILVERBULLET_URL: 'http://example.com' }), logger, fakeExit),
    (err: unknown) => err instanceof ExitCalled && err.code === 1,
  );
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0]![0], /^\[mcp-silverbullet\] FATAL: SILVERBULLET_URL must use https:\/\//);
  assert.match(errors[1]![0], /^\[mcp-silverbullet\] hint:/);
});

await test('loadConfigOrExit: failure path with leaky token does NOT echo the token in any logger call', () => {
  const { logger, errors } = makeFakeLogger();
  assert.throws(
    () =>
      loadConfigOrExit(
        { SILVERBULLET_URL: 'http://example.com', SILVERBULLET_TOKEN: LEAKY_TOKEN },
        logger,
        fakeExit,
      ),
    (err: unknown) => err instanceof ExitCalled,
  );
  for (const [message, attached] of errors) {
    assert.ok(!message.includes(LEAKY_TOKEN), `token in message: ${message}`);
    assert.strictEqual(attached, undefined, 'logger.error should be called single-arg form');
  }
});

await test('loadConfigOrExit: default-args wiring — single-arg call succeeds with valid env (no fakes)', () => {
  // No injected logger / exit. Production defaults wire to the diagnostic
  // logger (stderr) and process.exit. With a valid env neither default is
  // actually invoked, so this test exercises only that the default
  // parameters exist and the function is callable with a single argument.
  const cfg = loadConfigOrExit(envOf());
  assert.strictEqual(cfg.silverbulletUrl, 'https://example.com');
  assert.strictEqual(cfg.silverbulletToken, 'tok');
});
