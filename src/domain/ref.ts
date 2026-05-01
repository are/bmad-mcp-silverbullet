import { Buffer } from 'node:buffer';

/**
 * Branded type representing a validated SilverBullet page reference. The brand
 * is type-system-only (zero runtime cost). Construct via {@link makeRef}; the
 * cast inside `makeRef` is the only sanctioned `as Ref` site in the codebase.
 */
export type Ref = string & { readonly __brand: 'Ref' };

/**
 * Thrown by {@link makeRef} when the input string violates a SilverBullet
 * page-naming rule. Carries the original `value` (verbatim) and a short
 * `reason` identifying the failing rule.
 */
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

const MAX_BYTE_LENGTH = 1024;
const FORBIDDEN_CHARS: readonly string[] = ['|', '@', '#', '<', '>', '\\'];
const INVISIBLE_OR_FORMAT_CHARS = /[\u00A0\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;
const MD_SUFFIX = /\.md$/i;

function validate(s: string): string | null {
  if (s.length === 0) return 'name must be non-empty';
  if (Buffer.byteLength(s, 'utf8') > MAX_BYTE_LENGTH) {
    return `name exceeds ${MAX_BYTE_LENGTH}-byte UTF-8 limit`;
  }
  if (s !== s.trim()) return 'name has leading or trailing whitespace';

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo < 0xdc00 || lo > 0xdfff) return 'name contains lone high surrogate';
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return 'name contains lone low surrogate';
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `name contains control character (U+${hex})`;
    }
  }

  if (INVISIBLE_OR_FORMAT_CHARS.test(s)) {
    return 'name contains invisible or format character';
  }

  const firstChar = s.charAt(0);
  if (firstChar === '.' || firstChar === '^' || firstChar === '/') {
    return `name cannot start with '${firstChar}'`;
  }

  if (MD_SUFFIX.test(s)) return "name cannot end with '.md' (any case)";

  if (s.includes('[[')) return "name cannot contain '[['";
  if (s.includes(']]')) return "name cannot contain ']]'";

  for (const ch of FORBIDDEN_CHARS) {
    if (s.includes(ch)) return `name cannot contain '${ch}'`;
  }

  for (const segment of s.split('/')) {
    if (segment.length === 0) return 'name cannot have empty path segments';
    if (segment === '.' || segment === '..') {
      return `name cannot have '${segment}' path segment`;
    }
  }

  return null;
}

/**
 * Validate a string as a SilverBullet page reference and return a branded
 * {@link Ref}. Throws {@link RefValidationError} on any rule violation.
 *
 * **Validation rules** (consolidated from `silverbulletmd/silverbullet`'s
 * `plug-api/lib/ref.ts` `isValidName` + `website/Names.md`, plus defensive
 * additions called out in the architecture):
 *
 * 1. Non-empty.
 * 2. No leading or trailing whitespace (defensive — SB's regex does not
 *    enforce, but a security-boundary validator should).
 * 3. No control characters: ASCII `\x00`–`\x1F` + `\x7F`, plus C1 controls
 *    `\x80`–`\x9F`. Lone/unpaired UTF-16 surrogates also rejected.
 * 4. No invisible / format characters mid-string (NBSP, ZWSP, ZWNJ, ZWJ,
 *    LRM/RLM, bidi overrides, word joiner, BOM/ZWNBSP) — defends audit-log
 *    forensics against homoglyph and bidi-spoofing inputs.
 * 5. Cannot start with `.`, `^`, or `/`.
 * 6. Cannot end with `.md` (any case — `.md` / `.MD` / `.Md` all rejected).
 *    SB stores names with the extension; including it is virtually always an
 *    agent typo.
 * 7. Cannot contain the wikilink-syntax sequences `[[` or `]]`.
 * 8. Cannot contain `|`, `@`, `#`, `<`, `>`, `\` (SB-reserved, regex-reserved,
 *    or cross-platform path-traversal vectors).
 * 9. No empty path segments (no `//`).
 * 10. No `.` or `..` path segments — rejects path traversal.
 * 11. Maximum length 1024 bytes encoded as UTF-8 (defensive cap; not in SB's
 *     validator). Aligns with typical filesystem path-component limits.
 *
 * **Boundary discipline (AR10, architecture.md:360-362):** every MCP tool
 * argument naming a page MUST be converted via `makeRef()` *before any other
 * logic*. Refs returned from SilverBullet (e.g. `page` field on a config block
 * or search hit) MUST also be re-validated via `makeRef()` defensively — a
 * malformed ref from SB is treated as `config_error` per NFR11 fail-closed.
 *
 * The function is pure: no I/O, no clock, no global state.
 */
export function makeRef(value: string): Ref {
  const reason = validate(value);
  if (reason !== null) throw new RefValidationError(value, reason);
  return value as Ref;
}
