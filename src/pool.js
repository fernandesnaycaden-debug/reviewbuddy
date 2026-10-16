// A small worker pool: run an async function over a list with at most N calls in flight.

/**
 * Call fn(item, index) for every item, at most limit at a time. Returns [{ value } | { error }]
 * in the items' order, whatever order they finish in, so one failure doesn't lose the others.
 * An error with fatal: true (a bad API key, say, that would fail every item) stops new items
 * from starting; once the ones in flight settle, it is thrown.
 */
export async function mapPool(items, limit, fn) {
  const outcomes = new Array(items.length);
  let next = 0;
  let fatal = null;

  async function worker() {
    while (!fatal && next < items.length) {
      const index = next++;
      try {
        outcomes[index] = { value: await fn(items[index], index) };
      } catch (error) {
        if (error?.fatal) fatal ??= error;
        outcomes[index] = { error };
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal) throw fatal;
  return outcomes;
}
