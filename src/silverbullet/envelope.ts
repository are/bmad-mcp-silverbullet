import { Buffer } from 'node:buffer';

/**
 * Build a SilverBullet space-lua script that decodes its parameters from a
 * base64-encoded JSON envelope rather than via raw interpolation. The base64
 * alphabet (`[A-Za-z0-9+/=]`) shares no characters with Lua string-literal
 * escape syntax, so embedding the payload between double-quotes inside the
 * Lua source is provably injection-safe — adversarial inputs like
 * `'; os.exit() --` round-trip byte-for-byte through the JSON layer and
 * never reach the Lua parser as code.
 *
 * The rendered script is wrapped in an immediately-invoked function
 * expression (IIFE) so it stays a **single Lua expression**. SB's
 * `POST /.runtime/lua` endpoint evaluates its body via `eval(...)` style,
 * which prepends an implicit `return` — meaning a bare `local _p = ...`
 * statement block fails to parse with "unexpected symbol near 'l'". The
 * IIFE wrapper sidesteps this by making the entire script
 * `(function() ... end)()`, which IS a valid expression and lets the body
 * contain any number of `local` declarations + a `return` of its own.
 *
 * Decode chain (verified against SB's API docs at story-1.7 implementation
 * time):
 *
 * 1. `encoding.base64Decode(s)` (`website/API/encoding.md`) — base64 string → byte buffer.
 * 2. `encoding.utf8Decode(buf)` (same) — byte buffer → UTF-8 Lua string.
 * 3. `js.window.JSON.parse(s)` (`website/API/js.md` + browser-global) —
 *    UTF-8 JSON string → JS object via the JS-interop bridge.
 * 4. `js.tolua(jsValue)` — JS object → Lua table.
 *
 * Pure: no I/O.
 *
 * @see AR22 (`epics.md:135`) — base64+JSON envelope is the only sanctioned
 *   parameter-passing mechanism; raw interpolation is forbidden.
 * @see D3 (`architecture.md:322-338`) — injection-safety rationale.
 *
 * @example
 * buildScript('return _p.x', { x: 1 });
 * // '(function()\nlocal _p = js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode("eyJ4IjoxfQ=="))))\nreturn _p.x\nend)()'
 */
export function buildScript(template: string, params?: Readonly<Record<string, unknown>>): string {
  const payload = Buffer.from(JSON.stringify(params ?? {}), 'utf8').toString('base64');
  return `(function()\nlocal _p = js.tolua(js.window.JSON.parse(encoding.utf8Decode(encoding.base64Decode("${payload}"))))\n${template}\nend)()`;
}
