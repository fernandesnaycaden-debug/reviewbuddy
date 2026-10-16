// Review local git changes without a diff file: run `git diff` for the chosen mode, and read each
// changed file's matching version (index, HEAD or working tree) for full-file context.

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// A big branch diff can be many megabytes; Node's default 1 MiB would cut it off.
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * What each mode diffs, and where its changed files' new versions are: git's spec for
 * `git cat-file` (':0:' the index, 'HEAD:' the last commit), or null for the working tree.
 * takesRev: the flag is given a branch, tag or commit.
 */
export const GIT_MODES = {
  staged: { flag: '--staged', args: () => ['--cached'], spec: ':0:' },
  uncommitted: { flag: '--uncommitted', args: () => ['HEAD'], spec: null },
  branch: {
    flag: '--branch', args: (rev) => [`${rev}...HEAD`], spec: 'HEAD:', takesRev: true,
  },
  since: {
    flag: '--since', args: (rev) => [rev, 'HEAD'], spec: 'HEAD:', takesRev: true,
  },
};

/** Throw unless rev can be passed to git safely: one starting with "-" would be read as an option. */
export function checkRev(rev, flag) {
  if (typeof rev !== 'string' || !rev.trim()) throw new Error(`${flag} needs a branch, tag or commit, like ${flag} main.`);
  if (rev.startsWith('-')) throw new Error(`${flag} "${rev}" is not a revision: it can't start with "-".`);
}

/**
 * The arguments for `git diff` in a mode. Prefixes are set explicitly, since diff.noprefix or
 * diff.mnemonicPrefix would break reading file names; quotepath=off keeps non-ASCII names readable.
 * The final "--" keeps a revision from being taken for a path.
 */
export function diffArgs(mode, rev) {
  return [
    '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', ...GIT_MODES[mode].args(rev), '--',
  ];
}

/**
 * Run git (no shell) in cwd and return its stdout. exec replaces execFile in tests.
 * rev names the revision in an "unknown revision" error.
 */
export async function runGit(args, cwd, { exec = run, rev = 'HEAD' } = {}) {
  try {
    const { stdout } = await exec('git', args, {
      cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true,
    });
    return stdout;
  } catch (err) {
    // stderr stays on the error, for callers that expect some failures.
    throw Object.assign(gitError(err, cwd, rev), { stderr: String(err.stderr ?? '') });
  }
}

/** A clear error for a failed git command. */
function gitError(err, cwd, rev) {
  if (err.code === 'ENOENT') return new Error('git isn\'t installed, or isn\'t on PATH. Install it from https://git-scm.com/, or review a diff file instead.');
  const stderr = String(err.stderr ?? '');
  if (/not a git repository/i.test(stderr)) {
    return new Error(`${resolve(cwd)} is not inside a git repository. Run reviewbuddy there, or pass --repo-dir <path to the repo>.`);
  }
  if (/bad revision|unknown revision|ambiguous argument|(?:not a valid|invalid) object name|no merge base/i.test(stderr)) {
    const hint = rev === 'HEAD' ? ' Does the repository have a commit yet?' : ' Check the branch, tag or commit name (git log --oneline shows commits).';
    return new Error(`git doesn't know the revision "${rev}".${hint}`);
  }
  const first = stderr.split(/\r?\n/).find((line) => line.trim()) ?? err.message;
  return new Error(`git failed: ${first.trim()}`);
}

/**
 * The diff for a mode ({ mode, rev }) in the repo holding dir: { diff, root, label, spec }.
 * root is the repo's top level, which the diff's paths are relative to. An empty diff is an error.
 */
export async function gitDiff({ mode, rev }, dir, { exec } = {}) {
  const root = resolve((await runGit(['rev-parse', '--show-toplevel'], dir, { exec })).trim());
  const diff = await runGit(diffArgs(mode, rev), root, { exec, rev: rev ?? 'HEAD' });
  if (!diff.trim()) throw new Error(`Nothing to review: ${emptyHint(mode, rev)}`);
  return {
    diff, root, label: labelFor(mode, rev), spec: GIT_MODES[mode].spec,
  };
}

/** How to describe a mode's changes in progress output. */
function labelFor(mode, rev) {
  return {
    staged: 'staged changes',
    uncommitted: 'uncommitted changes',
    branch: `changes on this branch since ${rev}`,
    since: `changes since ${rev}`,
  }[mode];
}

function emptyHint(mode, rev) {
  return {
    staged: 'no staged changes. Stage some with git add, or use --uncommitted.',
    uncommitted: 'no uncommitted changes to tracked files. New files show up once you git add them (or git add -N).',
    branch: `no commits on this branch since ${rev}.`,
    since: `no committed changes since ${rev}. For uncommitted work, use --uncommitted.`,
  }[mode];
}

/**
 * A file's text as git has it at spec (':0:' the index, 'HEAD:' the last commit), or null if it
 * isn't there. path is relative to root, as in the diff.
 */
export async function gitShow(root, spec, path, { exec } = {}) {
  try {
    return await runGit(['cat-file', 'blob', `${spec}${path}`], root, { exec });
  } catch (err) {
    // A file added in the working tree but not staged, or deleted since: no version at spec.
    if (!/does not exist|exists on disk|(?:not a valid|invalid) object name/i.test(err.stderr)) console.warn(`  Could not read ${path} from git for context (${err.message}), reviewing the diff alone.`);
    return null;
  }
}
