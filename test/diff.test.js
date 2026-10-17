import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  addedLines, chunkDiff, commentableLines, decodeDiff, filesFromApi, hunkIndex, numberDiffLines, patchToFile, splitDiff,
} from '../src/diff.js';

const gitDiff = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a };',
  '@@ -20,2 +21,3 @@',
  ' function f() {',
  '+  return 1;',
  ' }',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone();',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
].join('\n');

test('splitDiff splits git diffs per file and skips files with no added lines', () => {
  const files = splitDiff(gitDiff);
  assert.deepEqual(files.map((f) => f.filename), ['src/a.js']);
});

test('splitDiff handles plain diff -u output, CRLF and a byte order mark', () => {
  const plain = '﻿--- a.js\t2024-01-01\r\n+++ a.js\t2024-01-02\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n';
  const files = splitDiff(plain);
  assert.deepEqual(files.map((f) => f.filename), ['a.js']);
});

test('numberDiffLines numbers added and context lines with their new-file line', () => {
  const numbered = numberDiffLines(splitDiff(gitDiff)[0].diff);
  assert.match(numbered, /^ {3}2 \+const b = 3;$/m);
  assert.match(numbered, /^ {3}3 \+const c = 4;$/m);
  assert.match(numbered, /^ {2}22 \+ {2}return 1;$/m);
  assert.match(numbered, /^ {5}-const b = 2;$/m);
});

test('commentableLines includes context lines, addedLines only added ones', () => {
  const diff = splitDiff(gitDiff)[0].diff;
  assert.deepEqual([...commentableLines(diff)], [1, 2, 3, 4, 21, 22, 23]);
  assert.deepEqual([...addedLines(diff)], [2, 3, 22]);
});

test('chunkDiff keeps small diffs whole', () => {
  const diff = splitDiff(gitDiff)[0].diff;
  assert.deepEqual(chunkDiff(diff, 10000), [diff]);
});

test('chunkDiff cuts between hunks, repeats the header, and keeps line numbers', () => {
  const diff = splitDiff(gitDiff)[0].diff;
  const chunks = chunkDiff(diff, 50);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(chunk.startsWith('diff --git a/src/a.js b/src/a.js'));
  assert.deepEqual([...addedLines(chunks[0])], [2, 3]);
  assert.deepEqual([...addedLines(chunks[1])], [22]);
});

test('the sample diff has its planted bugs on added lines', async () => {
  const [file] = splitDiff(await readFile(new URL('../samples/buggy.diff', import.meta.url), 'utf8'));
  const added = addedLines(file.diff);
  for (const line of [4, 15, 22]) assert.ok(added.has(line), `line ${line} should be added`);
});

// Encodings

const BOM = String.fromCharCode(0xfeff);
const text = "diff --git a/café.js b/café.js\n+const s = 'naïve ✓';\n";

test('decodeDiff reads plain UTF-8 as is', () => {
  assert.equal(decodeDiff(Buffer.from(text, 'utf8')), text);
});

test('decodeDiff drops a UTF-8 byte order mark', () => {
  assert.equal(decodeDiff(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text);
});

test('decodeDiff decodes UTF-16 LE, as Windows PowerShell 5.1 writes with >', () => {
  const bytes = Buffer.from(BOM + text, 'utf16le');
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(decodeDiff(bytes), text);
  assert.deepEqual(splitDiff(decodeDiff(bytes)).map((f) => f.filename), ['café.js']);
});

test('decodeDiff decodes UTF-16 BE, and leaves its input unchanged', () => {
  const bytes = Buffer.from(BOM + text, 'utf16le').swap16();
  const copy = Buffer.from(bytes);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xfe, 0xff]);
  assert.equal(decodeDiff(bytes), text);
  assert.deepEqual(bytes, copy);
});

test('decodeDiff handles empty input and a lone byte order mark', () => {
  assert.equal(decodeDiff(Buffer.alloc(0)), '');
  assert.equal(decodeDiff(Buffer.from([0xff, 0xfe])), '');
  assert.equal(decodeDiff(Buffer.from([0xfe, 0xff, 0x00])), '');
});

/** The hunks of a single-file git diff: what GitHub's files API sends as a file's patch. */
function patchOf(fileDiff) {
  const lines = fileDiff.split('\n');
  return lines.slice(lines.findIndex((l) => l.startsWith('@@ '))).join('\n');
}

/**
 * What the review uses of a file: its numbered hunks and the lines it may comment on.
 * The headers may differ: the files API has no "index" line, which carries no line numbers.
 */
function lineView(diff) {
  return { numbered: patchOf(numberDiffLines(diff)), commentable: [...commentableLines(diff)], added: [...addedLines(diff)] };
}

test('patchToFile numbers lines exactly as splitDiff does for the same file', () => {
  const [fromDiff] = splitDiff(gitDiff);
  const fromApi = patchToFile({ filename: 'src/a.js', status: 'modified', patch: patchOf(fromDiff.diff) });
  assert.equal(fromApi.filename, 'src/a.js');
  assert.deepEqual(lineView(fromApi.diff), lineView(fromDiff.diff));
  assert.deepEqual(chunkDiff(fromApi.diff, 40).map((c) => lineView(c).added), chunkDiff(fromDiff.diff, 40).map((c) => lineView(c).added));
});

test('patchToFile builds headers for added and renamed files', () => {
  const added = patchToFile({ filename: 'new.js', status: 'added', patch: '@@ -0,0 +1,2 @@\n+a();\n+b();' });
  assert.equal(added.diff, 'diff --git a/new.js b/new.js\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+a();\n+b();');
  assert.deepEqual([...addedLines(added.diff)], [1, 2]);
  assert.deepEqual(splitDiff(added.diff), [added]);

  const renamed = patchToFile({
    filename: 'lib/b.js', previous_filename: 'src/b.js', status: 'renamed', patch: '@@ -3 +3 @@\n-x\n+y\n',
  });
  assert.match(renamed.diff, /^diff --git a\/src\/b\.js b\/lib\/b\.js\n--- a\/src\/b\.js\n\+\+\+ b\/lib\/b\.js\n/);
  assert.deepEqual(splitDiff(renamed.diff), [renamed]);
});

test('patchToFile skips files without a patch or without added lines', () => {
  assert.equal(patchToFile({ filename: 'img.png', status: 'modified' }), null);
  assert.equal(patchToFile({ filename: 'old.js', status: 'removed', patch: '@@ -1 +0,0 @@\n-gone();' }), null);
});

test('filesFromApi lists files GitHub sent no patch for as too large, but not binary files or renames', () => {
  const { files, tooLarge } = filesFromApi([
    { filename: 'a.js', status: 'modified', additions: 1, patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'huge.js', status: 'modified', additions: 40000 },
    { filename: 'img.png', status: 'modified', additions: 0 },
    { filename: 'moved.js', previous_filename: 'was.js', status: 'renamed', additions: 0 },
    { filename: 'gone.js', status: 'removed', additions: 0, patch: '@@ -1 +0,0 @@\n-x' },
  ]);
  assert.deepEqual(files.map((f) => f.filename), ['a.js']);
  assert.deepEqual(tooLarge, ['huge.js']);
});

test('hunkIndex numbers the hunk of every added and context line', () => {
  const diff = [
    '--- a/a.js', '+++ b/a.js',
    '@@ -1,2 +1,3 @@', ' a', '+b', ' c',
    '@@ -10,1 +11,2 @@', '-old', '+d', ' e', '',
  ].join('\n');
  assert.deepEqual([...hunkIndex(diff)], [[1, 0], [2, 0], [3, 0], [11, 1], [12, 1]]);
});
