/**
 * Audit log schema — v1 type definitions per D4
 * (`_bmad-output/planning-artifacts/architecture.md:386-468`, AR29
 * `_bmad-output/planning-artifacts/epics.md:144`).
 *
 * The wire shape is the JSONL record written to the audit log file. Field
 * order in the serialized JSON is `v, t, id, tool, args, decision, response,
 * durationMs, reason?, details?, failedOperation?` — `JSON.stringify`
 * preserves insertion order, so the audit logger constructs the entry object
 * with that key order.
 *
 * Bumping {@link AUDIT_SCHEMA_VERSION} signals a schema break and requires a
 * documented migration path (NFR16, `epics.md:94`, `architecture.md:1177`).
 */

/**
 * Current audit log schema version. Locked at `1` for MVP. Bumping requires
 * NFR16 schema-migration discipline.
 */
export const AUDIT_SCHEMA_VERSION = 1 as const;

/**
 * Branded ULID identifying a single audit entry. The brand is type-system-
 * only; constructed inside the audit-logger's ULID generator (the only
 * sanctioned `as AuditEntryId` cast site, per `architecture.md:1009` and the
 * `Ref` brand-constructor precedent at `src/domain/ref.ts:121`).
 */
export type AuditEntryId = string & { readonly __brand: 'AuditEntryId' };

/**
 * Closed two-value union for the `decision` field per D4
 * (`architecture.md:419`). `allowed` covers successful tool calls;
 * `rejected` covers any reason category.
 */
export type AuditDecision = 'allowed' | 'rejected';

/**
 * Full wire shape of one audit log entry. Required fields land on every
 * record; conditional fields appear only when relevant.
 *
 * `reason` is typed as `string` (not a closed union) for forward
 * compatibility with Story 1.6's `ReasonCode` enum, which lands AFTER this
 * story (`architecture.md:818`). Story 1.6 will reconcile by re-exporting or
 * unifying the type. Tightening here ahead of 1.6 risks an unnecessary
 * schema-version bump (NFR16).
 *
 * `args` and `response` are typed `unknown` because handlers — not the
 * schema layer — own those shapes. AR31 (`epics.md:146`): agent intent in
 * `args` is logged in full; user-space content in `response` is digested
 * (see `./digest.ts`) or recorded as ref lists.
 */
export type AuditEntry = {
  readonly v: typeof AUDIT_SCHEMA_VERSION;
  readonly t: string;
  readonly id: AuditEntryId;
  readonly tool: string;
  readonly args: unknown;
  readonly decision: AuditDecision;
  readonly response: unknown;
  readonly durationMs: number;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly failedOperation?: { readonly index: number; readonly operation: object };
};

/**
 * Handler-side input to {@link AuditLogger.write}. The audit logger stamps
 * `v`, `t`, and `id` automatically; handlers never construct those.
 */
export type AuditEntryInput = Omit<AuditEntry, 'v' | 't' | 'id'>;
