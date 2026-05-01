import { makeRef, type Ref } from '../domain/ref.ts';

import { maxAccess, type AccessMode } from './access-mode.ts';
import { type ConfigBlock } from './config-block-parser.ts';

/**
 * The literal page reference that hosts global permission declarations
 * (D1 / `architecture.md:228`). A block on `CONFIG` applies to any page
 * not matched by a more-specific rule. The brand is constructed once at
 * module load — if `'CONFIG'` ever fails Ref validation (it won't, given
 * Story 1.2's rules), the import would throw, surfacing the bug at server
 * startup rather than at first tool call.
 */
export const CONFIG_PAGE: Ref = makeRef('CONFIG');

/**
 * Discriminate the three specificity tiers. `'global'` (CONFIG-page) <
 * `'scope'` (host page + descendants, ranked by root length) <
 * `'exact'` (host page only).
 */
type Specificity =
  | { readonly tag: 'global' }
  | { readonly tag: 'scope'; readonly length: number }
  | { readonly tag: 'exact'; readonly length: number };

function assertExhaustive(value: never): never {
  throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}

function specificityRank(spec: Specificity): 0 | 1 | 2 {
  switch (spec.tag) {
    case 'global':
      return 0;
    case 'scope':
      return 1;
    case 'exact':
      return 2;
    default:
      return assertExhaustive(spec);
  }
}

/**
 * `-1` means `a` is less specific than `b`; `1` more specific; `0` equal.
 *
 * Across tiers, ranks compare directly. Within `'scope'`, longer root wins
 * (a block on `Projects/Active` beats one on `Projects` for refs under
 * the deeper root). `'exact'` ties only arise when two `exact: true`
 * blocks declare the same root — which means they target the same host
 * page; tie-break by permissiveness happens in the main loop.
 */
function compareSpecificity(a: Specificity, b: Specificity): -1 | 0 | 1 {
  const ra = specificityRank(a);
  const rb = specificityRank(b);
  if (ra > rb) return 1;
  if (ra < rb) return -1;
  // Same tier. Within `'scope'`, longer root is more specific.
  if (a.tag === 'scope' && b.tag === 'scope') {
    if (a.length > b.length) return 1;
    if (a.length < b.length) return -1;
  }
  return 0;
}

/**
 * Resolve a page reference to its `AccessMode` per the D1 algorithm
 * (`architecture.md:231-272`):
 *
 * ```
 * resolveAccess(ref, blocks) -> AccessMode:
 *   bestSpec = null
 *   matchingModes = []
 *
 *   for block in blocks:
 *     root = block.page
 *
 *     if root === CONFIG_PAGE:
 *       spec = ('global',)
 *       matches = true
 *     elif block.exact:
 *       spec = ('exact', root.length)
 *       matches = (ref === root)
 *     else:
 *       spec = ('scope', root.length)
 *       matches = (ref === root) OR ref.startsWith(root + '/')
 *
 *     if not matches: continue
 *
 *     // Specificity ordering: exact > scope-by-longer-root > global.
 *     if bestSpec is null OR compareSpecificity(spec, bestSpec) > 0:
 *       bestSpec = spec
 *       matchingModes = [block.access]
 *     elif compareSpecificity(spec, bestSpec) === 0:
 *       matchingModes.push(block.access)
 *
 *   if matchingModes is empty:
 *     return 'none'                 // default-deny
 *
 *   return reduce(matchingModes, maxAccess)
 * ```
 *
 * Two ordering rules:
 *
 * 1. **Across specificities** — most-specific wins regardless of
 *    permissiveness. A more-specific `'none'` overrides a less-specific
 *    `'write'`. Security boundary preserved (AR16 / `epics.md:125`).
 * 2. **Within the same specificity** — most-permissive wins (OR-of-intents).
 *    Multiple equally-specific blocks compose as a permission union.
 *
 * Default-deny: any ref not matched by any block resolves to `'none'`.
 *
 * Pure: zero I/O (NFR19 / `epics.md:99`). Single-pass over `blocks`,
 * O(n) with constant per-iteration state.
 *
 * @see D1 (`architecture.md:205-276`).
 * @see AR12 / AR16 / NFR11 / NFR19 (`epics.md:120,125,85,99`).
 * @see AR58 (`epics.md:183`) — pure-domain core; this module imports from
 *   `domain/ref.ts` and `./access-mode.ts` only.
 */
export function resolveAccess(ref: Ref, blocks: readonly ConfigBlock[]): AccessMode {
  let bestSpec: Specificity | null = null;
  let matchingModes: AccessMode[] = [];

  for (const b of blocks) {
    let spec: Specificity;
    let matches: boolean;

    if (b.page === CONFIG_PAGE) {
      spec = { tag: 'global' };
      matches = true;
    } else if (b.exact) {
      spec = { tag: 'exact', length: b.page.length };
      matches = ref === b.page;
    } else {
      spec = { tag: 'scope', length: b.page.length };
      // Segment-boundary match (AR15 / `epics.md:124`): the host page
      // itself OR any descendant whose ref starts with `root + '/'`.
      // Bare `startsWith(root)` would incorrectly match `PersonalAssistant`
      // against a block on `Personal`.
      matches = ref === b.page || ref.startsWith(`${b.page}/`);
    }

    if (!matches) continue;

    if (bestSpec === null) {
      bestSpec = spec;
      matchingModes = [b.access];
      continue;
    }

    const cmp = compareSpecificity(spec, bestSpec);
    if (cmp === 1) {
      bestSpec = spec;
      matchingModes = [b.access];
    } else if (cmp === 0) {
      matchingModes.push(b.access);
    }
    // cmp === -1: less specific than the current best — discard.
  }

  if (matchingModes.length === 0) return 'none';

  // matchingModes is non-empty by the guard above; reduce without an
  // initial value is safe and avoids the typeof-undefined dance.
  return matchingModes.reduce((prev, curr) => maxAccess(prev, curr));
}
