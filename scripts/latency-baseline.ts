#!/usr/bin/env node
/* eslint-disable no-console -- this harness is operator-facing CLI output, not the production stdio surface (D7 applies inside src/, not scripts/). */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { infrastructureError } from '../src/domain/error.ts';
import { createRuntimeClient } from '../src/silverbullet/client.ts';
import {
  listPagesScript,
  type ListPagesResult,
} from '../src/silverbullet/scripts/list-pages.lua.ts';
import { readPageScript, type ReadPageResult } from '../src/silverbullet/scripts/read-page.lua.ts';
import {
  searchPagesScript,
  type SearchPagesResult,
} from '../src/silverbullet/scripts/search-pages.lua.ts';

const VERIFIED_REPORT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '_bmad-output',
  'implementation-artifacts',
  'latency-baseline.md',
);
// Misconfigured / transient-failure runs write here so a previously
// verified `latency-baseline.md` is preserved on disk. Operators only see
// real measurements at `latency-baseline.md`.
const NOT_VERIFIED_REPORT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '_bmad-output',
  'implementation-artifacts',
  'latency-baseline.not-verified.md',
);
const NFR1_BUDGET_MS = 500;
const WARMUP_ITERATIONS = 5;
const DEFAULT_ITERATIONS = 100;
const MIN_ITERATIONS = 10;

type OperationName = 'read_page' | 'list_pages' | 'search_pages';

type Percentiles = {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
};

type OperationReport = {
  readonly op: OperationName;
  readonly samples: ReadonlyArray<number>;
  readonly percentiles: Percentiles;
  readonly budgetMs: number;
  readonly nfr: 'NFR1' | 'NFR2';
};

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  // Nearest-rank percentile. For n=100, q=0.99 → idx 98 (the 99th smallest);
  // q=0.95 → idx 94; q=0.5 → idx 49. Without the `Math.ceil(...) - 1`
  // adjustment, `Math.floor(q * n)` returns idx 99 for p99 — the maximum
  // sample, biasing the report so "p99" is in fact the max.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? Number.NaN;
}

function summarise(samples: ReadonlyArray<number>): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
}

function fmt(ms: number): string {
  if (Number.isNaN(ms)) return 'n/a';
  return `${ms.toFixed(1)}ms`;
}

async function measure(
  label: OperationName,
  iterations: number,
  run: () => Promise<unknown>,
): Promise<OperationReport> {
  // Warmup — discard timings so JIT / connection-establishment effects
  // don't skew the percentile calculation.
  for (let i = 0; i < WARMUP_ITERATIONS; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await run();
    samples.push(performance.now() - t0);
  }
  return {
    op: label,
    samples,
    percentiles: summarise(samples),
    budgetMs: NFR1_BUDGET_MS,
    nfr: 'NFR1',
  };
}

function renderReport(opts: {
  readonly date: string;
  readonly silverbulletUrl: string;
  readonly iterations: number;
  readonly results: ReadonlyArray<OperationReport>;
}): string {
  const lines: string[] = [];
  lines.push('# Latency Baseline — `bmad-silverbullet-mcp`');
  lines.push('');
  lines.push(`**Date:** ${opts.date}`);
  lines.push(`**SilverBullet:** ${opts.silverbulletUrl}`);
  lines.push(
    `**Iterations per op:** ${String(opts.iterations)} (after ${String(WARMUP_ITERATIONS)} warmup)`,
  );
  lines.push('');
  lines.push('## Per-operation latency (round-trip via the Runtime API)');
  lines.push('');
  lines.push('| op | p50 | p95 | p99 | NFR | budget |');
  lines.push('|---|---|---|---|---|---|');
  let anyOver = false;
  for (const r of opts.results) {
    const status = r.percentiles.p95 <= r.budgetMs ? 'OK' : 'OVER';
    if (status === 'OVER') anyOver = true;
    lines.push(
      `| \`${r.op}\` | ${fmt(r.percentiles.p50)} | ${fmt(r.percentiles.p95)} | ${fmt(r.percentiles.p99)} | ${r.nfr} (${String(r.budgetMs)}ms p95) | ${status} |`,
    );
  }
  lines.push('');
  if (anyOver) {
    lines.push('## Findings — budget breach detected');
    lines.push('');
    lines.push(
      '- One or more operations exceeded the NFR1 (500ms p95) read-side budget. Optimisation seams (per `architecture.md:1486-1521`):',
    );
    lines.push(
      '  - **Bundle read-side queries into a single multi-statement Lua script.** Collapses the `edit_page` 4-round-trip case (config + meta + read + write) to 2 round-trips. No seam changes required to the runtime client interface.',
    );
    lines.push(
      '  - **Add an etag-revalidating cache for `query-config-blocks`** (D2 deferred optimisation — `architecture.md:288`). Permission-block fetches are the read-side overhead per tool call; caching them under a short TTL is mechanically safe given D2\'s "next operation refetches" contract.',
    );
    lines.push('');
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push(
      "- All measured read-side operations are within NFR1's 500ms p95 budget. No optimisation work required at this time.",
    );
    lines.push('');
  }
  lines.push('## Raw samples (ms, sorted ascending)');
  lines.push('');
  for (const r of opts.results) {
    lines.push(`### \`${r.op}\``);
    lines.push('');
    lines.push('```');
    const sorted = [...r.samples].sort((a, b) => a - b);
    lines.push(sorted.map((s) => s.toFixed(2)).join(', '));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function renderNotVerified(opts: {
  readonly date: string;
  readonly reason: string;
  readonly iterations: number;
}): string {
  return [
    '# Latency Baseline — `bmad-silverbullet-mcp`',
    '',
    `**Date:** ${opts.date}`,
    '**Status:** NOT VERIFIED — re-run with a live SilverBullet instance accessible.',
    '',
    `**Why:** ${opts.reason}`,
    '',
    '## Harness configuration',
    '',
    `- Iterations per op (default): ${String(opts.iterations)}`,
    `- Warmup iterations (discarded): ${String(WARMUP_ITERATIONS)}`,
    '- Operations measured: `read_page`, `list_pages`, `search_pages`',
    '- Timing source: `performance.now()` (monotonic, sub-millisecond precision)',
    '- Latency budgets: NFR1 (500ms p95) for read-side ops; NFR2 (1s p95) for write-side ops (Epic 2 territory).',
    '',
    '## Findings',
    '',
    '- p95 latency UNVERIFIED on this run. Re-run via `npm run latency-baseline` once a live SilverBullet instance with the Runtime API enabled is reachable. The harness will overwrite this file with measured values.',
    '- Optimisation seams remain available if a future run reveals budget breaches:',
    '  - Bundle read-side queries into a single multi-statement Lua script (collapses 4 round-trips → 2 for `edit_page`). `architecture.md:1486-1487`.',
    '  - Add etag-revalidating cache for `query-config-blocks` (D2 deferred). `architecture.md:288`.',
    '',
    '## Verification path',
    '',
    "Story 1.10 wires the read-side tool handlers; Story 1.11 wires the startup ladder. The first end-to-end smoke against a live SB will exercise the runtime client through real tool invocations. Re-run this harness at that point — the results feed back into the architecture's NFR1/NFR2 verification.",
    '',
  ].join('\n');
}

async function writeVerifiedReport(content: string): Promise<void> {
  await writeFile(VERIFIED_REPORT_PATH, content, 'utf8');
  console.log(`[latency-baseline] wrote ${VERIFIED_REPORT_PATH}`);
}

// Fail-soft variant for the NOT-VERIFIED stub paths. Wraps the write so a
// filesystem error (read-only mount, missing parent dir on a fresh checkout)
// does not escape as an unhandled rejection — the caller still reaches its
// `process.exit` line.
async function writeNotVerifiedStub(content: string): Promise<void> {
  try {
    await writeFile(NOT_VERIFIED_REPORT_PATH, content, 'utf8');
    console.log(`[latency-baseline] wrote ${NOT_VERIFIED_REPORT_PATH}`);
  } catch (err) {
    console.error(`[latency-baseline] failed to write NOT-VERIFIED stub: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const url = env.SILVERBULLET_URL;
  const token = env.SILVERBULLET_TOKEN;
  const refOverride = env.LATENCY_BASELINE_REF;
  const query = env.LATENCY_BASELINE_QUERY ?? 'a';
  const iterationsRaw = env.LATENCY_BASELINE_ITERATIONS;
  let iterations = DEFAULT_ITERATIONS;
  if (iterationsRaw !== undefined) {
    const parsed = Number(iterationsRaw);
    if (Number.isInteger(parsed) && parsed >= MIN_ITERATIONS) {
      iterations = parsed;
    } else {
      console.error(
        `[latency-baseline] LATENCY_BASELINE_ITERATIONS=${iterationsRaw} is not an integer ≥ ${String(MIN_ITERATIONS)}; using default ${String(DEFAULT_ITERATIONS)}.`,
      );
    }
  }
  const date = new Date().toISOString();

  if (url === undefined || url === '' || token === undefined || token === '') {
    console.error(
      '[latency-baseline] SILVERBULLET_URL and SILVERBULLET_TOKEN must be set; writing NOT-VERIFIED stub.',
    );
    await writeNotVerifiedStub(
      renderNotVerified({
        date,
        reason: 'SILVERBULLET_URL or SILVERBULLET_TOKEN env vars unset at harness invocation.',
        iterations,
      }),
    );
    process.exit(0);
  }

  const client = createRuntimeClient({
    config: { silverbulletUrl: url, silverbulletToken: token },
  });

  // Pre-flight — fail soft into the NOT-VERIFIED stub rather than crash.
  try {
    await client.ping();
    await client.probe();
  } catch (err) {
    const wrapped = infrastructureError(err);
    const underlying = wrapped.details.underlying;
    const reason = typeof underlying === 'string' ? underlying : JSON.stringify(underlying);
    console.error(`[latency-baseline] pre-flight failed: ${reason}`);
    await writeNotVerifiedStub(
      renderNotVerified({
        date,
        reason: `pre-flight failed: ${reason}`,
        iterations,
      }),
    );
    process.exit(0);
  }

  // Discover a real ref for read_page measurements unless the operator
  // pinned one via LATENCY_BASELINE_REF. Querying list_pages once before the
  // measurement loop avoids a chicken-and-egg "Index page doesn't exist"
  // failure on a fresh space.
  let ref: string;
  if (refOverride !== undefined && refOverride !== '') {
    ref = refOverride;
  } else {
    try {
      const list = await client.exec<ListPagesResult>(listPagesScript, {});
      const first = list.pages[0];
      if (first === undefined) {
        console.error('[latency-baseline] SB space has no pages; writing NOT-VERIFIED stub.');
        await writeNotVerifiedStub(
          renderNotVerified({
            date,
            reason:
              'SB space has no pages — populate at least one page or set LATENCY_BASELINE_REF to an existing ref.',
            iterations,
          }),
        );
        process.exit(0);
      }
      ref = first.ref;
      console.log(`[latency-baseline] auto-discovered read-page ref: ${ref}`);
    } catch (err) {
      const wrapped = infrastructureError(err);
      const underlying = wrapped.details.underlying;
      const reason = typeof underlying === 'string' ? underlying : JSON.stringify(underlying);
      console.error(`[latency-baseline] ref discovery failed: ${reason}`);
      await writeNotVerifiedStub(
        renderNotVerified({
          date,
          reason: `ref discovery via list_pages failed: ${reason}`,
          iterations,
        }),
      );
      process.exit(0);
    }
  }

  console.log(
    `[latency-baseline] measuring ${String(iterations)} iterations per op against ${url}`,
  );
  const ops: ReadonlyArray<{
    readonly name: OperationName;
    readonly run: () => Promise<unknown>;
  }> = [
    { name: 'read_page', run: () => client.exec<ReadPageResult>(readPageScript, { ref }) },
    { name: 'list_pages', run: () => client.exec<ListPagesResult>(listPagesScript, {}) },
    {
      name: 'search_pages',
      run: () => client.exec<SearchPagesResult>(searchPagesScript, { q: query }),
    },
  ];
  const results: OperationReport[] = [];
  for (const op of ops) {
    try {
      results.push(await measure(op.name, iterations, op.run));
    } catch (err) {
      const wrapped = infrastructureError(err);
      const underlying = wrapped.details.underlying;
      const reason = typeof underlying === 'string' ? underlying : JSON.stringify(underlying);
      console.error(`[latency-baseline] measurement failed during ${op.name}: ${reason}`);
      await writeNotVerifiedStub(
        renderNotVerified({
          date,
          reason: `measurement failed during ${op.name}: ${reason}`,
          iterations,
        }),
      );
      process.exit(0);
    }
  }
  await writeVerifiedReport(renderReport({ date, silverbulletUrl: url, iterations, results }));
  process.exit(0);
}

await main();
