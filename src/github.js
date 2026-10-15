// GitHub REST API client: fetches a pull request's diff, changed files and earlier reviews, and posts a review on it.

import { fetchWithRetry } from './http.js';

const API_URL = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

/**
 * Parse "https://github.com/owner/repo/pull/12" into { owner, repo, number }.
 * Returns null if the string isn't a pull request URL.
 */
export function parsePrUrl(url) {
  const match = url.match(/^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Fetch the pull request's details (we need head.sha). */
export async function getPullRequest(pr, token) {
  const response = await request(pr, token, `pulls/${pr.number}`);
  return response.json();
}

/** Fetch the pull request as one unified diff covering all changed files. */
export async function getPullRequestDiff(pr, token) {
  const response = await request(pr, token, `pulls/${pr.number}`, {
    headers: { Accept: 'application/vnd.github.diff' },
  });
  return response.text();
}

/**
 * Fetch the diff from commit base to head (base...head) on its own.
 * Returns null if GitHub doesn't know base any more, e.g. after a force-push or rebase.
 */
export async function getCompareDiff(pr, token, base, head) {
  try {
    const response = await request(pr, token, `compare/${base}...${head}`, {
      headers: { Accept: 'application/vnd.github.diff' },
    });
    return await response.text();
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Fetch a file's content at commit ref, as text. Returns null if the file isn't there.
 * Needs "Contents: Read" on fine-grained tokens.
 */
export async function getFileContent(pr, token, path, ref) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    const response = await request(pr, token, `contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    return await response.text();
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** List every review on the pull request, oldest first. */
export function listReviews(pr, token) {
  return listAll(pr, token, `pulls/${pr.number}/reviews`);
}

/** List every inline review comment on the pull request. */
export function listReviewComments(pr, token) {
  return listAll(pr, token, `pulls/${pr.number}/comments`);
}

/**
 * Post a review with inline comments. It is always a plain comment review:
 * reviewbuddy never approves or requests changes.
 * comments: [{ path, line, body }], where line is a line number in the new file.
 */
export async function postReview(pr, token, { commitId, body, comments }) {
  const response = await request(pr, token, `pulls/${pr.number}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit_id: commitId,
      event: 'COMMENT',
      body,
      comments: comments.map((c) => ({ ...c, side: 'RIGHT' })),
    }),
  }, {
    // A dropped connection or a 5xx may come after GitHub created the review,
    // and retrying would post it twice. A 429 means it was never processed.
    retryNetworkErrors: false,
    retryStatuses: [429],
  });
  return response.json();
}

const PER_PAGE = 100;

/** GET a list endpoint page by page until a page comes back short. */
async function listAll(pr, token, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const response = await request(pr, token, `${path}?per_page=${PER_PAGE}&page=${page}`);
    const batch = await response.json();
    items.push(...batch);
    if (batch.length < PER_PAGE) return items;
  }
}

async function request(pr, token, path, options = {}, retry = {}) {
  const url = `${API_URL}/repos/${pr.owner}/${pr.repo}/${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'reviewbuddy',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  let response;
  try {
    response = await fetchWithRetry(url, { ...options, headers }, { label: 'GitHub', timeoutMs: TIMEOUT_MS, ...retry });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`GitHub did not respond within ${TIMEOUT_MS / 1000}s.`);
    throw new Error(`Request to GitHub failed: ${err.cause?.message || err.message}`);
  }
  if (response.ok) return response;

  const details = await response.text();
  let message = details;
  try {
    const parsed = JSON.parse(details);
    message = [parsed.message, ...(parsed.errors ?? []).map((e) => e.message ?? e)].join(': ');
  } catch {}

  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  const hints = {
    401: 'GITHUB_TOKEN is invalid or expired.',
    403: `No permission. The token needs "Pull requests: Read and write" on ${pr.owner}/${pr.repo}.`,
    404: token
      ? `${name} not found, or the token has no access to ${pr.owner}/${pr.repo}.`
      : `${name} not found. If the repo is private, set GITHUB_TOKEN.`,
    406: 'The diff is too large for the GitHub API.',
  };
  const hint = hints[response.status] ? ` (${hints[response.status]})` : '';
  throw Object.assign(new Error(`GitHub returned HTTP ${response.status}${hint}: ${message}`), { status: response.status });
}
