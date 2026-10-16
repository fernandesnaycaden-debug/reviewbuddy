// fetch with a timeout and retries for flaky networks, rate limits and server errors.

import { warn } from './log.js';

const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_RETRY_AFTER_MS = 60_000;

// When a host rate-limits one request, every request to it waits: the time it may be retried, by origin.
const pausedUntil = new Map();

/**
 * fetch(url, init), retried on network errors and 429/5xx responses with exponential backoff.
 * Returns the last response, even if it isn't ok, so the caller can report the error.
 * A rate limit (429, or GitHub's 403 with Retry-After) pauses every request to that host, not just this one,
 * for as long as Retry-After asks, so parallel reviews don't keep hammering an API that said stop.
 *
 * timeoutMs: limit for each attempt (0 = none). Timeouts are not retried.
 * retryStatuses: HTTP statuses worth retrying.
 * retryNetworkErrors: false for requests that may have gone through before the connection dropped.
 */
export async function fetchWithRetry(url, init = {}, {
  label = 'Request',
  timeoutMs = 0,
  retries = 3,
  baseDelayMs = 1000,
  retryStatuses = RETRY_STATUSES,
  retryNetworkErrors = true,
} = {}) {
  const { origin } = new URL(url);
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
    await waitForPause(origin);
    let response;
    try {
      response = await fetch(url, { ...init, ...(timeoutMs > 0 && { signal: AbortSignal.timeout(timeoutMs) }) });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new TimeoutError(label, timeoutMs);
      // Connection refused means nothing is listening; waiting won't change that.
      const refused = err.cause?.code === 'ECONNREFUSED';
      if (!canRetry || !retryNetworkErrors || refused) throw err;
      await backoff(`${label} failed (${err.cause?.message || err.message})`, attempt, retries, delayFor(attempt, baseDelayMs));
      continue;
    }

    const limited = isRateLimit(response);
    const retryable = retryStatuses.includes(response.status) || (limited && retryStatuses.includes(429));
    if (!canRetry || !retryable) return response;
    await response.body?.cancel();
    const delay = retryAfterMs(response) ?? delayFor(attempt, baseDelayMs);
    if (limited) {
      pause(origin, `${label} rate limited (HTTP ${response.status})`, attempt, retries, delay);
      continue;
    }
    await backoff(`${label} returned HTTP ${response.status}`, attempt, retries, delay);
  }
}

export class TimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} did not finish within ${timeoutMs / 1000}s`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Forget every pause, so one test's rate limit can't slow the next. */
export function resetPauses() {
  pausedUntil.clear();
}

/** A 429, or a 403 that GitHub sends for its secondary rate limits (with Retry-After or no requests left). */
function isRateLimit(response) {
  if (response.status === 429) return true;
  return response.status === 403
    && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
}

function delayFor(attempt, baseDelayMs) {
  const delay = baseDelayMs * 2 ** attempt;
  return delay + Math.random() * delay * 0.25;
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null if absent. */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (header == null) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

async function backoff(reason, attempt, retries, delay) {
  warn(`${reason}, retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${retries})...`);
  await sleep(delay);
}

/**
 * Hold every request to origin for delay ms (unless an earlier pause already lasts longer).
 * Printed right away, not with the file's other lines, since it holds up every file.
 */
function pause(origin, reason, attempt, retries, delay) {
  const until = Date.now() + delay;
  if (until <= (pausedUntil.get(origin) ?? 0)) return;
  pausedUntil.set(origin, until);
  console.warn(`${reason}, pausing requests to it for ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${retries})...`);
}

/** Wait until origin's pause, if any, is over. A pause may grow while waiting. */
async function waitForPause(origin) {
  for (let ms = (pausedUntil.get(origin) ?? 0) - Date.now(); ms > 0; ms = (pausedUntil.get(origin) ?? 0) - Date.now()) {
    await sleep(ms);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
