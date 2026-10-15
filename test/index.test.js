import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { markerFor } from '../src/dedupe.js';
import {
  buildReview, formatReport, main, parseFailOn, parseMinSeverity, writeReport,
} from '../src/index.js';

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
    REVIEWBUDDY_MIN_SEVERITY: '',
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
 * Returns the posted review bodies, the requested URLs and the prompts sent to the model.
 */
function fakeGitHub({
  reviews = [], comments = [], compare = compareDiff, findings = [hardcodedKey], postStatus, source = SOURCE,
} = {}) {
  const calls = { posted: [], urls: [], reviewed: [] };
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.urls.push(url);
    if (url === 'http://ollama.test/api/chat') {
      calls.reviewed.push(JSON.parse(init.body).messages.at(-1).content);
      return ollamaReply(findings);
    }
    const path = url.replace('https://api.github.com/repos/o/r/', '');
    if (init.method === 'POST') {
      if (postStatus) return Response.json({ message: 'Resource not accessible by integration' }, { status: postStatus });
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
    if (path.startsWith('contents/')) {
      return source === null ? Response.json({ message: 'Not Found' }, { status: 404 }) : new Response(source);
    }
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

  // The PR, its reviews, its diff, the file at HEAD, the model, the post. No earlier reviews, so no compare or comments.
  assert.equal(calls.urls.length, 6);
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
