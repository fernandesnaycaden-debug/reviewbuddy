import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  checkRev, diffArgs, gitDiff, gitShow, runGit,
} from '../src/git.js';
import { findRevConfig } from '../src/config.js';
import { main } from '../src/index.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const needsGit = { skip: hasGit ? false : 'git is not installed' };

let dir;
let exitCode;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-git-'));
  exitCode = process.exitCode;
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});
afterEach(async () => {
  mock.restoreAll();
  process.exitCode = exitCode;
  await rm(dir, { recursive: true, force: true });
});

// Arguments and validation

const COMMON = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

test('diffArgs builds the git diff for each mode, ending with "--"', () => {
  assert.deepEqual(diffArgs('staged'), [...COMMON, '--cached', '--']);
  assert.deepEqual(diffArgs('uncommitted'), [...COMMON, 'HEAD', '--']);
  assert.deepEqual(diffArgs('branch', 'main'), [...COMMON, 'main...HEAD', '--']);
  assert.deepEqual(diffArgs('since', 'abc1234'), [...COMMON, 'abc1234', 'HEAD', '--']);
});

test('checkRev rejects a revision that git would read as an option, or none at all', () => {
  assert.doesNotThrow(() => checkRev('main', '--branch'));
  assert.doesNotThrow(() => checkRev('HEAD~3', '--since'));
  assert.throws(() => checkRev('-x', '--since'), /--since "-x" is not a revision: it can't start with "-"\./);
  assert.throws(() => checkRev('--output=/tmp/x', '--branch'), /can't start with "-"/);
  assert.throws(() => checkRev('', '--branch'), /--branch needs a branch, tag or commit/);
  assert.throws(() => checkRev(undefined, '--since'), /--since needs a branch, tag or commit/);
});

test('main rejects an option-like revision before running git', async () => {
  await assert.rejects(main(['--since=-p']), /--since "-p" is not a revision/);
  await assert.rejects(main(['--branch=--output=x']), /--branch "--output=x" is not a revision/);
});

test('main takes only one thing to review', async () => {
  for (const args of [['--staged', '--uncommitted'], ['--staged', 'changes.diff'], ['--branch', 'main', '--since', 'HEAD~1'], ['-', 'changes.diff']]) {
    await assert.rejects(main(args), /Review one thing at a time/, args.join(' '));
  }
});

// Errors, with execFile replaced

/** An exec that fails the way execFile does: with code and stderr. */
function failing(fields) {
  return async () => {
    throw Object.assign(new Error('Command failed'), fields);
  };
}

test('runGit runs git without a shell, in cwd, with a large buffer and utf8 output', async () => {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: 'out' };
  };
  assert.equal(await runGit(['status'], 'some/dir', { exec }), 'out');
  assert.equal(calls[0].file, 'git');
  assert.deepEqual(calls[0].args, ['status']);
  assert.equal(calls[0].options.cwd, 'some/dir');
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.equal(calls[0].options.shell, undefined);
  assert.ok(calls[0].options.maxBuffer >= 64 * 1024 * 1024);
});

test('runGit explains a missing git, a directory outside a repo, and an unknown revision', async () => {
  await assert.rejects(runGit(['diff'], '.', { exec: failing({ code: 'ENOENT' }) }), /git isn't installed, or isn't on PATH/);
  await assert.rejects(
    runGit(['diff'], dir, { exec: failing({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }) }),
    /is not inside a git repository\. Run reviewbuddy there, or pass --repo-dir/,
  );
  await assert.rejects(
    runGit(['diff'], '.', { exec: failing({ code: 128, stderr: "fatal: bad revision 'nope...HEAD'\n" }), rev: 'nope' }),
    /git doesn't know the revision "nope"\. Check the branch, tag or commit name/,
  );
  await assert.rejects(
    runGit(['diff'], '.', { exec: failing({ code: 128, stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n" }) }),
    /git doesn't know the revision "HEAD"\. Does the repository have a commit yet\?/,
  );
  await assert.rejects(runGit(['diff'], '.', { exec: failing({ code: 1, stderr: '\nfatal: something odd\n' }) }), /^Error: git failed: fatal: something odd$/);
});

/** An exec answering rev-parse with root and diff with diffText, recording each call's args and cwd. */
function fakeRepo(root, diffText) {
  const calls = [];
  const exec = async (file, args, { cwd }) => {
    calls.push({ args, cwd });
    return { stdout: args[0] === 'rev-parse' ? `${root}\n` : diffText };
  };
  return { calls, exec };
}

test('gitDiff runs the diff at the repo\'s top level and labels it', async () => {
  const { calls, exec } = fakeRepo(dir, 'diff --git a/x b/x\n');
  const got = await gitDiff({ mode: 'branch', rev: 'main' }, join(dir, 'sub'), { exec });
  assert.deepEqual(calls[0], { args: ['rev-parse', '--show-toplevel'], cwd: join(dir, 'sub') });
  assert.deepEqual(calls[1], { args: diffArgs('branch', 'main'), cwd: dir });
  assert.equal(got.root, dir);
  assert.equal(got.label, 'changes on this branch since main');
  assert.equal(got.spec, 'HEAD:');
});

test('gitDiff says there is nothing to review when the diff is empty', async () => {
  const cases = [
    [{ mode: 'staged' }, /^Error: Nothing to review: no staged changes\. Stage some with git add/],
    [{ mode: 'uncommitted' }, /Nothing to review: no uncommitted changes to tracked files/],
    [{ mode: 'branch', rev: 'main' }, /Nothing to review: no commits on this branch since main\./],
    [{ mode: 'since', rev: 'v1.0' }, /Nothing to review: no committed changes since v1\.0\./],
  ];
  for (const [selection, error] of cases) {
    await assert.rejects(gitDiff(selection, dir, fakeRepo(dir, '\n')), error);
  }
});

test('gitShow reads the file at a spec, and gives null quietly when it isn\'t there', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    return { stdout: 'text' };
  };
  assert.equal(await gitShow(dir, ':0:', 'src/a.js', { exec }), 'text');
  assert.deepEqual(calls[0], ['cat-file', 'blob', ':0:src/a.js']);
  assert.equal(await gitShow(dir, 'HEAD:', 'new.js', { exec: failing({ code: 128, stderr: "fatal: path 'new.js' does not exist in 'HEAD'\n" }) }), null);
  assert.equal(console.warn.mock.callCount(), 0);
});

// A real repository

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

const BASE = 'const a = 1;\nexport { a };\n';

/** A repo with src/a.js committed on main. Returns its path. */
async function makeRepo() {
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'src', 'a.js'), BASE);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

/** Replace src/a.js with BASE plus an added line. */
function edit(repo, line) {
  return writeFile(join(repo, 'src', 'a.js'), `const a = 1;\n${line}\nexport { a };\n`);
}

/** Mock Ollama with no findings and return the prompts it got. */
function fakeOllama() {
  const prompts = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    prompts.push(JSON.parse(init.body).messages.at(-1).content);
    const text = JSON.stringify({ comments: [] });
    return new Response(`${JSON.stringify({ message: { content: text }, done: true })}\n`);
  });
  return prompts;
}

/** Run main against a mocked Ollama with clean environment variables. */
async function review(args, { config = false } = {}) {
  const vars = {
    OLLAMA_URL: 'http://ollama.test', REVIEWBUDDY_PROVIDER: '', REVIEWBUDDY_FORMAT: '', REVIEWBUDDY_FAIL_ON: '', REVIEWBUDDY_MIN_SEVERITY: '', GITHUB_ACTIONS: '',
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    const prompts = fakeOllama();
    await main(config ? args : [...args, '--no-config']);
    return prompts;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The FULL FILE section of a prompt, or '' if there is none. */
function fullFile(prompt) {
  return prompt.match(/=== FULL FILE[^]*?=== END OF REFERENCE ===/)?.[0] ?? '';
}

test('--staged reviews the index, with the staged version of the file as context', needsGit, async () => {
  const repo = await makeRepo();
  await edit(repo, "const s = 'staged';");
  git(repo, 'add', 'src/a.js');
  await writeFile(join(repo, 'src', 'a.js'), `const a = 1;\nconst s = 'staged';\nconst w = 'working';\nexport { a };\n`);

  const [prompt] = await review(['--staged', '--repo-dir', repo]);

  assert.match(prompt, /^\s+2 \+const s = 'staged';$/m);
  assert.doesNotMatch(prompt, /\+const w/);
  assert.match(fullFile(prompt), /const s = 'staged';/);
  assert.doesNotMatch(fullFile(prompt), /working/);
});

test('--uncommitted reviews staged and unstaged changes, with the working tree as context', needsGit, async () => {
  const repo = await makeRepo();
  await edit(repo, "const s = 'staged';");
  git(repo, 'add', 'src/a.js');
  await writeFile(join(repo, 'src', 'a.js'), `const a = 1;\nconst s = 'staged';\nconst w = 'working';\nexport { a };\n`);

  const [prompt] = await review(['--uncommitted', '--repo-dir', repo]);

  assert.match(prompt, /\+const s = 'staged';/);
  assert.match(prompt, /\+const w = 'working';/);
  assert.match(fullFile(prompt), /const w = 'working';/);
});

test('--branch and --since review commits only, with HEAD as context', needsGit, async () => {
  const repo = await makeRepo();
  git(repo, 'checkout', '-q', '-b', 'feature');
  await edit(repo, "const f = 'feature';");
  git(repo, 'commit', '-q', '-am', 'feature');
  // Uncommitted work is left out of both, and doesn't spoil the context.
  await writeFile(join(repo, 'src', 'a.js'), 'dirty\n');

  for (const args of [['--branch', 'main'], ['--since', 'HEAD~1']]) {
    const [prompt] = await review([...args, '--repo-dir', repo]);
    assert.match(prompt, /\+const f = 'feature';/, args.join(' '));
    assert.doesNotMatch(prompt, /dirty/, args.join(' '));
    assert.match(fullFile(prompt), /const f = 'feature';/, args.join(' '));
  }
});

test('--branch and --since read the config from the revision given, not the checked-out branch', needsGit, async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, '.reviewbuddy.json'), '{"minSeverity": "bug"}');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'config');
  git(repo, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(repo, '.reviewbuddy.json'), '{"ignore": ["**"], "output": "../pwned.md"}');
  await edit(repo, "const f = 'feature';");
  git(repo, 'commit', '-q', '-am', 'feature');

  assert.deepEqual(await findRevConfig('main', join(repo, 'src')), {
    '.reviewbuddy.json': { text: '{"minSeverity": "bug"}', label: '.reviewbuddy.json (main)' },
  });
  // The feature branch's config would ignore every file; main's doesn't, so src/a.js is reviewed.
  const prompts = await review(['--branch', 'main', '--repo-dir', repo], { config: true });
  assert.ok(prompts.some((p) => /\+const f = 'feature';/.test(p)));
  assert.match(console.log.mock.calls.map((c) => c.arguments.join(' ')).join('\n'), /Config: \.reviewbuddy\.json \(main\)/);
  assert.ok(!existsSync(join(process.cwd(), '..', 'pwned.md')));
});

test('git modes find the repo root from a subdirectory', needsGit, async () => {
  const repo = await makeRepo();
  await edit(repo, "const s = 'staged';");
  git(repo, 'add', 'src/a.js');

  const [prompt] = await review(['--staged', '--repo-dir', join(repo, 'src')]);

  assert.match(prompt, /^File: src\/a\.js$/m);
  assert.match(fullFile(prompt), /const s = 'staged';/);
});

test('a real repo: nothing staged, and an unknown revision', needsGit, async () => {
  const repo = await makeRepo();
  await assert.rejects(review(['--staged', '--repo-dir', repo]), /Nothing to review: no staged changes/);
  await assert.rejects(review(['--branch', 'no-such-branch', '--repo-dir', repo]), /git doesn't know the revision "no-such-branch"/);
  await assert.rejects(review(['--since', 'no-such-commit', '--repo-dir', repo]), /git doesn't know the revision "no-such-commit"/);
});
