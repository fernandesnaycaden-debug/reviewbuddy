import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { addedLines, chunkDiff, commentableLines, numberDiffLines, splitDiff } from '../src/diff.js';

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
