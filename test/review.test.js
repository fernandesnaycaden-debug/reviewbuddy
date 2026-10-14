import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrUrl } from '../src/github.js';
import { DEFAULT_IGNORE, isIgnored, parsePatterns } from '../src/ignore.js';
import { parseComments } from '../src/review.js';

test('parseComments returns null for replies that are not the JSON we asked for', () => {
  assert.equal(parseComments('not json'), null);
  assert.equal(parseComments('{"issues": []}'), null);
});

test('parseComments normalizes comments and drops malformed ones', () => {
  const reply = JSON.stringify({
    comments: [
      { line: '4', severity: 'SECURITY', message: '  Hardcoded key  ' },
      { line: 7, severity: 'nitpick', message: 'Unknown severity' },
      { line: 'x', severity: 'bug', message: 'Bad line' },
      { line: 9, severity: 'bug' },
    ],
  });
  assert.deepEqual(parseComments(reply), [
    { line: 4, severity: 'security', message: 'Hardcoded key' },
    { line: 7, severity: 'suggestion', message: 'Unknown severity' },
  ]);
});

test('parsePrUrl reads owner, repo and number', () => {
  assert.deepEqual(parsePrUrl('https://github.com/o/r.js/pull/12/files'), { owner: 'o', repo: 'r.js', number: 12 });
  assert.equal(parsePrUrl('samples/buggy.diff'), null);
});

test('isIgnored matches file names, directories and full paths', () => {
  assert.ok(isIgnored('package-lock.json', DEFAULT_IGNORE));
  assert.ok(isIgnored('web/package-lock.json', DEFAULT_IGNORE));
  assert.ok(isIgnored('public/app.min.js', DEFAULT_IGNORE));
  assert.ok(isIgnored('packages/ui/dist/index.js', DEFAULT_IGNORE));
  assert.ok(!isIgnored('src/distance.js', DEFAULT_IGNORE));
  assert.ok(!isIgnored('src/build.js', DEFAULT_IGNORE));
  assert.ok(isIgnored('src/gen/api.js', ['src/gen/*.js']));
  assert.ok(!isIgnored('lib/src/gen/api.js', ['src/gen/*.js']));
});

test('parsePatterns splits a comma-separated list', () => {
  assert.deepEqual(parsePatterns(' a, ,b/ '), ['a', 'b/']);
  assert.deepEqual(parsePatterns(undefined), []);
});
