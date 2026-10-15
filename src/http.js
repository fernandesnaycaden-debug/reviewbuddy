// fetch with a timeout and retries for flaky networks, rate limits and server errors.

const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * fetch(url, init), retried on network errors and 429/5xx responses with exponential backoff.
 * Returns the last response, even if it isn't ok, so the caller can report the error.
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
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
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

    if (!canRetry || !retryStatuses.includes(response.status)) return response;
    await response.body?.cancel();
    const delay = retryAfterMs(response) ?? delayFor(attempt, baseDelayMs);
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
  console.warn(`${reason}, retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${retries})...`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
