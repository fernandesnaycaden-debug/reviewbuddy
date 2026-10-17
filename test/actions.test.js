import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  annotation, annotationsFor, appendStepSummary, escapeData, escapeProperty, isForkPullRequest,
} from '../src/actions.js';

const VARS = ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_EVENT_PATH'];
let dir;
let saved;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-'));
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

test('escapeData encodes %, CR and LF so a message stays one command', () => {
  assert.equal(escapeData('100% sure\r\nnext::line'), '100%25 sure%0D%0Anext::line');
});

test('escapeProperty also encodes : and ,', () => {
  assert.equal(escapeProperty('src/a,b:c%.js'), 'src/a%2Cb%3Ac%25.js');
});

test('annotation formats file, line and title, and skips empty properties', () => {
  assert.equal(
    annotation('error', 'Hardcoded key\nuse an env var', { file: 'src/a.js', line: 2, title: 'reviewbuddy: SECURITY' }),
    '::error file=src/a.js,line=2,title=reviewbuddy%3A SECURITY::Hardcoded key%0Ause an env var',
  );
  assert.equal(annotation('warning', 'Plain', { file: undefined }), '::warning::Plain');
});

test('annotationsFor makes security and bug errors, the rest warnings', () => {
  const lines = annotationsFor([{
    filename: 'a.js',
    comments: [
      { line: 1, severity: 'security', message: 's' },
      { line: 2, severity: 'bug', message: 'b' },
      { line: 3, severity: 'performance', message: 'p' },
      { line: 4, severity: 'suggestion', message: 'x' },
    ],
  }]);
  assert.deepEqual(lines.map((l) => l.match(/^::(\w+)/)[1]), ['error', 'error', 'warning', 'warning']);
  assert.equal(lines[2], '::warning file=a.js,line=3,title=reviewbuddy%3A PERFORMANCE::p');
});

test('appendStepSummary appends to GITHUB_STEP_SUMMARY in Actions', async () => {
  const path = join(dir, 'summary.md');
  await writeFile(path, 'earlier step\n');
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_STEP_SUMMARY = path;

  await appendStepSummary('# Report');

  assert.equal(await readFile(path, 'utf8'), 'earlier step\n# Report\n');
});

test('appendStepSummary does nothing outside Actions', async () => {
  const path = join(dir, 'summary.md');
  process.env.GITHUB_STEP_SUMMARY = path;
  await appendStepSummary('# Report');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

/** Write a pull_request event payload and point GITHUB_EVENT_PATH at it. */
async function event(head, base = 'o/r') {
  const path = join(dir, 'event.json');
  await writeFile(path, JSON.stringify({
    pull_request: { head: { repo: head && { full_name: head } }, base: { repo: { full_name: base } } },
  }));
  process.env.GITHUB_EVENT_PATH = path;
}

test('isForkPullRequest compares the head and base repos', async () => {
  await event('someone/r');
  assert.equal(await isForkPullRequest(), true);
  await event('o/r');
  assert.equal(await isForkPullRequest(), false);
  await event(null); // the fork was deleted
  assert.equal(await isForkPullRequest(), true);
});

test('isForkPullRequest is false without a readable event', async () => {
  assert.equal(await isForkPullRequest(), false);
  process.env.GITHUB_EVENT_PATH = join(dir, 'missing.json');
  assert.equal(await isForkPullRequest(), false);
});

test('annotationsFor gives a range finding an endLine', () => {
  const [line] = annotationsFor([{ filename: 'a.js', comments: [{ line: 4, endLine: 9, severity: 'bug', message: 'Loop' }] }]);
  assert.equal(line, '::error file=a.js,line=4,endLine=9,title=reviewbuddy%3A BUG::Loop');
});
