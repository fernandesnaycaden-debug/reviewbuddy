import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrUrl } from '../src/github.js';
import { DEFAULT_IGNORE, isIgnored, parsePatterns } from '../src/ignore.js';
import { atLeast, cleanSuggestion, parseComments } from '../src/review.js';

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

test('parseComments keeps a one-line suggestion and tolerates replies without one', () => {
  const reply = JSON.stringify({
    comments: [
      { line: 1, severity: 'bug', message: 'Off-by-one', suggestion: 'for (let i = 0; i < n; i++) {\n' },
      { line: 2, severity: 'bug', message: 'No field' },
      { line: 3, severity: 'bug', message: 'Empty', suggestion: '  ' },
      { line: 4, severity: 'bug', message: 'Two lines', suggestion: 'a();\nb();' },
      { line: 5, severity: 'bug', message: 'Not a string', suggestion: 42 },
    ],
  });
  assert.deepEqual(parseComments(reply), [
    { line: 1, severity: 'bug', message: 'Off-by-one', suggestion: 'for (let i = 0; i < n; i++) {' },
    { line: 2, severity: 'bug', message: 'No field' },
    { line: 3, severity: 'bug', message: 'Empty' },
    { line: 4, severity: 'bug', message: 'Two lines' },
    { line: 5, severity: 'bug', message: 'Not a string' },
  ]);
});

test('cleanSuggestion indents the fix like the line it replaces', () => {
  assert.equal(cleanSuggestion('return a < b;', '    return a <= b;'), '    return a < b;');
  assert.equal(cleanSuggestion('  return a < b;', '\treturn a <= b;'), '\treturn a < b;');
  assert.equal(cleanSuggestion('x = 1;  ', 'x = 2;'), 'x = 1;');
});

test('cleanSuggestion drops fixes that are empty, unchanged, multi-line or for an unknown line', () => {
  assert.equal(cleanSuggestion(undefined, 'x = 2;'), undefined);
  assert.equal(cleanSuggestion('', 'x = 2;'), undefined);
  assert.equal(cleanSuggestion('x = 2;', '    x = 2;'), undefined);
  assert.equal(cleanSuggestion('a();\nb();', 'a();'), undefined);
  assert.equal(cleanSuggestion('x = 1;', undefined), undefined);
});

test('atLeast ranks security > bug > performance > suggestion', () => {
  assert.ok(atLeast('security', 'bug'));
  assert.ok(atLeast('bug', 'bug'));
  assert.ok(!atLeast('performance', 'bug'));
  assert.ok(!atLeast('suggestion', 'performance'));
  assert.ok(atLeast('suggestion', undefined));
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
