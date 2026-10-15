import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  getCompareDiff, getFileContent, getPullRequest, getPullRequestDiff, listReviewComments, listReviews, postReview,
} from '../src/github.js';

const pr = { owner: 'o', repo: 'r', number: 12 };

/** Mock fetch to return each of the given responses in turn. */
function mockFetch(...responses) {
  return mock.method(globalThis, 'fetch', async () => responses.shift());
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => mock.method(console, 'warn', () => {}));
afterEach(() => mock.restoreAll());

test('getPullRequest fetches the pull request with the token', async () => {
  const fetch = mockFetch(json({ head: { sha: 'abc' } }));
  assert.deepEqual(await getPullRequest(pr, 'tok'), { head: { sha: 'abc' } });

  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/o/r/pulls/12');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
});

test('getPullRequestDiff asks for a diff and sends no token when there is none', async () => {
  const fetch = mockFetch(new Response('diff --git a/x b/x'));
  assert.equal(await getPullRequestDiff(pr, undefined), 'diff --git a/x b/x');

  const { headers } = fetch.mock.calls[0].arguments[1];
  assert.equal(headers.Accept, 'application/vnd.github.diff');
  assert.equal('Authorization' in headers, false);
});

test('listReviews follows pages until one comes back short', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const fetch = mockFetch(json(page1), json([{ id: 100 }]));
  const reviews = await listReviews(pr, 'tok');
  assert.equal(reviews.length, 101);
  assert.equal(reviews.at(-1).id, 100);

  const urls = fetch.mock.calls.map((c) => c.arguments[0]);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/o/r/pulls/12/reviews?per_page=100&page=1',
    'https://api.github.com/repos/o/r/pulls/12/reviews?per_page=100&page=2',
  ]);
});

test('listReviewComments stops after one short page', async () => {
  const fetch = mockFetch(json([{ id: 1, path: 'a.js', line: 2 }]));
  assert.deepEqual(await listReviewComments(pr, 'tok'), [{ id: 1, path: 'a.js', line: 2 }]);
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://api.github.com/repos/o/r/pulls/12/comments?per_page=100&page=1');
});

test('getCompareDiff asks for the diff between two commits', async () => {
  const fetch = mockFetch(new Response('diff --git a/x b/x'));
  assert.equal(await getCompareDiff(pr, 'tok', 'old', 'new'), 'diff --git a/x b/x');

  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/o/r/compare/old...new');
  assert.equal(init.headers.Accept, 'application/vnd.github.diff');
});

test('getCompareDiff returns null when the old commit is gone, and throws on other errors', async () => {
  mockFetch(json({ message: 'Not Found' }, 404));
  assert.equal(await getCompareDiff(pr, 'tok', 'old', 'new'), null);

  mockFetch(json({ message: 'Forbidden' }, 403));
  await assert.rejects(getCompareDiff(pr, 'tok', 'old', 'new'), /HTTP 403/);
});

test('getFileContent fetches the raw file at a commit, encoding the path', async () => {
  const fetch = mockFetch(new Response('const a = 1;\n'));
  assert.equal(await getFileContent(pr, 'tok', 'src/my file#1.js', 'abc123'), 'const a = 1;\n');

  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/o/r/contents/src/my%20file%231.js?ref=abc123');
  assert.equal(init.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(init.headers.Authorization, 'Bearer tok');
});

test('getFileContent returns null for a missing file, retries a server error, and throws on others', async () => {
  mockFetch(json({ message: 'Not Found' }, 404));
  assert.equal(await getFileContent(pr, 'tok', 'gone.js', 'abc'), null);

  const fetch = mockFetch(new Response('', { status: 502, headers: { 'Retry-After': '0' } }), new Response('ok'));
  assert.equal(await getFileContent(pr, 'tok', 'a.js', 'abc'), 'ok');
  assert.equal(fetch.mock.callCount(), 2);

  mockFetch(json({ message: 'Forbidden' }, 403));
  await assert.rejects(getFileContent(pr, 'tok', 'a.js', 'abc'), (err) => err.status === 403);
});

test('postReview posts a comment review on the right side of the diff', async () => {
  const fetch = mockFetch(json({ html_url: 'https://github.com/o/r/pull/12#review' }));
  const posted = await postReview(pr, 'tok', {
    commitId: 'abc',
    body: 'Summary',
    comments: [{ path: 'a.js', line: 3, body: 'Bug' }],
  });
  assert.equal(posted.html_url, 'https://github.com/o/r/pull/12#review');

  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.github.com/repos/o/r/pulls/12/reviews');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), {
    commit_id: 'abc',
    event: 'COMMENT',
    body: 'Summary',
    comments: [{ path: 'a.js', line: 3, body: 'Bug', side: 'RIGHT' }],
  });
});

test('errors explain common HTTP statuses', async () => {
  mockFetch(json({ message: 'Bad credentials' }, 401));
  await assert.rejects(getPullRequest(pr, 'tok'), /HTTP 401 \(GITHUB_TOKEN is invalid or expired\.\): Bad credentials/);

  mockFetch(json({ message: 'Forbidden' }, 403));
  await assert.rejects(getPullRequest(pr, 'tok'), /HTTP 403 \(No permission\./);

  mockFetch(json({ message: 'Not Found' }, 404));
  await assert.rejects(getPullRequest(pr, undefined), /o\/r#12 not found\. If the repo is private, set GITHUB_TOKEN\./);
});

test('errors include the validation messages GitHub sends', async () => {
  mockFetch(json({ message: 'Unprocessable Entity', errors: ['Line could not be resolved'] }, 422));
  await assert.rejects(
    postReview(pr, 'tok', { commitId: 'abc', body: '', comments: [] }),
    /HTTP 422: Unprocessable Entity: Line could not be resolved/,
  );
});

test('reads are retried after a rate limit', async () => {
  const fetch = mockFetch(new Response('', { status: 429, headers: { 'Retry-After': '0' } }), json({ head: { sha: 'abc' } }));
  assert.deepEqual(await getPullRequest(pr, 'tok'), { head: { sha: 'abc' } });
  assert.equal(fetch.mock.callCount(), 2);
});

test('posting is not retried after a server error, so a review is never posted twice', async () => {
  const fetch = mockFetch(json({ message: 'Server Error' }, 502));
  await assert.rejects(postReview(pr, 'tok', { commitId: 'abc', body: '', comments: [] }), /HTTP 502/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('network errors are reported as GitHub request failures', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  });
  await assert.rejects(
    postReview(pr, 'tok', { commitId: 'abc', body: '', comments: [] }),
    /Request to GitHub failed: getaddrinfo ENOTFOUND/,
  );
});
