/**
 * Minimal placeholder shape used by `Result<T>` (see `./result.ts`).
 *
 * Story 1.6 replaces this with the full `DomainError` type — closed
 * `ReasonCode` enum, `formatToolError`, `serializeForAudit`. Do NOT
 * pre-emptively expand it here: the closed enum is a story 1.6 decision and
 * widening it after-the-fact bumps the audit schema version (NFR16).
 */
export type DomainError = {
  readonly reason: string;
  readonly message: string;
};
