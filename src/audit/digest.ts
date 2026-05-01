import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/**
 * Compute a content digest suitable for the audit log's `response` field.
 * Returns the UTF-8 byte length and the lowercase-hex SHA-256 digest of the
 * input — never the raw content (NFR6 / `epics.md:78`, AR31
 * `epics.md:146`).
 *
 * `size` is the **UTF-8 byte length** of the content
 * (`Buffer.byteLength(content, 'utf8')`), NOT the JS-string length. UTF-8
 * byte length is the file-on-disk metric users will reconcile against; JS
 * `.length` counts UTF-16 code units which mismatches multi-byte
 * characters (e.g. `'café'.length === 4` but its UTF-8 byte length is 5).
 *
 * `sha256` is exactly 64 lowercase hex characters
 * (`createHash('sha256').update(content, 'utf8').digest('hex')`).
 *
 * The function is **pure**: no I/O, no clock, no global state. Same input
 * always yields the same output (NFR19 spirit; AR58 places `audit/digest`
 * in the pure-domain core, `epics.md:183`).
 *
 * Caller responsibility: this helper hashes whatever it's given. Filtering
 * `none`-mode page content (NFR6) is the handler's job — never call
 * `digest` on content the agent must not see.
 */
export function digest(content: string): { size: number; sha256: string } {
  return {
    size: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}
