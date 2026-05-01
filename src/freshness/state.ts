import type { Ref } from '../domain/ref.ts';

/**
 * In-memory `Ref → lastReadAt` store with bounded growth (NFR4 /
 * `epics.md:74`). Updated only on successful `read_page` calls
 * (`architecture.md:822`); consulted by `edit_page` / `delete_page`
 * handlers to enforce the freshness invariant (FR20 / `epics.md:51-52`,
 * `architecture.md:418-432`).
 *
 * `touch` is the only operation that updates LRU recency. `get` is a
 * read-only inspection and does NOT bump the entry — re-reading a stored
 * timestamp does not save it from eviction. The handler boundary
 * (Stories 1.10 / 2.3 / 2.5) wires this surface as `ctx.freshness`.
 *
 * @see D2 (`architecture.md:418-432`) — freshness invariant locus.
 * @see PRD §State & Session Model (`prd.md:418-432`) — in-memory,
 *   process-scoped; no persistence in MVP.
 */
export type FreshnessState = {
  touch(ref: Ref, at: Date): void;
  get(ref: Ref): Date | undefined;
};

/**
 * Construction options for {@link createFreshnessState}. Capacity is
 * optional under `exactOptionalPropertyTypes` (`tsconfig.json:10`) —
 * callers omit the field to use {@link DEFAULT_FRESHNESS_CAPACITY};
 * explicit `undefined` is type-rejected.
 */
export type CreateFreshnessStateOptions = {
  readonly capacity?: number;
};

/**
 * Default LRU cap for the freshness state. A personal SilverBullet space
 * typically holds low-thousands of pages and an agent session touches
 * dozens; `1024 entries × ~150 bytes/entry ≈ 150 KB` resident — well
 * within NFR4's bounded-growth envelope (`epics.md:74`). Production wiring
 * (Story 1.11) MAY override via `options.capacity` if a larger space
 * justifies.
 */
export const DEFAULT_FRESHNESS_CAPACITY = 1024 as const;

/**
 * Construct a {@link FreshnessState} with an LRU eviction policy bounded
 * by `capacity` (default {@link DEFAULT_FRESHNESS_CAPACITY}).
 *
 * Each invocation returns an independent instance with its own private
 * `Map<Ref, Date>` — no module-level singleton (AR53 / `epics.md:176`).
 *
 * Throws `Error` (NOT `DomainError`) on a non-positive or non-integer
 * `capacity` — invariant violation per `architecture.md:1118` ("throw
 * only for invariants and infra").
 */
export function createFreshnessState(options?: CreateFreshnessStateOptions): FreshnessState {
  const capacity = options?.capacity ?? DEFAULT_FRESHNESS_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(
      `createFreshnessState: capacity must be a positive integer, got ${String(capacity)}`,
    );
  }

  // Map preserves insertion order per ECMA-262 §24.1; the first iterated
  // key is the LRU entry under the delete-then-set discipline below.
  const entries = new Map<Ref, Date>();

  function touch(ref: Ref, at: Date): void {
    // delete-then-set is load-bearing: a bare `set` of an existing key
    // updates the value but keeps the original insertion position, so
    // re-touching would NOT move the entry to the MRU end.
    entries.delete(ref);
    entries.set(ref, at);
    if (entries.size > capacity) {
      const lruKey = entries.keys().next().value;
      // size > capacity ≥ 1, so the iterator yields a key. The
      // `!== undefined` guard satisfies `noUncheckedIndexedAccess`-style
      // safety without a type assertion.
      if (lruKey !== undefined) entries.delete(lruKey);
    }
  }

  function get(ref: Ref): Date | undefined {
    return entries.get(ref);
  }

  return { touch, get };
}
