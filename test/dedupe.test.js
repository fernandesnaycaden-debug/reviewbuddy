import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dropPosted, findingKey, latestMarkedReview, markerFor, openFindings, parseMarker, postedKeys,
} from '../src/dedupe.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

test('parseMarker reads the SHA back from a marker', () => {
  assert.equal(parseMarker(`Summary\n\n${markerFor(sha)}`), sha);
});

test('parseMarker returns null without a marker', () => {
  assert.equal(parseMarker('A review by a person'), null);
  assert.equal(parseMarker('<!-- some other comment -->'), null);
  assert.equal(parseMarker('<!-- reviewbuddy:sha=not-a-sha -->'), null);
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker(null), null);
});

test('latestMarkedReview picks the last review with a marker, whoever wrote it', () => {
  const reviews = [
    { id: 1, user: { login: 'me' }, body: markerFor('aaaaaaa') },
    { id: 2, user: { login: 'github-actions[bot]' }, body: `Found 1 issue\n\n${markerFor('bbbbbbb')}` },
    { id: 3, user: { login: 'colleague' }, body: 'LGTM' },
  ];
  assert.deepEqual(latestMarkedReview(reviews), { id: 2, sha: 'bbbbbbb' });
  assert.equal(latestMarkedReview([{ id: 3, body: 'LGTM' }]), null);
  assert.equal(latestMarkedReview([]), null);
});

test('findingKey matches on path, line and severity, ignoring severity case', () => {
  assert.equal(findingKey('a.js', 3, 'SECURITY'), findingKey('a.js', 3, 'security'));
  assert.notEqual(findingKey('a.js', 3, 'bug'), findingKey('a.js', 3, 'security'));
  assert.notEqual(findingKey('a.js', 3, 'bug'), findingKey('a.js', 4, 'bug'));
  assert.notEqual(findingKey('a.js', 3, 'bug'), findingKey('b.js', 3, 'bug'));
});

test('postedKeys keeps current comments from our reviews only', () => {
  const comments = [
    { pull_request_review_id: 1, path: 'a.js', line: 2, body: '**[SECURITY]** Hardcoded key' },
    { pull_request_review_id: 9, path: 'a.js', line: 5, body: '**[BUG]** From a person, not us' },
    { pull_request_review_id: 1, path: 'a.js', line: null, body: '**[BUG]** Outdated' },
    { pull_request_review_id: 1, path: 'a.js', line: 7, body: 'A reply without a severity' },
  ];
  assert.deepEqual(postedKeys(comments, new Set([1])), new Set([findingKey('a.js', 2, 'security')]));
  assert.deepEqual(openFindings(comments, new Set([1])), [{ filename: 'a.js', line: 2, severity: 'security' }]);
});

test('dropPosted removes findings already posted and counts them', () => {
  const results = [{
    filename: 'a.js',
    diff: '',
    comments: [
      { line: 2, severity: 'security', message: 'Hardcoded key, reworded' },
      { line: 2, severity: 'bug', message: 'Different severity' },
    ],
  }];
  const { results: kept, skipped } = dropPosted(results, new Set([findingKey('a.js', 2, 'security')]));
  assert.equal(skipped, 1);
  assert.deepEqual(kept[0].comments, [{ line: 2, severity: 'bug', message: 'Different severity' }]);
});
