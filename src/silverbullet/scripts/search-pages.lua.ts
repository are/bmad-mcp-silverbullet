/**
 * Result shape returned by {@link searchPagesScript}. Hits carry the page
 * ref + relevance score; no snippets, no metadata excerpts — Story 1.10's
 * `search_pages` handler post-filters via the permission engine and the
 * audit log records hits as a ref list per AR31 (`epics.md:146`).
 *
 * @see AR23 (`epics.md:136`).
 */
export type SearchPagesResult = {
  readonly hits: ReadonlyArray<{
    readonly ref: string;
    readonly score: number;
  }>;
};

/**
 * Lua template that runs full-text search and returns ranked hits.
 *
 * Params (envelope-bound):
 * - `_p.q: string` — the search query. **Field name avoids the reserved
 *   space-lua keyword `query`** (used by SB's integrated-query DSL alongside
 *   `from`, `where`, `select`, etc.). Using `_p.query` causes a Lua parse
 *   error: "unexpected symbol near 'q'" at the `.query` access site.
 *
 * Search API (verified at story-1.7 implementation time against a live SB):
 * - `silversearch.search(q, opts)` from the **silversearch** plug
 *   (https://github.com/MrMugame/silversearch). Registered as a syscall by
 *   the plug's `worker/silversearch.plug.yaml`. Returns an array of
 *   `ResultPage` objects (`shared/global.ts`); we project `{ name, score }`
 *   into `{ ref, score }` and drop the heavyweight per-hit fields
 *   (`content`, `matches`, `excerpts`, `foundWords`) the agent never sees.
 *   The second arg is **mandatory** — the plug worker dereferences
 *   `options.silent` without a default, so omitting it throws
 *   "Cannot read properties of undefined (reading 'silent')". An empty
 *   table `{}` is the canonical "use defaults" call shape.
 *
 * Why this plug instead of a core SB API: core SB exposes no FTS-style
 * search syscall in the space-lua surface. `space.searchPages` is **not**
 * defined ("attempt to call a nil value" at runtime); `index.queryLuaObjects`
 * is structural-query only and would require us to fan out reads + scan
 * content in Lua, which is both slow and a re-implementation of what
 * silversearch already does well. Coupling here is acknowledged: the MCP
 * server's `search_pages` tool requires the silversearch plug installed in
 * the target SB space. Documented as a deployment prerequisite for Epic 1
 * smoke; revisit if a future SB release ships a built-in FTS syscall.
 *
 * No `none`-mode filtering happens here — that is the handler's
 * responsibility (FR9 / FR10 / `epics.md:35,36`). The script returns the
 * full hit list and the handler drops `none`-mode hits before the agent
 * sees them.
 */
export const searchPagesScript = `local raw = silversearch.search(_p.q, {})
local out = {}
for i, hit in ipairs(raw) do
  assert(hit.name, "search-pages: hit missing name field")
  assert(hit.score ~= nil, "search-pages: hit missing score field for " .. tostring(hit.name))
  out[i] = { ref = hit.name, score = hit.score }
end
return { hits = out }
`;
