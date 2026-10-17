import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { markerFor } from '../src/dedupe.js';
import {
  buildReview, formatReport, main, parseFailOn, parseMinSeverity, readStdin, reviewEvent, selectInput, writeReport,
} from '../src/index.js';
import { SYSTEM_PROMPT } from '../src/review.js';

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
let exitCode;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-'));
  exitCode = process.exitCode;
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(async () => {
  mock.restoreAll();
  // --fail-on sets it; left at 1, it would fail this test file.
  process.exitCode = exitCode;
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

const withFix = [{
  filename: 'src/a.js',
  diff,
  comments: [
    { line: 2, severity: 'security', message: 'Hardcoded key', suggestion: 'const key = process.env.KEY;' },
    { line: 40, severity: 'bug', message: 'Off-by-one', suggestion: 'for (let i = 0; i < n; i++) {' },
  ],
}];

test('buildReview appends a suggestion block to inline comments only', () => {
  const review = buildReview(withFix, { commitId: 'abc', model: 'm' });
  assert.deepEqual(review.comments, [{
    path: 'src/a.js',
    line: 2,
    body: '**[SECURITY]** Hardcoded key\n\n```suggestion\nconst key = process.env.KEY;\n```',
  }]);
  // Line 40 is outside the diff, so its finding goes in the body, without a suggestion GitHub couldn't apply.
  assert.match(review.body, /^- `src\/a\.js:40` \*\*\[BUG\]\*\* Off-by-one$/m);
  assert.doesNotMatch(review.body, /suggestion/);
});

test('buildReview lengthens the suggestion fence when the code has backticks', () => {
  const results = [{ filename: 'src/a.js', diff, comments: [{ line: 2, severity: 'bug', message: 'Quote', suggestion: 'const s = ```x```;' }] }];
  const [comment] = buildReview(results, { commitId: 'abc', model: 'm' }).comments;
  assert.equal(comment.body, '**[BUG]** Quote\n\n````suggestion\nconst s = ```x```;\n````');
});

test('formatReport shows a suggestion as a Fix line', () => {
  const report = formatReport([{ ...withFix[0], comments: [{ line: 2, severity: 'bug', message: 'Bad', suggestion: '  x = a || b;' }] }], { model: 'm', seconds: '1', date: new Date(0) });
  assert.match(report, /\| 2 \| 🟠 \*\*BUG\*\* \| Bad<br>\*\*Fix:\*\* `x = a \\\|\\\| b;` \|/);
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
  // Keep a provider set in the developer's shell, or the Actions run the tests are in, from leaking in.
  vars = {
    REVIEWBUDDY_PROVIDER: '',
    REVIEWBUDDY_FAIL_ON: '',
    REVIEWBUDDY_REQUEST_CHANGES_ON: '',
    REVIEWBUDDY_MIN_SEVERITY: '',
    REVIEWBUDDY_IGNORE: '',
    REVIEWBUDDY_TIMEOUT: '',
    REVIEWBUDDY_FORMAT: '',
    REVIEWBUDDY_CONCURRENCY: '',
    REVIEWBUDDY_MAX_FILES: '',
    REVIEWBUDDY_MAX_CHUNKS_PER_FILE: '',
    OLLAMA_MODEL: '',
    GITHUB_ACTIONS: '',
    GITHUB_STEP_SUMMARY: '',
    GITHUB_EVENT_PATH: '',
    ...vars,
  };
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
const BASE = 'bbb2222ccc0';
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

/** src/a.js at HEAD, matching both diffs. */
const SOURCE = "const a = 1;\nconst key = 'secret';\nexport { a };\n";

/**
 * Mock GitHub (PR 1 at HEAD, with the given reviews and review comments) and Ollama (replying with findings).
 * compare: the diff since the old commit, or null to answer 404. postStatus: answer the post with this error status.
 * source: src/a.js at HEAD, or null to answer 404.
 * config: { [name]: text } for .reviewbuddy.json / .reviewbuddy.md. They exist at BASE only; headConfig is what the PR's head has.
 * Large PRs: diffStatus answers the PR's diff with that error status (406: too large), prFiles is what the files API
 * lists, changedFiles the PR's changed_files count. compareStatus and compareFiles do the same for the compare API.
 * findings may be a function of the reviewed file's name. ollamaStatus(filename) answers that file's model request
 * with an error status instead; delay(filename) holds its reply back that many ms.
 * rejectRequestChanges answers a change request with GitHub's 422 for the author's own PR. dismissStatus answers
 * dismissals with that error status.
 * Returns the posted review bodies, every attempted review's event, the dismissals ({ url, body }), the requested URLs,
 * and the user and system prompts sent to the model.
 */
function fakeGitHub({
  reviews = [], comments = [], compare = compareDiff, findings = [hardcodedKey], postStatus, source = SOURCE,
  config = {}, headConfig = {}, diffStatus, prFiles = [], changedFiles, compareStatus, compareFiles = [],
  ollamaStatus = () => undefined, delay = () => 0, rejectRequestChanges = false, dismissStatus,
} = {}) {
  const calls = {
    posted: [], events: [], dismissed: [], urls: [], reviewed: [], systems: [],
  };
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.urls.push(url);
    if (url === 'http://ollama.test/api/chat') {
      const { messages } = JSON.parse(init.body);
      const filename = messages.at(-1).content.match(/^File: (.+)$/m)[1];
      calls.reviewed.push(messages.at(-1).content);
      calls.systems.push(messages[0].content);
      await new Promise((resolve) => setTimeout(resolve, delay(filename)));
      const status = ollamaStatus(filename);
      if (status) return new Response(`model error for ${filename}`, { status });
      return ollamaReply(typeof findings === 'function' ? findings(filename) : findings);
    }
    const path = url.replace('https://api.github.com/repos/o/r/', '');
    if (init.method === 'PUT') {
      if (dismissStatus) return Response.json({ message: 'Resource not accessible by integration' }, { status: dismissStatus });
      calls.dismissed.push({ url, body: JSON.parse(init.body) });
      return Response.json({ state: 'DISMISSED' });
    }
    if (init.method === 'POST') {
      const { event } = JSON.parse(init.body);
      calls.events.push(event);
      if (rejectRequestChanges && event === 'REQUEST_CHANGES') {
        return Response.json({ message: 'Unprocessable Entity', errors: ['Review Can not request changes on your own pull request'] }, { status: 422 });
      }
      if (postStatus) return Response.json({ message: 'Resource not accessible by integration' }, { status: postStatus });
      calls.posted.push(JSON.parse(init.body));
      return Response.json({ html_url: 'https://github.com/o/r/pull/1#review' });
    }
    if (path.startsWith('pulls/1/files')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(prFiles.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith('compare/') && init.headers.Accept !== 'application/vnd.github.diff') {
      return Response.json({ commits: [{}], files: compareFiles });
    }
    if (path.startsWith('compare/')) {
      if (compareStatus) return Response.json({ message: 'too large' }, { status: compareStatus });
      return compare === null ? Response.json({ message: 'Not Found' }, { status: 404 }) : new Response(compare);
    }
    if (path.startsWith('pulls/1/reviews')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(reviews.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith('pulls/1/comments')) return Response.json(comments);
    const configFile = path.match(/^contents\/(\.reviewbuddy\.(?:json|md))\?ref=(\w+)$/);
    if (configFile) {
      const [, name, ref] = configFile;
      const text = (ref === BASE ? config : ref === HEAD ? headConfig : {})[name];
      return text === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : new Response(text);
    }
    if (path.startsWith('contents/')) {
      return source === null ? Response.json({ message: 'Not Found' }, { status: 404 }) : new Response(source);
    }
    if (init.headers.Accept === 'application/vnd.github.diff') {
      if (diffStatus) return Response.json({ message: 'Sorry, the diff exceeded the maximum number of files (300).' }, { status: diffStatus });
      return new Response(diff);
    }
    return Response.json({ head: { sha: HEAD }, base: { sha: BASE, ref: 'main' }, changed_files: changedFiles ?? prFiles.length });
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

  // The PR, the two config files at BASE, its reviews, its diff, the file at HEAD, the model, the post.
  // No earlier reviews, so no compare or comments.
  assert.equal(calls.urls.length, 8);
  assert.ok(calls.urls.includes(`https://api.github.com/repos/o/r/contents/src/a.js?ref=${HEAD}`));
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
  // The PR, the two config files, its reviews.
  assert.equal(calls.urls.length, 4);
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

test('parseFailOn reads comma-separated severities in any case', () => {
  assert.deepEqual(parseFailOn('Security, bug,,security'), ['security', 'bug']);
  assert.deepEqual(parseFailOn(''), []);
  assert.deepEqual(parseFailOn(undefined), []);
  assert.throws(() => parseFailOn('security,critical'), /Unknown severity "critical" in --fail-on\. Use a comma-separated list of: bug, security, performance, suggestion\./);
});

test('main rejects an unknown --fail-on severity before reviewing', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => assert.fail('nothing should be fetched'));
  await assert.rejects(main(['changes.diff', '--fail-on', 'nope']), /Unknown severity "nope"/);
  assert.equal(fetch.mock.callCount(), 0);
}));

/** Review a diff file whose model reply is one bug on line 2, with the given extra arguments. */
async function reviewBugDiff(...args) {
  mock.method(globalThis, 'fetch', async () => ollamaReply([{ line: 2, severity: 'bug', message: 'Unused key' }]));
  const diffPath = join(dir, 'changes.diff');
  await writeFile(diffPath, diff);
  await main([diffPath, ...args]);
}

test('main --fail-on sets exit code 1 when a finding has a listed severity', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  await reviewBugDiff('--fail-on', 'security,bug');
  assert.equal(process.exitCode, 1);
  assert.match(logged(), /Failing: 1 finding match --fail-on security,bug\./);
}));

test('main --fail-on leaves the exit code alone when no finding matches', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  await reviewBugDiff('--fail-on', 'security');
  assert.notEqual(process.exitCode, 1);
  assert.doesNotMatch(logged(), /Failing/);
}));

test('REVIEWBUDDY_FAIL_ON works like --fail-on', () => withEnv({ OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_FAIL_ON: 'BUG' }, async () => {
  await reviewBugDiff();
  assert.equal(process.exitCode, 1);
}));

const postedKey = { pull_request_review_id: 1, path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key' };

test('main --fail-on counts a finding even when it was already posted', () => github(async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(OLD) }], comments: [postedKey] });

  await main([PR_URL, '--fail-on', 'security']);

  assert.equal(calls.posted.length, 0);
  assert.equal(process.exitCode, 1);
}));

test('main --fail-on still fails on an earlier finding when the head was already reviewed', () => github(async () => {
  const calls = fakeGitHub({ reviews: [{ id: 1, body: markerFor(HEAD) }], comments: [postedKey] });

  await main([PR_URL, '--fail-on', 'security']);

  assert.equal(calls.reviewed.length, 0);
  assert.equal(process.exitCode, 1);
}));

test('main --fail-on ignores an earlier finding once its line changed', () => github(async () => {
  fakeGitHub({ reviews: [{ id: 1, body: markerFor(HEAD) }], comments: [{ ...postedKey, line: null }] });

  await main([PR_URL, '--fail-on', 'security']);

  assert.notEqual(process.exitCode, 1);
}));

/** Write a pull_request event; fork: whether the head repo differs from the base. Returns its path. */
async function eventFile(fork) {
  const path = join(dir, 'event.json');
  await writeFile(path, JSON.stringify({
    pull_request: { head: { repo: { full_name: fork ? 'someone/r' : 'o/r' } }, base: { repo: { full_name: 'o/r' } } },
  }));
  return path;
}

const actions = (vars, fn) => withEnv({ GITHUB_TOKEN: 'tok', OLLAMA_URL: 'http://ollama.test', GITHUB_ACTIONS: 'true', ...vars }, fn);

test('in Actions, main writes the report to the job summary and prints annotations', async () => {
  const summary = join(dir, 'summary.md');
  await actions({ GITHUB_STEP_SUMMARY: summary }, async () => {
    fakeGitHub();
    await main([PR_URL]);
  });

  const report = await readFile(summary, 'utf8');
  assert.match(report, /^# 🔍 ReviewBuddy Report/);
  assert.match(report, /\| 2 \| 🔴 \*\*SECURITY\*\* \| Hardcoded key \|/);
  assert.match(logged(), /^::error file=src\/a\.js,line=2,title=reviewbuddy%3A SECURITY::Hardcoded key$/m);
});

test('in Actions, main refuses Ollama without OLLAMA_URL', () => actions({ OLLAMA_URL: '' }, async () => {
  fakeGitHub();
  await assert.rejects(main([PR_URL]), /Ollama doesn't run on GitHub-hosted runners/);
}));

test('in Actions, a fork PR without an API key is skipped with a warning', async () => {
  const path = await eventFile(true);
  await actions({ REVIEWBUDDY_PROVIDER: 'groq', GROQ_API_KEY: '', GITHUB_EVENT_PATH: path }, async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => assert.fail('nothing should be fetched'));
    await main([PR_URL, '--fail-on', 'security']);
    assert.equal(fetch.mock.callCount(), 0);
  });
  assert.match(logged(), /^::warning::Skipping the review: GitHub doesn't pass secrets to workflows on pull requests from forks/m);
  assert.notEqual(process.exitCode, 1);
});

test('in Actions, a missing API key on a same-repo PR is an error with a hint', async () => {
  const path = await eventFile(false);
  await actions({ REVIEWBUDDY_PROVIDER: 'groq', GROQ_API_KEY: '', GITHUB_EVENT_PATH: path }, async () => {
    await assert.rejects(main([PR_URL]), /Set GROQ_API_KEY to use Groq[^]*add the key as a repository secret/);
  });
});

test('in Actions, a 403 when posting on a fork PR is a warning, and --fail-on still applies', async () => {
  const path = await eventFile(true);
  await actions({ GITHUB_EVENT_PATH: path }, async () => {
    fakeGitHub({ postStatus: 403 });
    await main([PR_URL, '--fail-on', 'security']);
  });
  assert.match(logged(), /^::warning::Could not post the review: on pull requests from forks the GitHub token is read-only/m);
  assert.equal(process.exitCode, 1);
});

test('a 403 when posting on a same-repo PR is still an error', async () => {
  const path = await eventFile(false);
  await actions({ GITHUB_EVENT_PATH: path }, async () => {
    fakeGitHub({ postStatus: 403 });
    await assert.rejects(main([PR_URL]), /GitHub returned HTTP 403/);
  });
});

// Full-file context

test('main sends the PR file at the head commit as context before the diff', () => github(async () => {
  const calls = fakeGitHub();

  await main([PR_URL]);

  const [prompt] = calls.reviewed;
  assert.match(prompt, /=== FULL FILE \(for reference only; do NOT comment on lines outside the diff\) ===\n {3}1 const a = 1;\n {3}2 const key = 'secret';\n {3}3 export \{ a \};\n=== END OF REFERENCE ===\n\n=== DIFF TO REVIEW ===/);
}));

test('main reviews the diff alone when the file at the head commit is missing', () => github(async () => {
  const calls = fakeGitHub({ source: null });

  await main([PR_URL]);

  assert.doesNotMatch(calls.reviewed[0], /FULL FILE/);
  assert.equal(calls.posted.length, 1);
}));

/** Mock Ollama with findings for every request; returns the prompts it got. */
function fakeOllama(findings) {
  const prompts = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    prompts.push(JSON.parse(init.body).messages.at(-1).content);
    return ollamaReply(findings);
  });
  return prompts;
}

/** Everything main printed with console.warn, as one string. */
function warned() {
  return console.warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
}

test('main --repo-dir reads the changed file from a local checkout', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const prompts = fakeOllama([]);
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.js'), SOURCE);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--repo-dir', repo]);

  assert.match(prompts[0], /=== FULL FILE/);
}));

test('main ignores a local file that does not match the diff', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const prompts = fakeOllama([]);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'a.js'), 'something else\n');
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--repo-dir', dir]);

  assert.doesNotMatch(prompts[0], /FULL FILE/);
  assert.match(warned(), /src\/a\.js doesn't match the diff/);
}));

test('main never reads a file outside --repo-dir, whatever path the diff names', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const prompts = fakeOllama([]);
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await writeFile(join(dir, 'secret.js'), "const key = 'secret';\n");
  await writeFile(join(dir, 'changes.diff'), diff.replaceAll('src/a.js', '../secret.js'));

  await main([join(dir, 'changes.diff'), '--repo-dir', repo]);

  assert.doesNotMatch(prompts[0], /FULL FILE/);
  assert.match(warned(), /Not reading \.\.\/secret\.js for context/);
}));

test('main rejects a --repo-dir that is not a directory', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  await assert.rejects(main(['changes.diff', '--repo-dir', join(dir, 'nope')]), /--repo-dir .*nope is not a directory/);
}));

// --min-severity

const mixed = [
  { line: 2, severity: 'security', message: 'Hardcoded key', suggestion: '' },
  { line: 2, severity: 'bug', message: 'Unused key', suggestion: '' },
  { line: 2, severity: 'performance', message: 'Slow', suggestion: '' },
  { line: 2, severity: 'suggestion', message: 'Rename', suggestion: '' },
];

test('parseMinSeverity reads one severity in any case and rejects unknown ones', () => {
  assert.equal(parseMinSeverity(' Bug '), 'bug');
  assert.equal(parseMinSeverity(''), undefined);
  assert.equal(parseMinSeverity(undefined), undefined);
  assert.throws(() => parseMinSeverity('critical'), /Unknown severity "critical" in --min-severity\. Use one of: security, bug, performance, suggestion\./);
});

test('main --min-severity leaves less serious findings out of the output and the report', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama(mixed);
  const reportPath = join(dir, 'report.md');
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--min-severity', 'bug', '-o', reportPath]);

  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /Hardcoded key/);
  assert.match(report, /Unused key/);
  assert.doesNotMatch(report, /Slow|Rename/);
  assert.doesNotMatch(logged(), /\[PERFORMANCE\]|\[SUGGESTION\]/);
  assert.match(logged(), /Left out 2 findings below --min-severity bug\./);
}));

test('main --min-severity leaves less serious findings out of the posted review', () => github(async () => {
  const calls = fakeGitHub({ findings: mixed });

  await main([PR_URL, '--min-severity', 'security']);

  assert.deepEqual(calls.posted[0].comments.map((c) => c.body), ['**[SECURITY]** Hardcoded key']);
}));

test('REVIEWBUDDY_MIN_SEVERITY works like --min-severity', () => withEnv({ OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_MIN_SEVERITY: 'Security' }, async () => {
  fakeOllama(mixed);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--fail-on', 'bug']);

  assert.notEqual(process.exitCode, 1);
  assert.match(logged(), /Left out 3 findings below --min-severity security\./);
}));

test('main rejects an unknown --min-severity before reviewing', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => assert.fail('nothing should be fetched'));
  await assert.rejects(main(['changes.diff', '--min-severity', 'high']), /Unknown severity "high" in --min-severity/);
  assert.equal(fetch.mock.callCount(), 0);
}));

test('main --fail-on still fails on findings at or above --min-severity', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama(mixed);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--min-severity', 'bug', '--fail-on', 'bug']);

  assert.equal(process.exitCode, 1);
}));

test('main --fail-on below --min-severity warns and never fails', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama(mixed);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '--min-severity', 'bug', '--fail-on', 'suggestion']);

  assert.notEqual(process.exitCode, 1);
  assert.match(warned(), /--fail-on suggestion has no effect with --min-severity bug/);
}));

test('main --fail-on ignores earlier posted findings below --min-severity', () => github(async () => {
  fakeGitHub({
    reviews: [{ id: 1, body: markerFor(HEAD) }],
    comments: [{ pull_request_review_id: 1, path: 'src/a.js', line: 2, body: '**[PERFORMANCE]** Slow' }],
  });

  await main([PR_URL, '--min-severity', 'bug', '--fail-on', 'performance']);

  assert.notEqual(process.exitCode, 1);
}));

// Suggestions

test('main posts a model suggestion as a suggestion block, indented like the line', () => github(async () => {
  const calls = fakeGitHub({ findings: [{ ...hardcodedKey, suggestion: '    const key = process.env.KEY;' }] });

  await main([PR_URL]);

  assert.equal(calls.posted[0].comments[0].body, '**[SECURITY]** Hardcoded key\n\n```suggestion\nconst key = process.env.KEY;\n```');
  assert.match(logged(), /^ {4}fix: const key = process\.env\.KEY;$/m);
}));

test('main drops a suggestion that is the same as the current line', () => github(async () => {
  const calls = fakeGitHub({ findings: [{ ...hardcodedKey, suggestion: "const key = 'secret';" }] });

  await main([PR_URL]);

  assert.equal(calls.posted[0].comments[0].body, '**[SECURITY]** Hardcoded key');
}));

// Per-repository config

const baseConfig = {
  '.reviewbuddy.json': JSON.stringify({ failOn: ['security'] }),
  '.reviewbuddy.md': '- Secrets come from process.env, never literals.',
};

test('main reads the PR\'s config from its base commit, never from its head', () => github(async () => {
  const calls = fakeGitHub({
    config: baseConfig,
    headConfig: { '.reviewbuddy.json': '{"failOn": []}', '.reviewbuddy.md': 'HEAD RULES' },
  });

  await main([PR_URL]);

  assert.ok(calls.urls.includes(`https://api.github.com/repos/o/r/contents/.reviewbuddy.json?ref=${BASE}`));
  assert.ok(calls.urls.includes(`https://api.github.com/repos/o/r/contents/.reviewbuddy.md?ref=${BASE}`));
  assert.deepEqual(calls.urls.filter((u) => u.includes('.reviewbuddy') && !u.endsWith(`ref=${BASE}`)), []);
  // failOn and the rules from the base branch apply.
  assert.equal(process.exitCode, 1);
  assert.match(calls.systems[0], /=== PROJECT RULES FROM THE REPOSITORY ===[^]*- Secrets come from process\.env, never literals\.\n=== END OF PROJECT RULES ===$/);
  assert.doesNotMatch(calls.systems[0], /HEAD RULES/);
  assert.match(logged(), /^Config: \.reviewbuddy\.json \(base branch main @ bbb2222\), \.reviewbuddy\.md \(base branch main @ bbb2222\)$/m);
}));

test('a flag wins over the PR\'s config', () => github(async () => {
  fakeGitHub({ config: baseConfig });

  await main([PR_URL, '--fail-on', 'bug']);

  assert.notEqual(process.exitCode, 1);
}));

test('an empty action input falls through to the PR\'s config', () => github(() => withEnv({ REVIEWBUDDY_FAIL_ON: '' }, async () => {
  fakeGitHub({ config: baseConfig });

  await main([PR_URL]);

  assert.equal(process.exitCode, 1);
})));

test('without config files the system prompt is exactly the built-in one, and nothing is printed about config', () => github(async () => {
  const calls = fakeGitHub();

  await main([PR_URL]);

  assert.equal(calls.systems[0], SYSTEM_PROMPT);
  assert.doesNotMatch(logged(), /Config/);
}));

test('main --no-config reads neither file', () => github(async () => {
  const calls = fakeGitHub({ config: baseConfig });

  await main([PR_URL, '--no-config']);

  assert.deepEqual(calls.urls.filter((u) => u.includes('.reviewbuddy')), []);
  assert.equal(calls.systems[0], SYSTEM_PROMPT);
  assert.notEqual(process.exitCode, 1);
}));

test('main stops on an invalid config on the base branch, naming it', () => github(async () => {
  fakeGitHub({ config: { '.reviewbuddy.json': '{"failOn": "security"}' } });

  await assert.rejects(main([PR_URL]), /"failOn" in \.reviewbuddy\.json \(base branch main @ bbb2222\) must be an array of severities/);
}));

/** A git repo in dir/repo with the given files, and a diff for its src/a.js. Returns the diff's path. */
async function localRepo(files) {
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, 'src'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(repo, name), text);
  await writeFile(join(dir, 'changes.diff'), diff);
  return join(dir, 'changes.diff');
}

test('main reads a diff file\'s config from --repo-dir, walking up to the git root', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const prompts = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    prompts.push(JSON.parse(init.body).messages[0].content);
    return ollamaReply(mixed);
  });
  const diffPath = await localRepo({
    '.reviewbuddy.json': JSON.stringify({ minSeverity: 'security', failOn: ['security'] }),
    '.reviewbuddy.md': '- Errors are logged with logger.error, never console.log.',
  });

  await main([diffPath, '--repo-dir', join(dir, 'repo', 'src')]);

  assert.match(logged(), /Left out 3 findings below --min-severity security\./);
  assert.equal(process.exitCode, 1);
  assert.match(prompts[0], /- Errors are logged with logger\.error, never console\.log\.\n=== END OF PROJECT RULES ===$/);
  assert.ok(logged().includes(`Config: ${join(dir, 'repo', '.reviewbuddy.json')}, ${join(dir, 'repo', '.reviewbuddy.md')}`));
}));

test('main --no-config ignores a diff file\'s local config', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama(mixed);
  const diffPath = await localRepo({ '.reviewbuddy.json': '{"minSeverity": "security"}' });

  await main([diffPath, '--repo-dir', join(dir, 'repo'), '--no-config']);

  assert.doesNotMatch(logged(), /Left out|Config/);
}));

test('main refuses a local config holding a secret before reviewing anything', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => assert.fail('nothing should be fetched'));
  const diffPath = await localRepo({ '.reviewbuddy.json': '{"provider": "groq", "GROQ_API_KEY": "gsk_123"}' });

  await assert.rejects(main([diffPath, '--repo-dir', join(dir, 'repo')]), /\.reviewbuddy\.json must not contain secrets, but it has "GROQ_API_KEY"/);
  assert.equal(fetch.mock.callCount(), 0);
}));

// Inputs: stdin, encodings, git flags

test('selectInput picks git modes, stdin, a PR, a file, or the sample diff', () => {
  assert.deepEqual(selectInput({ staged: true }, []), { kind: 'git', mode: 'staged' });
  assert.deepEqual(selectInput({ uncommitted: true }, []), { kind: 'git', mode: 'uncommitted' });
  assert.deepEqual(selectInput({ branch: 'main' }, []), { kind: 'git', mode: 'branch', rev: 'main' });
  assert.deepEqual(selectInput({ since: 'HEAD~2' }, []), { kind: 'git', mode: 'since', rev: 'HEAD~2' });
  assert.deepEqual(selectInput({}, ['-']), { kind: 'stdin' });
  assert.deepEqual(selectInput({}, ['changes.diff']), { kind: 'file', path: 'changes.diff' });
  assert.equal(selectInput({}, [PR_URL]).kind, 'pr');
  assert.match(selectInput({}, []).path, /samples[\\/]buggy\.diff$/);
  assert.throws(() => selectInput({ staged: true, since: 'v1' }, []), /Review one thing at a time/);
  assert.throws(() => selectInput({ uncommitted: true }, ['-']), /Review one thing at a time/);
});

test('readStdin reads and decodes a piped diff', async () => {
  assert.equal(await readStdin(Readable.from([Buffer.from(diff.slice(0, 20)), Buffer.from(diff.slice(20))])), diff);
  const utf16 = Buffer.from(String.fromCharCode(0xfeff) + diff, 'utf16le');
  assert.equal(await readStdin(Readable.from([utf16.subarray(0, 7), utf16.subarray(7)])), diff);
});

test('readStdin refuses a terminal, where nothing was piped in', async () => {
  const stream = Object.assign(Readable.from([]), { isTTY: true });
  await assert.rejects(readStdin(stream), /No diff on stdin\. Pipe one in/);
});

test('main reviews a UTF-16 diff file, as PowerShell 5.1\'s > writes it', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const prompts = fakeOllama([]);
  await writeFile(join(dir, 'changes.diff'), Buffer.from(String.fromCharCode(0xfeff) + diff, 'utf16le'));

  await main([join(dir, 'changes.diff')]);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^File: src\/a\.js$/m);
  assert.match(prompts[0], /\+const key = 'secret';/);
}));

// Output formats

test('main --format json --output writes the JSON document', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama([{ line: 2, severity: 'bug', message: 'Unused key', suggestion: '' }]);
  await writeFile(join(dir, 'changes.diff'), diff);
  // --format wins over the .md extension.
  const out = join(dir, 'out.md');

  await main([join(dir, 'changes.diff'), '--format', 'json', '-o', out]);

  const doc = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(doc.files, [{ path: 'src/a.js', findings: [{ line: 2, severity: 'bug', message: 'Unused key' }] }]);
  assert.match(logged(), /JSON written to /);
}));

test('main picks the format from --output\'s extension without --format', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama([{ line: 2, severity: 'bug', message: 'Unused key', suggestion: '' }]);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '-o', join(dir, 'r.sarif')]);
  const sarif = JSON.parse(await readFile(join(dir, 'r.sarif'), 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results[0].ruleId, 'reviewbuddy/bug');

  await main([join(dir, 'changes.diff'), '-o', join(dir, 'r.json')]);
  assert.equal(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8')).schemaVersion, 1);

  await main([join(dir, 'changes.diff'), '-o', join(dir, 'r.md')]);
  assert.match(await readFile(join(dir, 'r.md'), 'utf8'), /^# 🔍 ReviewBuddy Report/);
}));

test('REVIEWBUDDY_FORMAT works like --format', () => withEnv({ OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_FORMAT: 'sarif' }, async () => {
  fakeOllama([]);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff'), '-o', join(dir, 'out.json')]);

  assert.equal(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')).version, '2.1.0');
}));

test('REVIEWBUDDY_OUTPUT works like --output', () => withEnv({ OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_OUTPUT: join(dir, 'report.md') }, async () => {
  fakeOllama([{ line: 2, severity: 'bug', message: 'Unused key', suggestion: '' }]);
  await writeFile(join(dir, 'changes.diff'), diff);

  await main([join(dir, 'changes.diff')]);

  assert.match(await readFile(join(dir, 'report.md'), 'utf8'), /^# 🔍 ReviewBuddy Report/);
}));

test('--min-severity and --fail-on apply the same way with --format sarif', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  fakeOllama(mixed);
  await writeFile(join(dir, 'changes.diff'), diff);
  const out = join(dir, 'out.sarif');

  await main([join(dir, 'changes.diff'), '--format', 'sarif', '-o', out, '--min-severity', 'bug', '--fail-on', 'bug']);

  const { results: found } = JSON.parse(await readFile(out, 'utf8')).runs[0];
  assert.deepEqual(found.map((r) => r.ruleId), ['reviewbuddy/security', 'reviewbuddy/bug']);
  assert.equal(process.exitCode, 1);
}));

test('main writes an empty document when nothing is left to review', () => withEnv({ OLLAMA_URL: 'http://ollama.test' }, async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => assert.fail('nothing should be fetched'));
  await writeFile(join(dir, 'changes.diff'), diff.replaceAll('src/a.js', 'package-lock.json'));

  await main([join(dir, 'changes.diff'), '-o', join(dir, 'out.json')]);

  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')).files, []);
}));

const BIN = fileURLToPath(new URL('../bin/reviewbuddy.js', import.meta.url));

/** A stand-in for Ollama on 127.0.0.1 that answers every chat with findings. Returns { url, close }. */
async function ollamaServer(findings) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const content = JSON.stringify({ comments: findings });
      res.end(`${JSON.stringify({ message: { content }, done: true })}\n`);
    });
  });
  await new Promise((done) => { server.listen(0, '127.0.0.1', done); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { server.close(done); }) };
}

/** Run the real CLI in a child process with stdin as input. Returns { code, stdout, stderr }. */
function runCli(args, { stdin, env }) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

for (const format of ['json', 'sarif']) {
  test(`with --format ${format} and no --output, stdout holds only the document; progress goes to stderr`, async () => {
    const ollama = await ollamaServer([{
      line: 2, severity: 'security', message: 'Hardcoded key', suggestion: '',
    }]);
    try {
      const { code, stdout, stderr } = await runCli(['-', '--format', format, '--no-config', '--fail-on', 'security'], {
        stdin: diff,
        env: {
          OLLAMA_URL: ollama.url, OLLAMA_MODEL: '', REVIEWBUDDY_PROVIDER: '', REVIEWBUDDY_FORMAT: '', REVIEWBUDDY_FAIL_ON: '', REVIEWBUDDY_MIN_SEVERITY: '', GITHUB_ACTIONS: '',
        },
      });
      const doc = JSON.parse(stdout);
      if (format === 'json') assert.equal(doc.files[0].findings[0].message, 'Hardcoded key');
      else assert.equal(doc.runs[0].results[0].message.text, 'Hardcoded key');
      assert.match(stderr, /Using ollama/);
      assert.match(stderr, /Reviewed src\/a\.js \(1\/1\)/);
      assert.match(stderr, /Failing: 1 finding match --fail-on security/);
      // --fail-on still sets the exit code.
      assert.equal(code, 1);
    } finally {
      await ollama.close();
    }
  });
}

// Large pull requests

/** A files API entry adding n lines (each "const x<i> = <i>;") to a new file. */
function apiFile(filename, n = 1) {
  const lines = Array.from({ length: n }, (_, i) => `+const x${i} = ${i};`);
  return {
    filename, status: 'added', additions: n, patch: [`@@ -0,0 +1,${n} @@`, ...lines].join('\n'),
  };
}

/** The files API entry for src/a.js matching the PR's diff above. */
const aJsEntry = {
  filename: 'src/a.js', status: 'modified', additions: 1, patch: diff.slice(diff.indexOf('@@')),
};

test('main falls back to the files API, page by page, when GitHub won\'t send the diff', () => github(async () => {
  const binaries = Array.from({ length: 98 }, (_, i) => ({ filename: `img/${i}.png`, status: 'added', additions: 0 }));
  const calls = fakeGitHub({
    diffStatus: 406,
    prFiles: [
      ...binaries,
      { filename: 'src/huge.js', status: 'modified', additions: 50_000 },
      { filename: 'package-lock.json', status: 'modified', additions: 9000 },
      aJsEntry,
    ],
  });

  await main([PR_URL]);

  assert.ok(calls.urls.includes('https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=1'));
  assert.ok(calls.urls.includes('https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=2'));
  assert.match(logged(), /too large for GitHub's diff format, reading the changed files page by page instead/);
  // The same file and line numbers as from the diff.
  assert.equal(calls.reviewed.length, 1);
  assert.deepEqual(calls.posted[0].comments, [{ path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key', side: 'RIGHT' }]);
  // A file GitHub sent no patch for is listed; an ignored one isn't, and neither are binary files.
  assert.match(calls.posted[0].body, /Not reviewed:\n- `src\/huge\.js`: too large for the GitHub API/);
  assert.doesNotMatch(calls.posted[0].body, /package-lock|\.png/);
  assert.ok(calls.posted[0].body.endsWith(markerFor(HEAD)));
  assert.equal(process.exitCode, exitCode);
}));

test('main says when a PR has more files than GitHub\'s files API lists', () => github(async () => {
  const calls = fakeGitHub({ diffStatus: 406, prFiles: [aJsEntry], changedFiles: 3002 });

  await main([PR_URL]);

  assert.match(warned(), /GitHub's files API lists at most 3000 files, so 3001 more changed files could not be reviewed\./);
  assert.match(calls.posted[0].body, /Not reviewed:\n- GitHub's files API lists at most 3000 files/);
}));

test('an incremental review falls back to the compare API\'s file list when the compare diff is too large', () => github(async () => {
  const aSince = compareDiff.slice(compareDiff.indexOf('@@'), compareDiff.indexOf('diff --git a/src/base.js'));
  const calls = fakeGitHub({
    reviews: [{ id: 1, body: markerFor(OLD) }],
    compareStatus: 406,
    compareFiles: [{
      filename: 'src/a.js', status: 'modified', additions: 1, patch: aSince,
    }, apiFile('src/base.js')],
  });

  await main([PR_URL]);

  assert.ok(calls.urls.includes(`https://api.github.com/repos/o/r/compare/${OLD}...${HEAD}?per_page=1`));
  // Only src/a.js: src/base.js isn't part of the PR.
  assert.equal(calls.reviewed.length, 1);
  assert.match(calls.reviewed[0], /const key = 'x'/);
  assert.match(logged(), /The changes since aaa1111 are too large for GitHub's diff format, reading the changed files instead\./);
  assert.match(calls.posted[0].body, /^reviewbuddy found 1 issue in 1 file since `aaa1111`/);
}));

test('an incremental review over the compare API\'s 300-file cap reviews the whole PR instead', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [{ id: 1, body: markerFor(OLD) }],
    compareStatus: 406,
    compareFiles: Array.from({ length: 300 }, (_, i) => apiFile(`src/f${i}.js`)),
  });

  await main([PR_URL]);

  assert.match(logged(), /Too many changes since aaa1111 for GitHub's compare API \(it lists at most 300 files\), reviewing the whole PR\./);
  assert.equal(calls.reviewed.length, 1);
  assert.doesNotMatch(calls.reviewed[0], /const key = 'x'/);
  assert.match(calls.posted[0].body, /^reviewbuddy found 1 issue in 1 file \(/);
}));

/** Files a.js to d.js under src/, each adding one line that gets one finding. */
const fourFiles = ['a', 'b', 'c', 'd'].map((n) => apiFile(`src/${n}.js`));
const findingIn = (filename) => [{ line: 1, severity: 'bug', message: `Bug in ${filename}` }];

test('main reviews files in parallel, printing each as one block, and keeps every output in the PR\'s order', () => github(async () => {
  // a.js finishes last, b.js first.
  const delays = {
    'src/a.js': 60, 'src/b.js': 0, 'src/c.js': 30, 'src/d.js': 15,
  };
  const calls = fakeGitHub({
    diffStatus: 406, prFiles: fourFiles, findings: findingIn, source: null, delay: (f) => delays[f],
  });
  const output = join(dir, 'out.json');

  await main([PR_URL, '--concurrency', '4', '--output', output]);

  const out = logged();
  assert.match(out, /Reviewing 4 files with concurrency 4/);
  // Blocks come in finishing order, each with the running count, and each file's lines stay together.
  const blocks = [...out.matchAll(/Reviewed (\S+) \((\d)\/4\)\n {2}\1:1 \[BUG\] Bug in \1/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(blocks, ['1 src/b.js', '2 src/d.js', '3 src/c.js', '4 src/a.js']);
  // The posted review and the JSON keep the PR's order.
  assert.deepEqual(calls.posted[0].comments.map((c) => c.path), ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
  const doc = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(doc.files.map((f) => f.path), ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
}));

test('main --concurrency takes REVIEWBUDDY_CONCURRENCY and defaults to 1 for Ollama', () => github(async () => {
  fakeGitHub({ diffStatus: 406, prFiles: fourFiles, source: null });
  await main([PR_URL, '--dry-run']);
  assert.match(logged(), /Reviewing 4 files with concurrency 1\n/);

  await withEnv({ REVIEWBUDDY_CONCURRENCY: '3' }, () => main([PR_URL, '--dry-run']));
  assert.match(logged(), /Reviewing 4 files with concurrency 3\n/);

  await assert.rejects(main([PR_URL, '--concurrency', '0']), /Invalid value "0" in --concurrency: give a whole number from 1 to 16\./);
}));

test('a file that fails doesn\'t lose the others: they are posted, it is listed, and the run exits with 1', () => github(async () => {
  const calls = fakeGitHub({
    diffStatus: 406, prFiles: fourFiles, findings: findingIn, source: null, ollamaStatus: (f) => (f === 'src/b.js' ? 400 : undefined),
  });

  await main([PR_URL, '--concurrency', '2']);

  assert.deepEqual(calls.posted[0].comments.map((c) => c.path), ['src/a.js', 'src/c.js', 'src/d.js']);
  assert.match(calls.posted[0].body, /^reviewbuddy found 3 issues in 3 files/);
  assert.match(calls.posted[0].body, /- `src\/b\.js`: failed: Ollama returned HTTP 400: model error for src\/b\.js/);
  // The marker keeps the base commit, so the next run tries src/b.js again; posted findings are skipped then.
  assert.ok(calls.posted[0].body.endsWith(markerFor(BASE)));
  assert.match(logged(), /Could not review src\/b\.js \(\d\/4\)/);
  assert.match(logged(), /Incomplete: 1 file could not be reviewed \(src\/b\.js\)\./);
  assert.equal(process.exitCode, 1);
}));

test('an error that would fail every file stops the run instead of trying them all', () => github(async () => {
  const calls = fakeGitHub({
    diffStatus: 406, prFiles: [...fourFiles, apiFile('src/e.js'), apiFile('src/f.js')], source: null, ollamaStatus: () => 404,
  });

  await assert.rejects(main([PR_URL, '--concurrency', '2']), /Ollama returned HTTP 404 \(model "qwen3\.5:4b" isn't installed/);

  // The two started together; nothing after them was tried, and nothing was posted.
  assert.equal(calls.reviewed.length, 2);
  assert.equal(calls.posted.length, 0);
}));

test('main --max-files reviews source files and the biggest changes first, and lists the rest', () => github(async () => {
  const calls = fakeGitHub({
    diffStatus: 406,
    source: null,
    findings: findingIn,
    prFiles: [apiFile('README.md', 90), apiFile('src/small.js', 1), apiFile('test/a.test.js', 50), apiFile('src/big.js', 20), apiFile('src/mid.js', 5)],
  });

  await main([PR_URL, '--max-files', '2']);

  assert.match(logged(), /Reviewing 2 of 5 files \(--max-files 2\): source files and the biggest changes first\./);
  assert.deepEqual(calls.posted[0].comments.map((c) => c.path), ['src/big.js', 'src/mid.js']);
  assert.match(calls.posted[0].body, /Not reviewed:\n- `README\.md`: over --max-files 2\n- `src\/small\.js`: over --max-files 2\n- `test\/a\.test\.js`: over --max-files 2/);
  // Skipping files on purpose is not a failure.
  assert.equal(process.exitCode, exitCode);
  assert.ok(calls.posted[0].body.endsWith(markerFor(HEAD)));
}));

test('a review with more findings than the inline cap posts the most severe inline and lists the rest', () => github(async () => {
  const findings = Array.from({ length: 60 }, (_, i) => ({ line: i + 1, severity: i === 59 ? 'security' : 'suggestion', message: `Finding ${i + 1}` }));
  const calls = fakeGitHub({
    diffStatus: 406, prFiles: [apiFile('src/gen.js', 60)], source: null, findings,
  });

  await main([PR_URL]);

  const [review] = calls.posted;
  assert.equal(review.comments.length, 50);
  assert.equal(review.comments.at(-1).line, 60);
  assert.deepEqual(review.comments.slice(0, 49).map((c) => c.line), Array.from({ length: 49 }, (_, i) => i + 1));
  assert.match(review.body, /^reviewbuddy found 60 issues in 1 file/);
  assert.match(review.body, /Only the 50 most severe findings are posted inline, so the review stays readable\. The other 10:\n- `src\/gen\.js:50` \*\*\[SUGGESTION\]\*\* Finding 50\n/);
  assert.match(review.body, /- `src\/gen\.js:59` \*\*\[SUGGESTION\]\*\* Finding 59/);
}));

test('the JSON and SARIF output list what wasn\'t reviewed', () => github(async () => {
  fakeGitHub({
    diffStatus: 406, prFiles: fourFiles, findings: findingIn, source: null, ollamaStatus: (f) => (f === 'src/c.js' ? 400 : undefined),
  });
  const json = join(dir, 'out.json');
  const sarif = join(dir, 'out.sarif');

  await main([PR_URL, '--dry-run', '--max-files', '3', '--output', json]);
  const doc = JSON.parse(await readFile(json, 'utf8'));
  assert.deepEqual(doc.summary, { files: 2, findings: 2, notReviewed: 2 });
  assert.deepEqual(doc.notReviewed, [
    { path: 'src/d.js', reason: 'over --max-files 3' },
    { path: 'src/c.js', reason: 'failed: Ollama returned HTTP 400: model error for src/c.js' },
  ]);

  await main([PR_URL, '--dry-run', '--max-files', '3', '--output', sarif]);
  const [invocation] = JSON.parse(await readFile(sarif, 'utf8')).runs[0].invocations;
  assert.equal(invocation.executionSuccessful, false);
  assert.deepEqual(invocation.toolExecutionNotifications.map((n) => [n.level, n.locations[0].physicalLocation.artifactLocation.uri]), [
    ['warning', 'src/d.js'],
    ['error', 'src/c.js'],
  ]);
}));

// Multi-line findings

/** Lines 2-4 (a loop) added in the first hunk, line 24 in the second. */
const blockDiff = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,5 @@',
  ' function f(xs) {',
  '+  for (let i = 0; i <= xs.length; i++) {',
  '+    use(xs[i]);',
  '+  }',
  ' }',
  '@@ -20,1 +23,2 @@',
  ' x();',
  '+y();',
  '',
].join('\n');
const loopFix = '  for (let i = 0; i < xs.length; i++) {\n    use(xs[i]);\n  }';

test('buildReview posts a range as start_line and line, with a suggestion for the whole block', () => {
  const review = buildReview([{
    filename: 'src/a.js',
    diff: blockDiff,
    comments: [{
      line: 2, endLine: 4, severity: 'bug', message: 'Off-by-one', suggestion: loopFix,
    }],
  }], { commitId: 'abc', model: 'm' });
  assert.deepEqual(review.comments, [{
    path: 'src/a.js', start_line: 2, line: 4, body: `**[BUG]** Off-by-one\n\n\`\`\`suggestion\n${loopFix}\n\`\`\``,
  }]);
});

test('buildReview posts a range the PR diff splits on its first line, and lists one outside the diff as file:a-b', () => {
  const review = buildReview([{
    filename: 'src/a.js',
    diff: blockDiff,
    comments: [
      {
        line: 4, endLine: 24, severity: 'bug', message: 'Split', suggestion: 'a();\nb();',
      },
      {
        line: 40, endLine: 42, severity: 'security', message: 'Outside',
      },
    ],
  }], { commitId: 'abc', model: 'm' });
  assert.deepEqual(review.comments, [{ path: 'src/a.js', line: 4, body: '**[BUG]** Split' }]);
  assert.match(review.body, /^- `src\/a\.js:40-42` \*\*\[SECURITY\]\*\* Outside$/m);
});

test('formatReport shows a range and a multi-line fix', () => {
  const report = formatReport([{
    filename: 'src/a.js',
    comments: [{
      line: 2, endLine: 4, severity: 'bug', message: 'Off-by-one', suggestion: loopFix,
    }],
  }], { model: 'm', seconds: '1', date: new Date(0) });
  assert.match(report, /\| 2-4 \| 🟠 \*\*BUG\*\* \| Off-by-one<br>\*\*Fix:\*\* `for \(let i = 0; i < xs\.length; i\+\+\) \{`<br>` {2}use\(xs\[i\]\);`<br>`\}` \|/);
});

const loop = {
  line: 2, endLine: 3, severity: 'bug', message: 'Loop', suggestion: '',
};

test('main posts a range finding on both lines, and prints it as file:a-b', () => github(async () => {
  const calls = fakeGitHub({ findings: [loop] });

  await main([PR_URL]);

  assert.deepEqual(calls.posted[0].comments, [{
    path: 'src/a.js', start_line: 2, line: 3, body: '**[BUG]** Loop', start_side: 'RIGHT', side: 'RIGHT',
  }]);
  assert.match(logged(), /src\/a\.js:2-3 \[BUG\] Loop/);
}));

test('main does not post a range finding again on a re-run', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [{ id: 1, body: markerFor(OLD) }],
    // As GitHub lists the earlier range comment: start_line is its first line, line its last.
    comments: [{
      pull_request_review_id: 1, path: 'src/a.js', start_line: 2, line: 3, body: '**[BUG]** Loop',
    }],
    findings: [loop],
  });

  await main([PR_URL]);

  assert.equal(calls.posted.length, 0);
  assert.match(logged(), /Skipped 1 finding already posted/);
}));

// Requesting changes

test('reviewEvent requests changes only for a listed severity, and never approves', () => {
  const found = [{ filename: 'a.js', comments: [{ line: 1, severity: 'bug', message: 'm' }] }];
  assert.equal(reviewEvent(found, ['security', 'bug']), 'REQUEST_CHANGES');
  assert.equal(reviewEvent(found, ['security']), 'COMMENT');
  assert.equal(reviewEvent(found, []), 'COMMENT');
  assert.equal(reviewEvent(found), 'COMMENT');
  assert.equal(reviewEvent([], ['bug']), 'COMMENT');
  assert.equal(reviewEvent([{ filename: 'a.js', comments: [] }], ['bug']), 'COMMENT');
});

test('main requests changes when a posted finding matches --request-changes-on, and comments otherwise', () => github(async () => {
  const runs = [];
  for (const args of [['--request-changes-on', 'security,bug'], ['--request-changes-on', 'bug'], []]) {
    mock.restoreAll();
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    const calls = fakeGitHub();
    await main([PR_URL, ...args]);
    runs.push(calls);
  }
  assert.deepEqual(runs.map((calls) => calls.posted[0].event), ['REQUEST_CHANGES', 'COMMENT', 'COMMENT']);
  // reviewbuddy never approves, whatever it found.
  assert.ok(!runs.flatMap((calls) => calls.events).includes('APPROVE'));
}));

test('REVIEWBUDDY_REQUEST_CHANGES_ON works like --request-changes-on', () => withEnv({
  GITHUB_TOKEN: 'tok', OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_REQUEST_CHANGES_ON: 'security',
}, async () => {
  const calls = fakeGitHub();
  await main([PR_URL]);
  assert.equal(calls.posted[0].event, 'REQUEST_CHANGES');
}));

test('main posts a comment instead, with a warning, when GitHub refuses changes on the author\'s own PR', () => github(async () => {
  const calls = fakeGitHub({ rejectRequestChanges: true });

  await main([PR_URL, '--request-changes-on', 'security']);

  assert.deepEqual(calls.events, ['REQUEST_CHANGES', 'COMMENT']);
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0].event, 'COMMENT');
  assert.match(warned(), /Warning: GitHub doesn't let anyone request changes on their own pull request.*posted as a comment instead/);
  assert.notEqual(process.exitCode, 1);
}));

test('main --dry-run shows the event it would use', () => github(async () => {
  const calls = fakeGitHub();
  await main([PR_URL, '--dry-run', '--request-changes-on', 'security']);
  assert.equal(calls.events.length, 0);
  assert.match(logged(), /Dry run, not posting\. The review would be \(event REQUEST_CHANGES\):/);
  assert.match(logged(), /"event": "REQUEST_CHANGES"/);
}));

// Dismissing our earlier change request

const blockingReview = { id: 5, state: 'CHANGES_REQUESTED', body: `reviewbuddy found 1 issue.\n\n${markerFor(OLD)}` };
const keyComment = {
  pull_request_review_id: 5, path: 'src/a.js', line: 2, body: '**[SECURITY]** Hardcoded key',
};
// GitHub reports no current line on a comment whose code changed.
const outdatedKey = { ...keyComment, line: null };

test('main dismisses its change request once the blocking comments are outdated and nothing blocking is left', () => github(async () => {
  const calls = fakeGitHub({ reviews: [blockingReview], comments: [outdatedKey], findings: [] });

  await main([PR_URL, '--request-changes-on', 'security']);

  assert.equal(calls.posted.length, 0);
  assert.equal(calls.dismissed.length, 1);
  assert.equal(calls.dismissed[0].url, 'https://api.github.com/repos/o/r/pulls/1/reviews/5/dismissals');
  assert.deepEqual(calls.dismissed[0].body, {
    message: 'reviewbuddy: the blocking findings were fixed (the code under them changed) and the review of abc1234 found no new ones.',
    event: 'DISMISS',
  });
  assert.match(logged(), /Dismissed reviewbuddy's earlier change request #5/);
}));

test('main keeps its change request while a blocking comment still applies', () => github(async () => {
  const calls = fakeGitHub({ reviews: [blockingReview], comments: [keyComment], findings: [] });

  await main([PR_URL, '--request-changes-on', 'security']);

  assert.equal(calls.dismissed.length, 0);
  assert.match(logged(), /Keeping 1 earlier change request by reviewbuddy: not every blocking finding is fixed yet\./);
}));

test('main keeps its change request when this run finds a blocking issue', () => github(async () => {
  const calls = fakeGitHub({ reviews: [blockingReview], comments: [outdatedKey] });
  await main([PR_URL, '--request-changes-on', 'security']);
  assert.equal(calls.dismissed.length, 0);
  assert.equal(calls.posted[0].event, 'REQUEST_CHANGES');
}));

test('main keeps its change request when a file could not be reviewed', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [blockingReview], comments: [outdatedKey], findings: [], ollamaStatus: () => 400,
  });
  await main([PR_URL, '--request-changes-on', 'security']);
  assert.equal(calls.dismissed.length, 0);
}));

test('main --full dismisses its change request when the whole PR has no blocking issue', () => github(async () => {
  const reviewed = { ...blockingReview, body: markerFor(HEAD) };
  const calls = fakeGitHub({ reviews: [reviewed], comments: [keyComment], findings: [] });

  await main([PR_URL, '--full', '--request-changes-on', 'security']);

  assert.deepEqual(calls.dismissed.map((d) => d.body.message), ['reviewbuddy: a full review of abc1234 found no blocking issues.']);
}));

test('main warns, and carries on, when GitHub won\'t let it dismiss the review', () => github(async () => {
  const calls = fakeGitHub({
    reviews: [blockingReview], comments: [outdatedKey], findings: [], dismissStatus: 403,
  });

  await main([PR_URL, '--request-changes-on', 'security']);

  assert.equal(calls.dismissed.length, 0);
  assert.match(warned(), /Warning: Could not dismiss reviewbuddy's earlier change request #5: GitHub returned HTTP 403.*It keeps blocking the merge until someone with write access dismisses it\./);
  assert.notEqual(process.exitCode, 1);
}));

test('main --dry-run says which change request it would dismiss, without dismissing it', () => github(async () => {
  const calls = fakeGitHub({ reviews: [blockingReview], comments: [outdatedKey], findings: [] });

  await main([PR_URL, '--dry-run', '--request-changes-on', 'security']);

  assert.equal(calls.dismissed.length, 0);
  assert.ok(!calls.urls.some((u) => u.includes('/dismissals')));
  assert.match(logged(), /Would dismiss reviewbuddy's change request #5: reviewbuddy: the blocking findings were fixed/);
}));

test('main leaves change requests alone without --request-changes-on', () => github(async () => {
  const calls = fakeGitHub({ reviews: [blockingReview], comments: [outdatedKey], findings: [] });
  await main([PR_URL]);
  assert.equal(calls.dismissed.length, 0);
}));
