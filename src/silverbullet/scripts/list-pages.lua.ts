/**
 * Result shape returned by {@link listPagesScript}. The full ref + last-
 * modified timestamp are surfaced so Story 1.10's `list_pages` handler can
 * filter against the permission engine and digest the result for the
 * audit log without a second SB round-trip.
 *
 * @see AR23 (`epics.md:136`).
 */
export type ListPagesResult = {
  readonly pages: ReadonlyArray<{
    readonly ref: string;
    readonly lastModified: string;
  }>;
};

/**
 * Lua template that lists every page in the SB space (no filtering;
 * permission filtering happens in TypeScript per AR58 acyclic boundary).
 *
 * Params: none — the envelope still wraps `_p = {}` for shape consistency.
 *
 * SB API (verified against `silverbulletmd/silverbullet` index module at
 * story-1.7 implementation time):
 * - `index.queryLuaObjects("page", {})` → array of page objects with
 *   `name` and `lastModified` fields. The script renames `name` → `ref`
 *   so downstream TypeScript code uses the established domain vocabulary.
 *
 * Note on `none`-mode invisibility (FR8 / FR10 `epics.md:34,36`): this
 * script returns ALL pages; the handler (Story 1.10) filters out
 * `none`-mode pages before the agent sees the result. The audit logger
 * (Story 1.5 + AR31) records the agent-visible (filtered) ref list, NOT
 * the full pre-filter list.
 */
export const listPagesScript = `local raw = index.queryLuaObjects("page", {})
local out = {}
for i, page in ipairs(raw) do
  assert(page.name, "list-pages: index row missing name field")
  assert(page.lastModified, "list-pages: index row missing lastModified for " .. tostring(page.name))
  out[i] = { ref = page.name, lastModified = page.lastModified }
end
return { pages = out }
`;
