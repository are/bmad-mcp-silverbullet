/**
 * Access modes form a total order by permissiveness:
 *
 * ```
 * none < read < append < write
 * ```
 *
 * `read` permits list / read / search; `append` adds atomic append on top of
 * read; `write` is read + append + edit + delete + create. The four-mode
 * union is the closed vocabulary D1 (`architecture.md:209-215`) locks for the
 * permission contract — adding a value would change the security boundary
 * and is intentionally out of scope for MVP.
 *
 * @see D1 (`architecture.md:205-276`) — permission declaration mechanism.
 * @see AR16 (`epics.md:125`) — most-specific wins; within same specificity,
 *   most-permissive wins.
 */
export type AccessMode = 'none' | 'read' | 'append' | 'write';

/**
 * Runtime-iterable lock-in of {@link AccessMode}, ordered by ascending
 * permissiveness rank. The tuple shape (not an array) is preserved by
 * `as const`; tests assert positional ordering matches {@link accessRank}.
 *
 * The pattern mirrors `src/domain/error.ts:27-34`'s `REASON_CODES` —
 * extending the closed vocabulary requires a coordinated update of every
 * downstream switch (engine tie-break, parser narrowing, permits matrix).
 */
export const ACCESS_MODES = [
  'none',
  'read',
  'append',
  'write',
] as const satisfies ReadonlyArray<AccessMode>;

/**
 * Discriminate {@link AccessMode} from arbitrary `unknown` input. Used by
 * the config-block parser (`./config-block-parser.ts`) at the runtime-data
 * boundary to widen the upstream `access: string` field into the closed
 * union. Case-sensitive — `'WRITE'`, `'Read'`, `'  write  '` all return
 * `false` (the YAML body is the user's contract; we do not coerce).
 */
export function isAccessMode(value: unknown): value is AccessMode {
  if (typeof value !== 'string') return false;
  return (ACCESS_MODES as readonly string[]).includes(value);
}

function assertExhaustive(value: never): never {
  // Defensive sink: only fires if a runtime cast smuggled an out-of-domain
  // value past the type system. Surface clearly rather than silently fall
  // through. Mirrors `src/domain/error.ts:423-428`.
  throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}

/**
 * Numeric permissiveness rank: `'none' = 0 < 'read' = 1 < 'append' = 2 <
 * 'write' = 3`. Used by the engine's tie-break ({@link maxAccess}) and the
 * {@link permits} per-operation comparisons. Pure; total over
 * {@link AccessMode}.
 */
export function accessRank(mode: AccessMode): 0 | 1 | 2 | 3 {
  switch (mode) {
    case 'none':
      return 0;
    case 'read':
      return 1;
    case 'append':
      return 2;
    case 'write':
      return 3;
    default:
      return assertExhaustive(mode);
  }
}

/**
 * Return the higher-rank of two access modes (most-permissive wins). Used
 * by the engine's tie-break when multiple equally-specific blocks apply —
 * AR16 / `epics.md:125`. Symmetric and idempotent: `maxAccess(a, a) === a`,
 * `maxAccess(a, b) === maxAccess(b, a)`.
 */
export function maxAccess(a: AccessMode, b: AccessMode): AccessMode {
  return accessRank(a) >= accessRank(b) ? a : b;
}

/**
 * Closed enumeration of operations the permission engine gates. The
 * required-rank table is locked at D1 (`architecture.md:215`):
 *
 * | Operation              | Minimum mode | Rank |
 * |------------------------|--------------|------|
 * | `read`, `list`, `search` | `read`     | 1    |
 * | `append`               | `append`     | 2    |
 * | `edit`, `delete`, `create` | `write`  | 3    |
 *
 * `none`-mode rejects every operation (rank 0 < 1).
 */
export type AccessOperation = 'read' | 'list' | 'search' | 'append' | 'edit' | 'delete' | 'create';

/**
 * Predicate: does `mode` permit `operation`? Pure; no I/O. The exhaustive
 * `switch` over {@link AccessOperation} ensures adding an operation kind
 * surfaces as a TypeScript error at the `assertExhaustive` arm.
 */
export function permits(mode: AccessMode, operation: AccessOperation): boolean {
  const rank = accessRank(mode);
  switch (operation) {
    case 'read':
    case 'list':
    case 'search':
      return rank >= 1;
    case 'append':
      return rank >= 2;
    case 'edit':
    case 'delete':
    case 'create':
      return rank >= 3;
    default:
      return assertExhaustive(operation);
  }
}
