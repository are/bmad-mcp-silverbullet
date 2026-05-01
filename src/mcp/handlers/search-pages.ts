import { z } from 'zod';

import { makeRef, RefValidationError, type Ref } from '../../domain/ref.ts';
import {
  searchPagesScript,
  type SearchPagesResult,
} from '../../silverbullet/scripts/search-pages.lua.ts';

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

const TOOL_NAME = 'search_pages' as const;

/**
 * `search_pages` accepts a single non-empty string `q`. The param key is
 * `q` (NOT `query`) to align with the Lua script's `_p.q` envelope —
 * `_p.query` collides with SB's integrated-query DSL keyword
 * (`src/silverbullet/scripts/search-pages.lua.ts:21-25`). `.strict()`
 * rejects unknown keys per the same trust-model rationale as `list_pages`.
 */
const SearchPagesInputSchema = z
  .object({ q: z.string().min(1, 'q must be a non-empty string') })
  .strict();

function summarizeZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return 'search_pages received invalid input';
  const messages: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys?: readonly string[] }).keys ?? [];
      messages.push(`search_pages received unexpected fields: ${keys.join(', ')}`);
      continue;
    }
    if (issue.code === 'invalid_type' && issue.path.join('.') === 'q') {
      messages.push('q must be a non-empty string');
      continue;
    }
    messages.push(issue.message);
  }
  return messages.join('; ');
}

/**
 * `search_pages` MCP tool handler. Filters `none`-mode hits per FR9 / FR10
 * (`epics.md:35,36`). The audit `response` records ONLY `{ ref, score }`
 * for each visible hit — snippets / excerpts / matches NEVER appear in the
 * response or the audit log (NFR6 / AR31). The explicit `.map(h => ({ ref:
 * h.ref, score: h.score }))` projection is belt-and-suspenders against a
 * future silversearch upgrade that surfaces extra fields.
 */
export async function handleSearchPages(input: unknown, ctx: HandlerContext): Promise<ToolResult> {
  const startedAt = ctx.clock();
  let outcome: AuditOutcome | undefined;

  try {
    // 1. Parse input.
    const parsed = SearchPagesInputSchema.safeParse(input);
    if (!parsed.success) {
      const error = validationError({ failure: summarizeZodIssues(parsed.error.issues) });
      outcome = { decision: 'rejected', error };
      return formatToolError(error);
    }

    // 2. Fetch and parse #mcp/config blocks.
    const { blocks, parseErrors } = await fetchConfigBlocks(ctx.client);
    if (parseErrors.length > 0) {
      ctx.logger.warn(
        `${TOOL_NAME}: #mcp/config block parse errors: ${summarizeParseErrors(parseErrors)}`,
      );
    }

    // 3. Run silversearch via the Lua template — `q` matches the envelope key.
    const raw = await ctx.client.exec<SearchPagesResult>(searchPagesScript, { q: parsed.data.q });

    // 4. Defensively re-validate every ref + drop malformed (AR10).
    const validatedHits: Array<{ ref: Ref; score: number }> = [];
    for (const hit of raw.hits) {
      let validatedRef: Ref;
      try {
        validatedRef = makeRef(hit.ref);
      } catch (refErr) {
        if (refErr instanceof RefValidationError) {
          ctx.logger.warn(
            `${TOOL_NAME}: dropping malformed ref returned by SB: ${refErr.value} (${refErr.reason})`,
          );
          continue;
        }
        throw refErr;
      }
      validatedHits.push({ ref: validatedRef, score: hit.score });
    }

    // 5. Filter out `none`-mode hits.
    const visibleHits = validatedHits.filter(
      (h) => ctx.permissionEngine.resolve(h.ref, blocks) !== 'none',
    );

    // 6. Project to the agent-visible shape — snippets / excerpts NEVER
    //    surface even if the upstream type ever leaks them (NFR6 belt
    //    and suspenders — see story 1.10 AC4 + AC8 #17).
    // `h.ref` is `Ref` which extends `string`; the projection drops the brand
    // and any future upstream field (snippet, excerpt, match) by enumeration.
    const visibleHitsPlain: Array<{ ref: string; score: number }> = visibleHits.map((h) => ({
      ref: h.ref,
      score: h.score,
    }));
    const payload = { hits: visibleHitsPlain };

    outcome = { decision: 'allowed', responsePayload: payload };
    return formatToolSuccess(JSON.stringify(payload));
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
