import { makeRef, RefValidationError, type Ref } from '../domain/ref.ts';

import { isAccessMode, type AccessMode } from './access-mode.ts';

/**
 * Validated permission declaration. The value is fully narrowed: `page` is
 * a branded {@link Ref}, `access` is a closed-vocabulary {@link AccessMode},
 * `exact` is always a boolean (defaulted to `false` on absent input per
 * AR14 / `epics.md:123`).
 *
 * Constructed only by {@link parseConfigBlocks}; never built by hand at
 * call sites.
 */
export type ConfigBlock = {
  readonly page: Ref;
  readonly access: AccessMode;
  readonly exact: boolean;
};

/**
 * Structural error surfaced when an upstream `#mcp/config` row fails
 * field-level validation. The {@link ConfigBlockParseError.raw} field
 * preserves the offending input verbatim (only the three relevant keys —
 * never the full input object) so the handler boundary (Story 1.10) can
 * project the error into a `config_error` audit entry per AR17 /
 * `epics.md:126`.
 *
 * The parser produces a structural value, not a `DomainError`. Conversion
 * into `configError(...)` happens at the handler boundary where the rich
 * audit context (block location, full error list) is in scope. Importing
 * `domain/error.ts` here would couple the pure-domain core to the error
 * presentation layer; AR58 forbids it.
 */
export type ConfigBlockParseError = {
  readonly raw: { readonly page?: unknown; readonly access?: unknown; readonly exact?: unknown };
  readonly reason:
    | 'page_missing'
    | 'page_invalid'
    | 'access_missing'
    | 'access_invalid'
    | 'exact_invalid';
  readonly message: string;
};

/**
 * Output of {@link parseConfigBlocks}. Valid blocks land in `blocks`;
 * malformed entries land in `errors`. The function never throws — fail-
 * closed at the field level per NFR11 / `epics.md:85`.
 */
export type ConfigBlockParseResult = {
  readonly blocks: readonly ConfigBlock[];
  readonly errors: readonly ConfigBlockParseError[];
};

type RawBlock = {
  readonly page?: unknown;
  readonly access?: unknown;
  readonly exact?: unknown;
};

function makeRaw(r: RawBlock): ConfigBlockParseError['raw'] {
  // Pull only the three relevant keys defensively. Spreading `...r` would
  // capture extraneous keys from a future SB schema and leak them into the
  // audit log; explicit pulls keep the error shape narrow.
  return { page: r.page, access: r.access, exact: r.exact };
}

/**
 * Widen the raw output of `query_config_blocks.lua.ts` (Story 1.7) into
 * validated {@link ConfigBlock}s. Each input record is checked
 * independently: a malformed field causes the entire block to be dropped
 * and recorded in `errors`, but never aborts the batch — the engine still
 * resolves access from the remaining valid blocks per AR17's "scope falls
 * through to the next-most-specific rule" rule.
 *
 * Validation contract:
 *
 * 1. `page` MUST be a string that survives `makeRef` — otherwise
 *    `page_missing` (key absent / non-string) or `page_invalid`
 *    (`makeRef` throws `RefValidationError`).
 * 2. `access` MUST be a string in `ACCESS_MODES` — otherwise
 *    `access_missing` (absent / non-string) or `access_invalid`
 *    (out-of-vocabulary).
 * 3. `exact` is optional. Absent → defaults `false`. Present → MUST be a
 *    JS boolean primitive (no `'true'`, no `1`, no `null` coercion);
 *    otherwise `exact_invalid`.
 *
 * Pure: no I/O, no clock reads, no global state. Total over `unknown`
 * field-typed inputs — never throws.
 *
 * @see D1 (`architecture.md:205-276`) — block format + scope rules.
 * @see AR14 / AR17 (`epics.md:123,126`) — block format, fail-closed
 *   semantics.
 * @see NFR11 / NFR19 (`epics.md:85,99`) — fail-closed; engine purity.
 */
export function parseConfigBlocks(raw: ReadonlyArray<RawBlock>): ConfigBlockParseResult {
  const blocks: ConfigBlock[] = [];
  const errors: ConfigBlockParseError[] = [];

  for (const r of raw) {
    // Page narrowing
    if (r.page === undefined || typeof r.page !== 'string') {
      errors.push({
        raw: makeRaw(r),
        reason: 'page_missing',
        message: 'page field missing or not a string',
      });
      continue;
    }

    let page: Ref;
    try {
      page = makeRef(r.page);
    } catch (refErr) {
      // makeRef only throws RefValidationError; propagate any other throw
      // as the programmer error it would represent.
      if (!(refErr instanceof RefValidationError)) throw refErr;
      errors.push({
        raw: makeRaw(r),
        reason: 'page_invalid',
        message: `page is not a valid SilverBullet ref: ${refErr.reason}`,
      });
      continue;
    }

    // Access narrowing
    if (r.access === undefined || typeof r.access !== 'string') {
      errors.push({
        raw: makeRaw(r),
        reason: 'access_missing',
        message: 'access field missing or not a string',
      });
      continue;
    }

    if (!isAccessMode(r.access)) {
      errors.push({
        raw: makeRaw(r),
        reason: 'access_invalid',
        message: `access value not in {none, read, append, write}: ${JSON.stringify(r.access)}`,
      });
      continue;
    }
    const access: AccessMode = r.access;

    // Exact narrowing — no truthy/falsy coercion. Absent → false; present
    // → MUST be `true` or `false`.
    let exact: boolean;
    if (r.exact === undefined) {
      exact = false;
    } else if (r.exact === true || r.exact === false) {
      exact = r.exact;
    } else {
      errors.push({
        raw: makeRaw(r),
        reason: 'exact_invalid',
        message: `exact field must be boolean if present, got ${typeof r.exact}`,
      });
      continue;
    }

    blocks.push({ page, access, exact });
  }

  return { blocks, errors };
}
