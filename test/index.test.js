import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { markerFor } from '../src/dedupe.js';
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
    '',
    '<!-- reviewbuddy:sha=abc -->',
  ].join('\n'));
});

test('buildReview says when nothing was found', () => {
  const review = buildReview([{ filename: 'src/a.js', diff, comments: [] }], { commitId: 'abc', model: 'm' });
  assert.deepEqual(review.comments, []);
  assert.equal(review.body, 'reviewbuddy found no issues in 1 file (model `m`).\n\n<!-- reviewbuddy:sha=abc -->');
});

test('buildReview says which commit an incremental review starts from', () => {
  const review = buildReview(results, { commitId: 'abc', since: 'aaa1111', model: 'm' });
  assert.match(review.body, /^reviewbuddy found 2 issues in 2 files since `aaa1111` \(model `m`\)\./);
});

test('buildReview and formatReport name the provider when given one', () => {
  const review = buildReview([{ filename: 'src/a.js', diff, comments: [] }], { commitId: 'abc', model: 'm', provider: 'groq' });
  assert.match(review.body, /^reviewbuddy found no issues in 1 file \(model `m` via groq\)\./);
  const report = formatReport(results, { model: 'm', provider: 'groq', seconds: '1.5', date: new Date(0) });
  assert.match(report, /\| Provider \| groq \|\n\| Model \| `m` \|/);
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
  // Keep a provider set in the developer's shell from leaking in.
  vars = { REVIEWBUDDY_PROVIDER: '', ...vars };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const PR_URL = 'https://github.com/o/r/pull/1';
const HEAD = 'abc1234def0';
const OLD = 'aaa1111bbb0';
const hardcodedKey = { line: 2, severity: 'security', message: 'Hardcoded key' };

/** Commits since OLD: they change line 2 of src/a.js, and a base-branch merge brings in src/base.js. */
const compareDiff = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -2,2 +2,2 @@',
  "-const key = 'x';",
  "+const key = 'secret';",
  ' export { a };',
  'diff --git a/src/base.js b/src/base.js',
  '--- a/src/base.js',
  '+++ b/src/base.js',
  '@@ -1 +1 @@',
  '+export const fromMain = true;',
  '',
].join('\n');

/**
 * Mock GitHub (PR 1 at HEAD, with the given reviews and review comments) and Ollama (replying with findings).
 * compare: the diff since the old commit, or null to answer 404.
 * Returns the posted review bodies, the requested URLs and the diffs sent to the model.
 */
function fakeGitHub({ reviews = [], comments = [], compare = compareDiff, findings = [hardcodedKey] } = {}) {
  const calls = { posted: [], urls: [], reviewed: [] };
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.urls.push(url);
    if (url === 'http://ollama.test/api/chat') {
      calls.reviewed.push(JSON.parse(init.body).messages.at(-1).content);
      return ollamaReply(findings);
    }
    const path = url.replace('https://api.github.com/repos/o/r/', '');
    if (init.method === 'POST') {
      calls.posted.push(JSON.parse(init.body));
      return Response.json({ html_url: 'https://github.com/o/r/pull/1#review' });
    }
    if (path.startsWith('compare/')) {
      return compare === null ? Response.json({ message: 'Not Found' }, { status: 404 }) : new Response(compare);
    }
    if (path.startsWith('pulls/1/reviews')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(reviews.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith('pulls/1/comments')) return Response.json(comments);
    if (init.headers.Accept === 'application/vnd.github.diff') return new Response(diff);
    return Response.json({ head: { sha: HEAD } });
  });
  return calls;
}

/** Everything main printed with console.log, as one string. */
function logged() {
  return console.log.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
}

const github = (fn) => withEnv({ GITHUB_TOKEN: 'tok', OLLAMA_URL: 'http://ollama.test' }, fn);

test('main reviews a pull request and posts the review', () => github(async () => {
  const calls = fakeGitHub();

  await main([PR_URL, '--timeout', '5']);

  // The PR, its reviews, its diff, the model, the post. No earlier reviews, so no compare or comments.
  assert.equal(calls.urls.length, 5);
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0].commit_id, HEAD);
  assert.deepEqual(calls.posted[0].comments, [{ path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key', side: 'RIGHT' }]);
  assert.ok(calls.posted[0].body.endsWith(markerFor(HEAD)));
}));

test('main stops when the head commit was already reviewed', () => github(async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(HEAD) }] });

  await main([PR_URL]);

  assert.equal(calls.posted.length, 0);
  assert.equal(calls.reviewed.length, 0);
  assert.equal(calls.urls.length, 2);
  assert.match(logged(), /Already reviewed abc1234, nothing new/);
}));

test('main finds the latest marked review on a later page', () => github(async () => {
  const reviews = [
    { id: 0, body: markerFor(OLD) },
    ...Array.from({ length: 99 }, (_, i) => ({ id: i + 1, body: 'LGTM' })),
    { id: 100, body: `Found 1 issue\n\n${markerFor(HEAD)}` },
    { id: 101, body: 'A later review by a person' },
  ];
  const calls = fakeGitHub({ reviews });

  await main([PR_URL]);

  assert.equal(calls.urls.filter((u) => u.includes('/reviews?')).length, 2);
  assert.equal(calls.posted.length, 0);
  assert.match(logged(), /Already reviewed abc1234, nothing new/);
}));

test('main reviews only the commits since the last review', () => github(async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(OLD) }] });

  await main([PR_URL]);

  assert.ok(calls.urls.includes(`https://api.github.com/repos/o/r/compare/${OLD}...${HEAD}`));
  // Only src/a.js: src/base.js came from the base branch and isn't part of the PR.
  assert.equal(calls.reviewed.length, 1);
  assert.match(calls.reviewed[0], /const key = 'x'/);
  assert.match(logged(), /Reviewing changes since aaa1111/);
  assert.equal(calls.posted.length, 1);
  assert.match(calls.posted[0].body, /^reviewbuddy found 1 issue in 1 file since `aaa1111`/);
  assert.deepEqual(calls.posted[0].comments.map((c) => c.line), [2]);
}));

test('main falls back to a full review when the old commit is gone, and --dry-run shows it', () => withEnv({ GITHUB_TOKEN: '', OLLAMA_URL: 'http://ollama.test' }, async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(OLD) }], compare: null });

  await main([PR_URL, '--dry-run']);

  assert.equal(calls.posted.length, 0);
  assert.equal(calls.reviewed.length, 1);
  assert.doesNotMatch(calls.reviewed[0], /const key = 'x'/);
  const out = logged();
  assert.match(out, /Previous review's commit aaa1111 no longer exists \(force-push or rebase\?\), reviewing the whole PR\./);
  assert.match(out, /Skipped 0 findings already posted/);
  assert.match(out, /Dry run, not posting/);
  assert.match(out, /reviewbuddy:sha=abc1234def0/);
}));

test('main skips findings an earlier review already posted', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [{ id: 1, body: markerFor(OLD) }],
    comments: [
      { pull_request_review_id: 1, path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key' },
    ],
    findings: [hardcodedKey, { line: 2, severity: 'bug', message: 'Unused key' }],
  });

  await main([PR_URL]);

  assert.match(logged(), /Skipped 1 finding already posted/);
  assert.deepEqual(calls.posted[0].comments.map((c) => c.body), ['**[BUG]** Unused key']);
}));

test('main posts nothing when every finding was already posted', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [{ id: 1, body: markerFor(OLD) }],
    comments: [{ pull_request_review_id: 1, path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key' }],
  });

  await main([PR_URL]);

  assert.equal(calls.posted.length, 0);
  assert.match(logged(), /No new findings to post\./);
}));

test('main --full reviews the whole PR even when the head was already reviewed', () => github(async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(HEAD) }] });

  await main([PR_URL, '--full']);

  assert.equal(calls.urls.some((u) => u.includes('/compare/')), false);
  assert.equal(calls.posted.length, 1);
  assert.doesNotMatch(calls.posted[0].body, /since/);
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
