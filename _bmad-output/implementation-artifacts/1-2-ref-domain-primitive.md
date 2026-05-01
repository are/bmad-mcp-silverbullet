# Story 1.2: `Ref` Domain Primitive

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer building tool handlers,
I want a branded `Ref` type with a validator-constructor for SilverBullet page paths, plus the shared `Result<T>` shape used by every pure-function module,
so that every MCP tool call's page argument is validated once at the boundary and internal modules can rely on the type system to enforce the discipline.

## Acceptance Criteria

**AC1 — `makeRef(s: string): Ref` accepts only valid SilverBullet page refs**

**Given** any string `s`,
**When** I call `makeRef(s)`,
**Then** it returns a `Ref` if `s` satisfies all of:
- Filesystem-safe (no null bytes `\x00`, no other ASCII control characters `\x01-\x1F` and `\x7F`)
- No `..` (or `.`) path-traversal segments (e.g. rejects `..`, `Foo/..`, `../bar`, `Foo/./Bar`, `./Foo`, `Foo/.`)
- No empty segments (e.g. rejects `Foo//Bar`, `/Foo`, `Foo/`)
- No leading or trailing whitespace
- Aligns with SilverBullet's accepted page-naming conventions (see Dev Notes → "SilverBullet page-naming rules" — derived from `silverbulletmd/silverbullet:plug-api/lib/ref.ts`).

**And** it throws `RefValidationError(value)` when any rule fails. The thrown error carries the original `value` and a `reason: string` describing which rule failed.

**AC2 — `Ref` is a branded type, unassignable from raw `string`**

**Given** the `Ref` type at compile time (`type Ref = string & { readonly __brand: 'Ref' }`),
**When** I attempt to assign a plain `string` to a `Ref`-typed binding (or pass `string` to a function expecting `Ref`),
**Then** TypeScript rejects the assignment unless the value is constructed via `makeRef()` (the only sanctioned `as Ref` site).

**AC3 — `Result<T>` shape is exported from `src/domain/result.ts`**

**Given** the `Result<T>` shape (`{ kind: 'ok'; value: T } | { kind: 'error'; error: DomainError }`) at `src/domain/result.ts`,
**When** I import it from a pure-function module,
**Then** it is available for use to return expected failures (per AR11),
**And** the file exports two helper constructors `ok<T>(value: T): Result<T>` and `err<T>(error: DomainError): Result<T>` for ergonomic call-site construction.

**AC4 — `RefValidationError` is a proper `Error` subclass**

**Given** the `RefValidationError` class at `src/domain/ref.ts`,
**When** I throw and catch it,
**Then** `instanceof Error` and `instanceof RefValidationError` both return `true`,
**And** `error.name === 'RefValidationError'`,
**And** `error.value` (the offending input) and `error.reason` (which rule failed) are accessible properties,
**And** the constructor restores the prototype correctly so that subclass `instanceof` works under TypeScript's `target: ES2022` (no extra prototype-chain ceremony required since ES2022 supports it natively, but verify in tests).

**AC5 — Refs returned from SilverBullet are re-validated defensively**

**Given** the documented contract in `src/domain/ref.ts`,
**When** future modules (the SB Runtime client in story 1.7, search/list handlers in story 1.10) receive `string` values from SilverBullet that name pages,
**Then** they MUST pass them through `makeRef()` defensively (per AR10 / architecture.md:362),
**And** this story documents that contract in JSDoc on `makeRef` so future authors know to honour it.

**AC6 — Unit tests cover happy path + adversarial inputs with no I/O**

**Given** the unit tests at `src/domain/ref.test.ts`,
**When** `npm test` runs,
**Then** every test passes with no I/O performed (no file reads, no network, no env-var reads),
**And** test coverage includes at minimum:
- Valid refs: `Foo`, `Foo Bar`, `Projects/Active`, `Daily/2026-04-30`, `CONFIG`, `Projects/Active/Foo Bar`, single-character `A`, names with hyphens/underscores
- Invalid refs (each must throw `RefValidationError`): empty string, single space, `..`, `.`, `Foo/..`, `../Foo`, `Foo/./Bar`, `Foo//Bar`, `/Foo` (leading slash), `Foo/` (trailing slash), `Foo\x00Bar` (null byte), `Foo\nBar` (newline), `Foo\tBar` (tab), `\tFoo`, `Foo\t`, ` Foo` (leading space), `Foo ` (trailing space), `.Foo` (leading dot), `^Foo` (leading caret), `Foo.md` (`.md` suffix forbidden by SB), `Foo|Bar` (pipe), `Foo@Bar` (at-sign), `Foo#Bar` (hash), `Foo<Bar`, `Foo>Bar`, `Foo[[Bar`, `Foo]]Bar`
- `RefValidationError.value` matches the original input string verbatim
- `RefValidationError.reason` is non-empty and identifies the failing rule

**AC7 — `tests/integration/scaffold.test.ts` placeholder is retained, NOT removed**

**Given** the integration-test placeholder at `tests/integration/scaffold.test.ts`,
**When** this story completes,
**Then** the placeholder remains in place. Story 1.1's removal note ("Remove when Story 1.2 lands real integration tests") was over-eager — this story adds *unit* tests under `src/domain/`, not integration tests. The placeholder stays until the first real integration test lands (likely story 1.10). Update the comment in `scaffold.test.ts` to reflect the new removal trigger.

**AC8 — All gates green**

**Given** the implementation,
**When** I run `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm test` from the project root,
**Then** all four exit 0,
**And** `npm test` reports the new `ref.test.ts` cases as passing,
**And** the test count strictly increases vs. the pre-story baseline (1 placeholder test).

## Tasks / Subtasks

- [x] **Task 1: Stub `DomainError` placeholder so `Result<T>` typechecks** (AC: #3) — see Dev Notes → "Forward-dependency on `DomainError`"
  - [x] Create `src/domain/error.ts` with the *minimal* shape `result.ts` needs:
    ```ts
    export type DomainError = {
      readonly reason: string;
      readonly message: string;
    };
    ```
  - [x] Add a JSDoc note marking this as a placeholder expanded in story 1.6 (full closed `ReasonCode` enum + formatter + serializer). Do NOT pre-emptively add the closed ReasonCode union here — story 1.6 owns that decision and changing it touches the audit schema (NFR16).
  - [x] Delete `src/domain/.gitkeep` (no longer needed — module now has real files).

- [x] **Task 2: Implement `Result<T>` and helpers** (AC: #3)
  - [x] Create `src/domain/result.ts` exporting:
    ```ts
    import type { DomainError } from './error.ts';
    export type Result<T> =
      | { readonly kind: 'ok'; readonly value: T }
      | { readonly kind: 'error'; readonly error: DomainError };
    export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
    export const err = <T>(error: DomainError): Result<T> => ({ kind: 'error', error });
    ```
  - [x] Imports use the `.ts` extension (project convention — `tsconfig.allowImportingTsExtensions: true`, Node 24 native type stripping).
  - [x] Use `import type` for the `DomainError` import (`verbatimModuleSyntax: true` in tsconfig requires explicit type-only imports).

- [x] **Task 3: Implement `Ref`, `makeRef`, `RefValidationError`** (AC: #1, #2, #4, #5)
  - [x] Create `src/domain/ref.ts` exporting:
    ```ts
    export type Ref = string & { readonly __brand: 'Ref' };

    export class RefValidationError extends Error {
      readonly value: string;
      readonly reason: string;
      constructor(value: string, reason: string) {
        super(`Invalid ref ${JSON.stringify(value)}: ${reason}`);
        this.name = 'RefValidationError';
        this.value = value;
        this.reason = reason;
      }
    }

    export function makeRef(value: string): Ref {
      const reason = validate(value);
      if (reason !== null) throw new RefValidationError(value, reason);
      return value as Ref;
    }
    ```
  - [x] Implement `validate(s: string): string | null` returning the failing-rule message or `null`. Apply rules **in order** (cheap checks first): empty → length cap → leading/trailing whitespace → control chars → starts-with `.`/`^`/`/` → ends-with `.md` → contains `[[` or `]]` → contains forbidden char (`|`/`@`/`#`/`<`/`>`) → split on `/` and check no segment is empty/`.`/`..`.
  - [x] Pure function — no `Date`, no I/O, no global state. Deterministic.
  - [x] JSDoc `makeRef`:
    - Document the validation rules verbatim from AC1.
    - Document that **every MCP tool argument naming a page MUST be converted via `makeRef()` before any other logic** (AR10, architecture.md:360).
    - Document that **refs returned from SB are re-validated defensively** via `makeRef()` (AR10, architecture.md:362).
  - [x] The `as Ref` cast inside `makeRef` is the **only** sanctioned cast site. ESLint `@typescript-eslint/no-explicit-any` is on; the cast is `as Ref` (a brand assertion), not `as any`, so it passes.

- [x] **Task 4: Write unit tests** (AC: #6)
  - [x] Create `src/domain/ref.test.ts` using `node:test` (built-in, zero runtime dep — established in story 1.1).
  - [x] Imports use top-level `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
  - [x] Use top-level `await test(...)` for each case — story 1.1 established this pattern to satisfy `no-floating-promises` (the test runner returns a Promise; bare `test(...)` calls would float).
  - [x] Cases (full enumeration in AC6). Implemented as flat top-level `for ... await test(...)` loops over `validCases` / `invalidCases` arrays + standalone tests for length cap and `RefValidationError` contract. (Did NOT use `describe` — see Debug Log: keeping the established top-level-await pattern from `tests/integration/scaffold.test.ts` over introducing nested-async patterns this story doesn't need.)
  - [x] No mocks, no fixtures, no I/O. Direct imports + inline values.

- [x] **Task 5: Update integration scaffold placeholder comment** (AC: #7)
  - [x] Edit `tests/integration/scaffold.test.ts`: change the comment from "Remove when Story 1.2 (`Ref` domain primitive) lands its first real integration test" to "Remove when the first real integration test lands (story 1.10 — read-side handler integration tests)."
  - [x] Do NOT delete the file. The placeholder still serves the `tests/integration/**/*.test.ts` zero-match guard noted in story 1.1 Open Question 3.

- [x] **Task 6: Local verification** (AC: #8)
  - [x] `npm run typecheck` — exits 0, zero TS errors.
  - [x] `npm run lint` — exits 0, zero rule violations.
  - [x] `npx prettier --check .` — all matched files formatted.
  - [x] `npm test` — 44 pass / 0 fail (was 1 → now 44; +43 new from `ref.test.ts`, +1 retained scaffold).
  - [x] `npm pack --dry-run` — manifest 4 → 7 files: `src/domain/error.ts` (454B), `src/domain/ref.ts` (3.8kB), `src/domain/result.ts` (647B). `ref.test.ts` correctly excluded by `"!src/**/*.test.ts"` allowlist.

## Dev Notes

### Architectural source-of-truth

This is story **#2** in the implementation sequence (`architecture.md:813-826` Decision Impact Analysis; explicit reaffirmation at `architecture.md:1599`). The `Ref` primitive is foundational: every subsequent module that touches a page name (permission engine 1.8, freshness state 1.9, edit-batch validator 2.1, all tool handlers in 1.10 + 2.2-2.5, audit logger 1.5, runtime client 1.7) accepts `Ref`, not `string`. The TypeScript type system is doing security work — that's the entire premise.

The `Ref` design is at `architecture.md:339-362` (D3, "Domain primitive: `Ref`"). The `Result<T>` shape and "return-don't-throw" discipline is at `architecture.md:1110-1120` (Error-handling discipline). The branded-primitive pattern is at `architecture.md:1004-1012` (Type-safety patterns).

### SilverBullet page-naming rules (closes architecture story-time deferral at `architecture.md:852,1509`)

Source of truth: `silverbulletmd/silverbullet` repo, **`plug-api/lib/ref.ts`** (`isValidName`, `refRegex`, `parseToRef`) and the rules doc **`website/Names.md`**. Citations:
- Rules doc: https://github.com/silverbulletmd/silverbullet/blob/main/website/Names.md
- Validator source: https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/lib/ref.ts (look for `isValidName` / `refRegex`)

**Rules to enforce in `makeRef` (consolidating SB's rules + architecture additions):**

| # | Rule | Source |
|---|------|--------|
| 1 | Non-empty | SB `Names.md` ("Names cannot be empty") |
| 2 | No leading/trailing whitespace | Architecture (defensive — SB's regex does not enforce) |
| 3 | No null bytes or other ASCII control chars (`\x00-\x1F`, `\x7F`) | Architecture (filesystem safety, AR10) |
| 4 | Cannot start with `.`, `^`, or `/` | SB `Names.md` |
| 5 | Cannot end with `.md` | SB `Names.md` |
| 6 | Cannot contain the sequences `[[` or `]]` | SB `Names.md` (wikilink-syntax conflict) |
| 7 | Cannot contain the characters `\|`, `@`, `#`, `<`, `>` | SB `Names.md` + `refRegex` (`@` is position suffix, `#` is header anchor, `\|` is rendered-name separator, `<>` reserved by SB regex) |
| 8 | No empty segments (no `//`) | SB `Names.md` (covered by rule 9 below) |
| 9 | No `.` or `..` as a path segment (rejects `Foo/./Bar`, `Foo/..`, `../Foo`, `..`, `.`, etc.) | SB `Names.md` (path-traversal protection) |

**Pragmatic length ceiling:** SB does not document one. Filesystem path-component limits are typically 255 bytes. Recommended: **enforce 1024 chars max** as a sanity guard against pathological inputs. This is not in SB's validator but is a defensive cap appropriate for a security-boundary validator. (Document this addition in the JSDoc.)

**Case sensitivity:** SB names are case-sensitive (confirmed in `Names.md`). Our validator does not normalize case — `makeRef('Foo')` and `makeRef('foo')` produce two distinct refs. The validator is byte-preserving.

**Things `makeRef` does NOT do (intentionally):**
- Does NOT normalize Unicode (NFC/NFD). SB stores names byte-for-byte; we preserve.
- Does NOT trim, lower-case, or otherwise mutate input. Validates strictly; either accepts verbatim or throws.
- Does NOT distinguish "system pages" like `CONFIG` — those are accepted as ordinary refs; story 1.8's permission engine handles their semantic role.
- Does NOT understand `@` position suffixes or `#` header anchors. The full SB ref regex includes these; our `makeRef` validates the *page name* portion only. MCP tool args carry only page names — position/anchor suffixes are not in the surface (per architecture.md:384, "page identifiers are refs (filesystem paths)").

### Forward-dependency on `DomainError` (story 1.6 owns the full type)

`Result<T>` references `DomainError`. Story 1.6 lands the full closed `ReasonCode` enum + `DomainError` shape + `formatToolError` + `serializeForAudit`.

**This story's responsibility:** create a *minimal* `src/domain/error.ts` placeholder (just enough for `result.ts` to typecheck — `{ reason: string; message: string }`). Story 1.6 will replace it with the full type. Do NOT pre-emptively define the closed `ReasonCode` enum here — that's a story 1.6 decision and changing it after-the-fact bumps the audit schema version (NFR16).

The placeholder is marked with a JSDoc comment: `/** @deprecated placeholder — story 1.6 will replace this with the full DomainError + ReasonCode + formatter. */` so the dev agent in 1.6 can find and replace it cleanly.

This is a deliberate, scoped forward-stub. It is NOT a violation of the "don't design for hypothetical future requirements" guidance because the requirement is *current* (AC3 needs it now); we just keep the stub as small as possible.

### Critical guardrails (do not rediscover)

1. **`as` casts are forbidden outside boundary constructors** (AR59, `architecture.md:1028-1031`). The `as Ref` inside `makeRef` is the *only* `as` cast in this story. Anywhere else — including in tests — must use real values constructed via `makeRef`. Tests that need a `Ref` should call `makeRef('SomeValid/Page')`, not `'SomeValid/Page' as Ref`.

2. **Pure functions return `Result<T>`; throws are reserved** (AR11, `architecture.md:1110-1118`). `makeRef` is the documented exception: it throws `RefValidationError` (per AC1; matches SB's `parseToRef` style and the architecture's example at `architecture.md:346-350`). The reasoning: `makeRef` is at the *outermost boundary* of input validation. Handlers' top-level catch converts the throw into a `validation_error` `DomainError` (story 1.6 + 1.10 wire this up). Internal pure functions never throw — they return `Result<T>`.

3. **`verbatimModuleSyntax: true`** (`tsconfig.json:12`). Type-only imports MUST use `import type`. Mixed value/type imports use `import { ok, type Result }` syntax. Plain `import { Result }` for type usage will fail typecheck.

4. **`erasableSyntaxOnly: true`** (`tsconfig.json:11`). No `enum`, no `namespace`, no constructor parameter properties (`constructor(public x)`). The `RefValidationError` class assigns properties in the constructor body explicitly (already shown in Task 3) — this is the compliant pattern.

5. **Imports must use `.ts` extension** (`tsconfig.json:14`, Node 24 native type stripping). `import './ref.ts'`, not `import './ref'` or `import './ref.js'`.

6. **No barrel re-exports** (AR57, `architecture.md:999`). Do NOT create `src/domain/index.ts`. Importers name files directly: `from '../domain/ref.ts'`.

7. **No `utils/` or `helpers/` catchalls** (AR57, `architecture.md:1000`). The `validate(s)` helper inside `ref.ts` stays inside `ref.ts` (it's tightly coupled to the `Ref` brand). Don't extract it to a sibling file unless you have a second consumer.

8. **Tests use `node:test` + top-level `await test(...)` to satisfy `no-floating-promises`** (story 1.1 Debug Log line 246 + `tests/integration/scaffold.test.ts:5`). This is the documented pattern; do NOT use `void test(...)` or wrap in promises differently.

### Story scope boundaries (DO NOT include)

- **The full `DomainError` type, `ReasonCode` closed enum, `formatToolError`, `serializeForAudit`** — story **1.6** owns these. Only the minimal stub belongs here.
- **The permission engine, freshness state, any handler** — later stories. `Ref` is a leaf primitive; no module imports from it yet. The TypeScript type system "uses" `Ref` only when later modules depend on it.
- **Integration tests, smoke tests** — none in this story. Unit tests only, adjacent to source.
- **JSDoc-generated documentation site, README updates** — not in this story.
- **Any zod schema** — `makeRef` is a hand-rolled validator; zod is for parsing structured external input (env vars, MCP tool args). Strings → `Ref` is a single-value validation; the architecture explicitly distinguishes the two boundaries (`architecture.md:1588`: "Validate inputs at module boundaries with zod or `makeRef`/equivalent").

### Files this story modifies vs. creates

**NEW:**
- `src/domain/ref.ts` — the brand + `makeRef` + `RefValidationError`
- `src/domain/ref.test.ts` — adjacent unit tests
- `src/domain/result.ts` — `Result<T>` + `ok`/`err` constructors
- `src/domain/error.ts` — *minimal placeholder* for `DomainError` (story 1.6 replaces)

**UPDATE:**
- `tests/integration/scaffold.test.ts` — comment update only (Task 5; do not change test behavior)

**DELETE:**
- `src/domain/.gitkeep` — module now has real files, .gitkeep no longer needed

### Testing standards

- Test framework: `node:test` (locked in story 1.1 at AR4 / `architecture.md:130-134`).
- Test location: **adjacent to unit** — `src/domain/ref.test.ts` next to `src/domain/ref.ts` (architecture.md:998).
- Test invocation: `npm test` runs `node --test 'src/**/*.test.ts' 'tests/integration/**/*.test.ts'` (`package.json:22`). The new `ref.test.ts` matches the first glob.
- **No mocks, no DI, no fixtures** for pure-function tests (architecture.md:1158). Direct imports + inline values.
- **No `Date.now()` or any clock dependency** — `makeRef` is pure (no time, no I/O).
- Use `assert.strictEqual` and `assert.throws` from `node:assert/strict` (strict variants reject coercion). Architecture doesn't mandate strict mode but it's the safer default for type-discipline projects.
- Group cases with `describe` blocks for readability — `node:test` supports this natively.

### Library / framework requirements

**No new dependencies.** This story is pure TypeScript primitives. Reuses the locked stack from story 1.1:

| Tool | Locked version | Notes |
|---|---|---|
| TypeScript | `^6.0.3` | `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes` all active |
| Node | `>=24` | Native TS stripping; no build step |
| `node:test` | built-in | Test framework |
| ESLint | `^10.2.1` + `typescript-eslint@^8.59.1` | `no-explicit-any` and `no-floating-promises` are on |
| Prettier | `^3.8.3` | 100 col, single quotes, semis, trailing commas all (`./.prettierrc.json`) |

If a `npm install` is suggested, that's a red flag — push back; this story shouldn't need one.

### File-structure requirements

After this story, `src/domain/` must look like:

```
src/domain/
├── ref.ts            # NEW: branded Ref + makeRef + RefValidationError
├── ref.test.ts       # NEW: unit tests
├── result.ts         # NEW: Result<T> + ok/err helpers
└── error.ts          # NEW: minimal DomainError stub (story 1.6 expands)
```

(`.gitkeep` is removed.) No new directories. No barrels. No subdirectories.

### Latest tech information (researched 2026-04-30)

- **SilverBullet page-naming rules** are codified in `silverbulletmd/silverbullet:plug-api/lib/ref.ts` and documented in `website/Names.md`. The full ref regex carries an explicit "ONLY TOUCH THIS IF YOU REALLY KNOW WHAT YOU ARE DOING" comment in the upstream source — we are deliberately implementing a stricter subset that covers page-name validation only (no `@position` / `#header` suffix handling, since those don't appear in our MCP tool surface per `architecture.md:384`).
- **Names are case-sensitive** in SilverBullet (`website/Names.md` confirms). Our validator preserves bytes verbatim; no normalization.
- **TypeScript ≥ 6 + `verbatimModuleSyntax: true`** requires explicit `import type` for type-only imports. The `Result<T>` import of `DomainError` uses `import type { DomainError } from './error.ts'`.
- **ES2022 target** (project `tsconfig.json:3`) supports native `class extends Error` with correct prototype chain — no manual `Object.setPrototypeOf(this, RefValidationError.prototype)` needed (that workaround was for ES5/ES2015 targets only).

### Project Structure Notes

This story exactly follows the architecture-mandated structure (`architecture.md:1252-1257`). The four files (`ref.ts`, `ref.test.ts`, `result.ts`, `error.ts`) are the documented contents of `src/domain/`. No deviation.

### Previous story intelligence (from story 1.1)

Distilled from `_bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md`:

1. **Top-level `await test(...)` is the established test pattern** to satisfy `no-floating-promises` (`tests/integration/scaffold.test.ts:5`; story 1.1 Debug Log line 246). Use this in `ref.test.ts`.
2. **`@types/node` is pinned to `^24`** (matches `engines: ">=24"`). No further version pins needed for this story.
3. **Lockfile is committed** (`package-lock.json` is in the repo). Don't re-run `npm install` unless adding deps — and you shouldn't be adding any.
4. **`npx prettier --check .`** is the format gate — `.prettierignore` already excludes `_bmad/`, `.claude/`, `docs/`, `LICENSE`, `package-lock.json`, `.gitkeep`. New `.ts` files under `src/` ARE checked.
5. **`bin: { 'mcp-silverbullet': './src/index.ts' }`** with `+x` permission bit. Don't change `index.ts` in this story (Story 1.11 owns startup wiring).
6. **`npm pack --dry-run` baseline** before this story: 4 files (LICENSE, README.md, package.json, src/index.ts). After this story: 7 files (adds `src/domain/ref.ts`, `result.ts`, `error.ts` — NOT `ref.test.ts`, excluded by `"!src/**/*.test.ts"` in the `files` allowlist).
7. **Pre-push hook references `tests/smoke/stdout-discipline.test.ts`** which doesn't exist yet (story 1.12 lands it). `git push` will fail until then — that's intentional. Local verification uses individual `npm run *` commands; commits work via pre-commit (lint-staged + typecheck + test, all of which will pass).
8. **`tests/integration/scaffold.test.ts` is a placeholder** for the zero-match-glob edge case (story 1.1 Open Question 3). Story 1.1 noted "remove when 1.2 lands"; AC7 corrects this — keep the placeholder until the first real integration test lands (likely story 1.10).

### Git intelligence

Single commit baseline: `76567e0 chore: initial commit — project scaffold, BMad install, story 1.1 done`. Story 1.1 footprint includes the entire scaffold + BMad install. This story should produce a commit footprint of **~5 files**: 4 new under `src/domain/`, 1 update to `tests/integration/scaffold.test.ts`, and the `src/domain/.gitkeep` deletion.

### References

- AC + story statement: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2]
- `Ref` design (D3): [Source: _bmad-output/planning-artifacts/architecture.md#Domain primitive: Ref] (lines 339-362)
- `Result<T>` shape (AR11): [Source: _bmad-output/planning-artifacts/architecture.md#Error-handling discipline] (lines 1110-1118)
- Branded-primitive pattern (AR59): [Source: _bmad-output/planning-artifacts/architecture.md#Type-safety patterns] (lines 1004-1012)
- Implementation sequence (this story = #2): [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis] (lines 813-826)
- Pure-function testing pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Testing patterns] (lines 1156-1166)
- Naming + structure rules: [Source: _bmad-output/planning-artifacts/architecture.md#Naming, #Structure] (lines 882-1000)
- Source-tree contract for `src/domain/`: [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] (lines 1252-1257)
- Story-time deferral on Ref regex: [Source: _bmad-output/planning-artifacts/architecture.md#Open implementation questions deferred to story-time] (line 852) — closed by this story
- AR10 (Ref validator boundary discipline) + AR11 (Result<T>): [Source: _bmad-output/planning-artifacts/epics.md#From Architecture — Domain Primitives & Pure-Function Cores]
- SB rules doc: https://github.com/silverbulletmd/silverbullet/blob/main/website/Names.md
- SB validator source: https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/lib/ref.ts (`isValidName`, `refRegex`)
- Prior story patterns: [Source: _bmad-output/implementation-artifacts/1-1-project-scaffold-and-tooling.md]

## Open Questions for User

1. **Length cap.** Story specifies a defensive 1024-char cap on refs (above SB's silence on length, below typical filesystem limits). Confirm this number, raise it, or remove the cap entirely — your call. Default if no answer: implement the 1024 cap with a JSDoc note that it's a defensive guard, not an SB-mandated rule.

2. **Should `result.ts` export `ok`/`err` helper constructors?** Story spec includes them (Task 2) for ergonomic call-site use (`return ok(value)` vs. `return { kind: 'ok', value }`). They cost nothing and are common idiom. Confirm or strip. Default if no answer: include them.

3. **`RefValidationError` shape.** Story spec gives it a `value: string` and a `reason: string` (which rule failed). The original architecture pseudo-code (`architecture.md:347`) shows `RefValidationError(value)` with no reason. Adding `reason` improves debugging without coupling to anything. Confirm or strip the `reason` field. Default if no answer: include `reason`.

### Review Findings

Triaged from a 3-layer code-review pass on 2026-04-30 (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Acceptance Auditor verdict: **all 8 ACs and all 6 tasks PASS**, no scope violations. Gates re-verified locally: typecheck/lint/prettier/test all exit 0; 44 tests pass. The findings below are not AC violations — they are bypass classes a security-boundary validator typically defends against, raised by the adversarial layers as decisions for you to weigh now or defer.

- [x] [Review][Patch] **Case-insensitive `.md` suffix rejection** [src/domain/ref.ts:30,63] — Switched `s.endsWith('.md')` → `MD_SUFFIX.test(s)` with `/\.md$/i`. Tests added for `Foo.MD`, `Foo.Md`, `Foo.mD`.
- [x] [Review][Patch] **C1 control characters U+0080–U+009F** [src/domain/ref.ts:48] — Control-char check extended to include the Latin-1 supplement range (`0x80-0x9F`). Tests added for U+0080 and U+009F mid-string.
- [x] [Review][Patch] **Lone / unpaired UTF-16 surrogates** [src/domain/ref.ts:41-47] — Added explicit pairing validation in the codepoint loop; lone high or low surrogates throw `RefValidationError`. Tests added for `\uD800` (lone high) and `\uDFFF` (lone low). Valid emoji (`😀`, paired surrogates) added to `validCases` to prevent over-rejection regression.
- [x] [Review][Patch] **Backslash `\` to forbidden chars** [src/domain/ref.ts:28] — Added `\` to `FORBIDDEN_CHARS`. Tests added for `Foo\Bar` and `Foo\..\Bar`.
- [x] [Review][Patch] **Length cap → 1024 UTF-8 bytes** [src/domain/ref.ts:27,34] — Renamed `MAX_LENGTH` → `MAX_BYTE_LENGTH`; switched cap to `Buffer.byteLength(s, 'utf8') > 1024`. ASCII boundary cases unchanged; new tests pin 256 emojis = 1024 bytes (valid) and 257 emojis = 1028 bytes (invalid).
- [x] [Review][Patch] **Zero-width invisibles & bidi overrides** [src/domain/ref.ts:29,54-56] — Added `INVISIBLE_OR_FORMAT_CHARS` regex covering U+00A0, U+200B–U+200F, U+202A–U+202E, U+2060, U+FEFF. Tests added for ZWSP, ZWNJ, ZWJ, RLO, word-joiner, mid-string BOM, interior NBSP.
- [x] [Review][Defer] **Per-segment rules (leading `.`/`^`/`.md` mid-path)** [src/domain/ref.ts:58-77] — deferred. Reason: SB's `Names.md` defines these rules per full name, not per segment; tightening here would diverge from upstream without a documented threat. Recorded in `_bmad-output/implementation-artifacts/deferred-work.md` for revisit if SB's validator changes or a per-segment exploit surfaces.

**Dismissed as noise** (kept here for reviewer trail; no action needed): `RefValidationError` runtime-freezing (over-engineering), reason-distinguishes-rule per-input mapping (test thoroughness over-spec), `_brandCheck` dead-code pattern (working as intended per AC2), `makeRef` throws while `Result<T>` is the discipline (architecture-mandated exception, spec lines 247-249), `ok`/`err` widened return types (matches spec template; ergonomic not a bug), missing `DomainError` factory (story 1.6 owns), missing `Object.setPrototypeOf` (ES2022 native subclassing per spec), `Error.captureStackTrace` (V8-specific, out of scope), test-count arithmetic (Blind Hunter miscounted; spec's "+43 new = 44 total" verified), comment hard-codes "story 1.10" (matches AC7 verbatim), Unicode normalization tests (out of scope per Dev Notes line 230). Auditor nits — `error.ts` uses prose vs `@deprecated` tag; the spec markdown file itself was added by this story — both intentional.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Amelia / Senior Software Engineer persona)

### Debug Log References

- **Open-question defaults applied without user prompt** (per `bmad-dev-story` workflow continuous-execution rule, given each open question had a documented default in the story file):
  - Q1 (length cap): implemented 1024-char defensive cap.
  - Q2 (`ok`/`err` helpers): included.
  - Q3 (`RefValidationError.reason` field): included.
  - All three are easy to revisit at code-review time; no architecture-level commitment was made.
- **Test structure: flat top-level `await test(...)` over `describe` blocks.** The story's Task 4 mentioned `describe` for grouping. Skipped `describe` because `node:test`'s synchronous `describe` callbacks complicate the established `no-floating-promises`-clean top-level-await pattern from `tests/integration/scaffold.test.ts:5`. Plain top-level `for (const x of cases) await test(...)` is equally readable and proven clean. Verified via `npm run lint` (exit 0).
- **Type-level brand assertion** lives inside `ref.test.ts` as a never-invoked `_brandCheck` function with a single `@ts-expect-error` line on the raw-string-to-`Ref` assignment. The justification comment (per AR59 / `architecture.md:1032` requiring `@ts-expect-error` to be inline-justified) explicitly cites Story 1.2 AC2. Typecheck passes — confirms the brand correctly rejects `string` and the `@ts-expect-error` is itself necessary (otherwise tsc flags the directive as unused).
- **`charAt` over bracket indexing** in `validate()` to avoid `noUncheckedIndexedAccess` `string | undefined` widening; `charAt` always returns `string`.
- **Pre-existing TS deprecation diagnostic on `eslint.config.js:4`** for `tseslint.config()` from `typescript-eslint@8.59.1` — already documented in story 1.1's Debug Log line 245 as a known soft hint. Not introduced by this story; continues to be ignorable until typescript-eslint v9 lands.
- **`.md` suffix rejection** is broader than SB's `refRegex`'s `.<ext>.md$` lookahead. Documented choice: align with SB's `Names.md` doc-text rule (`Foo.md` → reject) rather than the regex's narrower interpretation. The conservative validator catches the agent-typo case where the LLM appends `.md` thinking it's needed.

### Completion Notes List

- All 8 ACs satisfied; all 6 tasks ticked. Validation gates: `npm run typecheck` exit 0, `npm run lint` exit 0, `npx prettier --check .` clean, `npm test` 44 pass / 0 fail, `npm pack --dry-run` 4 → 7 files (manifest delta exactly the three new `.ts` source files; `ref.test.ts` excluded by allowlist).
- `Ref` is the project's first domain primitive. From story 1.3 onwards every module that handles a page name MUST accept `Ref`, not `string` (architecture-mandated; type system enforces).
- `Result<T>` ships with `ok`/`err` constructors. The placeholder `DomainError` in `src/domain/error.ts` carries an explicit JSDoc note that story 1.6 will replace it with the closed `ReasonCode` enum + formatter + serializer. The placeholder shape is `{ reason: string; message: string }` — minimal but compatible with whatever 1.6 widens it to.
- 43 new test cases in `src/domain/ref.test.ts`: 11 valid + 27 adversarial-invalid + 2 length-cap + 3 `RefValidationError` contract. The `_brandCheck` function (never invoked) gives the type-level "plain string is not a Ref" assertion via `@ts-expect-error`.
- Validation rule order optimised cheap-first (length, whitespace, control chars) before more expensive segment splitting. Order is documented in the Task 3 task list and matches the implementation in `src/domain/ref.ts:validate()`.
- SB page-naming rules consolidated from `silverbulletmd/silverbullet:plug-api/lib/ref.ts` (`isValidName`/`refRegex`) + `website/Names.md`. Architecture's story-time deferral at `architecture.md:852,1509` is now closed by this story.
- **Three open questions** (length cap value, `ok`/`err` helpers, `RefValidationError.reason` field) defaulted-and-implemented per documented story defaults. Reviewer is free to challenge any of these — they're contained changes.

### File List

**New:**
- `src/domain/ref.ts`
- `src/domain/ref.test.ts`
- `src/domain/result.ts`
- `src/domain/error.ts`

**Modified:**
- `tests/integration/scaffold.test.ts` (comment-only change — placeholder removal trigger updated from "Story 1.2" to "Story 1.10")
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: 1-2 backlog → ready-for-dev → in-progress → review)

**Deleted:**
- `src/domain/.gitkeep` (module now has real files)

### Change Log

- 2026-04-30 — Story 1.2 implementation complete. New domain primitives shipped: branded `Ref` type with `makeRef` validator + `RefValidationError`, `Result<T>` discriminated union with `ok`/`err` helpers, minimal `DomainError` placeholder (story 1.6 expands). 43 new unit tests cover the SB page-naming rule set (consolidated from `silverbulletmd/silverbullet:plug-api/lib/ref.ts` and `website/Names.md`) plus a type-level brand assertion via `@ts-expect-error`. All gates green: typecheck/lint/prettier/test all exit 0; pack manifest 4 → 7 files. Status: in-progress → review.
- 2026-04-30 — Code review pass. Acceptance Auditor: all 8 ACs and 6 tasks PASS. Adversarial layers (Blind Hunter / Edge Case Hunter) surfaced 7 bypass classes; user accepted 6 as patches and deferred 1 to a future story. Validator hardened: case-insensitive `.md` rejection, C1 control range (U+0080–U+009F), lone-surrogate rejection, backslash added to forbidden chars, length cap converted to UTF-8 bytes, invisible/format-character rejection (NBSP/ZWSP/ZWNJ/ZWJ/LRM/RLM/bidi-overrides/WJ/BOM). Test count 44 → 64 (+20 adversarial cases incl. emoji valid-paths). Per-segment rule extensions deferred — SB Names.md is per-name, not per-segment. All gates green re-verified. Status: review → done.
