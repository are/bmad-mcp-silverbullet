# Deferred Work

A running ledger of items that are real but not actionable in the story that surfaced them. Each entry names its origin so future reviews can re-weigh.

## Deferred from: code review of story-1-1-project-scaffold-and-tooling (2026-04-30)

- **Enforce `engines.node` strictly?** — Decision (2026-04-30): leave advisory ("advisory is fine"). Contributors land on the right Node by README docs; no install-time gate. (`package.json:7-9`)
- **Test glob single-quoted breaks on Windows `cmd.exe`** — `package.json:21` uses `'src/**/*.test.ts'`; cmd.exe preserves the single quotes in argv and Node's glob then matches nothing. Project is POSIX-only for MVP; revisit when Windows support is on the roadmap.
- **`node --watch ./src/index.ts` may need `--experimental-strip-types` on early Node 24.x** — Strip-types became default-on partway through the 24.x line. Verify in CI which 24.x patch is the floor; flag README only if a regression appears. (`package.json:19`, `README.md:49`)
- **`.gitignore` audit-log pattern (`audit.jsonl`) may not match runtime write location** — Story 1.5 lands the audit logger; revisit the ignore pattern when the actual write path (CWD vs. configurable) is fixed.
- **`.gitignore` missing forward-looking patterns** (`dist/`, `coverage/`, `*.tsbuildinfo`) — No build step, no coverage tooling today. Revisit if either lands.
- **`lint-staged` glob misses `.editorconfig`, `*.yml`, `*.yaml`** — Minor formatting drift risk on non-`.ts/.js/.json/.md` configs. Tighten when CI / GH workflow YAML lands in Story 1.12.

## Deferred from: code review of story-1-2-ref-domain-primitive (2026-04-30)

- **Per-segment leading `.`/`^` and per-segment `.md` suffix rules** — `makeRef` validator applies leading-`.`/`^` and `.md` suffix rules only at the full-string boundary, so `Foo/.hidden`, `Foo/^bar`, and `Foo.md/Bar` all pass. SB's `Names.md` is per-name not per-segment, so tightening here would diverge from upstream without a documented threat. Revisit if SB's upstream validator changes, if Story 1.8's permission engine treats per-segment dotfiles specially, or if a per-segment exploit surfaces. (`src/domain/ref.ts:58-77`)

## Deferred from: code review of story-1-3-diagnostic-logger (2026-04-30)

- **Hostile `err` payloads with throwing getters could crash the logger** — `renderError(err)` reads `err.stack`, `err.message`, and falls through to `String(err)` with no try/catch. An `Error` subclass that throws on its `.stack` getter, or a plain object with a throwing `toString` / `Symbol.toPrimitive`, would surface the throw out of `logger.error(...)` — contradicting AC3's "never throws on bad inputs" spirit. Theoretical: real-world callers do not hand-craft hostile payloads. Revisit if a production crash is ever traced back to this surface, or when a future story tightens the input contract. (`src/diagnostic/logger.ts:55-63`)

## Deferred from: code review of story-1-5-audit-logger-jsonl-ulid-digest-drain (2026-04-30)

- **`createAuditLogger.filePath` is optional with the placeholder default `'<injected stream>'`** — If a future caller composes the factory without setting `filePath`, the placeholder string surfaces verbatim in the AR34 WARN (`audit log write failed: ... — continuing without audit (path: <injected stream>)`), which contradicts the spec wording in AC10 that assumes `<filePath>` is always the resolved on-disk path. Deferred because production (`openAuditLogger`) and every existing test pass `filePath` explicitly; making it required tightens the contract but breaks the symmetry of the DI shape. Revisit if a non-`openAuditLogger` consumer is added. (`src/audit/audit-logger.ts:47, 305, 343`)
- **`ensureAuditDir` does not chmod existing parent directories to `0o700`** — `mkdirSync({ recursive: true, mode: 0o700 })` per Node docs only applies `mode` to directories it creates. If `~/.local/state` already exists with `0o755` (created by another tool), the audit log lives in `~/.local/state/mcp-silverbullet/audit.jsonl` where the intermediate `~/.local/state` is world-readable for directory listings. The audit file itself is protected by the inner `mcp-silverbullet/` dir's `0o700`, so contents are not exposed — only the existence of the audit dir. AC5 explicitly mandates this exact `mkdirSync` invocation, so the behaviour is spec-correct. Revisit if directory-listing exposure is judged a leak in the threat model (Story 1.13). (`src/audit/audit-logger.ts:129-131`)

## Deferred from: code review of story-1-4-configuration-module-and-secret-scrubber (2026-04-30)

- **`pickPrimaryIssue` path-key collision** — `byPath` keys are `issue.path.join('.')`; lookup uses bare `FieldKey` strings. Works only because all current schema paths are top-level. Revisit if `ConfigSchema` ever gains a nested field. (`src/config/config.ts:144-167`)
- **`toFieldKey` silently coerces unknown paths to `'silverbulletUrl'`** — Defensive design is asymmetric: a misclassified path becomes a URL error rather than a generic config error. Revisit when schema gains additional fields. (`src/config/config.ts:84-88`)
- **`issueToConfigError` catch-all returns `rule: 'missing'`** — A future zod code (or schema refactor) surfaces an unmapped failure as "is required". Add an explicit `'invalid'` rule or assert never. (`src/config/config.ts:136-141`)
- **`formatConfigError` switch lacks a `default` arm** — A future `ConfigRule` variant returns `undefined` and breaks `loadConfigOrExit`'s destructuring. Add `default: throw` or `assertNever`. (`src/config/config.ts:228-254`)
- **`silverbulletUrl` / `auditLogPath` writable on wrapped object** — Despite TS `readonly`, runtime mutation is unblocked. Make them non-writable in `defineProperties`. (`src/config/secret-scrubber.ts:58-62`)
- **`structuredClone(wrapped)` drops token and serializer hooks** — Resulting clone is unusable by SB client and lacks redaction. No current caller; revisit if a clone path is added. (`src/config/secret-scrubber.ts:55-104`)
- **`Object.assign({}, wrapped)` drops token entirely** — Silent rather than `***redacted***`. Not a leak; behavioral surprise for callers expecting masked output. (`src/config/secret-scrubber.ts:55-104`)
- **`wrapConfig(wrapConfig(raw))` not idempotent** — Double-wraps; harmless today. Add a brand check if a re-wrap path emerges. (`src/config/secret-scrubber.ts:55`)
- **`toJSON` / `toString` close over `raw.silverbulletUrl` and `raw.auditLogPath`** — Direct-read vs serialized-view divergence if wrapper fields are mutated. Currently type-blocked by `Config` `readonly`. (`src/config/secret-scrubber.ts:74-93`)
- **Whitespace-only token (`'   '`) accepted** — `min(1)` is technically satisfied. Spec says length ≥ 1; tighten to `.refine(s => s.trim().length > 0)` if operator-error rate justifies it. (`src/config/config.ts:64`)
- **URL with userinfo (`https://user:pass@host`) accepted; userinfo flows into `toString` / `toJSON`** — Operator-controlled env, not in current threat model. Reject userinfo if NFR7 is tightened. (`src/config/config.ts:46-58`)
- **`toString` interpolates URL/path unescaped** — Values containing `,` or `)` break the format-shape contract used by log parsers. JSON-encode each field if a parser dependency emerges. (`src/config/secret-scrubber.ts:81-85`)
- **`ConfigError.message` for `must_use_https` lacks the exemption clause** — Rendered FATAL line is correct (formatter adds it); structured `.message` field is incomplete. Affects only consumers reading `.message` alone. (`src/config/config.ts:124`)
- **`must_be_non_empty` `ConfigRule` is structurally unreachable from `loadConfig`** — `readField` coerces empty-string to `undefined`, so empty token surfaces as `'missing'`. Defense-in-depth retention; no live test path. Either remove the rule or add a non-coerced bypass test. (`src/config/config.ts:23, 64, 102-108`)
- **IPv6 loopback `http://[::1]:port` rejected as `must_use_https`** — `isHttpsOrLocalhost` exempts only `localhost` and `127.0.0.1`. Reason for defer (Are, 2026-04-30): IPv6 support is not important for MVP. Revisit when a real operator hits it. (`src/config/config.ts:46-58`)
