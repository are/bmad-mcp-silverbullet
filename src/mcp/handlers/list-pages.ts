import { z } from 'zod';

import { makeRef, RefValidationError, type Ref } from '../../domain/ref.ts';
import {
  listPagesScript,
  type ListPagesResult,
} from '../../silverbullet/scripts/list-pages.lua.ts';

import {
  fetchConfigBlocks,
  formatToolError,
  formatToolSuccess,
  infrastructureError,
  isDomainError,
  projectOutcome,
  summarizeParseErrors,
  validationError,
  type AuditOutcome,
  type DomainError,
  type HandlerContext,
  type ToolResult,
} from '../handler-template.ts';

const TOOL_NAME = 'list_pages' as const;

/**
 * `list_pages` accepts no arguments. `.strict()` rejects unknown keys —
 * extraneous fields surface as `validation_error` rather than silently being
 * ignored. The MCP spec is permissive on tool input, but our trust model
 * prefers strict so agent misconfigurations are caught immediately.
 */
const ListPagesInputSchema = z.object({}).strict();

/**
 * Summarise zod issues into a single `failure` line for the
 * `validationError` projection. Falls back to a generic message if the
 * issues array is empty (defensive — zod's `safeParse` always emits at
 * least one issue on failure).
 */
function summarizeZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return 'list_pages received invalid input';
  const messages: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys?: readonly string[] }).keys ?? [];
      messages.push(
        `list_pages takes no arguments; received unexpected fields: ${keys.join(', ')}`,
      );
      continue;
    }
    messages.push(issue.message);
  }
  return messages.join('; ');
}

/**
 * `list_pages` MCP tool handler. Returns the agent-visible ref list — every
 * `none`-mode page is filtered out server-side per FR8 / FR10
 * (`epics.md:34,36`). The audit `response` records ONLY the visible refs
 * (no snippets, no pre-filter list per AR31 / NFR6).
 *
 * Follows the canonical `architecture.md:1041-1108` shape: top-level
 * try/catch/finally with exactly-one audit entry written in the `finally`.
 */
export async function handleListPages(input: unknown, ctx: HandlerContext): Promise<ToolResult> {
  const startedAt = ctx.clock();
  let outcome: AuditOutcome | undefined;

  try {
    // 1. Parse input.
    const parsed = ListPagesInputSchema.safeParse(input);
    if (!parsed.success) {
      const error = validationError({ failure: summarizeZodIssues(parsed.error.issues) });
      outcome = { decision: 'rejected', error };
      return formatToolError(error);
    }

    // 2. Fetch and parse #mcp/config blocks (D2 — every call refetches).
    const { blocks, parseErrors } = await fetchConfigBlocks(ctx.client);
    if (parseErrors.length > 0) {
      ctx.logger.warn(
        `${TOOL_NAME}: #mcp/config block parse errors: ${summarizeParseErrors(parseErrors)}`,
      );
    }

    // 3. Run the SB list-pages script.
    const raw = await ctx.client.exec<ListPagesResult>(listPagesScript);

    // 4. Defensively re-validate every ref returned by SB (AR10).
    const validatedRefs: Ref[] = [];
    for (const page of raw.pages) {
      try {
        validatedRefs.push(makeRef(page.ref));
      } catch (refErr) {
        if (refErr instanceof RefValidationError) {
          ctx.logger.warn(
            `${TOOL_NAME}: dropping malformed ref returned by SB: ${refErr.value} (${refErr.reason})`,
          );
          continue;
        }
        throw refErr;
      }
    }

    // 5. Filter out `none`-mode refs per FR8 / FR10.
    const visibleRefs = validatedRefs.filter(
      (r) => ctx.permissionEngine.resolve(r, blocks) !== 'none',
    );

    // 6. Build payload. `Ref` extends `string` via the brand — the
    //    `string[]` annotation drops the brand structurally.
    const visibleRefsPlain: string[] = [...visibleRefs];
    const payload = { pages: visibleRefsPlain };

    outcome = { decision: 'allowed', responsePayload: payload };
    return formatToolSuccess(JSON.stringify(payload));
  } catch (err) {
    const domainErr: DomainError = isDomainError(err) ? err : infrastructureError(err);
    ctx.logger.error(`${TOOL_NAME} handler crashed`, err);
    outcome = { decision: 'rejected', error: domainErr };
    return formatToolError(domainErr);
  } finally {
    if (outcome === undefined) {
      // Defensive — should be unreachable. The try/catch arms always set
      // `outcome` before the implicit fall-through to `finally`.
      outcome = {
        decision: 'rejected',
        error: infrastructureError(new Error('handler exited without populating outcome')),
      };
    }
    const projection = projectOutcome(outcome);
    const finishedAt = ctx.clock();
    ctx.audit.write({
      tool: TOOL_NAME,
      args: input,
      decision: projection.decision,
      response: projection.response,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ...(projection.reason !== undefined ? { reason: projection.reason } : {}),
      ...(projection.details !== undefined ? { details: projection.details } : {}),
      ...(projection.failedOperation !== undefined
        ? { failedOperation: projection.failedOperation }
        : {}),
    });
  }
}
