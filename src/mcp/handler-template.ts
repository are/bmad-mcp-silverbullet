/**
 * Canonical MCP tool-handler shape — `HandlerContext` injection type plus the
 * structural helpers every read- and write-side handler shares. Story 1.10
 * (`_bmad-output/implementation-artifacts/1-10-...md`) ships the read-side
 * handlers built on top of this; Story 1.11 wires the production
 * `HandlerContext` factory into the startup ladder; Stories 2.x add the
 * write-side handlers.
 *
 * **The re-exports of `formatToolError` and the per-reason error
 * constructors are deliberate single-file facades — NOT barrel re-exports
 * (AR57 / `architecture.md:999`).** AR57 forbids `index.ts` files that
 * re-export an entire directory; this file is a single-file public API for
 * handler authors. The re-exports keep handlers from importing a mix of
 * `domain/error.ts` and `mcp/handler-template.ts` for closely-coupled
 * symbols.
 *
 * @see Tool-handler shape — `architecture.md:1041-1108`.
 * @see AR53 — exactly-one audit entry per tool call (`epics.md:176`).
 * @see AR54 — canonical `handler-template.ts` (`epics.md:177`).
 */

import type { AuditLogger } from '../audit/audit-logger.ts';
import type { Logger } from '../diagnostic/logger.ts';
import { type DomainError, type ReasonCode, serializeForAudit } from '../domain/error.ts';
import type { Ref } from '../domain/ref.ts';
import type { FreshnessState } from '../freshness/state.ts';
import {
  parseConfigBlocks,
  type ConfigBlock,
  type ConfigBlockParseError,
} from '../permissions/config-block-parser.ts';
import type { AccessMode } from '../permissions/access-mode.ts';
import { resolveAccess } from '../permissions/engine.ts';
import type { RuntimeClient } from '../silverbullet/client.ts';
import {
  queryConfigBlocksScript,
  type QueryConfigBlocksResult,
} from '../silverbullet/scripts/query-config-blocks.lua.ts';

// Re-exports — single-file facade for handler authors (NOT a barrel; see header).
export {
  formatToolError,
  permissionDeniedError,
  freshnessViolationError,
  validationError,
  infrastructureError,
  configError,
  notFoundError,
} from '../domain/error.ts';
export type { DomainError, ReasonCode } from '../domain/error.ts';
export type { ConfigBlock, ConfigBlockParseError } from '../permissions/config-block-parser.ts';
export type { AccessMode } from '../permissions/access-mode.ts';

// Permission engine surface ---------------------------------------------------

/**
 * Object wrapper around the pure {@link resolveAccess} function. Architecture's
 * canonical handler shape (`architecture.md:1055`) uses
 * `ctx.permissionEngine.resolve(ref, blocks)`; the wrapper preserves that
 * vocabulary while keeping the engine itself a pure function.
 *
 * Tests inject hand-rolled stubs `{ resolve: (ref) => modeMap.get(ref) ?? 'none' }`
 * to drive specific access-mode outcomes without re-deriving from
 * `ConfigBlock[]`.
 */
export type PermissionEngine = {
  resolve(ref: Ref, blocks: readonly ConfigBlock[]): AccessMode;
};

/**
 * Production wiring's default {@link PermissionEngine} — a frozen object
 * literal that delegates to {@link resolveAccess}. The freeze is
 * belt-and-suspenders against accidental runtime mutation by tests; the
 * `readonly` typing already enforces compile-time immutability.
 */
export const defaultPermissionEngine: PermissionEngine = Object.freeze({
  resolve: resolveAccess,
});

// Handler context -------------------------------------------------------------

/**
 * Dependency-injection bag every MCP tool handler receives. Each field is the
 * minimal surface needed by the canonical try/catch/finally shape — no
 * module-level singleton is reachable from inside a handler body (AR53 /
 * `epics.md:176`).
 *
 * - `client` — the only network-touching module (AR21 / `epics.md:134`).
 * - `permissionEngine` — pure `(Ref, ConfigBlock[]) → AccessMode`.
 * - `freshness` — bounded in-memory `Map<Ref, lastReadAt>` (Story 1.9).
 * - `audit` — fire-and-forget JSONL logger (Story 1.5).
 * - `logger` — stderr-bound diagnostic logger (Story 1.3).
 * - `clock` — sole time source; tests inject `() => fixedDate`.
 */
export type HandlerContext = {
  readonly client: RuntimeClient;
  readonly permissionEngine: PermissionEngine;
  readonly freshness: FreshnessState;
  readonly audit: AuditLogger;
  readonly logger: Logger;
  readonly clock: () => Date;
};

// Tool result shape -----------------------------------------------------------

/**
 * Single text content block as required by AR43 (`epics.md:162`) — the LLM
 * sees recovery instructions via `content`, never `_meta`.
 */
export type ToolResultContent = ReadonlyArray<{
  readonly type: 'text';
  readonly text: string;
}>;

/**
 * Discriminated union for MCP tool results. The error arm carries
 * `isError: true`; the success arm omits the field entirely (the MCP SDK's
 * `CallToolResult` treats absent / falsy `isError` as success). Story 1.11
 * will verify structural fit against `@modelcontextprotocol/sdk` when the
 * SDK is wired into `src/mcp/registry.ts`.
 */
export type ToolResult =
  | { readonly isError: true; readonly content: ToolResultContent }
  | { readonly content: ToolResultContent };

/**
 * Render a successful single-text-block tool result. Pure: no clock, no
 * I/O. The same input always produces the same output.
 */
export function formatToolSuccess(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

// Audit outcome + projection --------------------------------------------------

/**
 * Discriminated outcome populated on every code path inside a handler's
 * `try` / `catch`. The `finally` block consumes the `outcome` once via
 * {@link projectOutcome} to write exactly one audit entry per AR53.
 */
export type AuditOutcome =
  | { readonly decision: 'allowed'; readonly responsePayload: unknown }
  | { readonly decision: 'rejected'; readonly error: DomainError };

/**
 * Audit-projection shape consumed by {@link AuditLogger.write}. The
 * `decision`, `response`, and (on rejection) `reason` / `details` /
 * `failedOperation` fields are spread directly into the audit logger's
 * `AuditEntryInput` (`src/audit/schema.ts:70`).
 */
export type AuditOutcomeProjection = {
  readonly decision: 'allowed' | 'rejected';
  readonly response: unknown;
  readonly reason?: ReasonCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly failedOperation?: { readonly index: number; readonly operation: object };
};

/**
 * Project an {@link AuditOutcome} into the field shape the audit logger
 * expects. On `'allowed'` returns `{ decision, response: responsePayload }`;
 * on `'rejected'` returns `{ decision, response: undefined,
 * ...serializeForAudit(error) }` (spreads `reason`, `details`, optional
 * `failedOperation`). Pure.
 */
export function projectOutcome(outcome: AuditOutcome): AuditOutcomeProjection {
  if (outcome.decision === 'allowed') {
    return { decision: 'allowed', response: outcome.responsePayload };
  }
  return { decision: 'rejected', response: undefined, ...serializeForAudit(outcome.error) };
}

// Domain-error structural type guard -----------------------------------------

/**
 * Structural test for the {@link DomainError} shape — used by every
 * handler's top-level `catch` to distinguish "the runtime client already
 * threw a `DomainError`" (pass through) from "an unexpected throw escaped"
 * (wrap with `infrastructureError`). The check is structural (no
 * `instanceof`); `DomainError` is an interface, not a class.
 */
export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  if (!('reason' in value) || typeof value.reason !== 'string') return false;
  if (!('details' in value)) return false;
  const details = (value as { details: unknown }).details;
  if (typeof details !== 'object' || details === null) return false;
  return true;
}

// Config-block fetch helper ---------------------------------------------------

/**
 * Combined output of {@link fetchConfigBlocks}: validated `ConfigBlock`s for
 * the engine plus the per-block parse errors for the handler's diagnostic
 * `ctx.logger.warn` (AR50 / `architecture.md:677`).
 */
export type FetchConfigBlocksResult = {
  readonly blocks: readonly ConfigBlock[];
  readonly parseErrors: readonly ConfigBlockParseError[];
};

/**
 * Fetch every `#mcp/config` block from SilverBullet and widen the raw rows
 * into validated {@link ConfigBlock}s. **Every read- and write-side handler
 * MUST go through this helper rather than calling `client.exec` directly**
 * — keeps the malformed-block warning on a single code path and avoids
 * duplicating the parse-error projection across handlers.
 *
 * `client.exec` rejections propagate unchanged for the handler's top-level
 * `catch` to translate into `infrastructure_error` per D2 strict
 * fail-closed (`architecture.md:284`). **No try/catch here** — the catch
 * lives at the handler boundary.
 */
export async function fetchConfigBlocks(client: RuntimeClient): Promise<FetchConfigBlocksResult> {
  const raw = await client.exec<QueryConfigBlocksResult>(queryConfigBlocksScript);
  const { blocks, errors } = parseConfigBlocks(raw.blocks);
  return { blocks, parseErrors: errors };
}

/**
 * Render a one-line summary of `parseErrors` suitable for the handler's
 * `ctx.logger.warn(...)` call. Each error contributes `<reason> on <page?>`;
 * missing-page errors render `<unknown page>`. Caller composes the final
 * string with the tool name. Pure.
 */
export function summarizeParseErrors(parseErrors: readonly ConfigBlockParseError[]): string {
  if (parseErrors.length === 0) return '';
  return parseErrors
    .map((e) => {
      const page = typeof e.raw.page === 'string' ? e.raw.page : '<unknown page>';
      return `${e.reason} on ${page}`;
    })
    .join('; ');
}
