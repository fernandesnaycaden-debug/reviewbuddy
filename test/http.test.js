import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { fetchWithRetry } from '../src/http.js';

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
afterEach(() => mock.restoreAll());

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
