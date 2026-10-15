import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { getPullRequest, getPullRequestDiff, postReview } from '../src/github.js';

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
