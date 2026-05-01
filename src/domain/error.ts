import type { Ref } from './ref.ts';

/**
 * Closed vocabulary for rejection categories. Six values, locked at this
 * set. Adding or removing a value REQUIRES bumping `AUDIT_SCHEMA_VERSION`
 * in `src/audit/schema.ts` per NFR16 (`epics.md:94`) / AR42
 * (`architecture.md:640`). The same value lands verbatim in the audit
 * log's `reason` field (D4 / `architecture.md:386-468`) and is emitted by
 * {@link serializeForAudit}.
 *
 * Order matches D6 (`architecture.md:548-555`) for stable presentation in
 * documentation, tests, and the {@link REASON_CODES} runtime tuple.
 */
export type ReasonCode =
  | 'permission_denied'
  | 'freshness_violation'
  | 'validation_error'
  | 'infrastructure_error'
  | 'config_error'
  | 'not_found';

/**
 * Runtime-iterable lock-in of {@link ReasonCode}. Tests assert exhaustive
 * coverage (one fixture per value) and the documented ordering. Adding a
 * value here requires the audit-schema-bump discipline above.
 */
export const REASON_CODES = [
  'permission_denied',
  'freshness_violation',
  'validation_error',
  'infrastructure_error',
  'config_error',
  'not_found',
] as const satisfies ReadonlyArray<ReasonCode>;

/**
 * Canonical domain-error shape per D6 (`architecture.md:537-555`). Single
 * source of truth, two projections:
 *
 * - {@link formatToolError} renders an LLM-readable text block with
 *   `isError: true` for the MCP transport (AR43 / `architecture.md:560`).
 * - {@link serializeForAudit} projects to the audit log's `reason` +
 *   `details` (+ `failedOperation`) fields (D4).
 *
 * Code-review rule (AR42 / `architecture.md:640`): adding a `ReasonCode`
 * value or changing a per-reason `details` shape REQUIRES updating both
 * projections AND bumping `AUDIT_SCHEMA_VERSION` (NFR16). Single PR;
 * never one projection in isolation.
 *
 * `ref` is optional and present for permission / freshness / validation /
 * not_found errors that name a page; `infrastructure_error` may omit it.
 * `failedOperation` is present only for batch errors per AR46
 * (`epics.md:165`), with the locked shape `{ index, operation }`.
 * `details` is required and carries reason-specific structured context
 * already scrubbed of sensitive fields by the per-reason constructors
 * (AR45 / `architecture.md:633`).
 */
export type DomainError = {
  readonly reason: ReasonCode;
  readonly ref?: Ref;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failedOperation?: {
    readonly index: number;
    readonly operation: object;
  };
};

/**
 * Local stand-in for the MCP SDK's `CallToolResult` shape. Story 1.10 /
 * 1.11 will wire `@modelcontextprotocol/sdk`; this stub is structurally a
 * subset of the SDK type so a future `satisfies CallToolResult` upgrade is
 * mechanical. AR43 / `architecture.md:560` mandates the single text block
 * via `content` (NOT `_meta`) so the LLM sees recovery instructions.
 */
export type MCPToolResult = {
  readonly isError: true;
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
};

/**
 * Audit-side projection of {@link DomainError}. Spreads cleanly into the
 * audit logger's `AuditEntryInput` (`src/audit/schema.ts:70`).
 *
 * Example handler usage (Story 1.10 territory):
 * ```ts
 * ctx.audit.write({
 *   tool: 'edit_page',
 *   args: input,
 *   decision: 'rejected',
 *   ...serializeForAudit(error),
 *   response: undefined,
 *   durationMs: ctx.clock.now() - startedAt,
 * });
 * ```
 *
 * `ref` is deliberately NOT projected — handlers log the ref via `args`
 * (AR31 / `epics.md:146`); the audit schema's published surface is
 * `reason` + `details` + `failedOperation` only.
 */
export type AuditErrorProjection = {
  readonly reason: ReasonCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failedOperation?: { readonly index: number; readonly operation: object };
};

// Secret scrubbing -----------------------------------------------------------

const REDACTED = '***redacted***';

const SCRUB_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'token',
  'apikey',
  'secret',
  'password',
]);

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function scrub(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'function') return Object.prototype.toString.call(value);
  if (typeof value !== 'object') return value;

  // Cycle protection uses enter/exit semantics — `seen` tracks the
  // currently-descending stack only. A DAG (same object referenced from
  // two different keys) is NOT a cycle and must scrub correctly both
  // times; the `finally` block below pops the entry so the second visit
  // recurses normally instead of collapsing to '<cycle>'.
  if (seen.has(value)) return '<cycle>';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => scrub(item, seen));
    }

    if (value instanceof Error) {
      // AR45 #4 (`architecture.md:636`): never include the stack. Returning
      // only `err.message` collapses Error → string before any serializer
      // sees it.
      return value.message;
    }

    if (value instanceof Date) {
      // Invalid Date (NaN epoch) would crash `toISOString()` with a
      // RangeError mid-scrub, propagating out of the catch block that
      // built the DomainError. Substitute a sentinel instead.
      if (Number.isNaN(value.getTime())) return '<invalid-date>';
      return value.toISOString();
    }

    if (!isPlainObject(value)) {
      // Class instances (Map, Set, Buffer, etc.) collapse to a safe sentinel
      // — `Object.prototype.toString.call(value)` returns `'[object Map]'`
      // / `'[object Uint8Array]'` etc., never a token-bearing payload.
      return Object.prototype.toString.call(value);
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const replacement = SCRUB_KEYS.has(key.toLowerCase()) ? REDACTED : scrub(val, seen);
      // `Object.defineProperty` bypasses the inherited `__proto__` setter
      // — assigning via `out[key] = ...` for a key of `'__proto__'` (own
      // enumerable on the input, e.g. from `JSON.parse('{"__proto__":...}')`)
      // would reassign `out`'s prototype. defineProperty creates a real
      // own data property called `'__proto__'` instead, preventing the
      // pollution while preserving the field's data and JSON round-trip.
      Object.defineProperty(out, key, {
        value: replacement,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Recursively walk a value and replace fields whose key (case-insensitive
 * ASCII) matches the closed set `{ authorization, token, apiKey, secret,
 * password }` with the literal `'***redacted***'`. Returns a NEW value;
 * never mutates the input (AR58 pure-domain).
 *
 * Behavioural rules:
 *
 * - Plain objects / arrays → recurse.
 * - `Error` instances → returned as their `.message` string. The stack is
 *   NEVER preserved (AR45 #4 / `architecture.md:636`).
 * - `Date` instances → returned as `toISOString()` for audit-shape
 *   consistency.
 * - Other class instances (`Map`, `Set`, `Buffer`, etc.) → collapsed to
 *   `Object.prototype.toString.call(value)` (e.g. `'[object Map]'`) — a
 *   safe sentinel that cannot leak per-instance content.
 * - Primitives (`string`, `number`, `boolean`, `bigint`, `symbol`) →
 *   pass-through. **Structural-only:** a token embedded inside a string
 *   (`'auth failed: token=SECRET'`) is NOT scrubbed. AR45 #1
 *   (`architecture.md:633`) defines the contract narrowly as fields named
 *   `token` / `apiKey` / `secret` / `password`. Content-scanning is a
 *   deferred-work item.
 * - `null` / `undefined` → returned as-is.
 * - Cycles → replaced by the literal string `'<cycle>'`. The `WeakSet`
 *   tracker is freshly allocated per top-level call.
 *
 * Limitation (deferred-work): header arrays of the shape
 * `[{ name: 'authorization', value: '...' }]` are not scrubbed — the
 * closed-list match is on field NAMES, not field VALUES.
 */
export function scrubSecrets(value: unknown): unknown {
  return scrub(value, new WeakSet());
}

// Per-reason constructors ----------------------------------------------------

/**
 * Construct a `permission_denied` {@link DomainError} (AR45 #3
 * compliant — exposes only the resolved access modes). `required` /
 * `granted` are typed `string` for forward-compatibility with Story 1.8's
 * `AccessMode` union (`architecture.md:1023`); the union is owned by
 * `permissions/access-mode.ts` once that file lands.
 */
export function permissionDeniedError(ref: Ref, required: string, granted: string): DomainError {
  return {
    reason: 'permission_denied',
    ref,
    details: { required, granted },
  };
}

/**
 * Construct a `freshness_violation` {@link DomainError}. `lastReadAt` is
 * coerced from `Date | undefined` → ISO string | `null` so the audit
 * projection stays explicit; the renderer prints `Last read by you:
 * never` when the value is `null`.
 */
export function freshnessViolationError(
  ref: Ref,
  lastModified: Date,
  lastReadAt: Date | undefined,
): DomainError {
  return {
    reason: 'freshness_violation',
    ref,
    details: {
      lastModified: lastModified.toISOString(),
      lastReadAt: lastReadAt !== undefined ? lastReadAt.toISOString() : null,
    },
  };
}

/**
 * Inputs for {@link validationError}. `failedOperation` is supplied for
 * batch failures (AR46 / `epics.md:165`); the optional `total` is stamped
 * into `details.totalEdits` so the formatter can render `operation N of
 * M failed.` when known.
 */
export type ValidationErrorOptions = {
  readonly ref?: Ref;
  readonly failure: string;
  readonly failedOperation?: {
    readonly index: number;
    readonly operation: object;
    readonly total?: number;
  };
};

/**
 * Construct a `validation_error` {@link DomainError}. Non-batch errors
 * supply only `failure`; batch errors additionally supply
 * `failedOperation`. The DomainError's locked shape pins `failedOperation`
 * to `{ index, operation }` (`architecture.md:542-545`); the optional
 * `total` lives under `details.totalEdits` instead.
 */
export function validationError(opts: ValidationErrorOptions): DomainError {
  const details: Record<string, unknown> = { failure: opts.failure };
  if (opts.failedOperation?.total !== undefined) {
    details.totalEdits = opts.failedOperation.total;
  }

  const failedOperation =
    opts.failedOperation !== undefined
      ? { index: opts.failedOperation.index, operation: opts.failedOperation.operation }
      : undefined;

  return {
    reason: 'validation_error',
    details,
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    ...(failedOperation !== undefined ? { failedOperation } : {}),
  };
}

function extractCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  if (!('code' in err)) return undefined;
  const code = err.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Construct an `infrastructure_error` {@link DomainError} from a caught
 * exception (typically the handler's top-level `catch`). Runs
 * {@link scrubSecrets} over the entire `err` value before stamping into
 * `details.underlying`, so headers like `Authorization: Bearer …`,
 * `token`, `apiKey`, `secret`, and `password` fields can never reach the
 * agent-facing projection (AR45 #1).
 *
 * **Stack traces are NEVER captured here** (AR45 #4) — `scrubSecrets`
 * collapses `Error` to `err.message`. Operators see the full stack via
 * the diagnostic logger from the handler's `catch` block (Story 1.10
 * territory).
 *
 * NodeJS errno `code` (e.g. `'ECONNREFUSED'`) is promoted to
 * `details.code` when present — useful for both audit forensics and
 * agent-side retry semantics.
 */
export function infrastructureError(err: unknown, ref?: Ref): DomainError {
  const underlying = scrubSecrets(err);
  const details: Record<string, unknown> = { underlying };
  const code = extractCode(err);
  if (code !== undefined) details.code = code;

  return {
    reason: 'infrastructure_error',
    details,
    ...(ref !== undefined ? { ref } : {}),
  };
}

/**
 * Construct a `config_error` {@link DomainError}. Used by Story 1.4's
 * `loadConfig` boundary (`src/config/config.ts`) and by future
 * permission-block parser failures (Story 1.8, AR17 / `epics.md:126`).
 */
export function configError(opts: {
  readonly variable: string;
  readonly rule: string;
  readonly message: string;
}): DomainError {
  return {
    reason: 'config_error',
    details: { variable: opts.variable, rule: opts.rule, message: opts.message },
  };
}

/**
 * Construct a `not_found` {@link DomainError}. `details` is empty by
 * design (AR45 #2 / `architecture.md:634`) — `not_found` carries no body
 * to leak. Per FR13 (`epics.md:42`) the wording is deliberately ambiguous
 * between "page doesn't exist" and "page is `none`-mode" so `none` pages
 * stay invisible.
 */
export function notFoundError(ref: Ref): DomainError {
  return {
    reason: 'not_found',
    ref,
    details: {},
  };
}

// Audit-side projection ------------------------------------------------------

/**
 * Project a {@link DomainError} into the audit log's `reason` + `details`
 * (+ optional `failedOperation`) shape. `ref` is intentionally absent —
 * handlers record the ref via `args`. Spreads cleanly into
 * `AuditEntryInput` (`src/audit/schema.ts:70`).
 */
export function serializeForAudit(error: DomainError): AuditErrorProjection {
  return {
    reason: error.reason,
    details: error.details,
    ...(error.failedOperation !== undefined ? { failedOperation: error.failedOperation } : {}),
  };
}

// MCP-text projection --------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function summarizeOperation(op: object): string {
  const scrubbed = scrubSecrets(op);
  if (scrubbed === null || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) {
    return typeof scrubbed === 'string' ? scrubbed : JSON.stringify(scrubbed);
  }

  const entries = Object.entries(scrubbed);
  let typeName = '';
  const fields: string[] = [];
  for (const [key, value] of entries) {
    if (key === 'type' && typeof value === 'string') {
      typeName = value;
      continue;
    }
    let rendered: string;
    if (typeof value === 'string' && value.length > 80) {
      rendered = JSON.stringify(`${value.slice(0, 79)}…`);
    } else {
      rendered = JSON.stringify(value) ?? 'undefined';
    }
    fields.push(`${key}: ${rendered}`);
  }

  const body = fields.length > 0 ? ` { ${fields.join(', ')} }` : '';
  if (typeName !== '') {
    return body !== '' ? `${typeName}${body}` : typeName;
  }
  return body !== '' ? body.trim() : '{}';
}

function assertExhaustive(value: never): never {
  // Defensive sink: only fires if a runtime `as`-cast or JSON-parse
  // smuggled an out-of-domain `reason` past the type system. Surface
  // clearly rather than silently fall through.
  throw new Error(`Unreachable: unexpected reason ${JSON.stringify(value)}`);
}

function renderText(error: DomainError): string {
  const ref = error.ref;

  switch (error.reason) {
    case 'permission_denied': {
      const required = asString(error.details.required, 'unknown');
      const granted = asString(error.details.granted, 'unknown');
      return [
        'Operation rejected — permission denied.',
        '',
        `Page: ${ref ?? 'unknown'}`,
        `Required: ${required}`,
        `Granted: ${granted}`,
        '',
        'To recover: this page is not accessible to you. Choose a different page or ask the user to update its access mode.',
      ].join('\n');
    }

    case 'freshness_violation': {
      const lastModified = asString(error.details.lastModified, 'unknown');
      const lastReadAtRaw = error.details.lastReadAt;
      const lastReadAt = lastReadAtRaw === null ? 'never' : asString(lastReadAtRaw, 'unknown');
      const refStr = ref ?? 'unknown';
      return [
        'Edit rejected — page has changed since last read.',
        '',
        `Page: ${refStr}`,
        `Last modified: ${lastModified}`,
        `Last read by you: ${lastReadAt}`,
        '',
        `To recover: call read_page("${refStr}") to refresh, then retry your edit with the updated content in mind.`,
      ].join('\n');
    }

    case 'validation_error': {
      const failure = asString(error.details.failure, 'invalid input');
      const failedOp = error.failedOperation;

      if (failedOp === undefined) {
        const lines: string[] = ['Operation rejected — input validation failed.', ''];
        if (ref !== undefined) lines.push(`Page: ${ref}`);
        lines.push(`Failure: ${failure}`);
        lines.push(
          '',
          "To recover: verify your input matches the tool's argument schema, then retry.",
        );
        return lines.join('\n');
      }

      const ordinal = failedOp.index + 1;
      const total = asNumber(error.details.totalEdits);
      const ordinalText = total !== undefined ? `${ordinal} of ${total}` : `${ordinal}`;
      const opSummary = summarizeOperation(failedOp.operation);

      const lines: string[] = [`Edit batch rejected — operation ${ordinalText} failed.`, ''];
      if (ref !== undefined) lines.push(`Page: ${ref}`);
      lines.push(`Failed operation: ${opSummary}`);
      lines.push(`Failure: ${failure}`);
      // Without a concrete ref, naming a literal like `read_page("the page")`
      // would mislead the agent into fetching a page named "the page". Drop
      // the example call when no ref is in scope.
      const recoveryLine =
        ref !== undefined
          ? `To recover: call read_page("${ref}") to verify current content, then submit a corrected batch. No partial changes were applied.`
          : 'To recover: re-read the affected page with read_page to verify its current content, then submit a corrected batch. No partial changes were applied.';
      lines.push('', recoveryLine);
      return lines.join('\n');
    }

    case 'infrastructure_error': {
      const underlying = error.details.underlying;
      const underlyingStr =
        typeof underlying === 'string' ? underlying : (JSON.stringify(underlying) ?? 'undefined');
      return [
        'Operation could not be completed — SilverBullet unreachable.',
        '',
        `Underlying error: ${underlyingStr}`,
        '',
        'To recover: this is a transient infrastructure issue. Retry shortly. If the problem persists, the user should check that their SilverBullet instance is running.',
      ].join('\n');
    }

    case 'config_error': {
      const variable = asString(error.details.variable, 'unknown');
      const rule = asString(error.details.rule, 'unknown');
      const message = asString(error.details.message, '');
      return [
        'Operation rejected — server configuration is malformed.',
        '',
        `Variable: ${variable}`,
        `Rule: ${rule}`,
        `Detail: ${message}`,
        '',
        "To recover: configuration on the user's SilverBullet is malformed; user must fix it. The agent should not retry.",
      ].join('\n');
    }

    case 'not_found': {
      return [
        'Operation rejected — page not found.',
        '',
        `Page: ${ref ?? 'unknown'}`,
        '',
        'To recover: page does not exist (or is not accessible) — verify the ref. The agent should not infer page existence from this response.',
      ].join('\n');
    }

    default:
      return assertExhaustive(error.reason);
  }
}

/**
 * Render a {@link DomainError} as the agent-facing MCP tool result —
 * `isError: true` plus a single `content` text block carrying the per-
 * reason summary, context, and recovery instruction. AR43–AR45
 * (`epics.md:162-164`) and the per-reason templates from D6
 * (`architecture.md:568-617`).
 *
 * **Verbatim wording for `freshness_violation`** (AC2 of epic spec /
 * `epics.md:445`): the rendered text contains the literal substring
 * `'call read_page("' + ref + '") to refresh, then retry'` so agents'
 * recovery heuristics can match on it.
 *
 * Information-leak rules (AR45 / `architecture.md:631-636`) are honoured
 * structurally:
 *
 * 1. Bearer tokens / `token` / `apiKey` / `secret` / `password` are
 *    scrubbed inside the per-reason constructors (notably
 *    {@link infrastructureError}) before reaching this function.
 * 2. `none`-mode page content never enters `details` — `notFoundError`
 *    populates `details: {}`.
 * 3. Internal MCP-server state stays out — only the per-reason `details`
 *    schemas defined by the constructors are surfaced.
 * 4. Stack traces are never rendered — `scrubSecrets` collapses `Error`
 *    to `err.message`.
 *
 * Pure: no I/O, no clock reads, no global state.
 */
export function formatToolError(error: DomainError): MCPToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: renderText(error) }],
  };
}
