import { z } from 'zod';

import { digest } from '../../audit/digest.ts';
import { makeRef, RefValidationError, type Ref } from '../../domain/ref.ts';
import { readPageScript, type ReadPageResult } from '../../silverbullet/scripts/read-page.lua.ts';

import {
  fetchConfigBlocks,
  formatToolError,
  formatToolSuccess,
  infrastructureError,
  isDomainError,
  notFoundError,
  projectOutcome,
  summarizeParseErrors,
  validationError,
  type AuditOutcome,
  type DomainError,
  type HandlerContext,
  type ToolResult,
} from '../handler-template.ts';

const TOOL_NAME = 'read_page' as const;

/**
 * `read_page` accepts a single non-empty string `ref` (the agent-supplied
 * page reference). The string is validated structurally by zod here and
 * semantically by `makeRef` immediately after — the two-stage validation
 * gives a useful message at each layer.
 */
const ReadPageInputSchema = z
  .object({ ref: z.string().min(1, 'ref must be a non-empty string') })
  .strict();

function summarizeZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return 'read_page received invalid input';
  const messages: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys?: readonly string[] }).keys ?? [];
      messages.push(`read_page received unexpected fields: ${keys.join(', ')}`);
      continue;
    }
    if (issue.code === 'invalid_type' && issue.path.join('.') === 'ref') {
      messages.push('ref must be a non-empty string');
      continue;
    }
    messages.push(issue.message);
  }
  return messages.join('; ');
}

/**
 * `read_page` MCP tool handler. Returns the page body verbatim and touches
 * the freshness state so Stories 2.3 / 2.5 can enforce the
 * read-before-edit invariant. `none`-mode refs short-circuit to
 * `not_found` BEFORE any SB call — the page must remain invisible per
 * FR13 (`epics.md:42`).
 *
 * The audit `response` is `digest(content)` — `{ size, sha256 }` only —
 * never the raw body (NFR6 / AR31, `epics.md:78,146`). The freshness
 * `touch` uses `ctx.clock()`, NOT the SB-side `lastModified` — the
 * invariant tracks "when did the AGENT last read this page", which is
 * anchored to the agent's clock per `architecture.md:1077`.
 */
export async function handleReadPage(input: unknown, ctx: HandlerContext): Promise<ToolResult> {
  const startedAt = ctx.clock();
  let outcome: AuditOutcome | undefined;

  try {
    // 1. Parse input.
    const parsed = ReadPageInputSchema.safeParse(input);
    if (!parsed.success) {
      const error = validationError({ failure: summarizeZodIssues(parsed.error.issues) });
      outcome = { decision: 'rejected', error };
      return formatToolError(error);
    }

    // 2. Brand the ref. RefValidationError surfaces as validation_error
    //    WITHOUT a `ref` field on the DomainError (no valid Ref exists).
    let ref: Ref;
    try {
      ref = makeRef(parsed.data.ref);
    } catch (refErr) {
      if (refErr instanceof RefValidationError) {
        const error = validationError({
          failure: `ref is not a valid SilverBullet page name: ${refErr.reason}`,
        });
        outcome = { decision: 'rejected', error };
        return formatToolError(error);
      }
      throw refErr;
    }

    // 3. Fetch and parse #mcp/config blocks.
    const { blocks, parseErrors } = await fetchConfigBlocks(ctx.client);
    if (parseErrors.length > 0) {
      ctx.logger.warn(
        `${TOOL_NAME}: #mcp/config block parse errors: ${summarizeParseErrors(parseErrors)}`,
      );
    }

    // 4. Resolve permission. `none` short-circuits to `not_found` — NO SB
    //    call, NO freshness touch. The page is invisible (FR13).
    const access = ctx.permissionEngine.resolve(ref, blocks);
    if (access === 'none') {
      const error = notFoundError(ref);
      outcome = { decision: 'rejected', error };
      return formatToolError(error);
    }

    // 5. Read the page body via SB. A failure inside `client.exec` becomes
    //    `infrastructure_error` via the catch arm; freshness MUST NOT be
    //    touched on failure.
    const result = await ctx.client.exec<ReadPageResult>(readPageScript, { ref });

    // 6. Touch freshness with the AGENT'S clock — NOT result.lastModified.
    //    Architecture.md:1077: the freshness invariant tracks the agent's
    //    last-read time, anchored to ctx.clock(). The SB-side
    //    `lastModified` is consumed by Story 2.3's `edit_page` via
    //    `pageMetaScript` to compare against this stored timestamp.
    ctx.freshness.touch(ref, ctx.clock());

    // 7. Build audit + response. The audit gets the digest (NFR6); the
    //    agent gets the body (FR11).
    const responsePayload = digest(result.content);
    outcome = { decision: 'allowed', responsePayload };
    return formatToolSuccess(result.content);
  } catch (err) {
    const domainErr: DomainError = isDomainError(err) ? err : infrastructureError(err);
    ctx.logger.error(`${TOOL_NAME} handler crashed`, err);
    outcome = { decision: 'rejected', error: domainErr };
    return formatToolError(domainErr);
  } finally {
    if (outcome === undefined) {
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
