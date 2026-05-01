# Story 1.5: Audit Logger (JSONL, ULID, Digest, Drain)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As Maya reviewing agent activity post-hoc,
I want a JSONL audit log written to a platform-appropriate state directory with non-blocking writes, ULID entry IDs, and a `digest()` helper for response payloads,
so that every agent operation produces exactly one durable, human-readable record without stalling the tool-call path.

## Acceptance Criteria

**AC1 — Schema-v1 module at `src/audit/schema.ts` defines the wire shape exactly per D4**

**Given** the audit schema module at `src/audit/schema.ts`,
**When** I import its public surface,
**Then** it exports:
- `AUDIT_SCHEMA_VERSION = 1 as const` — the integer literal that lands in every entry's `v` field. Bumping this constant signals a schema break per NFR16 (`epics.md:94`, `architecture.md:1177`, AR29 / `epics.md:144`).
- `type AuditEntryId = string & { readonly __brand: 'AuditEntryId' }` — branded ULID per `architecture.md:1009` and AR29.
- `type AuditDecision = 'allowed' | 'rejected'` — closed two-value union per D4 (`architecture.md:419`).
- `type AuditEntry` — the full wire shape with `v`, `t` (ISO 8601 UTC), `id`, `tool`, `args`, `decision`, `response`, `durationMs` required, plus `reason?`, `details?`, `failedOperation?` conditional. Field names are `camelCase` exactly as defined in D4 (AR55 / `architecture.md:912-914`). Top-level fields exactly as listed in D4 (`architecture.md:405`, `epics.md:144`).
- `type AuditEntryInput = Omit<AuditEntry, 'v' | 't' | 'id'>` — the handler-side input. The audit logger fills `v`/`t`/`id` automatically; handlers never construct those.

**And** the `reason` field is typed as `string` (NOT a closed union) for forward-compatibility with Story 1.6's `ReasonCode` enum — which lands AFTER this story (`architecture.md:818` "DomainError + formatter ... depends on ... ReasonCode enum"). Story 1.6 will reconcile by re-exporting / unifying the type. **Do NOT import from `src/domain/error.ts` for the `reason` shape** — that module currently exposes only the placeholder `DomainError` (`src/domain/error.ts:9-12`), and tightening the audit `reason` to a closed union ahead of Story 1.6 risks bumping the schema version unnecessarily (NFR16).

**And** the `args` field is typed `unknown` — agent intent is logged in full per AR31 / `architecture.md:441`, never narrowed at the schema layer; handlers pass the raw input object.

**And** the `response` field is typed `unknown` — handlers construct the shape (digest `{ size, sha256 }`, ref list, or error projection) per AR31. The schema does not constrain it beyond JSON-serializability.

**And** the `failedOperation` field is `{ readonly index: number; readonly operation: object } | undefined` — for batch errors only (FR26 / `epics.md:165` AR46).

**AC2 — `digest(content): { size, sha256 }` at `src/audit/digest.ts` is pure and deterministic**

**Given** the digest helper at `src/audit/digest.ts`,
**When** I import its public surface,
**Then** it exports `digest(content: string): { size: number; sha256: string }` where:
- `size` is the **byte length** of the UTF-8 encoded content (`Buffer.byteLength(content, 'utf8')`), NOT the JS string length. UTF-8 byte length is the file-on-disk metric users will reconcile against; JS `.length` counts UTF-16 code units which mismatches multi-byte characters.
- `sha256` is the lowercase hex-encoded SHA-256 digest of the UTF-8 bytes (`createHash('sha256').update(content, 'utf8').digest('hex')`). The hex string is exactly 64 lowercase hex characters.

**And** the function is pure: no I/O, no clock, no global state. Same input always yields the same output (NFR19 spirit; AR58 places `audit/digest` in the pure-domain core).

**And** the digest is **never** computed over `none`-mode content — that's the handler's responsibility (NFR6 / `epics.md:78`); this helper just hashes whatever it's given. Documented in JSDoc.

**AC3 — In-tree ULID generator inside `src/audit/audit-logger.ts` produces 26-char Crockford Base32 IDs, monotonic within a millisecond**

**Given** the ULID generator factory at `src/audit/audit-logger.ts`,
**When** the audit logger constructs IDs for entries,
**Then** every emitted `id` value:
- Is exactly 26 ASCII characters.
- Uses the Crockford Base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`).
- The first 10 characters encode the timestamp (48 bits of milliseconds since the Unix epoch, big-endian).
- The last 16 characters encode 80 bits of randomness.
- Is parseable as a ULID per the spec (`https://github.com/ulid/spec`).

**And** monotonicity holds: when two consecutive `id`s are generated within the same millisecond, the second is **strictly lexically greater** than the first. The implementation increments the previous randomness by 1 (treating the 10 random bytes as a big-endian integer); fresh randomness is drawn only when the millisecond changes.

**And** if the random-increment overflows (the random portion was already at its maximum), the generator either:
- Re-draws fresh randomness for the next call (acceptable; documented), OR
- Throws a `RangeError` (also acceptable; documented). Pick one and document the choice in JSDoc.

The probability of overflow within a single millisecond is ~2⁻⁸⁰ per call; a real workload will never hit it. The behaviour just needs to be defined.

**And** the generator is constructed via DI: the factory accepts `clock: () => Date` and `randomBytes: (n: number) => Uint8Array` as injected functions (defaults wire `() => new Date()` and `(n) => crypto.randomFillSync(new Uint8Array(n))`). Tests use a fake clock + a deterministic `randomBytes` to assert format, monotonicity, and time-prefix behaviour with no real time / real randomness.

**AC4 — Path resolver `resolveAuditLogPath(opts)` is pure and matches D4 platform rules**

**Given** the path resolver at `src/audit/audit-logger.ts`,
**When** I call `resolveAuditLogPath({ env, platform, homeDir, localAppData? })`,
**Then** the resolved string is:
- `env.MCP_SILVERBULLET_AUDIT_LOG_PATH` verbatim, when that variable is set to a non-empty absolute path. Story 1.4 already validated absoluteness at config-load time (`src/config/config.ts:64-66`), but this resolver re-asserts via `path.isAbsolute` for defence-in-depth — a non-absolute override is treated the same as "not set".
- Otherwise on Unix-like platforms (`platform !== 'win32'`):
  - `${env.XDG_STATE_HOME}/mcp-silverbullet/audit.jsonl` when `XDG_STATE_HOME` is set to a non-empty absolute path.
  - `${homeDir}/.local/state/mcp-silverbullet/audit.jsonl` otherwise (XDG fallback per the spec; D4 `architecture.md:394`, AR27 `epics.md:142`).
- Otherwise on Windows (`platform === 'win32'`):
  - `${localAppData}\mcp-silverbullet\audit.jsonl` when `localAppData` (resolved from `env.LOCALAPPDATA`) is set to a non-empty absolute path.
  - `${homeDir}\AppData\Local\mcp-silverbullet\audit.jsonl` otherwise (the documented Windows fallback when `%LOCALAPPDATA%` is unset is rare but possible — running Node from a stripped environment).

**And** path joining uses `node:path`'s platform-aware `path.join` so separators are correct per platform. **Do not hand-concatenate with `/`** — the unit must work the same on Windows (where the unit is exercised in CI when Windows support lands; for now the test suite is POSIX-only, see `deferred-work.md:8`).

**And** the function is pure: no `fs.*` calls, no `os.*` calls, no reads of `process.env` or `process.platform`. All inputs arrive via the `opts` parameter (NFR19 / AR58). Production wiring (Story 1.11) reads `process.env`, `process.platform`, and `os.homedir()` and passes them in.

**And** the function does NOT create the directory — that's `ensureAuditDir`'s job (AC5).

**AC5 — `ensureAuditDir(filePath)` creates the parent directory recursively with mode `0o700`**

**Given** the directory bootstrap helper at `src/audit/audit-logger.ts`,
**When** I call `ensureAuditDir(filePath: string)`,
**Then** it computes the parent directory via `path.dirname(filePath)` and calls `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`.

**And** if creation fails (filesystem permission denied, read-only mount, etc.), the function lets the underlying `Error` throw — Story 1.11's startup ladder catches it and produces an AR39 FATAL+hint per the documented exit-1 contract (`architecture.md:497-501`). This story does NOT swallow or reformat the error.

**And** mode `0o700` is documented in JSDoc with the rationale: the audit log can carry agent-supplied content (FR27/FR28) and should be owner-only readable on multi-user systems.

**Note:** `mkdirSync` with `mode: 0o700` is a no-op for the mode bits on Windows (Windows ignores POSIX permissions; ACLs apply). That is acceptable for MVP — Windows isolation comes from the user's own profile. Documented in the JSDoc.

**AC6 — `openAuditStream(filePath)` opens an append-only write stream**

**Given** the stream-opener helper at `src/audit/audit-logger.ts`,
**When** I call `openAuditStream(filePath: string)`,
**Then** it returns a `NodeJS.WritableStream` produced by `fs.createWriteStream(filePath, { flags: 'a' })` — append-only, no truncation. Matches D4 `architecture.md:448` and AR32 `epics.md:147`.

**And** the stream is NOT auto-closed by this helper. The caller (`createAuditLogger` in production wiring; the test harness in tests) owns the lifecycle.

**And** stream errors propagated via the `'error'` event are NOT silently swallowed by `openAuditStream` itself — the audit logger factory subscribes to `'error'` and handles them per AC10 (AR34 fail-policy).

**AC7 — `createAuditLogger(opts)` returns an `AuditLogger` with `write(entry)` non-blocking and `close(): Promise<void>` for shutdown**

**Given** the factory at `src/audit/audit-logger.ts`,
**When** I call `createAuditLogger({ stream, clock, randomBytes, logger })`,
**Then** it returns an object with the shape:
```typescript
type AuditLogger = {
  write(entry: AuditEntryInput): void;
  close(): Promise<void>;
};
```

**And** `write(entry)`:
- Constructs the wire-shape `AuditEntry` by stamping `v: AUDIT_SCHEMA_VERSION`, `t: clock().toISOString()`, and `id: <next ULID>` onto the supplied `entry`. Field order in the serialized JSON is `v, t, id, tool, args, decision, response, durationMs, reason?, details?, failedOperation?` — `JSON.stringify` preserves insertion order, so construct the object literal accordingly. Stable field order makes the on-disk JSONL human-greppable (AR26 / NFR18).
- Serializes to a single line: `JSON.stringify(entry) + '\n'`. The trailing `\n` is the JSONL record terminator.
- Calls `stream.write(line)`. If the call returns `true`, the entry is buffered fine and `write` returns immediately. If `false` (kernel buffer full / backpressure), enqueue the **already-serialized line string** in an in-memory FIFO queue and rely on the `'drain'` handler (AC8) to flush. Do NOT enqueue the unstamped `entry` — re-serializing on drain would risk timestamp drift.
- Returns `void` — never a `Promise`. The tool-call response path **never awaits** `write` (NFR17 / `epics.md:95`, AR32 / `epics.md:147`, AR61 / `epics.md:188` — "audit-write is the *only* sanctioned `void someAsync()` use site").

**And** `close()`:
- Returns a `Promise<void>` that resolves when the queue is empty AND `stream.end()` has flushed.
- Implementation: if the queue has entries, install a `'drain'` listener that flushes them; once the queue is empty, call `stream.end(callback)` — resolve when the callback fires. If the queue is already empty at call-time, call `stream.end(callback)` immediately.
- Designed to complete within NFR9's 1s shutdown budget on any reasonable disk. The implementation does NOT add artificial timeouts; the budget is enforced by Story 1.11's hard-stop force-exit at ~900ms (`epics.md:172` AR51).
- Calling `close()` twice resolves the second `Promise` immediately without calling `stream.end()` a second time (the underlying stream throws `ERR_STREAM_WRITE_AFTER_END`; we guard against that with an `isClosed` flag).
- After `close()` resolves, subsequent `write()` calls become no-ops (do not attempt to write to an ended stream; do not throw).

**AC8 — Backpressure handling: queue drains on `'drain'` event in FIFO order; pending entries do not lose ordering**

**Given** an `AuditLogger` whose stream's `write` returned `false` (kernel buffer full),
**When** subsequent `write(entry)` calls arrive,
**Then** each new entry is stamped with its own `t`/`id` at call-time (preserving the temporal order of the calls), serialized, and **appended** to the queue. The queue is a plain array; entries flush in FIFO order. Ordering is preserved across the boundary between "buffered" and "queued" entries: the queue does not jump ahead of in-flight buffered entries (the kernel handles the in-flight entries; the queue handles only the over-the-watermark entries).

**And** when the stream emits `'drain'`:
- Pop entries from the queue front-to-back, calling `stream.write(line)` for each. If a `write` returns `false` again, stop — leave the rest in the queue and wait for the next `'drain'`.
- Continue until the queue is empty or `write` re-pauses.
- The `'drain'` listener must be re-attached (or registered with `.on(...)` not `.once(...)`) so it fires for every drain cycle in a long-running session.

**And** the queue has no documented size cap in MVP. The architecture's `bounded-size policy` language (`architecture.md:546`) refers to the **freshness** module, not the audit queue. NFR4 (bounded memory) is satisfied here by the simple fact that real audit traffic is bursty + short-lived; if a burst overwhelms the queue indefinitely, the disk is broken and the diagnostic WARN from the `'error'` handler will surface. Document this trade-off in JSDoc on the factory: "queue is unbounded; a wedged disk will surface as memory growth long before it surfaces as data loss — this is the chosen trade-off for forensic completeness."

**AC9 — Exactly-one-line invariant per `write` call**

**Given** an `AuditLogger`,
**When** any `write(entry)` produces a record on the stream (whether immediately or after a drain cycle),
**Then** the stream receives **exactly one** call to `stream.write(...)` carrying **exactly one** `\n`-terminated JSON line for that entry.

**And** no entry is split across multiple `stream.write` calls. No entry is duplicated. The handler's `finally`-block invariant (AR33 / `epics.md:148` "exactly-one-audit-entry-per-tool-call") is satisfied by this property combined with the handler-shape contract — Story 1.5 owns this half of the invariant.

**And** the logger never emits the prefix or suffix bytes (`'\n'`, leading whitespace, etc.) outside the JSON line. The JSONL parser invariant ("one JSON object per line") is preserved (AR26 / `epics.md:141`).

**AC10 — Stream `'error'` handling: WARN to diagnostic + continue serving (AR34 non-blocking-and-continue)**

**Given** an `AuditLogger` whose underlying stream emits an `'error'` event mid-session (disk full, file deleted, permissions revoked),
**When** the error fires,
**Then**:
- The factory's registered `'error'` listener calls `logger.warn(message)` exactly once via the diagnostic logger from Story 1.3 (`src/diagnostic/logger.ts`). The message names the kind of error and the audit log path (the path is configuration metadata, not user data; safe to log). Format: `audit log write failed: <err.message> — continuing without audit (path: <filePath>)`.
- An internal `errored` flag is set. Subsequent `write()` calls become **no-ops** — they neither throw nor enqueue. The stream is treated as gone.
- A `'drain'` event after `'error'` does NOT cause the queue to flush (the stream is broken). The queue is dropped on `'error'` to free memory.
- `close()` after `'error'` resolves immediately without calling `stream.end()` (which would throw on a destroyed stream).

**And** subsequent stream errors are NOT logged again — only the first error produces a WARN. (Spamming stderr with one WARN per failed write defeats the "loud enough on stderr that the user notices" goal — `architecture.md:455` D4 fail-policy.)

**And** the `logger.warn` call must use the diagnostic logger's `warn` method specifically (NOT `error`) — the stream failure is a degraded but not fatal condition (AR50 / `epics.md:171`: "warnings (audit-write failures, ...)").

**AC11 — `openAuditLogger(opts)` is the production composition: path → mkdir → stream → factory**

**Given** the production composition function at `src/audit/audit-logger.ts`,
**When** I call `openAuditLogger({ env, platform, homeDir, clock, logger })`,
**Then** it:
1. Calls `resolveAuditLogPath({ env, platform, homeDir, localAppData: env.LOCALAPPDATA })` (AC4).
2. Calls `ensureAuditDir(filePath)` (AC5).
3. Calls `openAuditStream(filePath)` (AC6).
4. Calls `createAuditLogger({ stream, clock, randomBytes: defaultRandomBytes, logger })` (AC7).
5. Returns `{ logger: AuditLogger; filePath: string }` so Story 1.11 can log a startup banner mentioning the resolved path.

**And** `openAuditLogger` is the **only** function in this module that calls `fs.*`. Tests do not exercise it directly — they exercise the four building blocks separately (the path resolver with hand-crafted env; the factory with a fake stream). Story 1.11's startup-ladder integration test exercises `openAuditLogger` end-to-end.

**And** the function's JSDoc explicitly documents that it touches the filesystem and is intended for production wiring only.

**AC12 — Unit tests cover digest determinism, path resolution, ULID format + monotonicity, schema-v1 invariants, write/drain/close paths, and the `'error'` fail-policy**

**Given** the unit tests at `src/audit/digest.test.ts` and `src/audit/audit-logger.test.ts`,
**When** `npm test` runs,
**Then** every adversarial-input case below is covered. **No test in this story performs real filesystem writes** — the AC1 of the epic story spec ("with a fake clock and fake write stream ... no real filesystem writes" `epics.md:425-427`) is the binding constraint. Path-resolver tests are fs-free by construction (pure function with injected env / platform / homeDir).

**Cases for `digest` (≥ 6):**
1. Empty string → `{ size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }` (the canonical SHA-256 of the empty input).
2. ASCII content (`'hello'`) → `size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'`.
3. Multi-byte UTF-8 (`'café'`) → `size: 5` (`'c' 'a' 'f' 0xC3 0xA9`), with the appropriate sha256. Asserts that `size` is the **byte length**, not the JS-string length (which is 4 for `'café'`).
4. 4-byte UTF-8 emoji (`'🎉'`) → `size: 4`, with the appropriate sha256.
5. Long content (≥ 64 KiB) → exact `size` and a non-empty 64-char hex sha256 (verifying the helper handles non-trivial inputs without buffering bugs).
6. Determinism: `digest(x)` called twice returns the exact same `{ size, sha256 }` object shape with identical values.

**Cases for `resolveAuditLogPath` (≥ 8):**
1. Override set (Unix): `env.MCP_SILVERBULLET_AUDIT_LOG_PATH = '/var/log/x/audit.jsonl'` → returns that path verbatim.
2. Override set (Windows): `env.MCP_SILVERBULLET_AUDIT_LOG_PATH = 'C:\\ProgramData\\x\\audit.jsonl'`, `platform: 'win32'` → returns that path verbatim.
3. Override is a relative path → falls through to default (defence-in-depth even though Story 1.4 already validated). Use `'./relative.jsonl'`; expect XDG / fallback path returned, not the relative path.
4. Override is empty string → treated as unset; falls through to default.
5. Unix XDG set: `env.XDG_STATE_HOME = '/x/state'`, `homeDir: '/home/u'`, `platform: 'linux'` → returns `'/x/state/mcp-silverbullet/audit.jsonl'`.
6. Unix XDG unset / empty: `homeDir: '/home/u'`, `platform: 'darwin'` → returns `'/home/u/.local/state/mcp-silverbullet/audit.jsonl'`.
7. Windows LOCALAPPDATA set: `env.LOCALAPPDATA = 'C:\\Users\\Maya\\AppData\\Local'`, `platform: 'win32'` → returns `'C:\\Users\\Maya\\AppData\\Local\\mcp-silverbullet\\audit.jsonl'`. **Use the platform-aware `path.win32.join` (or rely on `path.join` when `platform === 'win32'` is hard-coded into the test) so the test is deterministic on POSIX CI runners.** Practical hint: the resolver's branching on `platform === 'win32'` should call `path.win32.join` explicitly when in the Windows branch; that way the test runs on Linux CI and still produces backslash-joined paths.
8. Windows LOCALAPPDATA unset, `homeDir: 'C:\\Users\\Maya'`, `platform: 'win32'` → returns `'C:\\Users\\Maya\\AppData\\Local\\mcp-silverbullet\\audit.jsonl'`.

**Cases for the ULID generator (≥ 7):**
1. Format: 26 chars, all in the Crockford alphabet (regex `/^[0-9A-HJKMNP-TV-Z]{26}$/`).
2. Time prefix decoding: with `clock = () => new Date(0)`, the first 10 chars decode to milliseconds = 0 (e.g. `'00000000000'.padEnd(10, '0')`). With `clock = () => new Date(1_700_000_000_000)`, the first 10 chars decode to that millisecond value.
3. Different milliseconds: with two clock ticks 1 ms apart and the same canned randomness, the second ULID's time prefix is greater than the first's. Lexical comparison reflects time order.
4. Same millisecond, different randomness draws — the second ULID is strictly greater than the first (monotonicity via increment). Use a canned `randomBytes` that returns a fixed buffer; assert the second call's randomness portion is the increment of the first.
5. Same millisecond, monotonicity across many calls (≥ 100) — every consecutive pair satisfies `id_n < id_{n+1}` lexically.
6. Branded type assertion: at compile time `id` satisfies `AuditEntryId`; at runtime it's a string of length 26. (Type-assertion tests are usually compile-only; this is a runtime length check.)
7. Overflow behaviour (whichever you choose — re-randomize OR throw): with a `randomBytes` stub returning all-`0xff` bytes, the second call within the same ms either returns a fresh-randomness ULID (re-draw) OR throws `RangeError`. Assert against the documented choice.

**Cases for `AUDIT_SCHEMA_VERSION` (≥ 1):**
- `assert.strictEqual(AUDIT_SCHEMA_VERSION, 1)` — locks in the version constant. Bumping this is intentional per NFR16.

**Cases for `createAuditLogger` (≥ 12):**
1. **Schema-v1 round-trip:** `write({ tool: 'list_pages', args: { query: 'foo' }, decision: 'allowed', response: { refs: [] }, durationMs: 12 })` → exactly one `stream.write` call with a string ending in `'\n'`. `JSON.parse(line.trimEnd())` produces `{ v: 1, t: '<iso>', id: '<26-char-ulid>', tool, args, decision, response, durationMs }` — every required field present, no extra fields, key order matches the documented order.
2. **`t` is ISO 8601 UTC:** with `clock = () => new Date(Date.UTC(2026, 3, 30, 14, 23, 51, 123))`, `t` equals `'2026-04-30T14:23:51.123Z'` (regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` for any clock).
3. **`id` is monotonic across consecutive writes within the same clock tick** — assertable via stream-capture comparison.
4. **Rejected-decision entries serialize `reason` and `details`:** input `{ ..., decision: 'rejected', reason: 'freshness_violation', details: { lastModified: '...', lastReadAt: '...' } }` → `JSON.parse(line)` includes those exact fields.
5. **Allowed-decision entries OMIT `reason` / `details`:** input lacks the optional fields → `JSON.parse(line)` lacks the keys (not present, NOT `null`, NOT `undefined`-stringified). `exactOptionalPropertyTypes: true` discipline (Story 1.4 dev-notes line 401-407) — never assign `undefined` explicitly.
6. **Backpressure happy path:** `stream.write` stub returning `true` for every call, ten consecutive `write` calls, ten captured lines. No queue activity.
7. **Backpressure paused path:** stub `stream.write` returns `false` for the first call (fills the kernel buffer), then `true` after a `'drain'` emission. Two `write(entry)` calls back-to-back, then emit `'drain'`. Assert ordering: line-1 is captured immediately, line-2 is captured AFTER the drain (the test fake exposes the writes-array; the second entry is appended after `'drain'` fires). Both lines parse to the original entries with stamped `v`/`t`/`id`. `t` for line-2 reflects the clock at line-2's `write` call (NOT the `'drain'` time).
8. **Backpressure during multiple drain cycles:** `stream.write` stub returns `false`, `false`, `true`, `false`, `true` across five entries; verify the queue empties in FIFO order across the two `'drain'` events. Final captured lines parse to the five original entries in input order.
9. **`close()` immediately when queue is empty:** `await close()` resolves; assert `stream.end` was called exactly once; subsequent `write()` calls are no-ops (no captured writes).
10. **`close()` waits for queue to drain:** queue holds three entries; `close()` returns a pending promise; emit `'drain'` → entries flush → `stream.end` is called → promise resolves. Assert ordering and that `close()`'s promise resolves AFTER the third entry is captured.
11. **`close()` is idempotent:** calling `close()` twice resolves both promises; `stream.end` is called only once.
12. **`'error'` event:** stream emits an `'error'` with a fake `Error('disk full')`. Assert exactly one `logger.warn` call whose message contains `'disk full'` AND the path AND `'audit log write failed'`. Subsequent `write()` calls on the same logger are no-ops. A second `'error'` does NOT produce a second `logger.warn`.
13. **`write` does NOT swallow synchronous throws from `JSON.stringify`** — if the entry contains a circular reference (`const a: any = {}; a.self = a; logger.write({ ..., args: a })`), `JSON.stringify` throws `TypeError`. The audit logger MUST NOT crash the handler. Two acceptable behaviours; pick one and document:
    - (a) Wrap `JSON.stringify` in try/catch; on failure emit a `logger.warn` ("audit serialization failed for tool=<tool>: <err>") AND emit a fallback entry whose `args` is `'<serialization_failed>'` so the entry is preserved for forensics. Preferred — preserves AR33 exactly-one-entry invariant.
    - (b) Wrap `JSON.stringify` in try/catch; on failure emit `logger.warn` and skip the entry. Acceptable but breaks AR33.
    Pick (a) and verify with a circular-args test. JSDoc the choice.

**AC13 — Module surface, file structure, no new dependencies, no edits outside `src/audit/`**

**Given** the project after this story,
**When** I list `src/audit/`,
**Then** it contains exactly:
```
src/audit/
├── audit-logger.ts        # NEW: factory, ULID generator, path resolver, mkdir helper, stream opener, openAuditLogger composition
├── audit-logger.test.ts   # NEW: ≥ 30 cases per the AC12 enumeration
├── digest.ts              # NEW: digest({size, sha256}) helper
├── digest.test.ts         # NEW: ≥ 6 cases per AC12
└── schema.ts              # NEW: AUDIT_SCHEMA_VERSION, AuditEntryId, AuditDecision, AuditEntry, AuditEntryInput
```

**And** `src/audit/.gitkeep` is removed (module now has real files; same pattern as Stories 1.2 / 1.3 / 1.4).

**And** no other source file in the repo is changed: no `src/index.ts` edits (startup wiring lands in Story 1.11), no `eslint.config.js` edits, no edits to `src/diagnostic/`, `src/domain/`, `src/config/`, or any other module. The package's dependency surface is unchanged — `node:crypto`, `node:fs`, `node:path`, `node:buffer`, `node:test`, `node:util` are all built-ins; no `npm install` should run.

**And** no `index.ts` re-export barrel inside `src/audit/` (AR57 / `architecture.md:999`). Importers in Story 1.6 / 1.10+ write `from '../audit/audit-logger.ts'`, `from '../audit/digest.ts'`, `from '../audit/schema.ts'` directly.

**AC14 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, and `npm test` from the project root,
**Then** all four exit `0`,
**And** `npm test` reports the new audit cases as passing,
**And** the test count strictly increases vs. the post-1.4 baseline of **125 tests** (story 1.4 dev-notes line 474 `npm test` 125/125). Conservative floor for this story: **+30 cases** (digest ≥ 6, path ≥ 8, ULID ≥ 7, factory ≥ 12, schema ≥ 1; expect 155+ post-1.5).
**And** `npm pack --dry-run` manifest grows by exactly **3** files (`src/audit/audit-logger.ts` + `src/audit/digest.ts` + `src/audit/schema.ts`; the test files are excluded by the `"!src/**/*.test.ts"` allowlist; the `.gitkeep` was already gitignored from `files` by extension). Pack count: 10 → 13 files.

## Tasks / Subtasks

- [x] **Task 1: Implement schema types in `src/audit/schema.ts`** (AC: #1)
  - [x] Export `AUDIT_SCHEMA_VERSION = 1 as const` with a JSDoc warning that bumping requires a documented migration path (NFR16, `epics.md:94`, `architecture.md:1177`).
  - [x] Export `type AuditEntryId = string & { readonly __brand: 'AuditEntryId' }` per `architecture.md:1009`. The brand constructor lives inside `audit-logger.ts`'s ULID generator (the only sanctioned `as AuditEntryId` cast site, per the `Ref` precedent in `src/domain/ref.ts:121`).
  - [x] Export `type AuditDecision = 'allowed' | 'rejected'`. Closed two-value union; D4 `architecture.md:419`.
  - [x] Export `type AuditEntry` with the documented field order and types. Use `readonly` on every field. The `reason` field is `string`, not a closed union (NFR16-friendly — Story 1.6 owns the closed enum).
  - [x] Export `type AuditEntryInput = Omit<AuditEntry, 'v' | 't' | 'id'>` — the handler-side shape; logger fills the auto fields.
  - [x] JSDoc on `AuditEntry`: cite D4 (`architecture.md:404-425`) and AR29 (`epics.md:144`).
  - [x] No runtime exports from `schema.ts` other than `AUDIT_SCHEMA_VERSION`. Everything else is `type` exports — `verbatimModuleSyntax: true` (`tsconfig.json:12`) forces consumers to use `import type` for them.
  - [x] No dependency on `src/domain/error.ts` (placeholder type; Story 1.6 will tighten). No dependency on any other module — `schema.ts` is leaf.

- [x] **Task 2: Implement `digest(content)` in `src/audit/digest.ts`** (AC: #2)
  - [x] One named export: `function digest(content: string): { size: number; sha256: string }`.
  - [x] `size = Buffer.byteLength(content, 'utf8')`. Document the byte-length (not JS-string-length) choice in JSDoc.
  - [x] `sha256 = createHash('sha256').update(content, 'utf8').digest('hex')` — explicit `'utf8'` encoding so `update`'s default doesn't drift across Node majors.
  - [x] Imports: `import { createHash } from 'node:crypto'` and `import { Buffer } from 'node:buffer'` (the `Ref` module already imports `Buffer` from `node:buffer` per the same project convention — `src/domain/ref.ts:1`).
  - [x] JSDoc: pure, deterministic, no I/O; cite NFR6 (`epics.md:78`) and AR31 (`epics.md:146`); document that callers are responsible for not invoking digest on `none`-mode content.
  - [x] No `as` casts. `verbatimModuleSyntax`: imports are runtime values, not types.

- [x] **Task 3: Implement path resolver, mkdir helper, stream opener, ULID generator, and factory in `src/audit/audit-logger.ts`** (AC: #3, #4, #5, #6, #7, #8, #9, #10, #11)
  - [x] **Imports** (top of file): `import path from 'node:path'`, `import { createWriteStream, mkdirSync } from 'node:fs'`, `import { createHash, randomFillSync } from 'node:crypto'` (createHash retained for any future-proofing — only digest.ts uses it today; alternative: drop createHash from this file's imports). Story-level rule: only import what's used. Diagnostic logger is imported as `import { type Logger } from '../diagnostic/logger.ts'` (type-only — `verbatimModuleSyntax`).
  - [x] Schema imports: `import { AUDIT_SCHEMA_VERSION, type AuditEntry, type AuditEntryId, type AuditEntryInput } from './schema.ts'`. Mixed runtime/type imports in one statement; the runtime constant + type names are valid together because zod did the same in `config.ts:2`.
  - [x] **`resolveAuditLogPath`** implementation:
    - Signature: `function resolveAuditLogPath(opts: { env: Record<string, string | undefined>; platform: NodeJS.Platform; homeDir: string; localAppData?: string }): string`.
    - Empty-string → `undefined` coercion for the override (mirroring Story 1.4's `readField` pattern in `src/config/config.ts:78-81`); same for `XDG_STATE_HOME` and `LOCALAPPDATA`.
    - Use `path.win32.join` explicitly when `platform === 'win32'` so the function is deterministic on POSIX CI (the test for case 7 / case 8 needs backslash-joined paths regardless of the host OS).
    - Use `path.posix.join` for non-Windows branches (mirror argument).
    - Defensively re-check `path.isAbsolute(override)` before accepting it (defence-in-depth — Story 1.4 already validated, but the resolver is a separate boundary).
    - Pure: no `process.*`, no `os.*`, no `fs.*`, no `Date.*`.
  - [x] **`ensureAuditDir`** implementation:
    - Signature: `function ensureAuditDir(filePath: string): void`.
    - Body: `mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })`.
    - JSDoc: documents mode `0o700` rationale + Windows no-op behaviour.
  - [x] **`openAuditStream`** implementation:
    - Signature: `function openAuditStream(filePath: string): NodeJS.WritableStream`.
    - Body: `return createWriteStream(filePath, { flags: 'a' })`.
    - JSDoc: cites D4 `architecture.md:448` and AR32 `epics.md:147`.
  - [x] **ULID generator** (private factory inside this module):
    - `const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'` (32 chars; no `I`/`L`/`O`/`U`).
    - `function encodeTime(ms: number): string` — encodes 48 bits of milliseconds as 10 Crockford-Base32 chars, big-endian. Implementation: bit-shift / divmod loop using `BigInt` (Crockford 32 → 5 bits/char; 10 chars = 50 bits; we use the low 48 + 2 zero pad — the standard ULID behaviour). **Use `BigInt` arithmetic**: JavaScript number arithmetic loses precision above `2^53`, so the millisecond timestamp encoded into 48 bits is fine for ints up to `Date.UTC(10889, 7, ...)`, but the bit-packing must use BigInt to avoid intermediate-precision drift.
    - `function encodeRandom(bytes: Uint8Array): string` — encodes 80 bits (10 bytes) as 16 Crockford-Base32 chars using BigInt-based packing for correctness.
    - `function incrementRandomness(bytes: Uint8Array): Uint8Array` — returns a NEW `Uint8Array` (does not mutate the caller's). Increments the 80-bit big-endian integer by 1. On overflow (was `0xFF...FF`), per AC3 pick: re-draw fresh randomness via the injected `randomBytes` (preferred — never throws). Document the choice in JSDoc.
    - `function makeUlidGenerator(deps: { clock: () => Date; randomBytes: (n: number) => Uint8Array }): () => AuditEntryId` — returns a closure-captured stateful function; `lastMs` and `lastRandomness` private to the closure.
    - The brand cast `value as AuditEntryId` is the **only** sanctioned `as` site in this module (AR59 / `architecture.md:1031`). Document with an inline comment naming the AR.
  - [x] **`createAuditLogger`** factory implementation:
    - Signature: `function createAuditLogger(opts: { stream: NodeJS.WritableStream; clock: () => Date; randomBytes: (n: number) => Uint8Array; logger: Logger }): AuditLogger`.
    - Internal state (closure-captured): `errored: boolean`, `closed: boolean`, `closingPromise: Promise<void> | undefined`, `queue: string[]`, `nextUlid: () => AuditEntryId`, plus the drain handler.
    - On construction: subscribe to `'error'` and `'drain'` events (`stream.on('error', ...)`, `stream.on('drain', ...)`). The `'error'` handler logs WARN (once), sets `errored = true`, drops the queue. The `'drain'` handler flushes the queue if not errored.
    - `write(entry)`:
      - If `errored || closed` → return early (no-op).
      - Try `JSON.stringify` of the assembled entry (with `v`, `t`, `id` stamped); on `TypeError` (circular ref), per AC12 case 13(a): log WARN, retry with `args: '<serialization_failed>'` and a marker `details: { reason: 'serialization_failed' }`. Re-stringify; if THAT throws too (shouldn't be possible after replacing the circular field), swallow and return — preserve "audit-write never throws".
      - Append `'\n'`.
      - If queue is non-empty → push to queue (preserves ordering across drain boundary).
      - Else: `const ok = stream.write(line)`. If `!ok` → push to queue.
    - `close()`:
      - If `closingPromise` exists → return it (idempotency).
      - Otherwise build the promise:
        - If `errored` → resolve immediately (stream is gone).
        - Else if `queue.length === 0` → call `stream.end(() => resolve())`.
        - Else → install a one-shot listener that, after each drain, checks `queue.length === 0` and then calls `stream.end(() => resolve())`. Schedule it after the existing drain handler's flush so the order is: drain → flush queue → if empty, `stream.end`.
      - Set `closed = true`. Cache the promise in `closingPromise`.
    - JSDoc on the factory: documents AR33, AR34, AR35, NFR9, NFR17, NFR19, AR61 (audit-write is the sanctioned `void someAsync()` site).
  - [x] **`openAuditLogger`** composition:
    - Signature: `function openAuditLogger(opts: { env: Record<string, string | undefined>; platform: NodeJS.Platform; homeDir: string; clock: () => Date; logger: Logger }): { logger: AuditLogger; filePath: string }`.
    - Body: resolve path → ensure dir → open stream → create logger. Return `{ logger, filePath }`.
    - Default `randomBytes` injected here: `(n) => { const b = new Uint8Array(n); randomFillSync(b); return b; }`.
    - JSDoc: only function in the module that touches the filesystem.
  - [x] **No `as` casts** outside the ULID brand-constructor and (if ESLint complains) the `as AuditEntryId` site. **No `@ts-expect-error`** without inline justification (AR59).
  - [x] **No barrel files** (AR57). Import sites in later stories use the file paths directly.
  - [x] All imports use `.ts` extensions per `tsconfig.json:14`.

- [x] **Task 4: Write digest tests** (AC: #2, #12)
  - [x] Create `src/audit/digest.test.ts`. Use `node:test` + `node:assert/strict` per the established pattern (Stories 1.1, 1.2, 1.3, 1.4).
  - [x] Top-level `await test(...)` for each case (no `describe` — Story 1.3 Debug Log line 401 / Story 1.4 dev-notes line 366 confirmed convention).
  - [x] Cases per AC12 (≥ 6).
  - [x] No fs / clock / network. Pure assertions on string/number return values.

- [x] **Task 5: Write audit-logger tests** (AC: #3, #4, #7, #8, #9, #10, #11, #12)
  - [x] Create `src/audit/audit-logger.test.ts`. Same conventions as Task 4.
  - [x] Build a `makeFakeStream()` test helper modelled on `src/diagnostic/logger.test.ts:9-49`. The fake exposes:
    - A `writes: string[]` array capturing each `stream.write(chunk)` call's payload.
    - A `nextWriteReturns: boolean[]` queue controlling `stream.write`'s return value (defaults to `true`; pop one entry per call). When the queue empties, falls back to `true`.
    - An `emit(event, payload)` method to fire `'drain'` / `'error'` synthetically.
    - An `end(callback)` capture so `close()` tests can assert ordering.
    - Subscribed listeners stored so `emit` can iterate them.
    - Cast to `NodeJS.WritableStream` at the test boundary with an inline AR59 justification (mirroring `logger.test.ts:46-47`).
  - [x] Build a `fakeClock(initialMs: number)` helper: returns `() => new Date(currentMs)` plus a `tick(deltaMs: number)` mutator. Used for ULID and `t` field assertions.
  - [x] Build a `fakeRandomBytes(...buffers: Uint8Array[])` helper: a queue-based stub returning each buffer in order. Defaults to `new Uint8Array(10).fill(0)` once exhausted (deterministic).
  - [x] Build a `fakeLogger()` helper capturing `info` / `warn` / `error` calls into arrays.
  - [x] **Path-resolver cases** (≥ 8 per AC12) — pure function, no fakes needed beyond hand-rolled `env` records.
  - [x] **ULID cases** (≥ 7) — exercise the generator factory directly via a private export (or via the public `write` path observing the `id` field — either is acceptable; if you export the generator as `_makeUlidGenerator` for testing, prefix the underscore to signal "internal").
  - [x] **Schema constant case** (≥ 1) — `assert.strictEqual(AUDIT_SCHEMA_VERSION, 1)`.
  - [x] **`createAuditLogger` cases** (≥ 12 per AC12) covering schema-v1 round-trip, ISO timestamp format, monotonic ids, rejected/allowed conditional fields, backpressure happy/paused/multi-cycle, close empty/queued/idempotent, error fail-policy, circular-args.
  - [x] **No real `fs.*`, `process.*`, `setTimeout` longer than `setImmediate`-equivalent.** All async assertions use `await new Promise(setImmediate)` or `await new Promise(resolve => stream.emit('drain'); setImmediate(resolve))` patterns to flush the microtask queue cleanly.
  - [x] Assertions: `assert.deepStrictEqual` for parsed JSON entries, `assert.strictEqual` for primitives, `assert.match` for regex shapes (timestamp, ULID alphabet), `assert.ok(line.endsWith('\n'))` for the JSONL invariant.

- [x] **Task 6: Remove `src/audit/.gitkeep`** (AC: #13)
  - [x] `git rm src/audit/.gitkeep`. Same pattern as Stories 1.2 / 1.3 / 1.4.

- [x] **Task 7: Local verification** (AC: #14)
  - [x] `npm run typecheck` → exit 0, zero TS errors. `exactOptionalPropertyTypes: true` is on — the `AuditEntry` literal must NOT assign `reason: undefined` / `details: undefined` / `failedOperation: undefined` explicitly when those branches are absent (use a conditional spread or build the object via successive property assignments).
  - [x] `npm run lint` → exit 0, zero rule violations. Watch for: `no-floating-promises` on the `close()` promise paths; `no-misused-promises` on listener registrations; `no-explicit-any` on the fake stream cast.
  - [x] `npx prettier --check .` → all matched files formatted.
  - [x] `npm test` → all tests pass; count increases by ≥ 30 vs. the post-1.4 baseline (125 → ≥ 155 expected).
  - [x] `npm pack --dry-run` → manifest grows by exactly **3** files (`src/audit/audit-logger.ts` + `src/audit/digest.ts` + `src/audit/schema.ts`); confirm test files excluded by `"!src/**/*.test.ts"` allowlist (pack should be 10 → 13 files).

### Review Findings

_Adversarial code review — 2026-04-30. Three layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor._

- [x] [Review][Decision] **`SERIALIZATION_FAILED_MARKER` replaces both `args` AND `response`, not only `args`** — Resolved 2026-04-30: keep the current broader behaviour. Wiping both fields is the conservative reading because `JSON.stringify(entry)` does not name the failing field. The spec deviation is to be documented in JSDoc on the `createAuditLogger` factory and in the dev-notes "Critical guardrails" / "Latest tech information" section so future readers don't mistake the breadth for a bug. Tracked as patch P5 below.
- [x] [Review][Patch] **Stream `'error'` during in-flight `close()` leaves the closing promise dangling — violates NFR9 1s shutdown** [`src/audit/audit-logger.ts:336-344`, `:384-424`] — fixed: factory now tracks `pendingCloseResolve`; both the stream `'error'` handler and synchronous failures inside `flushQueue` settle the close promise via `treatAsErrored`. New regression test exercises error-during-in-flight-close.
- [x] [Review][Patch] **Synchronous throws inside `write()` and `flushQueue()` (clock invalid-Date, `nextUlid` `RangeError`, `stream.write` throw) escape the audit boundary, contradicting AR61 fire-and-forget** [`src/audit/audit-logger.ts:315-328`, `:370-382`] — fixed: both functions now wrap their work in try/catch and route into the shared `treatAsErrored` helper (single WARN, queue dropped, subsequent writes no-op). Two regression tests added — one for a throwing clock, one for a throwing `stream.write` during drain.
- [x] [Review][Patch] **Backpressure paused-path test does not verify `t` is captured at write-time vs. drain-time (AC12 case 7)** [`src/audit/audit-logger.test.ts:497-515`] — fixed: test now calls `clock.tick(50)` between writes A and B and again before drain, then asserts each line's `t` field equals its respective write-time, NOT the drain-time.
- [x] [Review][Patch] **`serialise` fallback `catch { return null; }` silently drops the audit entry — no diagnostic when the placeholder build also fails** [`src/audit/audit-logger.ts:364-366`] — fixed: secondary catch now logs `audit log placeholder also failed for tool=<tool>: <err> — entry dropped` before returning null. Regression test forces double-failure via a `BigInt` `durationMs` that fails both the primary and the fallback.
- [x] [Review][Patch] **Document the AC12 case 13(a) deviation: both `args` and `response` are replaced with the sentinel on serialisation failure** [`src/audit/audit-logger.ts:354-368`] — fixed: JSDoc on `createAuditLogger` now spells out the deviation and rationale (JSON.stringify does not name the failing field; wiping both is the conservative reading). Inline comment in `serialise` cross-references AC12 case 13(a) and patch P5.
- [x] [Review][Defer] **`createAuditLogger.filePath` optional with `'<injected stream>'` placeholder default could leak into a WARN if a future caller forgets to pass it** [`src/audit/audit-logger.ts:47, 305, 343`] — deferred, pre-existing trade-off (production wires it, tests wire it; making it required would break the test-friendly DI shape)
- [x] [Review][Defer] **`ensureAuditDir` does not tighten existing parent dirs to `0o700`; the audit log can sit under a world-readable `~/.local/state` listing** [`src/audit/audit-logger.ts:129-131`] — deferred, spec-accepted: AC5 explicitly mandates `mkdirSync({ recursive: true, mode: 0o700 })` and Node only applies `mode` to dirs it creates. The audit file itself is owner-only via `0o700` on its direct parent.

## Dev Notes

### Architectural source-of-truth

This is story **#5** in the implementation sequence (`architecture.md:817`, item 5: "Audit logger — JSONL stream module, ULID generator, schema-v1 writer, drain handling, shutdown flush. (D4.)"). It depends on:
- Story 1.3's diagnostic logger (`src/diagnostic/logger.ts`) for the `Logger` type — used as the sink for `'error'`-event WARNs.
- Story 1.4's config wiring is **not** a runtime dependency of this module — Story 1.5 takes path inputs via DI (env, platform, homeDir). Story 1.11 reads the config and calls `openAuditLogger`.

It does **NOT** depend on:
- Story 1.6's `DomainError` / `formatToolError` / `serializeForAudit` — those land **after** this story (`architecture.md:818`). The audit `reason` field is typed as `string` for forward-compat; Story 1.6 will tighten via `ReasonCode` reconciliation.
- Story 1.7's runtime client — the audit logger has no upstream calls.

**Primary specs (read these first):**
- D4 — Audit Log Format & Sink: `_bmad-output/planning-artifacts/architecture.md:386-468`. The schema, sink, verbosity policy, non-blocking write path, fail policy, shutdown, and what's NOT in the audit log.
- AR26–AR35 in `_bmad-output/planning-artifacts/epics.md:140-150` — the bullet-list summary of the same specs.
- NFR16 — versioned audit schema, `epics.md:94`.
- NFR17 — non-blocking audit writes, `epics.md:95`.
- NFR18 — JSONL human-readable offline, `epics.md:96`.
- NFR9 — clean shutdown ≤ 1s, `epics.md:83`.
- NFR6 — no `none`-content in audit, `epics.md:78`. Enforced by handlers; this module just hashes what it's given (`docs/audit-log.md` will document the discipline — Story 1.13).
- AR58 — acyclic dependency rule: `audit/schema` and `audit/digest` are pure-domain; `audit/audit-logger` is a boundary module (it touches `fs.*` and `stream.*`).

### What this story owns (and does NOT own)

**Owns:**
- `src/audit/schema.ts` — `AUDIT_SCHEMA_VERSION`, `AuditEntryId`, `AuditDecision`, `AuditEntry`, `AuditEntryInput` types.
- `src/audit/digest.ts` — `digest(content)` helper.
- `src/audit/audit-logger.ts` — path resolver, mkdir helper, stream opener, ULID generator, `createAuditLogger` factory, `openAuditLogger` composition.
- All adjacent test files.

**Does NOT own (these land in later stories):**
- `src/index.ts` startup ladder wiring of `openAuditLogger` into the boot sequence — Story 1.11.
- Permission engine emitting `config_error` audit entries on malformed `#mcp/config` blocks — Story 1.8 (the audit-logger is consumed; the entry-construction is the parser's responsibility, AR17 / `epics.md:126`).
- The `serializeForAudit(error: DomainError)` projection that builds `reason + details + failedOperation` from a `DomainError` — Story 1.6 (D6 / `architecture.md:548-555`).
- Tool handlers calling `audit.write(...)` from their `finally` blocks — Stories 1.10, 2.x (AR53 / `epics.md:176`).
- `docs/audit-log.md` schema reference + jq-query examples — Story 1.13 (AR65 / `epics.md:194`).
- The Story-1.6 `DomainError` -> closed `ReasonCode` reconciliation — when 1.6 lands, decide whether to widen `AuditEntry.reason` to `ReasonCode | string`, or just leave as `string` and document that the value is the closed-enum literal.

### Files this story creates / modifies / deletes

**NEW:**
- `src/audit/schema.ts` — type definitions + `AUDIT_SCHEMA_VERSION = 1` constant.
- `src/audit/digest.ts` — `digest(content)` helper.
- `src/audit/digest.test.ts` — adjacent unit tests (≥ 6 cases).
- `src/audit/audit-logger.ts` — path resolver, mkdir, stream opener, ULID generator, factory, composition.
- `src/audit/audit-logger.test.ts` — adjacent unit tests (≥ 28 cases: 8 path + 7 ULID + 1 schema + 12 factory).

**DELETE:**
- `src/audit/.gitkeep` (module now has real files).

**UNCHANGED (do not touch):**
- `src/index.ts` — startup ladder is Story 1.11.
- `src/diagnostic/logger.ts`, `src/diagnostic/logger.test.ts` — Story 1.3 territory; this story imports the `Logger` type only.
- `src/domain/*` — no dependency. (`src/domain/error.ts`'s placeholder is intentionally not used here; Story 1.6 owns the closed `ReasonCode` enum.)
- `src/config/*` — no dependency. Story 1.11 wires `cfg.auditLogPath` into `openAuditLogger` at startup-ladder time.
- `eslint.config.js`, `package.json`, `tsconfig.json` — no rule / dep / TS-config changes needed.
- `.gitignore` — already excludes `audit.jsonl` (`. gitignore:5`); revisit deferred per `deferred-work.md:10`. **Do not modify in this story** — the deferred entry says "revisit when the actual write path is fixed", and the path is now configurable, so the existing `audit.jsonl` rule is fine for the default-CWD test case (which the test suite never hits anyway, since tests use a fake stream).
- All `_bmad/`, `_bmad-output/`, `docs/` — no doc updates in this story (the README's audit-path note is touched in Story 1.13).

### Testing standards

- Test framework: `node:test` (built-in; AR4 / `architecture.md:130-134`).
- Test location: **adjacent** — `src/audit/digest.test.ts` next to `src/audit/digest.ts`; `src/audit/audit-logger.test.ts` next to `src/audit/audit-logger.ts` (`architecture.md:998`).
- Test invocation: `npm test` (= `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'`).
- **No real `fs.*` writes** during tests (binding constraint per `epics.md:425-427`). All I/O goes through fakes.
- **No real `Date.now()` reads** in tests with timing assertions. Use `fakeClock(initialMs)` via DI.
- **No real `crypto.randomFillSync`** in tests asserting ULID monotonicity / format. Use `fakeRandomBytes(...buffers)` via DI.
- **Top-level `await test(...)`** for each case (no `describe` blocks — Story 1.3 Debug Log line 401, Story 1.4 dev-notes line 366).
- **No mocks beyond:**
  - `makeFakeStream()` — modelled on `src/diagnostic/logger.test.ts:9-49`. Captures writes, controls `stream.write` return value, exposes `emit` for `'drain'` / `'error'`.
  - `fakeClock(initialMs)` — closure over a mutable `now` variable.
  - `fakeRandomBytes(...buffers)` — queue-based deterministic stub.
  - `fakeLogger()` — captures `info` / `warn` / `error` calls.
- Assertions: `assert.deepStrictEqual` for parsed JSON entries, `assert.strictEqual` for primitives, `assert.match` for regex shapes (timestamp, ULID alphabet), `assert.ok(line.endsWith('\n'))` for JSONL invariants.

### Library / framework requirements

**No new dependencies.** All needed primitives are Node built-ins:

| Module | Locked version | Purpose |
|---|---|---|
| TypeScript | `^6.0.3` (`package.json:46`) | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all active |
| Node | `>=24` (`package.json:8`) | Native TS stripping; no build step |
| `node:crypto` | built-in | `createHash('sha256')` for `digest`; `randomFillSync` for default randomness |
| `node:fs` | built-in | `mkdirSync`, `createWriteStream` |
| `node:path` | built-in | `path.dirname`, `path.posix.join`, `path.win32.join`, `path.isAbsolute` |
| `node:buffer` | built-in | `Buffer.byteLength` for `digest`'s `size` field |
| `node:test` | built-in | Test framework |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | All rules from `eslint.config.js` apply |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

**Push back on:** any suggestion to add `ulid` (`npm install ulid`), `uuid`, `crypto-js`, `sha.js`, `pino`, `bunyan`, `winston`, `lodash`, `ramda`, `mkdirp`, or `make-dir`. The project's "boring + minimal deps" stance (Story 1.4 dev-notes line 333) holds: the ULID generator is ~50 LOC; SHA-256 ships with Node; recursive mkdir ships with Node; nothing third-party is justified.

### File-structure requirements

After this story, `src/audit/` must look like:

```
src/audit/
├── audit-logger.ts        # NEW: path resolver, mkdir, stream opener, ULID generator, factory, composition
├── audit-logger.test.ts   # NEW: ≥ 28 cases (8 path + 7 ULID + 1 schema + 12 factory + edge cases)
├── digest.ts              # NEW: digest({ size, sha256 }) helper
├── digest.test.ts         # NEW: ≥ 6 cases
└── schema.ts              # NEW: AUDIT_SCHEMA_VERSION + types
```

(`.gitkeep` removed.) No new directories. **No barrel files** (AR57 / `architecture.md:999`). Importers in later stories write `from '../audit/audit-logger.ts'` etc. directly. Do **not** create `src/audit/index.ts`.

### Latest tech information (researched 2026-04-30)

- **ULID spec** — `https://github.com/ulid/spec`. 26 chars, Crockford Base32 (no `I`/`L`/`O`/`U`), 48-bit timestamp + 80-bit randomness. Monotonicity within a millisecond is RECOMMENDED (not strictly required by the spec, but expected of any quality implementation; we adopt it because Story 1.5 AC explicitly calls for "ULID monotonicity" `epics.md:427`).
- **Crockford Base32 alphabet:** `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Maps each 5-bit group to one ASCII char. The omitted letters `I`/`L`/`O`/`U` reduce visual ambiguity. Encoding 48 bits → ceil(48 / 5) = 10 chars (with 2 zero-pad bits at the top). Encoding 80 bits → 16 chars exactly.
- **`BigInt` for bit-packing:** Node 24's `BigInt` is the right tool for 48-bit and 80-bit unsigned integer arithmetic. JS numbers lose precision past 2⁵³; Crockford encoding via repeated `>> 5n` and `mask = 0x1Fn` keeps the high bits intact.
- **`createHash('sha256')` Node-built-in:** stable since Node 0.x; no API drift across Node 24.x.
- **`fs.createWriteStream(path, { flags: 'a' })`:** the `'a'` flag is "open file for appending; create if not exists." The stream is a `Writable` whose `write(chunk)` returns `false` when the kernel buffer is full and emits `'drain'` when ready for more. Standard since Node 0.x.
- **`fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`:** the `recursive` option is stable since Node 10.12; `mode` is applied to each created directory along the path. On Windows, `mode` is largely ignored (POSIX permissions don't apply); the directory is owner-readable by default via the user's profile ACL.
- **`Buffer.byteLength(content, 'utf8')`:** the canonical UTF-8 byte length. Works for any JS string including non-BMP code points.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:11`): same trap Story 1.4 hit (`src/config/config.ts:188-197` conditional construction). When building an `AuditEntry`, do NOT assign `reason: undefined` / `details: undefined` / `failedOperation: undefined` explicitly. Use successive property assignment or a conditional spread:
  ```ts
  const base = { v: AUDIT_SCHEMA_VERSION, t, id, tool, args, decision, response, durationMs };
  const entry: AuditEntry = {
    ...base,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
    ...(input.failedOperation !== undefined ? { failedOperation: input.failedOperation } : {}),
  };
  ```
- **`erasableSyntaxOnly: true`:** no `enum`, no `namespace`, no constructor parameter properties. Use plain `type` aliases, `const` literals, `function` declarations.
- **`verbatimModuleSyntax: true`:** `import type { Logger } from '../diagnostic/logger.ts'` for type-only imports; `import { AUDIT_SCHEMA_VERSION, type AuditEntry } from './schema.ts'` for mixed runtime+type. Match Story 1.4's `config.ts:1-6` style.
- **`@types/node@^24`:** `NodeJS.WritableStream`, `NodeJS.Platform`, `Uint8Array` types are all available without additional declarations.

### Previous story intelligence (from Stories 1.1, 1.2, 1.3, 1.4)

Distilled patterns to apply:

1. **Top-level `await test(...)` is the established test pattern** — Story 1.1 Debug Log line 246, Story 1.2 Task 4, Story 1.3 Debug Log line 401, Story 1.4 dev-notes line 366. Do **not** introduce `describe` blocks.
2. **`@types/node@^24` is pinned.** No action needed.
3. **No `npm install` should be needed.** All needed primitives are built-ins.
4. **`npx prettier --check .`** is the format gate. `.prettierignore` already excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep` — new `.ts` files under `src/` ARE checked.
5. **`npm pack --dry-run` baseline after Story 1.4:** 10 files. After this story: **13 files** (adds `src/audit/audit-logger.ts` + `src/audit/digest.ts` + `src/audit/schema.ts`).
6. **Pre-push hook** (`tests/smoke/stdout-discipline.test.ts`) does not exist yet (Story 1.12). `git push` will fail until then; that's intentional. AC14 verifies `npm run *` gates only.
7. **`@ts-expect-error` requires inline justification** (AR59 / `architecture.md:1032`). Avoid altogether in production code.
8. **No barrel re-exports** (AR57). Importers write the file path directly.
9. **Story 1.4's secret-scrubber spread-bypass lesson** (Story 1.4 Debug Log line 460): assume any object you build can be `JSON.stringify`d, `String()`d, `util.inspect`ed, spread, or passed to `Object.assign`. The audit logger's `entry` object goes straight to `JSON.stringify` — there's no agent-controlled token in this module's data flow, so the same concern doesn't apply directly. **But**: `entry.args` carries agent-supplied input which COULD include token-like fields if a future tool accepts a token-shaped argument. Defence: this module logs `args` as-is (AR31 explicit); the agent-facing scrubber for `infrastructure_error.details` is Story 1.6's job (AR45 / `epics.md:164`). The audit logger does not introduce its own scrubber.
10. **Story 1.4's DI-by-default pattern** (`src/config/config.ts:275-279` `loadConfigOrExit(env, logger?, exitFn?)`) — replicate for `createAuditLogger({ stream, clock, randomBytes, logger })` and `openAuditLogger({ env, platform, homeDir, clock, logger })`. Required arguments only; defaults wire production values.
11. **Story 1.3's diagnostic logger contract** (`src/diagnostic/logger.ts:15-19`): `info(message)`, `warn(message)`, `error(message, err?)`. The audit logger calls `logger.warn(message)` exactly (single-arg form — the stream `'error'` value is interpolated into the message string, NOT passed as the second argument, because the `err.stack` rendering would dump a multi-line trace into the WARN that's noisier than the user needs for "audit log degraded"). Pattern: `logger.warn(\`audit log write failed: \${err.message} — continuing without audit (path: \${filePath})\`)`. Rationale: AR50 says "warnings (audit-write failures, ...)"; D4 fail-policy at `architecture.md:455` says "logs a warning to the diagnostic stream (stderr — D7's domain)".
12. **`Buffer` import explicit** — Story 1.2's `src/domain/ref.ts:1` imports `Buffer` from `node:buffer` rather than relying on the global. Match this convention in `digest.ts`.
13. **`Result<T, E>` from Story 1.2/1.4** is NOT used in this story. The audit logger's contract is `void` for `write` (fire-and-forget) and `Promise<void>` for `close` (no failure projection — the failure projection is the WARN to the diagnostic logger, not a returned `Result`).

### Git intelligence

Recent commits (`git log --oneline -10`):
- `a9b4ca6 feat(config): env-var loader and secret-scrubber wrapper (story 1.4)`
- `6760e41 feat(diagnostic): stderr Logger with INFO/WARN/ERROR levels (story 1.3)`
- `a867ada chore(bmad): adopt Conventional Commits for review commit-gate`
- `f3f90df feat(domain): Ref primitive, Result<T>, DomainError stub (story 1.2)`
- `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`

**Expected commit footprint for this story:** 5 new files in `src/audit/` (`audit-logger.ts`, `audit-logger.test.ts`, `digest.ts`, `digest.test.ts`, `schema.ts`), 1 deletion (`src/audit/.gitkeep`). No other tree changes.

**Conventional Commits gate** lands in `a867ada`. This story's commit message should follow the established pattern: `feat(audit): JSONL audit logger with ULID, digest, drain handling (story 1.5)`.

### Critical guardrails (do not rediscover)

1. **Audit-write is the ONLY sanctioned `void someAsync()` site** (AR61 / `epics.md:188`). The `write(entry)` contract is synchronous-with-fire-and-forget-side-effects. **Do NOT return a `Promise` from `write`.** ESLint's `no-floating-promises` will flag any handler-side `audit.write(...)` call if `write` returns a Promise.
2. **Stream `'error'` is non-fatal — log WARN and keep serving** (AR34 / `epics.md:149`, D4 fail-policy at `architecture.md:455`). NEVER throw out of an `'error'` handler. NEVER call `process.exit` from this module.
3. **Schema version `v: 1` is locked.** Adding fields, narrowing types, or renaming top-level fields requires bumping `AUDIT_SCHEMA_VERSION` and is OUT OF SCOPE for this story (NFR16 / `epics.md:94`, `architecture.md:1177`).
4. **Field order in the serialized JSON is `v, t, id, tool, args, decision, response, durationMs, reason?, details?, failedOperation?`** — `JSON.stringify` preserves insertion order, so build the object literal accordingly. AR26 / NFR18 (human-readable offline) — operators reading `jq '.t,.tool,.decision'` expect a stable shape.
5. **No content from user pages in `args` or anywhere the handler doesn't put it** — `digest()` is the only sanctioned channel for body content (NFR6 / `epics.md:78`, AR31 / `epics.md:146`). The audit logger does NOT enforce this — handlers are responsible — but the JSDoc on `digest.ts` and on `AuditEntry.response` should remind readers.
6. **Diagnostic logger is the only sanctioned stderr writer** (AR48 / `epics.md:169`). The audit logger's `'error'` handler calls `logger.warn(...)` — never `process.stderr.write(...)`, never `console.error(...)`.
7. **`as` casts are forbidden outside boundary constructors** (AR59 / `architecture.md:1031`). The brand-constructor exemption applies to the ULID generator's `value as AuditEntryId` cast (one site). Document with an inline AR59 comment.
8. **`@ts-ignore` and `@ts-expect-error` are forbidden without inline tracked-issue justification** (AR59 / `architecture.md:1032`).
9. **`exactOptionalPropertyTypes: true`** — when building `AuditEntry`, do NOT assign optional fields (`reason`, `details`, `failedOperation`) as `undefined`. Use conditional spreads (per the snippet in "Latest tech information" above).
10. **Imports use `.ts` extension** (`tsconfig.json:14`). `from './schema.ts'`, `from '../diagnostic/logger.ts'`. `node:` builtins import normally (`import { createHash } from 'node:crypto'`).
11. **No fs / network / clock reads in any of `digest.ts`, `schema.ts`, or the pure helpers in `audit-logger.ts` (`resolveAuditLogPath`, `incrementRandomness`, `encodeTime`, `encodeRandom`).** All I/O is concentrated in `ensureAuditDir`, `openAuditStream`, `openAuditLogger`. AR58 acyclic dependency rule.
12. **Backpressure queue is unbounded in MVP.** No size-cap fallback. The trade-off is documented in JSDoc on `createAuditLogger`. Don't bolt on a "drop oldest" / "drop newest" policy without a story to justify it (NFR4 covers freshness state, not the audit queue — `architecture.md:546`).
13. **`close()` is idempotent.** Cache the promise in `closingPromise`. Calling `close()` twice resolves both with the same underlying state. Calling `write()` after `close()` resolved is a no-op.
14. **`'error'` event drops the queue.** The stream is gone; queued entries are unwritable. Do NOT re-attempt them on a fresh stream — there is no fresh stream in MVP (no auto-reopen / failover). Memory is freed; subsequent writes are no-ops.
15. **No timing-based test waits longer than `setImmediate` / one microtask flush.** Tests assert ordering by emitting events synthetically and awaiting microtasks. Real-time waits introduce flakes on slow CI.

### Story scope boundaries (DO NOT include)

- **Audit log rotation, archival, compression, or pruning.** D4 explicit (`architecture.md:390`): "single append-only file. **No rotation in MVP** — user manages size externally if needed." Adding `logrotate`-style logic, hourly file roll, gzip-on-close, or any "keep last N MB" policy is out-of-scope.
- **Reading the audit log.** This module only writes. Consumers parse the JSONL file out-of-band with `jq`, `cat`, custom scripts. AR65 documents `docs/audit-log.md` examples — Story 1.13.
- **Querying / filtering audit entries.** No Bloom filters, indexes, or search APIs. Out-of-band tools (jq) handle this.
- **Audit-entry validation at the write site.** The wire shape is enforced by TypeScript (`AuditEntryInput` type); runtime validation would be redundant. Story-1.10+ handler tests will exercise the integration.
- **Pluggable sinks** (multiple write streams, syslog, fluentd, etc.). Single-file, JSONL only. AR26 binding.
- **Encryption-at-rest of the audit log.** Out-of-scope; relies on filesystem permissions (mode 0o700) and OS-level whole-disk encryption (the user's choice).
- **A `query()` or `tail()` API on the `AuditLogger`.** Module exposes only `write` and `close`. AR58 acyclic.
- **A `ReasonCode` enum re-export.** Story 1.6 owns it. This story uses `string` for `reason`.
- **`config_error` audit-entry construction for malformed `#mcp/config` blocks.** Story 1.8 (the parser) constructs the entry; this module just writes it. AR17 / `epics.md:126`.
- **Startup banner / "ready" log line.** Story 1.11's startup-ladder responsibility (AR50 / `epics.md:171`). `openAuditLogger` returns the resolved `filePath` so Story 1.11 can log it; this story does NOT log on its own initiative.
- **Pretty-printing or indentation of the JSON.** JSONL = one JSON object per line, no pretty-print, no tabs. Operators read it via `jq`, not by eye.
- **Retroactive reconciliation with Story 1.6's `ReasonCode`.** When 1.6 lands, its dev story decides whether to widen `AuditEntry.reason: string` to `ReasonCode | string`. Don't pre-emptively import a yet-unwritten enum.
- **CWD-relative default path.** D4 (`architecture.md:393-396`) and AR27 (`epics.md:142`) are explicit: platform-appropriate state directory. The `.gitignore`'s leftover `audit.jsonl` line (`.gitignore:5`) is a Story-1.1 artifact; leave it alone (`deferred-work.md:10` defers cleanup).
- **IPv6 / hostname-based path overrides.** Path resolution is purely string-based; networking concerns belong to Story 1.7's runtime client.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.5] (lines 391-427)
- D4 — Audit Log Format & Sink: [Source: _bmad-output/planning-artifacts/architecture.md#D4] (lines 386-468)
- Schema-v1 example: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 407-425)
- Verbosity policy: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 438-443)
- Non-blocking write path code sketch: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 445-453)
- Audit-write failure policy (AR34): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 455-456)
- Shutdown discipline (AR35 / NFR9): [Source: _bmad-output/planning-artifacts/architecture.md] (line 457)
- What audit log does NOT contain: [Source: _bmad-output/planning-artifacts/architecture.md] (lines 459-464)
- AR26 (JSONL, no rotation): [Source: _bmad-output/planning-artifacts/epics.md] (line 141)
- AR27 (path resolution): [Source: _bmad-output/planning-artifacts/epics.md] (line 142)
- AR28 (file by default, not stderr): [Source: _bmad-output/planning-artifacts/epics.md] (line 143)
- AR29 (schema-v1 fields): [Source: _bmad-output/planning-artifacts/epics.md] (line 144)
- AR30 (closed reason vocabulary): [Source: _bmad-output/planning-artifacts/epics.md] (line 145) — note: Story 1.5 uses `string` for forward-compat; Story 1.6 owns the closed enum
- AR31 (verbosity policy): [Source: _bmad-output/planning-artifacts/epics.md] (line 146)
- AR32 (non-blocking write): [Source: _bmad-output/planning-artifacts/epics.md] (line 147)
- AR33 (exactly-one-entry invariant): [Source: _bmad-output/planning-artifacts/epics.md] (line 148) — handler-shape responsibility per AR53; this story owns the audit-side guarantee
- AR34 (fail-policy): [Source: _bmad-output/planning-artifacts/epics.md] (line 149)
- AR35 (shutdown flush): [Source: _bmad-output/planning-artifacts/epics.md] (line 150)
- NFR6 (no `none` content): [Source: _bmad-output/planning-artifacts/epics.md] (line 78)
- NFR9 (clean shutdown ≤ 1s): [Source: _bmad-output/planning-artifacts/epics.md] (line 83)
- NFR16 (versioned schema): [Source: _bmad-output/planning-artifacts/epics.md] (line 94)
- NFR17 (non-blocking audit): [Source: _bmad-output/planning-artifacts/epics.md] (line 95)
- NFR18 (human-readable offline): [Source: _bmad-output/planning-artifacts/epics.md] (line 96)
- AR48 (single approved stderr writer): [Source: _bmad-output/planning-artifacts/epics.md] (line 169)
- AR50 (diagnostic-log content): [Source: _bmad-output/planning-artifacts/epics.md] (line 171)
- AR53 (tool-handler shape, exactly-one-audit invariant): [Source: _bmad-output/planning-artifacts/epics.md] (line 176)
- AR55 (naming): [Source: _bmad-output/planning-artifacts/epics.md] (line 180)
- AR57 (no barrels): [Source: _bmad-output/planning-artifacts/epics.md] (line 182), [Source: _bmad-output/planning-artifacts/architecture.md] (lines 999-1000)
- AR58 (acyclic dependency rule): [Source: _bmad-output/planning-artifacts/epics.md] (line 183)
- AR59 (no `as` outside boundaries): [Source: _bmad-output/planning-artifacts/epics.md] (line 186), [Source: _bmad-output/planning-artifacts/architecture.md#Type-safety patterns] (lines 1028-1032)
- AR61 (audit-write sanctioned `void someAsync()`): [Source: _bmad-output/planning-artifacts/epics.md] (line 188)
- Audit log field naming (`camelCase`): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 912-914)
- ULID branded type: [Source: _bmad-output/planning-artifacts/architecture.md] (line 1009)
- Implementation sequence (this story = #5): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (line 817)
- Cross-component dependency map: [Source: _bmad-output/planning-artifacts/architecture.md] (line 835) — Audit logger depends on Configuration (path) + DomainError (Story 1.6, future); we satisfy the dep via DI not import
- Source-tree contract for `src/audit/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 1247-1251)
- Stream/output discipline: [Source: _bmad-output/planning-artifacts/architecture.md#Stream/output discipline] (lines 1144-1148)
- Async patterns + sanctioned audit-write `void`: [Source: _bmad-output/planning-artifacts/architecture.md#Async patterns] (lines 1150-1154)
- Testing patterns: [Source: _bmad-output/planning-artifacts/architecture.md#Testing patterns] (lines 1156-1166)
- Mandatory rules summary: [Source: _bmad-output/planning-artifacts/architecture.md#Mandatory rules] (lines 1167-1180)
- Anti-patterns (audit entries outside `finally`, etc.): [Source: _bmad-output/planning-artifacts/architecture.md] (lines 1182-1193)
- Logger import surface (consumed for WARN): [Source: src/diagnostic/logger.ts] (lines 15-19, 68-93)
- Story 1.4 fake-stream + DI-default patterns to mirror: [Source: _bmad-output/implementation-artifacts/1-4-configuration-module-and-secret-scrubber.md], [Source: src/diagnostic/logger.test.ts] (lines 9-49)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-3-diagnostic-logger.md], [Source: _bmad-output/implementation-artifacts/1-2-ref-domain-primitive.md], [Source: _bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md]
- Deferred-work ledger: [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **`path.isAbsolute` is platform-dependent — Windows-override path detection failed on the POSIX CI runner.** First-pass `resolveAuditLogPath` used the platform-default `path.isAbsolute(override)` check; on POSIX, `'C:\\ProgramData\\x\\audit.jsonl'` is not detected as absolute, so the test for AC4 case 2 (Windows env override) fell through to the AppData fallback. **Fix:** branch on `opts.platform` to call `path.win32.isAbsolute` or `path.posix.isAbsolute` explicitly. The `XDG_STATE_HOME` and `localAppData` checks already used the correct platform-specific variants — only the override branch needed the fix. (`src/audit/audit-logger.ts:95-98`)
- **`@typescript-eslint/unbound-method` flagged the ternary `path.win32.isAbsolute : path.posix.isAbsolute`.** Wrapping in an arrow function (`(p: string) => opts.platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p)`) preserves Node's internal `this`-binding and keeps the call site lint-clean. Same pattern Story 1.4 applied to `productionExit` (`src/config/config.ts:273`).
- **Multi-drain test math: 5 entries with [false,false,true,false,true] writes need 3 drain cycles, not 2.** Trace: write t0 consumes [false] → paused. Writes t1..t4 queue. Drain 1: pop t1 → [false] → paused. Drain 2: pop t2 → [true] → continue, pop t3 → [false] → paused. Drain 3: pop t4 → [true] → done. Test originally emitted 2 drains and expected 5 captured writes. Fixed by emitting 3 drains and updating the explanatory comment.
- **`close()` "waits for queue to drain" test let the queue empty synchronously inside `close()`'s flushQueue.** Original test pushed only one `false` return; `nextWriteReturns` then defaulted to `true`, so the synchronous flushQueue inside `close()` drained the queue and called `stream.end` immediately, contradicting the assertion `endCalls === 0` before drain. Fixed by stuffing `nextWriteReturns` with five `false` values to keep the stream paused through `close()`'s synchronous flush, then clearing the queue and emitting drain to trigger end.
- **`prettier --write` reflowed the test file's `if (b.length !== n) throw …` onto two lines and the audit-logger's isAbs ternary across three lines.** No semantic change. Both files now `prettier --check` clean.
- **No `as` casts in production code outside the documented sites.** The ULID generator's `value as AuditEntryId` is the single sanctioned brand-constructor cast (AR59), with an inline justification comment citing the `Ref` precedent. The test file's fake-stream cast (`as unknown as NodeJS.WritableStream`) is the test-boundary AR59 exemption mirroring `src/diagnostic/logger.test.ts:46-47`. Production code has zero `as` casts that aren't AR59-sanctioned.
- **`exactOptionalPropertyTypes: true` interaction:** `AuditEntry` literal builds optional fields via successive property assignment on a `Record<string, unknown>` accumulator, NEVER `key: undefined`. Same pattern Story 1.4 used for `Config`'s `auditLogPath` (`src/config/config.ts:188-197`).
- **`logger.warn` is called with the single-arg form** for the stream-error WARN (no second `err` argument). Story 1.3's logger contract `error(message, err?)` accepts an optional `err`, but the WARN message string already names the error reason; passing `err` would dump a multi-line stack trace into the WARN, contradicting AR50 ("warnings: ... single-line per event"). Pattern matches Story 1.4 dev-notes line 375.
- **`@types/node@^24` types `stream.end(callback)` accepts an optional callback.** The fake stream's `end(cb?)` signature with optional callback satisfies the cast at the test boundary. The actual `Writable.end()` callback fires after `'finish'` — production behaviour is correct.
- **No new dependencies; no `npm install` run.** All primitives are Node built-ins (`node:crypto`, `node:fs`, `node:path`, `node:buffer`).
- **Pack manifest delta verified:** 10 → 13 files. Added `src/audit/audit-logger.ts` (16.4 kB), `src/audit/digest.ts` (1.4 kB), `src/audit/schema.ts` (2.8 kB). Test files correctly excluded by `"!src/**/*.test.ts"` allowlist.

### Completion Notes List

- All 14 ACs satisfied; all 7 tasks (with subtasks) ticked. Validation gates: `npm run typecheck` exit 0, `npm run lint` exit 0, `npx prettier --check .` clean, `npm test` 164/164 pass (was 125 → +39 audit cases), `npm pack --dry-run` 10 → 13 files (delta = `src/audit/audit-logger.ts` + `src/audit/digest.ts` + `src/audit/schema.ts`).
- **Schema-v1 lock-in (AC1):** `AUDIT_SCHEMA_VERSION = 1 as const` plus `AuditEntry` / `AuditEntryInput` / `AuditDecision` / `AuditEntryId` types in `src/audit/schema.ts`. `AuditEntry.reason` is typed `string` (not a closed union) for forward-compat with Story 1.6's `ReasonCode` enum. Field order locked: `v, t, id, tool, args, decision, response, durationMs, reason?, details?, failedOperation?` — verified by an `Object.keys(parsed)` deep-equal assertion in the schema-v1 round-trip test.
- **Pure `digest()` (AC2):** UTF-8 byte length (not JS-string length) and lowercase-hex SHA-256. 7 unit tests cover empty input, ASCII, multi-byte UTF-8 (`'café'` size 5 vs. JS-length 4), 4-byte emoji, ≥ 64 KiB content, determinism, and lowercase-only output.
- **In-tree ULID generator (AC3):** `makeUlidGenerator({ clock, randomBytes })` returns a stateful closure. 26-char Crockford Base32 (`0-9A-HJKMNP-TV-Z`), 48-bit timestamp prefix + 80-bit randomness suffix, `BigInt`-based bit-packing for precision above 2⁵³. Monotonicity within a millisecond via increment of the previous randomness; overflow (`0xFF…FF`) re-draws fresh randomness via the injected `randomBytes` function (documented choice; ~2⁻⁸⁰ probability per call). 7 ULID tests cover format, time-prefix decoding, monotonicity across 100 same-ms calls, overflow re-draw, and the brand-cast (single AR59-sanctioned `as` site).
- **Pure `resolveAuditLogPath` (AC4):** branches on `opts.platform`; uses `path.win32.join` / `path.posix.join` and `path.win32.isAbsolute` / `path.posix.isAbsolute` explicitly so the resolver is deterministic on POSIX CI runners regardless of the input platform. Override is re-validated for absoluteness as defence-in-depth (Story 1.4 already validated at config-load time). 9 path tests cover the override (Unix + Windows + relative + empty), Unix XDG set/unset, Windows LOCALAPPDATA set/unset, and empty-string XDG.
- **`ensureAuditDir` + `openAuditStream` (AC5, AC6):** thin filesystem helpers — `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `createWriteStream(path, { flags: 'a' })`. JSDoc documents the Windows-mode-no-op caveat and the append-only flag rationale. Not unit-tested directly per the AC12 "no real filesystem writes" constraint; Story 1.11's startup-ladder integration test will exercise them end-to-end.
- **`createAuditLogger` factory (AC7–AC10):** `write(entry): void` — never returns a Promise (AR61 audit-write is the *only* sanctioned `void someAsync()` site). Stamps `v`/`t`/`id` server-side; tests never construct those. Backpressure: when `stream.write` returns `false`, subsequent serialised lines queue FIFO; `'drain'` fires the flush; multi-cycle drain preserved order verified across [false,false,true,false,true] pattern. `'error'`: single WARN to the diagnostic logger, queue dropped, subsequent writes become no-ops, second `'error'` is silent. `close(): Promise<void>` is idempotent, drains queue before `stream.end`, resolves immediately on errored streams. 17 factory tests cover all paths.
- **Circular-args fallback (AC12 case 13):** `JSON.stringify` on a self-referential object throws `TypeError`; the audit logger catches it, logs WARN, and emits a placeholder entry with `args: '<serialization_failed>'` and `details: { reason: 'serialization_failed', message: <err.message> }`. Preserves AR33 exactly-one-entry invariant. Verified by the circular-args test.
- **`openAuditLogger` composition (AC11):** the production wiring function — only place that touches the filesystem. Resolves path, ensures dir, opens stream, constructs the logger with the default `randomFillSync`-backed `randomBytes`. Returns `{ logger, filePath }` so Story 1.11's startup ladder can log a banner naming the resolved path.
- **No edits outside `src/audit/`.** No changes to `src/index.ts`, `src/diagnostic/`, `src/domain/`, `src/config/`, `eslint.config.js`, `package.json`, `tsconfig.json`, `.gitignore`, or any documentation. The deferred `.gitignore` cleanup (`deferred-work.md:10`) was left alone — the existing `audit.jsonl` rule remains correct for the default-CWD case (which the test suite never hits anyway, since tests use a fake stream).
- **Story 1.6 forward-compat:** `AuditEntry.reason: string` is intentionally loose so Story 1.6's closed `ReasonCode` enum can be reconciled at story-time without bumping `AUDIT_SCHEMA_VERSION` (NFR16). The on-disk shape is unchanged regardless of TS type tightening.
- **Open questions for review:** none. The factory's circular-args fallback is documented in JSDoc; the ULID overflow choice (re-draw vs. throw) is documented; the unbounded queue trade-off is documented. All AR-cited guardrails honoured.

### File List

**New:**
- `src/audit/schema.ts`
- `src/audit/digest.ts`
- `src/audit/digest.test.ts`
- `src/audit/audit-logger.ts`
- `src/audit/audit-logger.test.ts`

**Modified:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: 1-5 backlog → ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/1-5-audit-logger-jsonl-ulid-digest-drain.md` (Tasks/Subtasks ticked; Dev Agent Record / File List / Change Log filled; Status: ready-for-dev → review)

**Deleted:**
- `src/audit/.gitkeep` (module now has real files)

### Change Log

- 2026-04-30 — Story 1.5 implementation complete. Audit logger module shipped: `schema.ts` (`AUDIT_SCHEMA_VERSION = 1`, `AuditEntry`, `AuditEntryInput`, `AuditDecision`, branded `AuditEntryId`); `digest.ts` (pure `digest(content)` → `{ size, sha256 }` using UTF-8 byte length and lowercase-hex SHA-256); `audit-logger.ts` (`resolveAuditLogPath` pure platform-aware path resolver with override + XDG + Windows fallbacks; `ensureAuditDir` mkdir-recursive 0o700; `openAuditStream` append-only `{ flags: 'a' }`; `makeUlidGenerator` Crockford Base32 26-char ULIDs with same-ms monotonicity via increment-and-overflow-redraw; `createAuditLogger` factory with non-blocking `write(entry): void`, FIFO queue + drain handling, idempotent `close(): Promise<void>`, AR34 stream-error fail-policy with single WARN to diagnostic logger; `openAuditLogger` production composition). 39 new unit tests cover digest determinism, path resolution (9 cases), ULID format + monotonicity + overflow (7 cases), schema-v1 lock-in (1 case), and the factory's write/drain/close/error paths (17 cases including circular-args fallback). All gates green: typecheck/lint/prettier exit 0; tests 125 → 164 (+39); pack manifest 10 → 13 files (`src/audit/audit-logger.ts` + `src/audit/digest.ts` + `src/audit/schema.ts`). No new dependencies — Node `crypto`, `fs`, `path`, `buffer` built-ins only. Status: ready-for-dev → in-progress → review.
