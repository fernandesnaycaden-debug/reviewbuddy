import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockingReviews, bodySeverities, dismissible, dropPosted, findingKey, latestMarkedReview, markerFor, openFindings,
  parseMarker, postedKeys,
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

test('openFindings maps a range comment (start_line, line) back to its first line and endLine', () => {
  const comments = [
    { pull_request_review_id: 1, path: 'a.js', start_line: 4, line: 9, body: '**[BUG]** Loop' },
    { pull_request_review_id: 1, path: 'a.js', start_line: null, line: 2, body: '**[SECURITY]** Key' },
    { pull_request_review_id: 1, path: 'a.js', start_line: 5, line: null, body: '**[BUG]** Outdated range' },
  ];
  assert.deepEqual(openFindings(comments, new Set([1])), [
    {
      filename: 'a.js', line: 4, endLine: 9, severity: 'bug',
    },
    { filename: 'a.js', line: 2, severity: 'security' },
  ]);
  // The key is the first line, so a re-run of the range finding is recognised.
  assert.ok(postedKeys(comments, new Set([1])).has(findingKey('a.js', 4, 'bug')));
});

const blockBody = `reviewbuddy found 1 issue.\n\n${markerFor('aaaaaaa')}`;

test('blockingReviews keeps our reviews that still request changes', () => {
  const reviews = [
    { id: 1, state: 'CHANGES_REQUESTED', body: blockBody },
    { id: 2, state: 'DISMISSED', body: blockBody },
    { id: 3, state: 'COMMENTED', body: blockBody },
    { id: 4, state: 'CHANGES_REQUESTED', body: 'A person asking for changes' },
  ];
  assert.deepEqual(blockingReviews(reviews).map((r) => r.id), [1]);
});

test('bodySeverities reads the findings a review body lists, ranges included', () => {
  const body = [
    'reviewbuddy found 3 issues.',
    '',
    'These point at lines outside the diff, so they could not be posted inline:',
    '- `src/a.js:40` **[BUG]** Off-by-one',
    '- `src/b.js:4-9` **[SECURITY]** Unsafe loop',
    '',
    'Not reviewed:',
    '- `src/c.js`: over --max-files 1',
  ].join('\n');
  assert.deepEqual(bodySeverities(body), ['bug', 'security']);
  assert.deepEqual(bodySeverities(null), []);
});

const review = { id: 1, state: 'CHANGES_REQUESTED', body: blockBody };
const outdated = { pull_request_review_id: 1, path: 'a.js', line: null, body: '**[SECURITY]** Key' };
const current = { pull_request_review_id: 1, path: 'a.js', line: 2, body: '**[SECURITY]** Key' };
const rule = {
  blocking: ['security'], found: [], full: false, failed: false,
};

test('dismissible dismisses a change request once all its blocking comments are outdated', () => {
  assert.deepEqual(dismissible([review], [outdated], rule), [1]);
  // A suggestion that is still there doesn't block.
  assert.deepEqual(dismissible([review], [outdated, { ...current, body: '**[SUGGESTION]** Tidy' }], rule), [1]);
});

test('dismissible keeps a change request when unsure', () => {
  // A blocking comment still applies.
  assert.deepEqual(dismissible([review], [outdated, current], rule), []);
  // This run found a blocking issue (posted now or before), or a file failed.
  assert.deepEqual(dismissible([review], [outdated], { ...rule, found: ['bug', 'security'] }), []);
  assert.deepEqual(dismissible([review], [outdated], { ...rule, failed: true }), []);
  // The body lists a blocking finding, which can't be tracked.
  const listed = { ...review, body: `- \`a.js:40\` **[SECURITY]** Key\n\n${markerFor('aaaaaaa')}` };
  assert.deepEqual(dismissible([listed], [outdated], rule), []);
  // No blocking comment to judge by, or no blocking severities configured.
  assert.deepEqual(dismissible([review], [], rule), []);
  assert.deepEqual(dismissible([review], [outdated], { ...rule, blocking: [] }), []);
});

test('dismissible dismisses every change request after a full review finds no blocking issue', () => {
  const second = { ...review, id: 2 };
  assert.deepEqual(dismissible([review, second], [current], { ...rule, full: true }), [1, 2]);
  assert.deepEqual(dismissible([review, second], [current], { ...rule, full: true, found: ['security'] }), []);
});
