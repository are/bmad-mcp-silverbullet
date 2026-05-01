/**
 * Result shape returned by {@link readPageScript}. `lastModified` is an
 * ISO-8601 UTC string emitted by SilverBullet's page-meta surface; the
 * `read_page` handler (Story 1.10) hands it to `freshness.touch(ref, new
 * Date(lastModified))`.
 *
 * @see AR23 (`epics.md:136`) — every `.lua.ts` exports the script template
 *   string AND the typed return value.
 */
export type ReadPageResult = {
  readonly content: string;
  readonly lastModified: string;
};

/**
 * Lua template that reads a page's body + last-modified timestamp.
 *
 * Params (envelope-bound — see `../envelope.ts`):
 * - `_p.ref: string` — the SB page ref to read.
 *
 * SB API (verified against `silverbulletmd/silverbullet` `plug-api/lua/space.lua`
 * at story-1.7 implementation time):
 * - `space.readPage(ref) → string`.
 * - `space.getPageMeta(ref) → { lastModified, ... }`.
 *
 * If the page is absent, SB raises a Lua error which the runtime client
 * surfaces as `infrastructure_error`; Story 1.10's `read_page` handler
 * narrows the underlying error into a `not_found` `DomainError` for the
 * agent. The Lua script itself is intentionally thin — error projection
 * lives in the TypeScript layer, not the Lua layer.
 *
 * Atomicity: the two SB calls are independent; an interleaving that
 * mutates the page between them would surface as a `lastModified` slightly
 * older than the just-read content. The freshness invariant catches this
 * on the next edit attempt — re-reading is cheap and idempotent.
 */
export const readPageScript = `local meta = space.getPageMeta(_p.ref)
local content = space.readPage(_p.ref)
assert(meta.lastModified, "read-page: page meta missing lastModified for ref " .. tostring(_p.ref))
return { content = content, lastModified = meta.lastModified }
`;
