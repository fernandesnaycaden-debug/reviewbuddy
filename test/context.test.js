import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext, matchesDiff } from '../src/context.js';

/** A 200-line file, "line 1" to "line 200", with line 100 changed. */
const source = `${Array.from({ length: 200 }, (_, i) => (i === 99 ? 'changed();' : `line ${i + 1}`)).join('\n')}\n`;

const diff = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -99,3 +99,3 @@',
  ' line 99',
  '-line 100',
  '+changed();',
  ' line 101',
].join('\n');

test('buildContext sends the whole numbered file when it fits', () => {
  const context = buildContext(source, diff, 10_000);
  assert.equal(context.kind, 'full');
  const lines = context.text.split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines[0], '   1 line 1');
  assert.equal(lines[99], ' 100 changed();');
});

test('buildContext falls back to a window around each hunk', () => {
  const context = buildContext(source, diff, 1000, { window: 2 });
  assert.equal(context.kind, 'window');
  assert.equal(context.text, [
    '     ...',
    '  97 line 97',
    '  98 line 98',
    '  99 line 99',
    ' 100 changed();',
    ' 101 line 101',
    ' 102 line 102',
    ' 103 line 103',
    '     ...',
  ].join('\n'));
});

test('buildContext defaults to 40 lines around each hunk and merges windows that overlap', () => {
  const twoHunks = `${diff}\n@@ -130,1 +130,1 @@\n-x\n+line 130`;
  const context = buildContext(source, twoHunks, 2000);
  assert.equal(context.kind, 'window');
  const lines = context.text.split('\n');
  // 99-40 = 59 up to 130+40 = 170, as one window.
  assert.equal(lines[1], '  59 line 59');
  assert.equal(lines.at(-2), ' 170 line 170');
  assert.equal(lines.filter((l) => l === '     ...').length, 2);
});

test('buildContext keeps separate windows apart with a gap', () => {
  const twoHunks = `${diff}\n@@ -190,1 +190,1 @@\n-x\n+line 190`;
  const context = buildContext(source, twoHunks, 1000, { window: 1 });
  assert.equal(context.text, [
    '     ...',
    '  98 line 98',
    '  99 line 99',
    ' 100 changed();',
    ' 101 line 101',
    ' 102 line 102',
    '     ...',
    ' 189 line 189',
    ' 190 line 190',
    ' 191 line 191',
    '     ...',
  ].join('\n'));
});

test('buildContext gives up when even the windows exceed the budget', () => {
  assert.equal(buildContext(source, diff, 100), null);
  assert.equal(buildContext(source, diff, 0), null);
  assert.equal(buildContext(source, diff, -50), null);
});

test('buildContext sends nothing without a source', () => {
  assert.equal(buildContext(null, diff, 10_000), null);
  assert.equal(buildContext(undefined, diff, 10_000), null);
});

test('matchesDiff checks that the added lines are in the file, ignoring CRLF line endings', () => {
  assert.equal(matchesDiff(source, diff), true);
  assert.equal(matchesDiff(source.replace(/\n/g, '\r\n'), diff), true);
  assert.equal(matchesDiff(source.replace('changed();', 'other();'), diff), false);
  assert.equal(matchesDiff('line 1\n', diff), false);
});
