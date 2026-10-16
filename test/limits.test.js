import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capInlineComments, fileRank, MAX_INLINE_COMMENTS, selectFiles,
} from '../src/limits.js';

/** A file whose diff adds n lines. */
function file(filename, n) {
  const added = Array.from({ length: n }, (_, i) => `+line ${i}`);
  return { filename, diff: [`--- a/${filename}`, `+++ b/${filename}`, `@@ -0,0 +1,${n} @@`, ...added].join('\n') };
}

test('fileRank puts source before tests before docs and config', () => {
  assert.equal(fileRank('src/app.js'), 0);
  assert.equal(fileRank('lib/server.go'), 0);
  assert.equal(fileRank('test/app.test.js'), 1);
  assert.equal(fileRank('src/__tests__/a.js'), 1);
  assert.equal(fileRank('pkg/handler_test.go'), 1);
  assert.equal(fileRank('src/a.spec.ts'), 1);
  assert.equal(fileRank('README.md'), 2);
  assert.equal(fileRank('docs/guide.html'), 2);
  assert.equal(fileRank('config/app.yml'), 2);
  assert.equal(fileRank('package.json'), 2);
});

test('selectFiles keeps every file without a limit, or when under it', () => {
  const files = [file('a.js', 1), file('b.md', 1)];
  assert.deepEqual(selectFiles(files, 0), { selected: files, skipped: [] });
  assert.deepEqual(selectFiles(files, 5), { selected: files, skipped: [] });
});

test('selectFiles picks source first, then the biggest changes, and keeps the PR order', () => {
  const files = [
    file('README.md', 500),
    file('test/a.test.js', 300),
    file('src/small.js', 2),
    file('src/big.js', 80),
    file('src/tie1.js', 10),
    file('src/tie2.js', 10),
  ];
  const { selected, skipped } = selectFiles(files, 4);
  // The four source files beat the much larger test and README; they stay in PR order.
  assert.deepEqual(selected.map((f) => f.filename), ['src/small.js', 'src/big.js', 'src/tie1.js', 'src/tie2.js']);
  assert.deepEqual(skipped.map((f) => f.filename), ['README.md', 'test/a.test.js']);

  // Within the source files, the bigger changes win; a tie goes to the earlier file.
  assert.deepEqual(selectFiles(files, 2).selected.map((f) => f.filename), ['src/big.js', 'src/tie1.js']);
  // With room for one more than the source files, tests come before docs.
  assert.deepEqual(selectFiles(files, 5).skipped.map((f) => f.filename), ['README.md']);
});

test('capInlineComments keeps the most severe inline, in file order, and moves the rest out', () => {
  const candidates = [
    { id: 1, severity: 'suggestion' },
    { id: 2, severity: 'bug' },
    { id: 3, severity: 'performance' },
    { id: 4, severity: 'security' },
    { id: 5, severity: 'bug' },
  ];
  const { inline, overflow } = capInlineComments(candidates, 3);
  assert.deepEqual(inline.map((c) => c.id), [2, 4, 5]);
  assert.deepEqual(overflow.map((c) => c.id), [1, 3]);
  assert.deepEqual(capInlineComments(candidates, 10), { inline: candidates, overflow: [] });
  assert.equal(MAX_INLINE_COMMENTS, 50);
});
