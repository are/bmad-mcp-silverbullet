/**
 * Result shape returned by {@link queryConfigBlocksScript}. Each block is
 * the raw on-page declaration; Story 1.8's parser (`config-block-parser.ts`)
 * widens `access: string` into the closed `AccessMode` union and treats
 * out-of-range values as `config_error` per NFR11 / AR17 (fail-closed).
 *
 * @see AR23 (`epics.md:136`).
 * @see AR56 (`epics.md:181`) — `#mcp/<name>` tag namespace; permission
 *   blocks use exactly `#mcp/config`.
 */
export type QueryConfigBlocksResult = {
  readonly blocks: ReadonlyArray<{
    readonly page: string;
    readonly access: string;
    readonly exact?: boolean;
  }>;
};

/**
 * Lua template that fetches every `#mcp/config` YAML fence block in the
 * space.
 *
 * Params: none.
 *
 * SB API:
 * - `index.queryLuaObjects("mcp/config", {})` returns the indexed fence
 *   blocks as Lua tables with the YAML body parsed into fields. Each block
 *   carries:
 *   - `page` — ref of the page hosting the block.
 *   - `access` — string per the YAML body (validated downstream).
 *   - `exact` — optional boolean per the YAML body (defaults to false in
 *     the parser; absent from the result when not declared).
 *
 * No cache (D2 / `architecture.md:278-288`): every tool call refetches.
 * If the latency baseline justifies caching, an etag-revalidating layer
 * can be added between the runtime client and the engine without changing
 * either's interface.
 */
export const queryConfigBlocksScript = `local raw = index.queryLuaObjects("mcp/config", {})
local out = {}
for i, block in ipairs(raw) do
  assert(block.page, "query-config-blocks: block missing page field")
  assert(block.access, "query-config-blocks: block missing access field on page " .. tostring(block.page))
  local entry = { page = block.page, access = block.access }
  if block.exact ~= nil then entry.exact = block.exact end
  out[i] = entry
end
return { blocks = out }
`;
