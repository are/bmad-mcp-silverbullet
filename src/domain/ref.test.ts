import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRef, RefValidationError, type Ref } from './ref.ts';

// Type-level assertion (Story 1.2 AC2): a plain string must not be assignable
// to `Ref`. This function is never invoked — it exists only to fail typecheck
// if the brand is broken.
function _brandCheck(): void {
  const _branded: Ref = makeRef('Foo');
  // @ts-expect-error — Story 1.2 AC2: plain `string` is not assignable to `Ref`.
  const _raw: Ref = 'Foo';
  void _branded;
  void _raw;
}
void _brandCheck;

const validCases: readonly string[] = [
  'Foo',
  'Foo Bar',
  'Projects/Active',
  'Daily/2026-04-30',
  'CONFIG',
  'Projects/Active/Foo Bar',
  'A',
  'foo-bar',
  'foo_bar',
  'My Page With Spaces',
  'a/b/c/d/e',
  '😀',
  'Projects/😀 Notes',
];

for (const input of validCases) {
  await test(`makeRef accepts: ${JSON.stringify(input)}`, () => {
    assert.strictEqual(makeRef(input), input);
  });
}

const invalidCases: ReadonlyArray<readonly [input: string, label: string]> = [
  ['', 'empty string'],
  [' ', 'whitespace only'],
  ['..', 'parent-directory bare'],
  ['.', 'current-directory bare'],
  ['Foo/..', 'trailing parent segment'],
  ['../Foo', 'leading parent segment'],
  ['Foo/./Bar', 'middle dot segment'],
  ['Foo//Bar', 'empty middle segment'],
  ['/Foo', 'leading slash'],
  ['Foo/', 'trailing slash'],
  ['Foo\x00Bar', 'null byte'],
  ['Foo\nBar', 'newline'],
  ['Foo\tBar', 'tab'],
  ['\tFoo', 'leading tab'],
  ['Foo\t', 'trailing tab'],
  [' Foo', 'leading space'],
  ['Foo ', 'trailing space'],
  ['.Foo', 'leading dot'],
  ['^Foo', 'leading caret'],
  ['Foo.md', '.md suffix'],
  ['Foo|Bar', 'pipe'],
  ['Foo@Bar', 'at-sign'],
  ['Foo#Bar', 'hash'],
  ['Foo<Bar', 'less-than'],
  ['Foo>Bar', 'greater-than'],
  ['Foo[[Bar', 'wikilink open'],
  ['Foo]]Bar', 'wikilink close'],
  ['Foo.MD', 'uppercase .MD suffix'],
  ['Foo.Md', 'mixed-case .Md suffix'],
  ['Foo.mD', 'mixed-case .mD suffix'],
  ['Foo\\Bar', 'backslash'],
  ['Foo\\..\\Bar', 'backslash path traversal'],
  ['Foo\u0080Bar', 'C1 control U+0080'],
  ['Foo\u009FBar', 'C1 control U+009F'],
  ['\uD800Foo', 'lone high surrogate'],
  ['Foo\uDFFF', 'lone low surrogate'],
  ['Foo\u200BBar', 'zero-width space'],
  ['Foo\u200CBar', 'zero-width non-joiner'],
  ['Foo\u200DBar', 'zero-width joiner'],
  ['Foo\u202EBar', 'right-to-left override'],
  ['Foo\u2060Bar', 'word joiner'],
  ['Foo\uFEFFBar', 'mid-string BOM / ZWNBSP'],
  ['Foo\u00A0Bar', 'interior non-breaking space'],
];

for (const [input, label] of invalidCases) {
  await test(`makeRef rejects ${label}: ${JSON.stringify(input)}`, () => {
    assert.throws(
      () => makeRef(input),
      (thrown: unknown) => {
        assert(thrown instanceof RefValidationError, 'expected RefValidationError');
        assert.strictEqual(thrown.value, input, 'error.value matches input verbatim');
        assert.ok(thrown.reason.length > 0, 'error.reason is non-empty');
        return true;
      },
    );
  });
}

await test('makeRef accepts a 1024-byte ASCII ref (UTF-8 length-cap boundary)', () => {
  const at1024 = 'a'.repeat(1024);
  assert.strictEqual(makeRef(at1024), at1024);
});

await test('makeRef rejects a 1025-byte ASCII ref (UTF-8 length-cap)', () => {
  const over1024 = 'a'.repeat(1025);
  assert.throws(() => makeRef(over1024), RefValidationError);
});

await test('makeRef accepts 256 emojis exactly (1024 UTF-8 bytes)', () => {
  const emoji = '\u{1F600}';
  const at1024 = emoji.repeat(256);
  assert.strictEqual(makeRef(at1024), at1024);
});

await test('makeRef rejects 257 emojis (1028 UTF-8 bytes, over the byte cap)', () => {
  const emoji = '\u{1F600}';
  const over1024 = emoji.repeat(257);
  assert.throws(() => makeRef(over1024), RefValidationError);
});

await test('RefValidationError is an Error and a RefValidationError instance', () => {
  let captured: unknown;
  try {
    makeRef('');
  } catch (caught) {
    captured = caught;
  }
  assert(captured instanceof Error, 'instanceof Error');
  assert(captured instanceof RefValidationError, 'instanceof RefValidationError');
  assert.strictEqual(captured.name, 'RefValidationError');
});

await test('RefValidationError exposes value and reason as readable properties', () => {
  let captured: RefValidationError | undefined;
  try {
    makeRef('..');
  } catch (caught) {
    assert(caught instanceof RefValidationError);
    captured = caught;
  }
  assert(captured !== undefined, 'error was thrown');
  assert.strictEqual(captured.value, '..');
  assert.ok(captured.reason.length > 0);
});

await test('RefValidationError message references the offending value', () => {
  let captured: RefValidationError | undefined;
  try {
    makeRef('|bad|');
  } catch (caught) {
    assert(caught instanceof RefValidationError);
    captured = caught;
  }
  assert(captured !== undefined);
  assert.ok(captured.message.includes('|bad|'), 'message includes the offending value');
});
