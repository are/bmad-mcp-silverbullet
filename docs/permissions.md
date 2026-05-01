# Permissions guide

This document explains how to author permission declarations for `mcp-silverbullet` directly inside
your SilverBullet space — using the same plain-markdown editor you already use for everything else.

If you just want to get started: paste a `#mcp/config` block on your `CONFIG` page (see
[Worked examples](#worked-examples) below for ready-to-paste snippets) and start asking your agent
about your notes.

## What `#mcp/config` is

Permission declarations are **SilverBullet-tag-indexed YAML fence blocks** authored inside ordinary
SilverBullet pages. They use the tag `#mcp/config` exactly. The MCP server queries SilverBullet's
tag index for these blocks before every tool call, so your changes take effect on the next agent
operation — no restart required.

The canonical block shape:

````markdown
```yaml #mcp/config
access: write          # one of: none | read | append | write
exact: false           # optional, default false
```
````

**The tag is matched literally.** SilverBullet indexes blocks by their declared tag. A typo in the
fence opener — `#mcp/cfg`, `#mcp-config`, `mcp/config` (without the `#`), `#config` — silently
fails to index, and the block is invisible to the engine. There is no audit-log entry for "tag
typo" because there is nothing to be malformed about; the index simply has no record. This is the
single most common authoring footgun. See
[Malformed-block behavior](#malformed-block-behavior) below for the failure modes that **do**
produce audit entries.

## The four access modes

Modes form a total order by permissiveness:

```
none < read < append < write
```

Higher modes include the lower modes:

| Mode     | Listing                  | Search                   | Direct read              | Append    | Edit / delete | Freshness check |
| -------- | ------------------------ | ------------------------ | ------------------------ | --------- | ------------- | --------------- |
| `none`   | Filtered out (invisible) | Filtered out (invisible) | Returns `not_found`      | Rejected  | Rejected      | n/a             |
| `read`   | Listed                   | Searchable               | Allowed                  | Rejected  | Rejected      | n/a             |
| `append` | Listed                   | Searchable               | Allowed                  | Allowed   | Rejected      | n/a (append exempt) |
| `write`  | Listed                   | Searchable               | Allowed                  | Allowed   | Allowed       | Yes (read-before-edit invariant) |

A few clarifying points worth pinning:

- **`none` is invisible, not advertised-but-blocked.** A direct `read_page` call on a `none`-mode
  page returns `not_found`, the same response as a page that doesn't exist. The agent does not
  learn that the page is there.
- **`append` is exempt from the read-before-edit invariant.** Appends are atomic and additive; the
  agent does not need to have read the page first to append to it.
- **`write` is the only mode that allows `edit_page` and `delete_page`**, and both are
  freshness-gated: the operation is rejected if the page was modified after the agent's last
  `read_page`. The agent must re-read and retry. Append is the explicit exception.

The permissiveness rank (`none < read < append < write`) is also used as the tie-break in the
resolution algorithm — see [Resolution algorithm](#resolution-algorithm) below.

## Block scope

A `#mcp/config` block's scope depends on the page that hosts it:

- **Global block** — a block on the page named `CONFIG` applies to **any page not matched by a
  more-specific rule**. This is your "set the default mode for the whole space" lever.
- **Scoped block (descendant-inclusive)** — a block on any other page applies to **the host page
  and all descendants**. Descendant-matching uses page-ref prefix: a block on `Projects/Active`
  covers `Projects/Active`, `Projects/Active/Foo`, and `Projects/Active/Foo/Bar`.
- **Scoped block with `exact: true`** — applies to **the host page only**, no descendants.

Without `exact`, a block on `Projects/Active` covers `Projects/Active/Foo` and
`Projects/Active/Foo/Bar`; with `exact: true`, it covers only `Projects/Active`.

## Resolution algorithm

For each tool call, the engine collects every `#mcp/config` block from the index and resolves the
target page's access mode using two rules:

1. **Across specificities — most specific wins**, regardless of permissiveness. A more-specific
   `none` overrides a less-specific `write`. This preserves the security boundary: you can carve
   out a `none` corner inside a `write` directory without worrying that the broader rule will
   "win".
2. **Within the same specificity — most permissive wins** (OR-of-intents). Two equally-specific
   blocks compose as a permission union; if one says `read` and another says `append`, the
   resolved mode is `append`.

Specificity ordering:

```
exact (matches host page only) > scope-by-longer-root > global (CONFIG)
```

Among scoped blocks, the one with the longer matching prefix is more specific.

**Default-deny:** any page not matched by any block resolves to `none`. This is the safe baseline.
You opt your space in to the trust contract by authoring blocks; pages you forget to mark stay
invisible.

## Worked examples

The four scenarios below cover the common shapes. Each shows the block(s) you would author, the
page(s) they affect, and the resolved access for one or two probe refs. Page names match the kind
of structure most SilverBullet spaces actually have.

### Example A — Global block on `CONFIG`

Set a default mode for the whole space.

On the `CONFIG` page:

````markdown
```yaml #mcp/config
access: read
```
````

Resolved access:

| Probe ref               | Resolved mode | Why                                            |
| ----------------------- | ------------- | ---------------------------------------------- |
| `Projects/Active/Foo`   | `read`        | No more-specific block matches; global wins.   |
| `Personal/Journal/2026-04-21` | `read`  | Same — no more-specific block matches.         |

Now your whole space is listed and readable. Search and `read_page` work everywhere; `append`,
`edit`, and `delete` are rejected (they need `append` or `write`).

### Example B — Directory-scoped block

Grant `write` on an active project's pages, while keeping the rest at the global default.

On `CONFIG`:

````markdown
```yaml #mcp/config
access: read
```
````

On `Projects/Active`:

````markdown
```yaml #mcp/config
access: write
```
````

Resolved access:

| Probe ref                       | Resolved mode | Why                                                                |
| ------------------------------- | ------------- | ------------------------------------------------------------------ |
| `Projects/Active`               | `write`       | The block on `Projects/Active` matches its host page exactly.      |
| `Projects/Active/Foo`           | `write`       | Descendant of `Projects/Active` (no `exact`), so the block applies. |
| `Projects/Active/Foo/Bar`       | `write`       | Same — prefix-match descendant.                                    |
| `Projects/Archive/2025-Q4`      | `read`        | No `Projects/Archive` block; falls through to the global `read`.   |

The agent can now read, append, edit, and delete inside `Projects/Active/**` — and the
read-before-edit invariant kicks in for any non-`append` change.

### Example C — `exact: true` block

Make a single page `write` without granting `write` to its descendants.

On `Daily/2026-04-30`:

````markdown
```yaml #mcp/config
access: write
exact: true
```
````

For this example, assume only the global `CONFIG` block from Example A is also in place
(`access: read`). The `Projects/Active` block from Example B is **not** present here — these
worked examples do not stack.

Resolved access:

| Probe ref               | Resolved mode | Why                                                                                  |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `Daily/2026-04-30`      | `write`       | `exact: true` matches the host page exactly.                                         |
| `Daily/2026-04-30/Notes` | `read`       | `exact: true` blocks **do not** match descendants; falls through to the global `read`. |
| `Daily/2026-04-29`      | `read`        | Different page; the `exact` block does not match.                                    |

`exact: true` is the right tool when you want to give the agent edit access to today's daily-log
page without granting the same mode to a sub-page you may add later.

### Example D — Personal journal `none`

Keep a directory invisible to the agent — it should not appear in listings, in search results, or
in direct-fetch responses.

On `Personal/Journal`:

````markdown
```yaml #mcp/config
access: none
```
````

(Other blocks may be in place; `none` here is more specific than the global, and "most specific
wins" preserves the boundary even if the global is `write`.)

Resolved access:

| Probe ref                            | Resolved mode | Visible to agent?                                                              |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `Personal/Journal`                   | `none`        | Filtered from `list_pages` and `search_pages`; `read_page` returns `not_found`. |
| `Personal/Journal/2026-04-21`        | `none`        | Same — descendant of the scoped block.                                         |
| `Personal/Journal/2026-04-21/Mood`   | `none`        | Same — deeper descendant.                                                      |
| `Projects/Active/Foo`                | (other rules apply) | Unaffected — different scope.                                            |

The agent never receives a hint that `Personal/Journal/**` exists. The audit log records every
attempt the agent made to list or search, so you can see what it was trying to find — but the
agent's view is genuinely empty for these refs.

> **Important:** `none` is **best-effort on common-path interfaces** (listing, search, direct
> fetch). It is **not** a hard isolation boundary against a determined agent that can author or
> invoke Lua via SilverBullet's own programmability, or follow indirect references in non-`none`
> pages. See [`docs/threat-model.md`](./threat-model.md) for the full disclosure. If you need a
> hard boundary, use a separate SilverBullet space (or another tool) for that material.

## Malformed-block behavior

The permission engine is **fail-closed** on malformed blocks. The behavior depends on the failure
mode:

| Failure                                                       | What happens                                                                                                  | Audit-log entry                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unparseable YAML inside the fence                             | Block is ignored; resolution falls through to the next-most-specific rule (or default-deny).                  | Yes — `reason: config_error`.            |
| `access` value not one of `none`, `read`, `append`, `write`   | Block is ignored; resolution falls through.                                                                   | Yes — `reason: config_error`.            |
| `exact` value is not a YAML boolean (`true` / `false`)        | Block is ignored; resolution falls through. YAML accepts `yes`/`no`/`1`/`0`/`"true"` as truthy-ish, but the engine requires a real boolean — `exact: yes` silently fails closed. Use `exact: true` or `exact: false`. | Yes — `reason: config_error`.            |
| Tag typo (`#mcp/cfg`, `#mcp-config`, `mcp/config`, `#config`) | Block is **not indexed** by SilverBullet at all. The engine never sees it; no audit entry.                    | No — engine has no record of the block.  |

The takeaways:

- **Tag typos fail silently** — they're invisible to the engine and to the audit log. If a block
  isn't taking effect, the first thing to check is the fence opener. Copy it from this guide.
- **`config_error` does not unblock a request.** When a block is ignored, the engine continues
  resolution **without** that block. If the only matching block was the malformed one, the result
  is default-deny (`none`). Bad blocks make pages less accessible, never more.
- **Resolution continues with the bad block removed**, not stopped. A `config_error` somewhere in
  the index does not break access for unrelated pages.

### Verifying a block is actually indexed

Because tag typos are invisible to the engine, the fastest debug recipe when a block "isn't taking
effect" is to confirm SilverBullet is indexing it under the expected tag:

- In SilverBullet's UI, open the **Tags** page (or the tag index — the exact UI varies by SB
  version) and look for `#mcp/config`. Pages with a correctly-tagged block appear there.
- If the page hosting your block does not appear, the fence opener is wrong. Compare it
  character-for-character against the block in [What `#mcp/config` is](#what-mcpconfig-is) — the
  three-backtick fence, the `yaml` language tag, and the literal `#mcp/config` text are all
  required.
- If the page does appear in the tag index but the block still has no effect, the failure is one
  of the table rows above and the audit log will record `reason: config_error` on the next tool
  call — `tail -f` your audit log to confirm.

## Updates take effect on the next tool call

There is no permission cache inside this server. Every MCP tool call refetches `#mcp/config`
blocks from SilverBullet's tag index before the engine resolves access. No restart, no TTL, no
invalidation step on the server side.

The one moving part is **SilverBullet's own tag indexer**: when you save a page with a new or
changed `#mcp/config` block, SilverBullet re-indexes the page asynchronously. In typical use the
new block is visible to the engine on the very next tool call; if you save a block and immediately
ask the agent to act, an in-flight indexer pass may briefly mean the old rule is still in effect.
The window is small (sub-second on local instances) and self-healing — the next call after the
indexer settles sees the new state.

This is also why permission edits are observable in the audit log within one or two tool calls of
the edit — the engine sees the new state as soon as SilverBullet's index does.

## Starter templates and patterns

A paste-ready starter template covering common space layouts (work pages = `write`, archive pages
= `read`, daily-log pages = `append`, personal pages = `none`) lands in `docs/starter-template.md`
alongside Story 2.8.

Until that ships, the four worked examples above cover the patterns most SilverBullet spaces
actually use; mix and match to suit yours.
