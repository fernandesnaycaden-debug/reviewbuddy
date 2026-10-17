import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  CONFIG_FILE, DEFAULT_MAX_CHUNKS_PER_FILE, findLocalConfig, loadConfig, loadRemoteConfig, MAX_CONCURRENCY, MAX_RULES_CHARS,
  parseConfig, parseCount, parseRules, resolveSettings, RULES_FILE,
} from '../src/config.js';
import { DEFAULT_IGNORE } from '../src/ignore.js';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-config-'));
  mock.method(console, 'warn', () => {});
});
afterEach(async () => {
  mock.restoreAll();
  await rm(dir, { recursive: true, force: true });
});

/** Everything printed with console.warn, as one string. */
function warned() {
  return console.warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
}

// .reviewbuddy.json

test('parseConfig reads every key and normalizes case', () => {
  const file = parseConfig(JSON.stringify({
    provider: 'Groq',
    model: 'llama-3.3-70b-versatile',
    ignore: ['src/generated/', ' *.pb.js '],
    defaultIgnore: false,
    minSeverity: 'Bug',
    failOn: ['security', 'BUG', 'security'],
    timeout: 90,
  }));
  assert.deepEqual(file, {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    ignore: ['src/generated/', '*.pb.js'],
    defaultIgnore: false,
    minSeverity: 'bug',
    failOn: ['security', 'bug'],
    timeoutMs: 90_000,
  });
  assert.equal(console.warn.mock.callCount(), 0);
});

test('parseConfig accepts an empty object and a byte order mark', () => {
  assert.deepEqual(parseConfig('﻿{}'), {});
});

test('parseConfig names the file on invalid JSON', () => {
  assert.throws(() => parseConfig('{ "minSeverity": "bug", }', 'repo/.reviewbuddy.json'), /^Error: Invalid JSON in repo\/\.reviewbuddy\.json: /);
  assert.throws(() => parseConfig('["bug"]'), /\.reviewbuddy\.json must hold a JSON object/);
});

test('parseConfig rejects a wrong type for each key, naming the key and the file', () => {
  const cases = [
    [{ provider: 'openai' }, /"provider" in \.reviewbuddy\.json must be one of: ollama, groq, openrouter, gemini, anthropic\./],
    [{ provider: 3 }, /"provider" in \.reviewbuddy\.json must be one of/],
    [{ provider: 'groq', model: '' }, /"model" in \.reviewbuddy\.json must be a model name\./],
    [{ ignore: 'dist/' }, /"ignore" in \.reviewbuddy\.json must be an array of file patterns/],
    [{ ignore: ['dist/', ''] }, /"ignore" in \.reviewbuddy\.json must be an array of file patterns/],
    [{ defaultIgnore: 'false' }, /"defaultIgnore" in \.reviewbuddy\.json must be true or false\./],
    [{ minSeverity: 'high' }, /"minSeverity" in \.reviewbuddy\.json must be one of: security, bug, performance, suggestion\./],
    [{ failOn: 'security' }, /"failOn" in \.reviewbuddy\.json must be an array of severities/],
    [{ failOn: ['security', 'critical'] }, /"failOn" in \.reviewbuddy\.json must be an array of severities/],
    [{ requestChangesOn: 'bug' }, /"requestChangesOn" in \.reviewbuddy\.json must be an array of severities/],
    [{ requestChangesOn: ['blocker'] }, /"requestChangesOn" in \.reviewbuddy\.json must be an array of severities/],
    [{ timeout: '60' }, /"timeout" in \.reviewbuddy\.json must be a number of seconds/],
    [{ timeout: -1 }, /"timeout" in \.reviewbuddy\.json must be a number of seconds/],
  ];
  for (const [config, error] of cases) {
    assert.throws(() => parseConfig(JSON.stringify(config)), error, JSON.stringify(config));
  }
});

test('parseConfig wants a provider next to a model', () => {
  assert.throws(() => parseConfig('{"model": "gpt-oss"}'), /"model" in \.reviewbuddy\.json needs "provider" next to it/);
});

test('parseConfig refuses anything that looks like a secret, and says where secrets go', () => {
  for (const config of [
    { apiKey: 'gsk_123' },
    { GROQ_API_KEY: 'gsk_123' },
    { provider: 'groq', 'api-key': 'x' },
    { githubToken: 'ghp_123' },
    { provider: 'groq', extra: { auth: { token: 'x' } } },
    { password: 'hunter2' },
  ]) {
    assert.throws(
      () => parseConfig(JSON.stringify(config)),
      /\.reviewbuddy\.json must not contain secrets, but it has "[^"]+"\. Put API keys and tokens in environment variables, or in GitHub Actions secrets/,
      JSON.stringify(config),
    );
  }
});

test('parseConfig warns about unknown keys and still uses the rest', () => {
  assert.deepEqual(parseConfig('{"minSeverity": "bug", "severity": "bug"}'), { minSeverity: 'bug' });
  assert.match(warned(), /Warning: unknown key "severity" in \.reviewbuddy\.json, ignoring it\. Known keys: provider, model, ignore, defaultIgnore, minSeverity, failOn, requestChangesOn, timeout, concurrency, maxFiles, maxChunksPerFile, format, output\./);
});

test('parseConfig reads "format" in any case and rejects unknown ones', () => {
  assert.deepEqual(parseConfig('{"format": "SARIF"}'), { format: 'sarif' });
  assert.throws(() => parseConfig('{"format": "xml"}'), /"format" in \.reviewbuddy\.json must be one of: text, json, sarif\./);
  assert.throws(() => parseConfig('{"format": 1}'), /"format" in \.reviewbuddy\.json must be one of/);
});

test('parseConfig reads "output" and rejects non-strings', () => {
  assert.deepEqual(parseConfig('{"output": "report.md"}'), { output: 'report.md' });
  assert.throws(() => parseConfig('{"output": ""}'), /"output" in \.reviewbuddy\.json must be a file path\./);
  assert.throws(() => parseConfig('{"output": 123}'), /"output" in \.reviewbuddy\.json must be a file path\./);
});

// .reviewbuddy.md

test('parseRules trims the rules, and treats a blank file as none', () => {
  assert.equal(parseRules('﻿\n- Use db.query(sql, params).\n\n'), '- Use db.query(sql, params).');
  assert.equal(parseRules(' \n\t\n'), undefined);
});

test('parseRules cuts long rules at a line break within the cap, with a warning', () => {
  const line = `- ${'x'.repeat(97)}\n`;
  const rules = parseRules(line.repeat(50), 'repo/.reviewbuddy.md');
  assert.ok(rules.length <= MAX_RULES_CHARS);
  assert.equal(rules, line.repeat(40).trimEnd());
  assert.match(warned(), /Warning: repo\/\.reviewbuddy\.md is 4999 characters; only the first 4000 go into the prompt\./);
});

test('parseRules keeps rules of exactly the cap without a warning', () => {
  const rules = 'x'.repeat(MAX_RULES_CHARS);
  assert.equal(parseRules(rules), rules);
  assert.equal(console.warn.mock.callCount(), 0);
});

// Precedence: flag > variable > file > default

const file = parseConfig(JSON.stringify({
  provider: 'groq',
  model: 'file-model',
  ignore: ['from-file/'],
  minSeverity: 'performance',
  failOn: ['security'],
  timeout: 30,
}));

test('resolveSettings uses the built-in defaults when nothing is set', () => {
  assert.deepEqual(resolveSettings({}), {
    provider: 'ollama',
    providerSource: 'default',
    model: undefined,
    failOn: [],
    requestChangesOn: [],
    minSeverity: undefined,
    timeoutMs: undefined,
    format: undefined,
    output: undefined,
    concurrency: undefined,
    maxFiles: 0,
    maxChunksPerFile: 10,
    defaultIgnore: true,
    ignorePatterns: DEFAULT_IGNORE,
  });
});

test('resolveSettings takes the format from a flag, then a variable, then the file', () => {
  const fromFile = { format: 'json' };
  assert.equal(resolveSettings({ file: fromFile }).format, 'json');
  assert.equal(resolveSettings({ env: { REVIEWBUDDY_FORMAT: 'Sarif' }, file: fromFile }).format, 'sarif');
  assert.equal(resolveSettings({ flags: { format: 'text' }, env: { REVIEWBUDDY_FORMAT: 'sarif' }, file: fromFile }).format, 'text');
  assert.equal(resolveSettings({ env: { REVIEWBUDDY_FORMAT: '' }, file: fromFile }).format, 'json');
  assert.throws(() => resolveSettings({ env: { REVIEWBUDDY_FORMAT: 'xml' } }), /Unknown format "xml" in REVIEWBUDDY_FORMAT\. Use one of: text, json, sarif\./);
  assert.throws(() => resolveSettings({ flags: { format: 'md' } }), /Unknown format "md" in --format\./);
});

test('resolveSettings takes requestChangesOn from a flag, then a variable, then the file, and defaults to none', () => {
  const fromFile = parseConfig('{"requestChangesOn": ["Security", "bug", "security"]}');
  assert.deepEqual(fromFile, { requestChangesOn: ['security', 'bug'] });
  assert.deepEqual(resolveSettings({}).requestChangesOn, []);
  assert.deepEqual(resolveSettings({ file: fromFile }).requestChangesOn, ['security', 'bug']);
  assert.deepEqual(resolveSettings({ env: { REVIEWBUDDY_REQUEST_CHANGES_ON: 'Security' }, file: fromFile }).requestChangesOn, ['security']);
  assert.deepEqual(resolveSettings({
    flags: { 'request-changes-on': 'performance' }, env: { REVIEWBUDDY_REQUEST_CHANGES_ON: 'bug' }, file: fromFile,
  }).requestChangesOn, ['performance']);
  assert.deepEqual(resolveSettings({ env: { REVIEWBUDDY_REQUEST_CHANGES_ON: '' }, file: fromFile }).requestChangesOn, ['security', 'bug']);
  assert.throws(() => resolveSettings({ flags: { 'request-changes-on': 'security,blocker' } }), /Unknown severity "blocker" in --request-changes-on\./);
  assert.throws(() => resolveSettings({ env: { REVIEWBUDDY_REQUEST_CHANGES_ON: 'nope' } }), /Unknown severity "nope" in REVIEWBUDDY_REQUEST_CHANGES_ON\./);
});

test('resolveSettings takes the output from a flag, then a variable, then the file', () => {
  const fromFile = { output: 'file.md' };
  assert.equal(resolveSettings({ file: fromFile }).output, 'file.md');
  assert.equal(resolveSettings({ env: { REVIEWBUDDY_OUTPUT: 'env.md' }, file: fromFile }).output, 'env.md');
  assert.equal(resolveSettings({ flags: { output: 'flag.md' }, env: { REVIEWBUDDY_OUTPUT: 'env.md' }, file: fromFile }).output, 'flag.md');
  assert.equal(resolveSettings({ env: { REVIEWBUDDY_OUTPUT: '' }, file: fromFile }).output, 'file.md');
});

test('resolveSettings takes each setting from the file over the defaults', () => {
  const s = resolveSettings({ file });
  assert.equal(s.provider, 'groq');
  assert.equal(s.providerSource, CONFIG_FILE);
  assert.equal(s.model, 'file-model');
  assert.deepEqual(s.failOn, ['security']);
  assert.equal(s.minSeverity, 'performance');
  assert.equal(s.timeoutMs, 30_000);
});

test('resolveSettings takes each setting from a variable over the file', () => {
  const env = {
    REVIEWBUDDY_PROVIDER: 'groq',
    GROQ_MODEL: 'env-model',
    REVIEWBUDDY_FAIL_ON: 'bug',
    REVIEWBUDDY_MIN_SEVERITY: 'Bug',
    REVIEWBUDDY_TIMEOUT: '45',
  };
  const s = resolveSettings({ env, file });
  assert.equal(s.providerSource, 'REVIEWBUDDY_PROVIDER');
  assert.equal(s.model, 'env-model');
  assert.deepEqual(s.failOn, ['bug']);
  assert.equal(s.minSeverity, 'bug');
  assert.equal(s.timeoutMs, 45_000);
});

test('resolveSettings takes each setting from a flag over the variable and the file', () => {
  const env = {
    REVIEWBUDDY_PROVIDER: 'gemini', REVIEWBUDDY_FAIL_ON: 'bug', REVIEWBUDDY_MIN_SEVERITY: 'bug', REVIEWBUDDY_TIMEOUT: '45',
  };
  const flags = {
    provider: 'anthropic', 'fail-on': 'performance', 'min-severity': 'suggestion', timeout: '0',
  };
  const s = resolveSettings({ flags, env, file });
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.providerSource, '--provider');
  assert.deepEqual(s.failOn, ['performance']);
  assert.equal(s.minSeverity, 'suggestion');
  assert.equal(s.timeoutMs, 0);
});

test('resolveSettings treats an empty variable as unset, as the action passes empty inputs', () => {
  const env = {
    REVIEWBUDDY_PROVIDER: '', GROQ_MODEL: '', REVIEWBUDDY_FAIL_ON: '', REVIEWBUDDY_MIN_SEVERITY: '', REVIEWBUDDY_TIMEOUT: '', REVIEWBUDDY_IGNORE: '',
  };
  const s = resolveSettings({ env, file });
  assert.equal(s.provider, 'groq');
  assert.equal(s.model, 'file-model');
  assert.deepEqual(s.failOn, ['security']);
  assert.equal(s.minSeverity, 'performance');
  assert.equal(s.timeoutMs, 30_000);
});

test('resolveSettings skips the file\'s model, with a warning, when another provider is selected', () => {
  const s = resolveSettings({ env: { REVIEWBUDDY_PROVIDER: 'Gemini' }, file });
  assert.equal(s.provider, 'Gemini');
  assert.equal(s.model, undefined);
  assert.match(warned(), /not using "model" from \.reviewbuddy\.json: it is for groq, but REVIEWBUDDY_PROVIDER selects gemini\./);
  // The same provider named by a flag keeps it.
  assert.equal(resolveSettings({ flags: { provider: 'GROQ' }, file }).model, 'file-model');
});

test('resolveSettings names the source of a bad value', () => {
  assert.throws(() => resolveSettings({ env: { REVIEWBUDDY_FAIL_ON: 'critical' } }), /Unknown severity "critical" in REVIEWBUDDY_FAIL_ON\./);
  assert.throws(() => resolveSettings({ flags: { 'min-severity': 'high' } }), /Unknown severity "high" in --min-severity\./);
  assert.throws(() => resolveSettings({ env: { REVIEWBUDDY_TIMEOUT: 'soon' } }), /Invalid timeout "soon" in REVIEWBUDDY_TIMEOUT/);
});

test('resolveSettings adds the file\'s ignore patterns to the defaults, the variable\'s and the flag\'s', () => {
  const s = resolveSettings({ flags: { ignore: 'from-flag/' }, env: { REVIEWBUDDY_IGNORE: 'from-env/, *.gen.ts' }, file });
  assert.deepEqual(s.ignorePatterns, [...DEFAULT_IGNORE, 'from-file/', 'from-env/', '*.gen.ts', 'from-flag/']);
});

test('resolveSettings drops the default patterns for defaultIgnore: false or --no-default-ignore', () => {
  const off = parseConfig('{"defaultIgnore": false, "ignore": ["from-file/"]}');
  assert.deepEqual(resolveSettings({ file: off, flags: { ignore: 'from-flag/' } }).ignorePatterns, ['from-file/', 'from-flag/']);
  assert.deepEqual(resolveSettings({ file, flags: { 'no-default-ignore': true } }).ignorePatterns, ['from-file/']);
  assert.equal(resolveSettings({ file: parseConfig('{"defaultIgnore": true}') }).defaultIgnore, true);
});

// Finding the files locally

test('findLocalConfig walks up from a subdirectory to the git root', async () => {
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, 'packages', 'web'), { recursive: true });
  await writeFile(join(dir, CONFIG_FILE), '{"minSeverity": "bug"}');
  await writeFile(join(dir, 'packages', RULES_FILE), '- Money is integer cents.');

  const found = await findLocalConfig(join(dir, 'packages', 'web'));

  assert.deepEqual(found, {
    [CONFIG_FILE]: { text: '{"minSeverity": "bug"}', label: join(dir, CONFIG_FILE) },
    [RULES_FILE]: { text: '- Money is integer cents.', label: join(dir, 'packages', RULES_FILE) },
  });
});

test('findLocalConfig prefers the nearest file', async () => {
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, CONFIG_FILE), '{"minSeverity": "bug"}');
  await writeFile(join(dir, 'sub', CONFIG_FILE), '{"minSeverity": "security"}');

  const found = await findLocalConfig(join(dir, 'sub'));

  assert.equal(found[CONFIG_FILE].label, join(dir, 'sub', CONFIG_FILE));
});

test('findLocalConfig never looks above the git root', async () => {
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, '.git'), 'gitdir: ../elsewhere\n');
  await writeFile(join(dir, CONFIG_FILE), '{"minSeverity": "bug"}');

  assert.deepEqual(await findLocalConfig(join(repo, 'src')), {});
});

test('findLocalConfig checks only the directory itself outside a git repo', async () => {
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, CONFIG_FILE), '{"minSeverity": "bug"}');

  assert.deepEqual(await findLocalConfig(join(dir, 'sub')), {});
  assert.deepEqual(Object.keys(await findLocalConfig(dir)), [CONFIG_FILE]);
});

test('loadConfig parses what was found and says where it came from', () => {
  const loaded = loadConfig({
    [CONFIG_FILE]: { text: '{"failOn": ["bug"]}', label: '/repo/.reviewbuddy.json' },
    [RULES_FILE]: { text: '- Log with logger.error.\n', label: '/repo/.reviewbuddy.md' },
  });
  assert.deepEqual(loaded, {
    file: { failOn: ['bug'] },
    rules: '- Log with logger.error.',
    summary: 'Config: /repo/.reviewbuddy.json, /repo/.reviewbuddy.md',
  });
  assert.deepEqual(loadConfig({}), { file: {}, rules: undefined, summary: null });
});

test('loadConfig names the file and where it came from in errors', () => {
  assert.throws(
    () => loadConfig({ [CONFIG_FILE]: { text: '{', label: '.reviewbuddy.json (base branch main @ bbb2222)' } }),
    /Invalid JSON in \.reviewbuddy\.json \(base branch main @ bbb2222\)/,
  );
});

// Fetching the files for a PR

const pr = { owner: 'o', repo: 'r', number: 1 };
const base = { sha: 'bbb2222ccc0', ref: 'main' };

test('loadRemoteConfig fetches both files at the base commit', async () => {
  const urls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return url.includes('.json') ? new Response('{"minSeverity": "bug"}') : Response.json({ message: 'Not Found' }, { status: 404 });
  });

  const found = await loadRemoteConfig(pr, 'tok', base);

  assert.deepEqual(urls, [
    'https://api.github.com/repos/o/r/contents/.reviewbuddy.json?ref=bbb2222ccc0',
    'https://api.github.com/repos/o/r/contents/.reviewbuddy.md?ref=bbb2222ccc0',
  ]);
  assert.deepEqual(found, {
    [CONFIG_FILE]: { text: '{"minSeverity": "bug"}', label: '.reviewbuddy.json (base branch main @ bbb2222)' },
  });
});

test('loadRemoteConfig fails on a 403, with a hint, rather than reviewing without the repo\'s config', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }));
  await assert.rejects(
    loadRemoteConfig(pr, 'tok', base),
    /Could not read \.reviewbuddy\.json from the base branch main @ bbb2222: GitHub returned HTTP 403[^]*The token needs "Contents: Read"\. Pass --no-config/,
  );
});

test('the example files in examples/ are valid', async () => {
  const examples = new URL('../examples/', import.meta.url);
  const file = parseConfig(await readFile(new URL(CONFIG_FILE, examples), 'utf8'), 'examples/.reviewbuddy.json');
  assert.equal(file.provider, 'groq');
  const rules = parseRules(await readFile(new URL(RULES_FILE, examples), 'utf8'));
  assert.match(rules, /db\.query\(sql, params\)/);
  assert.match(rules, /logger\.error/);
  assert.equal(console.warn.mock.callCount(), 0);
});

// Concurrency and limits for large pull requests

test('parseConfig reads concurrency, maxFiles and maxChunksPerFile as whole numbers', () => {
  assert.deepEqual(parseConfig('{"concurrency": 3, "maxFiles": 100, "maxChunksPerFile": 0}'), { concurrency: 3, maxFiles: 100, maxChunksPerFile: 0 });
  assert.throws(() => parseConfig('{"concurrency": 0}'), /"concurrency" in \.reviewbuddy\.json must be a whole number from 1 to 16\./);
  assert.throws(() => parseConfig('{"concurrency": 17}'), /from 1 to 16/);
  assert.throws(() => parseConfig('{"concurrency": "4"}'), /"concurrency" .* must be a whole number/);
  assert.throws(() => parseConfig('{"maxFiles": 2.5}'), /"maxFiles" .* must be a whole number of at least 0\./);
  assert.throws(() => parseConfig('{"maxChunksPerFile": -1}'), /"maxChunksPerFile" .* must be a whole number of at least 0\./);
});

test('parseCount accepts whole numbers in range and names the source otherwise', () => {
  assert.equal(parseCount(' 4 ', '--concurrency', { min: 1, max: MAX_CONCURRENCY }), 4);
  assert.equal(parseCount('0', '--max-files'), 0);
  for (const bad of ['0', '17', '2.5', '-1', 'four', '']) {
    assert.throws(() => parseCount(bad, '--concurrency', { min: 1, max: 16 }), /Invalid value ".*" in --concurrency: give a whole number from 1 to 16\./);
  }
});

test('resolveSettings: concurrency and the limits come from a flag, then a variable, then the file, then the default', () => {
  const file = { concurrency: 2, maxFiles: 50, maxChunksPerFile: 5 };
  assert.deepEqual(pick(resolveSettings({})), { concurrency: undefined, maxFiles: 0, maxChunksPerFile: DEFAULT_MAX_CHUNKS_PER_FILE });
  assert.deepEqual(pick(resolveSettings({ file })), file);
  const env = { REVIEWBUDDY_CONCURRENCY: '3', REVIEWBUDDY_MAX_FILES: '60', REVIEWBUDDY_MAX_CHUNKS_PER_FILE: '0' };
  assert.deepEqual(pick(resolveSettings({ env, file })), { concurrency: 3, maxFiles: 60, maxChunksPerFile: 0 });
  const flags = { concurrency: '8', 'max-files': '70', 'max-chunks-per-file': '2' };
  assert.deepEqual(pick(resolveSettings({ flags, env, file })), { concurrency: 8, maxFiles: 70, maxChunksPerFile: 2 });
  // An empty action input counts as unset.
  assert.equal(resolveSettings({ env: { REVIEWBUDDY_CONCURRENCY: '' }, file }).concurrency, 2);
  assert.throws(() => resolveSettings({ env: { REVIEWBUDDY_CONCURRENCY: '99' } }), /in REVIEWBUDDY_CONCURRENCY: give a whole number from 1 to 16/);
});

function pick({ concurrency, maxFiles, maxChunksPerFile }) {
  return { concurrency, maxFiles, maxChunksPerFile };
}
