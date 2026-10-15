import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { buildReview, formatReport, main, writeReport } from '../src/index.js';

const diff = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  "+const key = 'secret';",
  ' export { a };',
  '',
].join('\n');

const results = [
  {
    filename: 'src/a.js',
    diff,
    comments: [
      { line: 2, severity: 'security', message: 'Hardcoded key' },
      { line: 40, severity: 'bug', message: 'Off-by-one' },
    ],
  },
  { filename: 'src/b.js', diff, comments: [] },
];

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-'));
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(async () => {
  mock.restoreAll();
  await rm(dir, { recursive: true, force: true });
});

test('buildReview posts findings inside the diff inline and lists the rest in the body', () => {
  const review = buildReview(results, { commitId: 'abc', model: 'm' });
  assert.equal(review.commitId, 'abc');
  assert.deepEqual(review.comments, [{ path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key' }]);
  assert.equal(review.body, [
    'reviewbuddy found 2 issues in 2 files (model `m`).',
    '',
    'These point at lines outside the diff, so they could not be posted inline:',
    '- `src/a.js:40` **[BUG]** Off-by-one',
  ].join('\n'));
});

test('buildReview says when nothing was found', () => {
  const review = buildReview([{ filename: 'src/a.js', diff, comments: [] }], { commitId: 'abc', model: 'm' });
  assert.deepEqual(review.comments, []);
  assert.equal(review.body, 'reviewbuddy found no issues in 1 file (model `m`).');
});

test('formatReport renders a summary and a table per file', () => {
  const report = formatReport(results, { model: 'm', seconds: '1.5', date: new Date(0) });
  assert.match(report, /^# 🔍 ReviewBuddy Report\n/);
  assert.match(report, /> \*\*2 issues\*\* found across \*\*2 files\*\* in 1\.5s/);
  assert.match(report, /\| Model \| `m` \|/);
  assert.match(report, /## `src\/a\.js`\n\n\| Line \| Severity \| Issue \|/);
  assert.match(report, /\| 2 \| 🔴 \*\*SECURITY\*\* \| Hardcoded key \|/);
  assert.match(report, /\| 40 \| 🟠 \*\*BUG\*\* \| Off-by-one \|/);
  assert.match(report, /## `src\/b\.js`\n\n_No issues found\._/);
});

test('writeReport writes the report and returns its path', async () => {
  const path = await writeReport(results, { seconds: '1.5', outputPath: join(dir, 'report.md'), model: 'm' });
  assert.equal(path, join(dir, 'report.md'));
  assert.match(await readFile(path, 'utf8'), /Hardcoded key/);
});

/** An Ollama streaming reply, split mid-line the way network chunks can arrive. */
function ollamaReply(comments) {
  const text = JSON.stringify({ comments });
  const ndjson = [
    JSON.stringify({ message: { content: text.slice(0, 10) }, done: false }),
    JSON.stringify({ message: { content: text.slice(10) }, done: false }),
    JSON.stringify({ message: { content: '' }, done: true }),
  ].join('\n') + '\n';
  const bytes = new TextEncoder().encode(ndjson);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 25));
      controller.enqueue(bytes.slice(25));
      controller.close();
    },
  }));
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('main reviews a pull request and posts the review', () => withEnv({ GITHUB_TOKEN: 'tok', OLLAMA_URL: 'http://ollama.test' }, async () => {
  const posted = [];
  const fetch = mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'http://ollama.test/api/chat') {
      assert.equal(JSON.parse(init.body).stream, true);
      return ollamaReply([{ line: 2, severity: 'security', message: 'Hardcoded key' }]);
    }
    if (init.method === 'POST') {
      posted.push(JSON.parse(init.body));
      return Response.json({ html_url: 'https://github.com/o/r/pull/1#review' });
    }
    if (init.headers.Accept === 'application/vnd.github.diff') return new Response(diff);
    return Response.json({ head: { sha: 'abc' } });
  });

  await main(['https://github.com/o/r/pull/1', '--timeout', '5']);

  assert.equal(fetch.mock.callCount(), 4);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].commit_id, 'abc');
  assert.deepEqual(posted[0].comments, [{ path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key', side: 'RIGHT' }]);
}));

test('main reviews a diff file and writes the report', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  mock.method(globalThis, 'fetch', async () => ollamaReply([{ line: 2, severity: 'bug', message: 'Unused key' }]));
  const diffPath = join(dir, 'changes.diff');
  const reportPath = join(dir, 'report.md');
  await writeFile(diffPath, diff);

  await main([diffPath, '-o', reportPath]);

  assert.match(await readFile(reportPath, 'utf8'), /\| 2 \| 🟠 \*\*BUG\*\* \| Unused key \|/);
}));

test('main refuses to post without a token', () => withEnv({ GITHUB_TOKEN: '' }, async () => {
  await assert.rejects(main(['https://github.com/o/r/pull/1']), /Set GITHUB_TOKEN/);
}));
