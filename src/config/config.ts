import path from 'node:path';
import { z } from 'zod';

import { logger as defaultLogger, type Logger } from '../diagnostic/logger.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { wrapConfig } from './secret-scrubber.ts';

/**
 * Validated server configuration. Construct via {@link loadConfig} (pure) or
 * {@link loadConfigOrExit} (calls `process.exit(1)` on failure). The token is
 * the live value — wrap with `wrapConfig` (called automatically by
 * `loadConfigOrExit`) before passing to any code path that may serialize.
 */
export type Config = {
  readonly silverbulletUrl: string;
  readonly silverbulletToken: string;
  readonly auditLogPath?: string;
};

export type ConfigRule =
  | 'missing'
  | 'invalid_url'
  | 'must_use_https'
  | 'must_be_non_empty'
  | 'must_be_absolute_path';

/**
 * Local error type for config-validation failures, reconciled with the
 * canonical `DomainError` shape from `src/domain/error.ts` (Story 1.6). The
 * `reason: 'config_error'` literal is one of the closed `ReasonCode` values;
 * `variable`, `rule`, and `message` live under `details` to satisfy the
 * `details: Record<string, unknown>` requirement structurally — making
 * `Result<Config, ConfigError>` compile against `Result<T, E extends
 * DomainError>` (`src/domain/result.ts:13-15`).
 *
 * The shape carries enough detail to render the AR39 FATAL+hint format
 * without ever including the user-supplied env value — that's how token
 * hygiene is enforced structurally (NFR5 / AR37).
 */
export type ConfigError = {
  readonly reason: 'config_error';
  readonly details: {
    readonly variable:
      | 'SILVERBULLET_URL'
      | 'SILVERBULLET_TOKEN'
      | 'MCP_SILVERBULLET_AUDIT_LOG_PATH';
    readonly rule: ConfigRule;
    readonly message: string;
  };
};

export type LoadConfigResult = Result<Config, ConfigError>;

function isHttpsOrLocalhost(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
}

const ConfigSchema = z.object({
  silverbulletUrl: z.url('SILVERBULLET_URL must be a valid URL').refine(isHttpsOrLocalhost, {
    message: 'SILVERBULLET_URL must use https:// (localhost/127.0.0.1 exempt)',
  }),
  silverbulletToken: z.string().min(1, 'SILVERBULLET_TOKEN must be non-empty'),
  auditLogPath: z
    .string()
    .refine((s) => path.isAbsolute(s), 'MCP_SILVERBULLET_AUDIT_LOG_PATH must be an absolute path')
    .optional(),
});

const ENV_KEYS = {
  silverbulletUrl: 'SILVERBULLET_URL',
  silverbulletToken: 'SILVERBULLET_TOKEN',
  auditLogPath: 'MCP_SILVERBULLET_AUDIT_LOG_PATH',
} as const;

type FieldKey = keyof typeof ENV_KEYS;

function readField(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function toFieldKey(pathSegment: PropertyKey | undefined): FieldKey {
  return pathSegment === 'silverbulletToken' || pathSegment === 'auditLogPath'
    ? pathSegment
    : 'silverbulletUrl';
}

function makeConfigError(
  variable: ConfigError['details']['variable'],
  rule: ConfigRule,
  message: string,
): ConfigError {
  return { reason: 'config_error', details: { variable, rule, message } };
}

function issueToConfigError(issue: z.core.$ZodIssue): ConfigError {
  const fieldKey = toFieldKey(issue.path[0]);
  const variable = ENV_KEYS[fieldKey];

  if (issue.code === 'invalid_type') {
    return makeConfigError(variable, 'missing', `${variable} is required`);
  }
  if (issue.code === 'too_small' && fieldKey === 'silverbulletToken') {
    return makeConfigError(variable, 'must_be_non_empty', `${variable} must be non-empty`);
  }
  if (issue.code === 'invalid_format' && fieldKey === 'silverbulletUrl') {
    return makeConfigError(variable, 'invalid_url', `${variable} must be a valid URL`);
  }
  if (issue.code === 'custom') {
    if (fieldKey === 'silverbulletUrl') {
      return makeConfigError(variable, 'must_use_https', `${variable} must use https://`);
    }
    if (fieldKey === 'auditLogPath') {
      return makeConfigError(
        variable,
        'must_be_absolute_path',
        `${variable} must be an absolute path`,
      );
    }
  }
  return makeConfigError(variable, 'missing', `${variable} is invalid`);
}

function pickPrimaryIssue(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue | undefined {
  // For the same field, `invalid_format` (URL syntax) outranks `custom`
  // (refine) — when a URL fails to parse, the syntax message is more useful
  // than the downstream scheme-rule fallout. Otherwise the first issue per
  // field is taken in zod-emission order.
  const byPath = new Map<string, z.core.$ZodIssue>();
  for (const issue of issues) {
    const key = issue.path.join('.');
    const existing = byPath.get(key);
    if (existing === undefined) {
      byPath.set(key, issue);
      continue;
    }
    if (existing.code === 'custom' && issue.code === 'invalid_format') {
      byPath.set(key, issue);
    }
  }
  // Stable order: SILVERBULLET_URL → SILVERBULLET_TOKEN → audit-path.
  const ordered: FieldKey[] = ['silverbulletUrl', 'silverbulletToken', 'auditLogPath'];
  for (const fieldKey of ordered) {
    const candidate = byPath.get(fieldKey);
    if (candidate !== undefined) return candidate;
  }
  return issues[0];
}

/**
 * Pure function: env → {@link LoadConfigResult}. No I/O, no `process.exit`,
 * no stderr writes. Empty-string env values are coerced to `undefined`
 * before zod sees them, so missing-key and empty-string both resolve to the
 * `missing` rule with the same downstream message.
 *
 * On failure, the returned `ConfigError` deliberately omits the input value
 * for `SILVERBULLET_TOKEN` issues (NFR5 / AR37): only the variable name and
 * the rule are recorded.
 */
export function loadConfig(env: Record<string, string | undefined>): LoadConfigResult {
  const input = {
    silverbulletUrl: readField(env, ENV_KEYS.silverbulletUrl),
    silverbulletToken: readField(env, ENV_KEYS.silverbulletToken),
    auditLogPath: readField(env, ENV_KEYS.auditLogPath),
  };
  const parsed = ConfigSchema.safeParse(input);
  if (parsed.success) {
    const value: Config =
      parsed.data.auditLogPath !== undefined
        ? {
            silverbulletUrl: parsed.data.silverbulletUrl,
            silverbulletToken: parsed.data.silverbulletToken,
            auditLogPath: parsed.data.auditLogPath,
          }
        : {
            silverbulletUrl: parsed.data.silverbulletUrl,
            silverbulletToken: parsed.data.silverbulletToken,
          };
    return ok(value);
  }
  const issue = pickPrimaryIssue(parsed.error.issues);
  if (issue === undefined) {
    // Defensive: zod's safeParse always emits at least one issue on
    // failure. Surface a generic config_error if that invariant is ever
    // violated rather than throwing.
    const fallback = makeConfigError('SILVERBULLET_URL', 'missing', 'configuration is invalid');
    return err(fallback);
  }
  return err(issueToConfigError(issue));
}

/**
 * Pure: {@link ConfigError} → `{ fatal, hint }` per AR39
 * (`architecture.md:512-521`). Single-line FATAL summary plus a single-line
 * hint, both prefixed `[mcp-silverbullet]`. Neither line ends in `\n` —
 * the diagnostic logger appends one when it writes.
 */
export function formatConfigError(err: ConfigError): { fatal: string; hint: string } {
  const README_HINT =
    '[mcp-silverbullet] hint: see the project README — Configuration / Environment variables';
  const { variable, rule } = err.details;
  switch (rule) {
    case 'missing':
      return {
        fatal: `[mcp-silverbullet] FATAL: ${variable} is required`,
        hint: README_HINT,
      };
    case 'invalid_url':
      return {
        fatal: `[mcp-silverbullet] FATAL: ${variable} must be a valid URL`,
        hint: `[mcp-silverbullet] hint: ${variable} must parse as an absolute URL (e.g. https://notes.example.com)`,
      };
    case 'must_use_https':
      return {
        fatal: `[mcp-silverbullet] FATAL: ${variable} must use https:// (localhost/127.0.0.1 exempt)`,
        hint: '[mcp-silverbullet] hint: NFR7 requires https:// for non-local SilverBullet endpoints',
      };
    case 'must_be_non_empty':
      return {
        fatal: `[mcp-silverbullet] FATAL: ${variable} must be non-empty`,
        hint: README_HINT,
      };
    case 'must_be_absolute_path':
      return {
        fatal: `[mcp-silverbullet] FATAL: ${variable} must be an absolute path`,
        hint: `[mcp-silverbullet] hint: ${variable} must be an absolute filesystem path (e.g. /var/log/mcp-silverbullet/audit.jsonl)`,
      };
  }
}

type ExitFn = (code?: number | string | null) => never;

/**
 * Production startup wrapper. Used by the story-1.11 startup ladder.
 *
 * - On success: returns the {@link wrapConfig}-wrapped `Config` ready for
 *   downstream use. The wrapper masks the token in `JSON.stringify`,
 *   `toString`, and `util.inspect` so accidental serialization can't leak
 *   the bearer (AR40 / NFR5).
 * - On failure: emits the AR39 FATAL line and the one-line hint via the
 *   diagnostic logger (the only sanctioned stderr writer per AR48), then
 *   calls `exitFn(1)`. The function never returns from the failure branch.
 *
 * `logger` and `exitFn` default to the production diagnostic logger and
 * `process.exit`; both are injected for unit testing.
 */
// `process.exit` rebound to keep its `this`-binding when invoked through the
// `exitFn` parameter; the unbound `process.exit` reference would lose the
// internal Node binding and trip `@typescript-eslint/unbound-method`.
const productionExit: ExitFn = (code) => process.exit(code);

export function loadConfigOrExit(
  env: Record<string, string | undefined>,
  logger: Logger = defaultLogger,
  exitFn: ExitFn = productionExit,
): Config {
  const result = loadConfig(env);
  if (result.kind === 'ok') return wrapConfig(result.value);
  const { fatal, hint } = formatConfigError(result.error);
  logger.error(fatal);
  logger.error(hint);
  return exitFn(1);
}
