import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPool } from '../src/pool.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mapPool never runs more than limit at once, and uses all of it', async () => {
  let running = 0;
  let most = 0;
  await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    most = Math.max(most, ++running);
    await sleep(5);
    running--;
  });
  assert.equal(most, 3);
});

test('mapPool returns results in the items\' order, whatever order they finish in', async () => {
  const finished = [];
  const outcomes = await mapPool([30, 1, 15, 5], 4, async (ms, i) => {
    await sleep(ms);
    finished.push(i);
    return ms * 2;
  });
  assert.deepEqual(outcomes, [{ value: 60 }, { value: 2 }, { value: 30 }, { value: 10 }]);
  assert.notDeepEqual(finished, [0, 1, 2, 3]);
});

test('mapPool keeps going after an error and reports it in its place', async () => {
  const outcomes = await mapPool(['a', 'bad', 'c'], 2, async (item) => {
    if (item === 'bad') throw new Error('boom');
    return item.toUpperCase();
  });
  assert.deepEqual(outcomes.map((o) => o.value ?? o.error.message), ['A', 'boom', 'C']);
});

test('mapPool stops starting items after a fatal error, lets running ones finish, then throws it', async () => {
  const started = [];
  const settled = [];
  await assert.rejects(
    mapPool([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      if (i === 1) throw Object.assign(new Error('bad key'), { fatal: true });
      await sleep(10);
      settled.push(i);
    }),
    /bad key/,
  );
  // 0 and 1 start together; 1 fails at once, so only 0 (already running) finishes and nothing else starts.
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(settled, [0]);
});

test('mapPool handles an empty list and a limit above the item count', async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
  assert.deepEqual(await mapPool([1], 8, async (x) => x), [{ value: 1 }]);
});
