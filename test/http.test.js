import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { fetchWithRetry, resetPauses } from '../src/http.js';
import { buffered } from '../src/log.js';

const fast = { baseDelayMs: 1 };

/** Mock fetch to return (or throw) each of the given values in turn. */
function mockFetch(...outcomes) {
  return mock.method(globalThis, 'fetch', async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

function networkError(code) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

beforeEach(() => mock.method(console, 'warn', () => {}));
afterEach(() => {
  mock.restoreAll();
  resetPauses();
});

test('retries network errors, then returns the response', async () => {
  const fetch = mockFetch(networkError('ECONNRESET'), new Response('ok'));
  const response = await fetchWithRetry('https://x.test', {}, fast);
  assert.equal(await response.text(), 'ok');
  assert.equal(fetch.mock.callCount(), 2);
});

test('retries 5xx and 429 responses', async () => {
  const fetch = mockFetch(new Response('', { status: 503 }), new Response('', { status: 429 }), new Response('ok'));
  const response = await fetchWithRetry('https://x.test', {}, fast);
  assert.equal(response.status, 200);
  assert.equal(fetch.mock.callCount(), 3);
});

test('waits as long as Retry-After says', async () => {
  mockFetch(new Response('', { status: 429, headers: { 'Retry-After': '0.05' } }), new Response('ok'));
  const start = performance.now();
  await fetchWithRetry('https://x.test', {}, { baseDelayMs: 0 });
  assert.ok(performance.now() - start >= 45);
});

test('gives up after the last retry and returns the failed response', async () => {
  const fetch = mockFetch(...Array.from({ length: 3 }, () => new Response('', { status: 500 })));
  const response = await fetchWithRetry('https://x.test', {}, { ...fast, retries: 2 });
  assert.equal(response.status, 500);
  assert.equal(fetch.mock.callCount(), 3);
});

test('throws the network error after the last retry', async () => {
  const fetch = mockFetch(networkError('ECONNRESET'), networkError('ECONNRESET'));
  await assert.rejects(fetchWithRetry('https://x.test', {}, { ...fast, retries: 1 }), /fetch failed/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('does not retry client errors', async () => {
  const fetch = mockFetch(new Response('', { status: 404 }));
  assert.equal((await fetchWithRetry('https://x.test', {}, fast)).status, 404);
  assert.equal(fetch.mock.callCount(), 1);
});

test('does not retry refused connections', async () => {
  const fetch = mockFetch(networkError('ECONNREFUSED'));
  await assert.rejects(fetchWithRetry('https://x.test', {}, fast), (err) => err.cause.code === 'ECONNREFUSED');
  assert.equal(fetch.mock.callCount(), 1);
});

test('does not retry network errors when retryNetworkErrors is false', async () => {
  const fetch = mockFetch(networkError('ECONNRESET'));
  await assert.rejects(fetchWithRetry('https://x.test', {}, { ...fast, retryNetworkErrors: false }));
  assert.equal(fetch.mock.callCount(), 1);
});

test('times out without retrying', async () => {
  const fetch = mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  await assert.rejects(
    fetchWithRetry('https://x.test', {}, { ...fast, label: 'Slow', timeoutMs: 20 }),
    { name: 'TimeoutError', message: 'Slow did not finish within 0.02s' },
  );
  assert.equal(fetch.mock.callCount(), 1);
});

/** Mock fetch: the first request to a 'limited' URL gets a 429 with Retry-After; every call's time is recorded. */
function rateLimitedFetch(retryAfter) {
  const calls = [];
  let limited = false;
  mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url, at: performance.now() });
    if (url.includes('limited') && !limited) {
      limited = true;
      return new Response('', { status: 429, headers: { 'Retry-After': retryAfter } });
    }
    return new Response('ok');
  });
  return calls;
}

test('a 429 pauses every request to the same host, not just the one that got it', async () => {
  const calls = rateLimitedFetch('0.1');
  const start = performance.now();
  await Promise.all([
    fetchWithRetry('https://api.test/limited', {}, fast),
    (async () => {
      // Starts while the first is paused.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fetchWithRetry('https://api.test/second', {}, fast);
    })(),
  ]);
  const second = calls.find((c) => c.url === 'https://api.test/second').at - start;
  assert.ok(second >= 90, `second request went out after ${second}ms`);
  assert.equal(calls.length, 3);
});

test('a pause on one host does not hold up another', async () => {
  const calls = rateLimitedFetch('0.2');
  const start = performance.now();
  const limited = fetchWithRetry('https://api.test/limited', {}, fast);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fetchWithRetry('https://other.test/x', {}, fast);
  const elsewhere = calls.find((c) => c.url === 'https://other.test/x').at - start;
  assert.ok(elsewhere < 150, `other host waited ${elsewhere}ms`);
  await limited;
});

test('a pause is announced right away, once, not held back with a file\'s output', async () => {
  rateLimitedFetch('0');
  const { lines } = await buffered(() => fetchWithRetry('https://api.test/limited', {}, { ...fast, label: 'Groq' }));
  const warned = console.warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.deepEqual(warned, ['Groq rate limited (HTTP 429), pausing requests to it for 0.0s (1/3)...']);
  assert.deepEqual(lines, []);
});

test('other retries are held back with the file\'s output', async () => {
  mockFetch(new Response('', { status: 503 }), new Response('ok'));
  const { lines } = await buffered(() => fetchWithRetry('https://x.test', {}, { ...fast, label: 'Groq' }));
  assert.equal(console.warn.mock.callCount(), 0);
  assert.match(lines[0][1][0], /^Groq returned HTTP 503, retrying in/);
});
