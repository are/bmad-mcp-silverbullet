/**
 * MCP tool registry — wires the Story 1.10 read-side handlers into the
 * `@modelcontextprotocol/sdk` `McpServer` surface. **The only file under
 * `src/mcp/` that imports the SDK at runtime** (alongside `src/index.ts`,
 * which imports `McpServer` and `StdioServerTransport` for the constructors).
 * Pure-domain modules and handler files do not import the SDK — Story 1.10
 * pinned this seam.
 *
 * The wrapper around each handler enforces two invariants that the handler
 * itself cannot:
 *
 * 1. **Draining-state rejection (AR51 / `epics.md:172`).** When the lifecycle
 *    is in the `'draining'` state (Story 1.11's shutdown sequence), every NEW
 *    tool call is rejected with `infrastructure_error: server shutting down`
 *    BEFORE the underlying handler is invoked. The wrapper writes the audit
 *    entry directly so the AR53 "exactly-one audit entry per tool call"
 *    invariant survives the bypass.
 *
 * 2. **In-flight tracking.** Non-draining calls register with the lifecycle's
 *    `trackInflight` so the shutdown sequence can `await` them before tearing
 *    down the audit stream / runtime client / transport.
 *
 * @see Tool-handler shape — `architecture.md:1041-1108`.
 * @see AR51 — cooperative shutdown (`epics.md:172`).
 * @see AR53 — exactly-one audit entry per call (`epics.md:176`).
 * @see NFR15 — use the official MCP SDK (`epics.md:91`).
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  formatToolError,
  infrastructureError,
  type DomainError,
  type HandlerContext,
  type ToolResult,
} from './handler-template.ts';
import { handleListPages } from './handlers/list-pages.ts';
import { handleReadPage } from './handlers/read-page.ts';
import { handleSearchPages } from './handlers/search-pages.ts';

/**
 * Lifecycle handle exposed to the registry — the registry owns NO lifecycle
 * state of its own. The implementation lives in `src/index.ts`'s
 * `createLifecycle()` factory.
 */
export type LifecycleHandle = {
  isDraining(): boolean;
  trackInflight<T>(promise: Promise<T>): Promise<T>;
};

/**
 * Inputs to {@link registerTools}. The `server`, `ctx`, and `lifecycle` are
 * all constructed by `src/index.ts`'s startup ladder; the registry just wires
 * them together.
 */
export type RegisterToolsOptions = {
  readonly server: McpServer;
  readonly ctx: HandlerContext;
  readonly lifecycle: LifecycleHandle;
};

type ReadHandler = (input: unknown, ctx: HandlerContext) => Promise<ToolResult>;

type ToolDef = {
  readonly name: 'list_pages' | 'search_pages' | 'read_page';
  readonly description: string;
  readonly handler: ReadHandler;
};

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'list_pages',
    description:
      'List page refs in the SilverBullet space. Pages declared none-mode are filtered server-side.',
    handler: handleListPages,
  },
  {
    name: 'search_pages',
    description:
      'Search the SilverBullet space by query. Pages declared none-mode are filtered server-side.',
    handler: handleSearchPages,
  },
  {
    name: 'read_page',
    description:
      'Read the body of a page by ref. Returns not_found for none-mode pages (deliberately invisible).',
    handler: handleReadPage,
  },
];

/**
 * Build the audit-entry projection for a draining-rejected tool call. Pure;
 * shaped to match the `AuditEntryInput` contract from `src/audit/schema.ts:70`
 * and Story 1.10's handler `finally` projection (`src/mcp/handler-template.ts:166`).
 */
function buildDrainingAuditEntry(toolName: string, args: unknown, error: DomainError) {
  return {
    tool: toolName,
    args,
    decision: 'rejected' as const,
    response: undefined,
    durationMs: 0,
    reason: error.reason,
    details: error.details,
  };
}

/**
 * Register the three Story 1.10 read-side handlers with the MCP SDK. Each
 * wrapper short-circuits to an `infrastructure_error: server shutting down`
 * during the draining state (writing exactly one audit entry directly), and
 * registers in-flight calls with the lifecycle so the shutdown sequence can
 * await them.
 *
 * **No `inputSchema` validation here** — Story 1.10's handlers do their own
 * `z.object({...}).strict().safeParse(input)` per AC8. The SDK-side
 * `inputSchema: z.unknown()` is a permissive passthrough purely so the SDK
 * forwards `request.params.arguments` to our callback (without an
 * `inputSchema`, the SDK's `executeToolHandler` calls `typedHandler(extra)`
 * with only the `extra` argument — the args are dropped). The handler's
 * strict validation is preserved.
 */
export function registerTools(opts: RegisterToolsOptions): void {
  const { server, ctx, lifecycle } = opts;

  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        // Permissive passthrough — handler does the strict zod parse. See JSDoc above.
        inputSchema: z.unknown(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      // The SDK callback signature with `inputSchema` provided is
      // `(args: unknown, extra) => Promise<CallToolResult>`. We ignore
      // `extra` (Story 1.10 handlers don't consume it).
      async (args: unknown): Promise<CallToolResult> => {
        if (lifecycle.isDraining()) {
          const error = infrastructureError(new Error('server shutting down'));
          // The audit logger may already be closed (shutdown sequence
          // calls `audit.close()` BEFORE `server.close()`, so a draining
          // call arriving in that window writes into a closed stream).
          // Wrap to keep the rejection deterministic — the agent-facing
          // tool error still returns regardless of audit-write outcome.
          try {
            ctx.audit.write(buildDrainingAuditEntry(def.name, args, error));
          } catch (writeErr) {
            ctx.logger.warn(`audit write during draining failed: ${String(writeErr)}`);
          }
          // formatToolError returns `{ isError: true, content: [...] }` —
          // structurally equivalent to the SDK's `CallToolResult`.
          return formatToolError(error) as CallToolResult;
        }
        const result = await lifecycle.trackInflight(def.handler(args, ctx));
        return result as CallToolResult;
      },
    );
  }
}
