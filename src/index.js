import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  annotationsFor, appendStepSummary, inActions, isForkPullRequest, warning,
} from './actions.js';
import {
  dropPosted, findingKey, latestMarkedReview, markerFor, openFindings, parseMarker, postedKeys,
} from './dedupe.js';
import {
  commentableLines, decodeDiff, filesFromApi, splitDiff,
} from './diff.js';
import {
  checkRev, GIT_MODES, gitDiff, gitShow,
} from './git.js';
import {
  getCompareDiff, getCompareFiles, getFileContent, getPullRequest, getPullRequestDiff, listPullRequestFiles,
  listReviewComments, listReviews, MAX_COMPARE_FILES, MAX_PR_FILES, parsePrUrl, postReview,
} from './github.js';
import {
  findLocalConfig, loadConfig, loadRemoteConfig, resolveSettings,
} from './config.js';
import { isIgnored } from './ignore.js';
import { capInlineComments, MAX_INLINE_COMMENTS, selectFiles } from './limits.js';
import {
  buffered, flush, info, logToStderr, warn,
} from './log.js';
import { formatJson, formatSarif, outputFormat } from './output.js';
import { mapPool } from './pool.js';
import { defaultConcurrency, describe as describeProvider, useProvider } from './providers/index.js';
import { atLeast, reviewDiff } from './review.js';

const SAMPLE_DIFF = fileURLToPath(new URL('../samples/buggy.diff', import.meta.url));

export { parseFailOn, parseMinSeverity } from './config.js';

/** Run the CLI with the given arguments (process.argv without node and the script). */
export async function main(argv) {
  try {
    await run(argv);
  } finally {
    // Tests call main again in the same process.
    logToStderr(false);
  }
}

async function run(argv) {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    options: {
      branch: { type: 'string' },
      concurrency: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'fail-on': { type: 'string' },
      format: { type: 'string' },
      full: { type: 'boolean', default: false },
      ignore: { type: 'string' },
      'max-chunks-per-file': { type: 'string' },
      'max-files': { type: 'string' },
      'min-severity': { type: 'string' },
      'no-config': { type: 'boolean', default: false },
      'no-default-ignore': { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
      provider: { type: 'string' },
      'repo-dir': { type: 'string' },
      since: { type: 'string' },
      staged: { type: 'boolean' },
      timeout: { type: 'string' },
      uncommitted: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const input = selectInput(flags, positionals);
  const { pr } = input;
  const repoDir = flags['repo-dir'];
  if (repoDir !== undefined && !(await stat(repoDir).catch(() => null))?.isDirectory()) {
    throw new Error(`--repo-dir ${repoDir} is not a directory.`);
  }

  // Check flags and variables now, before any request. A provider they name wins over the
  // repo's config, so an unknown one or a missing API key fails here too.
  const early = resolveSettings({ flags, env: process.env });
  routeLogs(early.format, early.output);
  if (early.providerSource !== 'default' && await selectProvider(early.provider) === SKIPPED) return;

  const token = process.env.GITHUB_TOKEN;
  let details;
  if (pr) {
    // Fail now rather than after several minutes of model calls.
    if (!token && !flags['dry-run']) {
      throw new Error('Set GITHUB_TOKEN to post a review, or pass --dry-run to only print it.');
    }
    details = await getPullRequest(pr, token);
  }
  const config = await repoConfig(flags['no-config'], pr, token, details, repoDir);
  const settings = resolveSettings({ flags, env: process.env, file: config.file });
  // The repo's config can set the format too.
  routeLogs(settings.format, settings.output);
  if (config.summary) info(config.summary);

  const { failOn, minSeverity } = settings;
  const format = outputFormat(settings.format, settings.output);
  const unreachable = failOn.filter((s) => !atLeast(s, minSeverity));
  if (unreachable.length > 0) {
    warn(`Warning: --fail-on ${unreachable.join(',')} has no effect with --min-severity ${minSeverity}, which leaves those findings out.`);
  }
  const used = await selectProvider(settings.provider, settings.model);
  if (used === SKIPPED) return;
  info(`Using ${used.provider} (${used.model})\n`);

  const options = {
    dryRun: flags['dry-run'],
    failOn,
    full: flags.full,
    minSeverity,
    repoDir,
    timeoutMs: settings.timeoutMs,
    ignorePatterns: settings.ignorePatterns,
    rules: config.rules,
    concurrency: settings.concurrency ?? defaultConcurrency(),
    maxFiles: settings.maxFiles,
    maxChunksPerFile: settings.maxChunksPerFile,
  };

  const {
    results, findings, seconds, notReviewed,
  } = pr
    ? await reviewPullRequest(pr, token, details, options)
    : await reviewLocal(input, options);
  await writeOutput(results, {
    format, output: settings.output, seconds, notReviewed,
  });
  checkFailOn(findings, failOn);
  checkFailed(notReviewed);
}

const ONE_INPUT = 'Review one thing at a time: pass only one of --staged, --uncommitted, --branch <base>, --since <rev>, a diff file, a PR URL or - (stdin).';

/**
 * What to review, from the git flags and the positional target:
 * { kind: 'git', mode, rev }, { kind: 'stdin' }, { kind: 'pr', pr } or { kind: 'file', path }.
 * Without any, the sample diff.
 */
export function selectInput(flags, positionals) {
  const modes = Object.keys(GIT_MODES).filter((m) => flags[m] !== undefined && flags[m] !== false);
  if (positionals.length > 1 || modes.length + positionals.length > 1) throw new Error(ONE_INPUT);
  if (modes.length === 1) {
    const [mode] = modes;
    if (!GIT_MODES[mode].takesRev) return { kind: 'git', mode };
    checkRev(flags[mode], GIT_MODES[mode].flag);
    return { kind: 'git', mode, rev: flags[mode] };
  }
  const target = positionals[0] || SAMPLE_DIFF;
  if (target === '-') return { kind: 'stdin' };
  const pr = parsePrUrl(target);
  return pr ? { kind: 'pr', pr } : { kind: 'file', path: target };
}

/** Send progress to stderr when a JSON or SARIF document goes to stdout, so stdout holds only that. */
function routeLogs(format, output) {
  logToStderr(!output && (format === 'json' || format === 'sarif'));
}

const SKIPPED = Symbol('skipped');

/**
 * Select the provider and model, or throw if that's impossible: an unknown name, a missing API key,
 * Ollama on a GitHub-hosted runner. Returns describe(), or SKIPPED for a fork PR without a key.
 */
async function selectProvider(name, model) {
  let used;
  try {
    used = useProvider(name, { model });
  } catch (err) {
    if (await skipWithoutKey(err)) return SKIPPED;
    throw err;
  }
  if (used.provider === 'ollama' && inActions() && !process.env.OLLAMA_URL) {
    throw new Error('Ollama doesn\'t run on GitHub-hosted runners. Set the provider input to groq, openrouter, gemini or anthropic and pass its API key, or set OLLAMA_URL to a server the runner can reach.');
  }
  return used;
}

/**
 * The reviewed repo's .reviewbuddy.json and .reviewbuddy.md, parsed (see loadConfig).
 * For a PR they come from its base commit, not its head (see loadRemoteConfig for why);
 * for a diff file from repoDir or the current directory, or a parent up to the git root.
 */
async function repoConfig(skip, pr, token, details, repoDir) {
  if (skip) return { file: {}, rules: undefined, summary: null };
  const found = pr ? await loadRemoteConfig(pr, token, details.base) : await findLocalConfig(repoDir ?? '.');
  return loadConfig(found);
}

/**
 * Set the exit code to 1 if a finding ([{ filename, line, severity }]) has a severity in failOn.
 * Not process.exit(): see bin/reviewbuddy.js.
 */
function checkFailOn(findings, failOn) {
  const failing = new Set(findings
    .filter((f) => failOn.includes(f.severity))
    .map((f) => findingKey(f.filename, f.line, f.severity)));
  if (failing.size === 0) return;
  info(`\nFailing: ${plural(failing.size, 'finding')} match --fail-on ${failOn.join(',')}.`);
  process.exitCode = 1;
}

/** Set the exit code to 1 if a file could not be reviewed (see reviewFiles): the review is incomplete. */
function checkFailed(notReviewed) {
  const failed = notReviewed.filter((n) => n.failed);
  if (failed.length === 0) return;
  info(`\nIncomplete: ${plural(failed.length, 'file')} could not be reviewed (${failed.map((n) => n.filename).join(', ')}).`);
  process.exitCode = 1;
}

/**
 * A fork PR's workflow gets no secrets, so in Actions a missing API key there skips the review
 * with a warning: returns true. Elsewhere it adds a hint to the error and returns false.
 */
async function skipWithoutKey(err) {
  if (err.code !== 'MISSING_API_KEY' || !inActions()) return false;
  if (await isForkPullRequest()) {
    const message = 'Skipping the review: GitHub doesn\'t pass secrets to workflows on pull requests from forks, so there is no API key. A maintainer can review this PR with the reviewbuddy CLI instead.';
    warning(message);
    await appendStepSummary(`reviewbuddy: ${message}`);
    return true;
  }
  err.message += '\nIn GitHub Actions, add the key as a repository secret (Settings → Secrets and variables → Actions) and pass it to the action as api-key.';
  return false;
}

/** [{ filename, line, severity }] for every finding in results. */
function flatFindings(results) {
  return results.flatMap((r) => r.comments.map((c) => ({ filename: r.filename, line: c.line, severity: c.severity })));
}

/**
 * Review a diff file, stdin or local git changes (input: see selectInput).
 * Returns { results, findings (for --fail-on), seconds, notReviewed (see reviewFiles) }.
 */
async function reviewLocal(input, options) {
  const { text, label, loadSource } = await localInput(input, options.repoDir);
  const all = reviewable(splitDiff(text), options);
  if (all.length === 0) {
    info(`Nothing to review in ${label}.`);
    await appendStepSummary(`reviewbuddy: nothing to review in ${label}.`);
    return {
      results: [], findings: [], seconds: '0.0', notReviewed: [],
    };
  }
  const { files, notReviewed } = limitFiles(all, options);
  const reviewed = await reviewFiles(files, options, loadSource, notReviewed);
  return { ...reviewed, findings: flatFindings(reviewed.results) };
}

/**
 * The diff to review, a label for it, and where to read changed files for context.
 * Git modes read each file's version from the same place the diff's new side comes from
 * (the index for --staged, HEAD for --branch and --since, the working tree for --uncommitted),
 * relative to the repo's top level. Diff files and stdin read the working tree under repoDir.
 */
async function localInput(input, repoDir) {
  if (input.kind === 'git') {
    const {
      diff, root, label, spec,
    } = await gitDiff(input, repoDir ?? '.');
    info(`Reviewing ${label} in ${root}\n`);
    const read = spec ? (path, filename) => gitShow(root, spec, filename) : undefined;
    return { text: diff, label, loadSource: localSource(root, read) };
  }
  if (input.kind === 'stdin') return { text: await readStdin(), label: 'stdin', loadSource: localSource(repoDir) };
  return { text: decodeDiff(await readFile(input.path)), label: input.path, loadSource: localSource(repoDir) };
}

/** A diff piped in on stdin (a "-" target), decoded like a diff file. */
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) {
    throw new Error('No diff on stdin. Pipe one in, like `git diff | reviewbuddy -`, or use --staged or --uncommitted instead of -.');
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return decodeDiff(Buffer.concat(chunks));
}

/** A file's text from the working tree, for context. */
function readWorkingTree(path) {
  return readFile(path, 'utf8');
}

/**
 * Read a changed file locally (under repoDir, else the current directory) for context:
 * read(path, filename) gives its text, from the working tree unless git says otherwise.
 * null if it isn't there, or if its path leads outside that directory: a crafted diff must not
 * get other local files sent to the model.
 */
function localSource(repoDir = '.', read = readWorkingTree) {
  const root = resolve(repoDir);
  return async (filename) => {
    const path = resolve(root, filename);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      warn(`  Not reading ${filename} for context: it is outside ${root}.`);
      return null;
    }
    try {
      return await read(path, filename);
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`  Could not read ${filename} for context (${err.message}), reviewing the diff alone.`);
      return null;
    }
  };
}

/** Fetch a changed file at the PR's head commit for context. null (with a warning) if that fails. */
function remoteSource(pr, token, sha) {
  return async (filename) => {
    try {
      return await getFileContent(pr, token, filename, sha);
    } catch (err) {
      const hint = err.status === 403 ? ' The token needs "Contents: Read" for this.' : '';
      warn(`  Could not fetch ${filename} for context (${err.message}), reviewing the diff alone.${hint}`);
      return null;
    }
  };
}

/**
 * Review a PR (details: its getPullRequest reply) and post the new findings. Returns { results, findings, seconds, notReviewed }:
 * results are this run's findings, including ones posted before (for --output and --format). findings are what
 * --fail-on judges: those, plus earlier inline findings whose lines haven't changed since.
 */
async function reviewPullRequest(pr, token, details, options) {
  const { head, base } = details;
  const reviews = await listReviews(pr, token);
  const ourReviews = new Set(reviews.filter((r) => parseMarker(r.body)).map((r) => r.id));
  // Inline comments from our earlier reviews, fetched at most once and only when needed.
  let ourComments;
  const listOurComments = async () => (ourComments ??= ourReviews.size > 0 ? await listReviewComments(pr, token) : []);
  const stillOpen = async () => (options.failOn.length > 0
    ? openFindings(await listOurComments(), ourReviews).filter((f) => atLeast(f.severity, options.minSeverity))
    : []);

  const previous = options.full ? null : latestMarkedReview(reviews);
  if (previous?.sha === head.sha) {
    info(`Already reviewed ${short(head.sha)}, nothing new`);
    await appendStepSummary(`reviewbuddy already reviewed \`${short(head.sha)}\`, nothing new.`);
    return {
      results: [], findings: await stillOpen(), seconds: '0.0', notReviewed: [],
    };
  }

  const listed = await pullRequestFiles(pr, token, details, options);
  const prFiles = listed.files;
  let candidates = prFiles;
  let { tooLarge } = listed;
  let since;
  if (previous) {
    const newer = await filesSince(pr, token, previous.sha, head.sha, listed);
    if (newer.files) {
      ({ files: candidates, tooLarge } = newer);
      since = short(previous.sha);
      info(`Reviewing changes since ${since}`);
    } else {
      info(newer.reason);
    }
  }
  const { files, notReviewed: skipped } = limitFiles(candidates, options);
  const notReviewed = [...tooLargeEntries(tooLarge, options), ...listed.notes, ...skipped];
  info(`Pull request ${pr.owner}/${pr.repo}#${pr.number}: ${files.length} file(s) to review\n`);

  const reviewed = files.length > 0
    ? await reviewFiles(files, options, remoteSource(pr, token, head.sha), notReviewed)
    : { results: [], seconds: '0.0', notReviewed: printNotReviewed(notReviewed) };
  let { results } = reviewed;
  // Judged before dropping repeats: a finding posted earlier is still in the code.
  const findings = [...flatFindings(results), ...await stillOpen()];
  // --output and --format get every finding of this run, posted before or not.
  const done = {
    results: reviewed.results, findings, seconds: reviewed.seconds, notReviewed: reviewed.notReviewed,
  };
  if (ourReviews.size > 0 && countIssues(results) > 0) {
    const dropped = dropPosted(results, postedKeys(await listOurComments(), ourReviews));
    results = dropped.results;
    info(`Skipped ${plural(dropped.skipped, 'finding')} already posted in an earlier review.`);
  }
  if (countIssues(results) === 0) {
    info('No new findings to post.');
    return done;
  }

  // GitHub only accepts inline comments on lines in the PR's own diff, not the compare diff.
  const prDiffs = new Map(prFiles.map((f) => [f.filename, f.diff]));
  // A file that failed must be tried again next run, so the marker keeps the commit this run started from.
  const incomplete = done.notReviewed.some((n) => n.failed);
  const review = buildReview(
    results.map((r) => ({ ...r, diff: prDiffs.get(r.filename) })),
    {
      commitId: head.sha,
      markerSha: incomplete ? previous?.sha ?? base.sha : head.sha,
      since,
      notReviewed: done.notReviewed,
      ...describeProvider(),
    },
  );

  if (options.dryRun) {
    info('Dry run, not posting. The review would be:\n');
    info(JSON.stringify(review, null, 2));
    return done;
  }
  let posted;
  try {
    posted = await postReview(pr, token, review);
  } catch (err) {
    // On a fork PR the workflow's token is read-only; the annotations and job summary still have the findings.
    if (err.status !== 403 || !inActions() || !await isForkPullRequest()) throw err;
    warning('Could not post the review: on pull requests from forks the GitHub token is read-only. The findings are in the job summary and the annotations.');
    return done;
  }
  info(`Posted review: ${posted.html_url}`);
  return done;
}

const TOO_LARGE = 'too large for the GitHub API';

/**
 * The PR's changed files as { files, tooLarge, notes }: files to review (the ignore list applied), names of
 * files GitHub sent no patch for, and notReviewed entries for files GitHub didn't list at all.
 * GitHub refuses the diff format (HTTP 406) for big PRs; then the files API gives the same files, page by page.
 */
async function pullRequestFiles(pr, token, details, options) {
  try {
    return { files: reviewable(splitDiff(await getPullRequestDiff(pr, token)), options), tooLarge: [], notes: [] };
  } catch (err) {
    if (err.status !== 406) throw err;
  }
  info('The diff is too large for GitHub\'s diff format, reading the changed files page by page instead.');
  const entries = await listPullRequestFiles(pr, token);
  const { files, tooLarge } = filesFromApi(entries);
  const notes = [];
  const unlisted = (details.changed_files ?? entries.length) - entries.length;
  if (unlisted > 0) {
    const reason = `GitHub's files API lists at most ${MAX_PR_FILES} files, so ${plural(unlisted, 'more changed file')} could not be reviewed.`;
    warn(`Warning: ${reason}`);
    notes.push({ filename: null, reason });
  }
  return { files: reviewable(files, options), tooLarge, notes };
}

/**
 * The PR's files narrowed to what changed between sha and head, as { files, tooLarge }, or { reason }
 * saying why the whole PR is reviewed instead: GitHub no longer has sha, or too much changed for its compare API.
 * Files the PR itself doesn't change (brought in by merging the base branch) are left out.
 * listed: pullRequestFiles' result.
 */
async function filesSince(pr, token, sha, head, listed) {
  const gone = { reason: `Previous review's commit ${short(sha)} no longer exists (force-push or rebase?), reviewing the whole PR.` };
  let files;
  let tooLarge = [];
  try {
    const diff = await getCompareDiff(pr, token, sha, head);
    if (diff === null) return gone;
    files = splitDiff(diff);
  } catch (err) {
    // 406: too large for the diff format. 5xx (after retries): GitHub timed out building it.
    if (err.status !== 406 && !(err.status >= 500)) throw err;
    info(`The changes since ${short(sha)} are too large for GitHub's diff format, reading the changed files instead.`);
    const entries = await getCompareFiles(pr, token, sha, head);
    if (entries === null) return gone;
    if (entries.length >= MAX_COMPARE_FILES) {
      return { reason: `Too many changes since ${short(sha)} for GitHub's compare API (it lists at most ${MAX_COMPARE_FILES} files), reviewing the whole PR.` };
    }
    ({ files, tooLarge } = filesFromApi(entries));
  }
  const inPr = new Set([...listed.files.map((f) => f.filename), ...listed.tooLarge]);
  return { files: files.filter((f) => inPr.has(f.filename)), tooLarge: tooLarge.filter((name) => inPr.has(name)) };
}

/** notReviewed entries for files GitHub sent no patch for, except ignored ones. */
function tooLargeEntries(names, { ignorePatterns }) {
  return names.filter((name) => !isIgnored(name, ignorePatterns)).map((filename) => ({ filename, reason: TOO_LARGE }));
}

/** The files to review under --max-files (see selectFiles), as { files, notReviewed }. */
function limitFiles(all, { maxFiles }) {
  const { selected, skipped } = selectFiles(all, maxFiles);
  if (skipped.length > 0) {
    info(`Reviewing ${selected.length} of ${plural(all.length, 'file')} (--max-files ${maxFiles}): source files and the biggest changes first.\n`);
  }
  return { files: selected, notReviewed: skipped.map((f) => ({ filename: f.filename, reason: `over --max-files ${maxFiles}` })) };
}

function short(sha) {
  return sha.slice(0, 7);
}

/**
 * Turn review results into the { commitId, body, comments } posted to GitHub.
 * GitHub rejects the whole review if a comment points outside the diff,
 * so findings on other lines go into the review body instead.
 * At most MAX_INLINE_COMMENTS go inline, the most severe first; the rest are listed in the body.
 * An inline comment with a suggestion ends with a ```suggestion block that GitHub can apply in one click.
 * The body lists notReviewed (see reviewFiles) and ends with a hidden marker naming markerSha (default commitId);
 * since (a short SHA) says the review covers only newer commits.
 */
export function buildReview(results, {
  commitId, markerSha = commitId, since, model, provider, notReviewed = [],
}) {
  const candidates = [];
  const leftovers = [];
  for (const { filename, diff, comments: found } of results) {
    const allowed = commentableLines(diff);
    for (const c of found) {
      const body = `**[${c.severity.toUpperCase()}]** ${c.message}`;
      const listed = `- \`${filename}:${c.line}\` ${body}`;
      if (allowed.has(c.line)) {
        const comment = { path: filename, line: c.line, body: c.suggestion ? body + suggestionBlock(c.suggestion) : body };
        candidates.push({ comment, severity: c.severity, listed });
      } else {
        leftovers.push(listed);
      }
    }
  }
  const { inline, overflow } = capInlineComments(candidates);
  const text = reviewBody(results, {
    leftovers, overflow: overflow.map((c) => c.listed), notReviewed, since, model, provider,
  });
  return { commitId, body: `${fitBody(text)}\n\n${markerFor(markerSha)}`, comments: inline.map((c) => c.comment) };
}

// GitHub refuses longer bodies (65,536 characters); this leaves room for the marker.
const MAX_BODY_CHARS = 60_000;

/** text cut at a line break to fit MAX_BODY_CHARS, saying where the rest is. */
function fitBody(text) {
  if (text.length <= MAX_BODY_CHARS) return text;
  const cut = text.slice(0, text.lastIndexOf('\n', MAX_BODY_CHARS));
  return `${cut}\n\n_The summary was too long for one GitHub review and was cut here. The job summary and --output have everything._`;
}

/** A GitHub suggestion block replacing the commented line with code. The fence outgrows any backticks in it. */
function suggestionBlock(code) {
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return `\n\n${fence}suggestion\n${code}\n${fence}`;
}

/** Leave out lockfiles, generated files and anything else on the ignore list. */
function reviewable(files, { ignorePatterns }) {
  const kept = files.filter((f) => !isIgnored(f.filename, ignorePatterns));
  const skipped = files.filter((f) => !kept.includes(f));
  if (skipped.length > 0) {
    info(`Skipping ${plural(skipped.length, 'ignored file')}: ${skipped.map((f) => f.filename).join(', ')}\n`);
  }
  return kept;
}

function reviewBody(results, {
  leftovers, overflow, notReviewed, since, model, provider,
}) {
  const total = countIssues(results);
  const scope = `${plural(results.length, 'file')}${since ? ` since \`${since}\`` : ''}`;
  const by = `model \`${model}\`${provider ? ` via ${provider}` : ''}`;
  const lines = [total === 0
    ? `reviewbuddy found no issues in ${scope} (${by}).`
    : `reviewbuddy found ${plural(total, 'issue')} in ${scope} (${by}).`];
  if (overflow.length > 0) {
    lines.push('', `Only the ${MAX_INLINE_COMMENTS} most severe findings are posted inline, so the review stays readable. The other ${overflow.length}:`, ...overflow);
  }
  if (leftovers.length > 0) {
    lines.push('', 'These point at lines outside the diff, so they could not be posted inline:', ...leftovers);
  }
  if (notReviewed.length > 0) {
    lines.push('', 'Not reviewed:', ...notReviewed.map(notReviewedLine));
  }
  return lines.join('\n');
}

/** One notReviewed entry as a Markdown list item. */
function notReviewedLine({ filename, reason }) {
  return filename ? `- \`${filename}\`: ${reason}` : `- ${reason}`;
}

/**
 * Review the files, up to concurrency at once, print the findings, and return
 * { results: [{ filename, diff, comments }], seconds, notReviewed }.
 * Each file's output is held back and printed as one block when it finishes; results keep the files' order.
 * A file that fails (after retries) doesn't stop the others: it goes into notReviewed as { filename, reason, failed: true }.
 * An error that would fail every file (fatal: a bad API key, an unknown model) stops the run.
 * notReviewed starts as skipped ([{ filename, reason }], left out before reviewing) and gains the failed files
 * and the partly reviewed ones (over --max-chunks-per-file; their findings are still in results).
 * loadSource(filename) gives the file's new version for context, or null.
 * Findings below minSeverity are left out here, so nothing later sees them: not --fail-on, and not any output format.
 */
async function reviewFiles(files, {
  timeoutMs, minSeverity, rules, concurrency = 1, maxChunksPerFile = 0,
}, loadSource, skipped = []) {
  const start = performance.now();
  let finished = 0;
  info(`Reviewing ${plural(files.length, 'file')} with concurrency ${concurrency}\n`);

  const outcomes = await mapPool(files, concurrency, async (file) => {
    let partial;
    const review = async () => reviewDiff(file.filename, file.diff, {
      timeoutMs,
      source: await loadSource(file.filename),
      rules,
      maxChunks: maxChunksPerFile,
      onPartial: (p) => { partial = p; },
    });
    try {
      const { value: found, lines } = await buffered(review);
      const comments = found.filter((c) => atLeast(c.severity, minSeverity));
      printFile(file, ++finished, files.length, lines, comments);
      return { comments, below: found.length - comments.length, partial };
    } catch (err) {
      info(`Could not review ${file.filename} (${++finished}/${files.length})`);
      flush(err.lines);
      // A fatal error ends the run, which prints it.
      if (!err.fatal) warn(`  ${err.message}\n`);
      throw err;
    }
  });

  const results = [];
  const notReviewed = [...skipped];
  let below = 0;
  for (const [i, { value, error }] of outcomes.entries()) {
    const { filename } = files[i];
    if (error) {
      notReviewed.push({ filename, reason: `failed: ${error.message.split('\n')[0]}`, failed: true });
      continue;
    }
    results.push({ ...files[i], comments: value.comments });
    below += value.below;
    if (value.partial) {
      const { reviewed, total } = value.partial;
      notReviewed.push({ filename, reason: `partly reviewed: the first ${reviewed} of ${total} parts (--max-chunks-per-file)` });
    }
  }

  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  info(`${plural(countIssues(results), 'issue')} in ${plural(results.length, 'file')}. Review took ${seconds}s`);
  if (below > 0) info(`Left out ${plural(below, 'finding')} below --min-severity ${minSeverity}.`);
  printNotReviewed(notReviewed);

  if (inActions()) {
    // Annotations show on the run page and in the PR's "Files changed" view; the report goes in the job summary.
    for (const line of annotationsFor(results)) info(line);
    await appendStepSummary(formatReport(results, {
      ...describeProvider(), seconds, date: new Date(), notReviewed,
    }));
  }
  return { results, seconds, notReviewed };
}

/** Print a finished file as one block: its running count, what it printed while reviewed, then its findings. */
function printFile(file, finished, total, lines, comments) {
  info(`Reviewed ${file.filename} (${finished}/${total})`);
  flush(lines);
  for (const c of comments) {
    info(`  ${file.filename}:${c.line} [${c.severity.toUpperCase()}] ${c.message}`);
    if (c.suggestion) info(`    fix: ${c.suggestion.trim()}`);
  }
  if (comments.length === 0) info('  No issues found.');
  info();
}

/** Print the files left out or only partly reviewed, if any. Returns notReviewed. */
function printNotReviewed(notReviewed) {
  if (notReviewed.length === 0) return notReviewed;
  info(`\nNot reviewed (${notReviewed.length}):`);
  for (const n of notReviewed) info(`  ${n.filename ? `${n.filename}: ${n.reason}` : n.reason}`);
  return notReviewed;
}

/**
 * Write the results in format (see outputFormat): to the output file if there is one, else a JSON or
 * SARIF document to stdout (text was already printed). Called once per run, also when nothing was reviewed,
 * so a consumer always gets a document.
 */
async function writeOutput(results, {
  format, output, seconds, notReviewed = [],
}) {
  if (format === 'text') {
    if (!output) return;
    const filePath = await writeReport(results, { seconds, outputPath: output, notReviewed });
    info(`\nReport written to ${filePath}`);
    return;
  }
  const used = describeProvider();
  const doc = format === 'json'
    ? formatJson(results, { ...used, seconds, notReviewed })
    : formatSarif(results, { ...used, notReviewed });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (!output) {
    process.stdout.write(text);
    return;
  }
  const filePath = resolve(output);
  await writeFile(filePath, text, 'utf8');
  info(`\n${format === 'json' ? 'JSON' : 'SARIF'} written to ${filePath}`);
}

function countIssues(results) {
  return results.reduce((sum, r) => sum + r.comments.length, 0);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const SEVERITY_ICON = { security: '🔴', bug: '🟠', performance: '🟡', suggestion: '🔵' };

/** Render review results as a Markdown report. notReviewed (see reviewFiles) gets a section at the end. */
export function formatReport(results, {
  model, provider, seconds, date, notReviewed = [],
}) {
  const total = countIssues(results);
  const lines = [
    '# 🔍 ReviewBuddy Report',
    '',
    `> **${plural(total, 'issue')}** found across **${plural(results.length, 'file')}** in ${seconds}s`,
    '',
    '| Detail | Value |',
    '|--------|-------|',
    ...(provider ? [`| Provider | ${provider} |`] : []),
    `| Model | \`${model}\` |`,
    `| Date | ${date.toLocaleString()} |`,
    `| Files reviewed | ${results.length} |`,
    ...(notReviewed.length > 0 ? [`| Not reviewed | ${notReviewed.length} |`] : []),
    '',
    '---',
    '',
  ];

  for (const { filename, comments } of results) {
    lines.push(`## \`${filename}\``);
    lines.push('');
    if (comments.length === 0) {
      lines.push('_No issues found._');
      lines.push('');
      continue;
    }
    lines.push('| Line | Severity | Issue |');
    lines.push('|------|----------|-------|');
    for (const c of comments) {
      const icon = SEVERITY_ICON[c.severity] || 'ℹ️';
      const fix = c.suggestion ? `<br>**Fix:** ${inlineCode(c.suggestion.trim())}` : '';
      lines.push(`| ${c.line} | ${icon} **${c.severity.toUpperCase()}** | ${c.message}${fix} |`);
    }
    lines.push('');
  }
  if (notReviewed.length > 0) lines.push('## Not reviewed', '', ...notReviewed.map(notReviewedLine), '');
  return lines.join('\n');
}

/** code as a Markdown code span that is safe inside a table cell. */
function inlineCode(code) {
  const ticks = code.includes('`') ? '``' : '`';
  const pad = code.includes('`') ? ' ' : '';
  return `${ticks}${pad}${code.replace(/\|/g, '\\|')}${pad}${ticks}`;
}

/**
 * Write the Markdown report to outputPath and return its absolute path.
 * model and provider default to the selected provider.
 */
export async function writeReport(results, {
  seconds, outputPath, date = new Date(), notReviewed, ...used
}) {
  const filePath = resolve(outputPath);
  const { model, provider } = used.model ? used : describeProvider();
  await writeFile(filePath, formatReport(results, {
    model, provider, seconds, date, notReviewed,
  }), 'utf8');
  return filePath;
}
