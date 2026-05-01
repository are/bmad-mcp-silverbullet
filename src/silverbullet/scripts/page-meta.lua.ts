/**
 * Result shape returned by {@link pageMetaScript}. Carries the
 * `lastModified` timestamp Story 2.3's `edit_page` handler compares
 * against `freshness.get(ref)` to enforce the read-before-edit invariant
 * (FR20 / `epics.md:52`).
 *
 * @see AR23 (`epics.md:136`).
 */
export type PageMetaResult = {
  readonly lastModified: string;
};

/**
 * Lua template that returns a page's metadata without reading the body.
 *
 * Params (envelope-bound):
 * - `_p.ref: string` — the SB page ref whose metadata to fetch.
 *
 * SB API:
 * - `space.getPageMeta(ref)` → `{ lastModified, ... }` (additional fields
 *   exist but are not surfaced — Story 2.3's freshness check needs only
 *   `lastModified`; downstream stories that need more (e.g. permissions,
 *   tags) can extend the script's projection in a focused fix).
 *
 * If the page is absent, SB raises a Lua error which the runtime client
 * surfaces as `infrastructure_error`; the consumer handler (Story 2.3)
 * narrows it as appropriate.
 */
export const pageMetaScript = `local meta = space.getPageMeta(_p.ref)
assert(meta.lastModified, "page-meta: page meta missing lastModified for ref " .. tostring(_p.ref))
return { lastModified = meta.lastModified }
`;
