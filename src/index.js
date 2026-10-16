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
import { commentableLines, splitDiff } from './diff.js';
import {
  getCompareDiff, getFileContent, getPullRequest, getPullRequestDiff, listReviewComments, listReviews, parsePrUrl, postReview,
} from './github.js';
import {
  findLocalConfig, loadConfig, loadRemoteConfig, resolveSettings,
} from './config.js';
import { isIgnored } from './ignore.js';
import { describe as describeProvider, useProvider } from './providers/index.js';
import { atLeast, reviewDiff } from './review.js';

const SAMPLE_DIFF = fileURLToPath(new URL('../samples/buggy.diff', import.meta.url));

export { parseFailOn, parseMinSeverity } from './config.js';

/** Run the CLI with the given arguments (process.argv without node and the script). */
export async function main(argv) {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'fail-on': { type: 'string' },
      full: { type: 'boolean', default: false },
      ignore: { type: 'string' },
      'min-severity': { type: 'string' },
      'no-config': { type: 'boolean', default: false },
      'no-default-ignore': { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
      provider: { type: 'string' },
      'repo-dir': { type: 'string' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });

  const target = positionals[0] || SAMPLE_DIFF;
  const pr = parsePrUrl(target);
  const repoDir = flags['repo-dir'];
  if (repoDir !== undefined && !(await stat(repoDir).catch(() => null))?.isDirectory()) {
    throw new Error(`--repo-dir ${repoDir} is not a directory.`);
  }

  // Check flags and variables now, before any request. A provider they name wins over the
  // repo's config, so an unknown one or a missing API key fails here too.
  const early = resolveSettings({ flags, env: process.env });
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
  if (config.summary) console.log(config.summary);

  const settings = resolveSettings({ flags, env: process.env, file: config.file });
  const { failOn, minSeverity } = settings;
  const unreachable = failOn.filter((s) => !atLeast(s, minSeverity));
  if (unreachable.length > 0) {
    console.warn(`Warning: --fail-on ${unreachable.join(',')} has no effect with --min-severity ${minSeverity}, which leaves those findings out.`);
  }
  const used = await selectProvider(settings.provider, settings.model);
  if (used === SKIPPED) return;
  console.log(`Using ${used.provider} (${used.model})\n`);

  const options = {
    dryRun: flags['dry-run'],
    failOn,
    full: flags.full,
    minSeverity,
    output: flags.output,
    repoDir,
    timeoutMs: settings.timeoutMs,
    ignorePatterns: settings.ignorePatterns,
    rules: config.rules,
  };

  const findings = pr ? await reviewPullRequest(pr, token, details, options) : await reviewDiffFile(target, options);
  checkFailOn(findings, failOn);
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
  console.log(`\nFailing: ${plural(failing.size, 'finding')} match --fail-on ${failOn.join(',')}.`);
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

/** Review a diff file and return its findings, for --fail-on. */
async function reviewDiffFile(diffPath, options) {
  const files = reviewable(splitDiff(await readFile(diffPath, 'utf8')), options);
  if (files.length === 0) {
    console.log(`Nothing to review in ${diffPath}.`);
    await appendStepSummary(`reviewbuddy: nothing to review in ${diffPath}.`);
    return [];
  }
  return flatFindings(await reviewFiles(files, options, localSource(options.repoDir)));
}

/**
 * Read a changed file from the local checkout (repoDir, else the current directory) for context.
 * null if it isn't there, or if its path leads outside that directory: a crafted diff must not
 * get other local files sent to the model.
 */
function localSource(repoDir = '.') {
  const root = resolve(repoDir);
  return async (filename) => {
    const path = resolve(root, filename);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      console.warn(`  Not reading ${filename} for context: it is outside ${root}.`);
      return null;
    }
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`  Could not read ${filename} for context (${err.message}), reviewing the diff alone.`);
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
      console.warn(`  Could not fetch ${filename} for context (${err.message}), reviewing the diff alone.${hint}`);
      return null;
    }
  };
}

/**
 * Review a PR (details: its getPullRequest reply) and post the new findings. Returns what --fail-on judges:
 * this run's findings, including ones posted before, plus earlier inline findings whose lines haven't changed since.
 */
async function reviewPullRequest(pr, token, { head }, options) {
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
    console.log(`Already reviewed ${short(head.sha)}, nothing new`);
    await appendStepSummary(`reviewbuddy already reviewed \`${short(head.sha)}\`, nothing new.`);
    return stillOpen();
  }

  const prFiles = reviewable(splitDiff(await getPullRequestDiff(pr, token)), options);
  let files = prFiles;
  let since;
  if (previous) {
    const newer = await filesSince(pr, token, previous.sha, head.sha, prFiles);
    if (newer) {
      files = newer;
      since = short(previous.sha);
      console.log(`Reviewing changes since ${since}`);
    } else {
      console.log(`Previous review's commit ${short(previous.sha)} no longer exists (force-push or rebase?), reviewing the whole PR.`);
    }
  }
  console.log(`Pull request ${pr.owner}/${pr.repo}#${pr.number}: ${files.length} file(s) to review\n`);

  let results = files.length > 0 ? await reviewFiles(files, options, remoteSource(pr, token, head.sha)) : [];
  // Judged before dropping repeats: a finding posted earlier is still in the code.
  const findings = [...flatFindings(results), ...await stillOpen()];
  if (ourReviews.size > 0 && countIssues(results) > 0) {
    const dropped = dropPosted(results, postedKeys(await listOurComments(), ourReviews));
    results = dropped.results;
    console.log(`Skipped ${plural(dropped.skipped, 'finding')} already posted in an earlier review.`);
  }
  if (countIssues(results) === 0) {
    console.log('No new findings to post.');
    return findings;
  }

  // GitHub only accepts inline comments on lines in the PR's own diff, not the compare diff.
  const prDiffs = new Map(prFiles.map((f) => [f.filename, f.diff]));
  const review = buildReview(
    results.map((r) => ({ ...r, diff: prDiffs.get(r.filename) })),
    { commitId: head.sha, since, ...describeProvider() },
  );

  if (options.dryRun) {
    console.log('Dry run, not posting. The review would be:\n');
    console.log(JSON.stringify(review, null, 2));
    return findings;
  }
  let posted;
  try {
    posted = await postReview(pr, token, review);
  } catch (err) {
    // On a fork PR the workflow's token is read-only; the annotations and job summary still have the findings.
    if (err.status !== 403 || !inActions() || !await isForkPullRequest()) throw err;
    warning('Could not post the review: on pull requests from forks the GitHub token is read-only. The findings are in the job summary and the annotations.');
    return findings;
  }
  console.log(`Posted review: ${posted.html_url}`);
  return findings;
}

/**
 * The PR's files narrowed to what changed between sha and head, or null if GitHub no longer has sha.
 * Files the PR itself doesn't change (brought in by merging the base branch) are left out.
 */
async function filesSince(pr, token, sha, head, prFiles) {
  const diff = await getCompareDiff(pr, token, sha, head);
  if (diff === null) return null;
  const inPr = new Set(prFiles.map((f) => f.filename));
  return splitDiff(diff).filter((f) => inPr.has(f.filename));
}

function short(sha) {
  return sha.slice(0, 7);
}

/**
 * Turn review results into the { commitId, body, comments } posted to GitHub.
 * GitHub rejects the whole review if a comment points outside the diff,
 * so findings on other lines go into the review body instead.
 * An inline comment with a suggestion ends with a ```suggestion block that GitHub can apply in one click.
 * The body ends with a hidden marker naming commitId; since (a short SHA) says the review covers only newer commits.
 */
export function buildReview(results, { commitId, since, model, provider }) {
  const comments = [];
  const leftovers = [];
  for (const { filename, diff, comments: found } of results) {
    const allowed = commentableLines(diff);
    for (const c of found) {
      const body = `**[${c.severity.toUpperCase()}]** ${c.message}`;
      if (allowed.has(c.line)) {
        comments.push({ path: filename, line: c.line, body: c.suggestion ? body + suggestionBlock(c.suggestion) : body });
      } else {
        leftovers.push(`- \`${filename}:${c.line}\` ${body}`);
      }
    }
  }
  const body = `${reviewBody(results, leftovers, { since, model, provider })}\n\n${markerFor(commitId)}`;
  return { commitId, body, comments };
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
    console.log(`Skipping ${plural(skipped.length, 'ignored file')}: ${skipped.map((f) => f.filename).join(', ')}\n`);
  }
  return kept;
}

function reviewBody(results, leftovers, { since, model, provider }) {
  const total = countIssues(results);
  const scope = `${plural(results.length, 'file')}${since ? ` since \`${since}\`` : ''}`;
  const by = `model \`${model}\`${provider ? ` via ${provider}` : ''}`;
  const lines = [total === 0
    ? `reviewbuddy found no issues in ${scope} (${by}).`
    : `reviewbuddy found ${plural(total, 'issue')} in ${scope} (${by}).`];
  if (leftovers.length > 0) {
    lines.push('', 'These point at lines outside the diff, so they could not be posted inline:', ...leftovers);
  }
  return lines.join('\n');
}

/**
 * Review each file, print the findings, and return [{ filename, diff, comments }].
 * loadSource(filename) gives the file's new version for context, or null.
 * Findings below minSeverity are left out here, so nothing later sees them.
 */
async function reviewFiles(files, {
  output, timeoutMs, minSeverity, rules,
}, loadSource) {
  const start = performance.now();
  const results = [];
  let below = 0;

  for (const [i, file] of files.entries()) {
    console.log(`Reviewing ${file.filename} (${i + 1}/${files.length}) ...`);
    const source = await loadSource(file.filename);
    const found = await reviewDiff(file.filename, file.diff, { timeoutMs, source, rules });
    const comments = found.filter((c) => atLeast(c.severity, minSeverity));
    below += found.length - comments.length;
    results.push({ ...file, comments });

    for (const c of comments) {
      console.log(`  ${file.filename}:${c.line} [${c.severity.toUpperCase()}] ${c.message}`);
      if (c.suggestion) console.log(`    fix: ${c.suggestion.trim()}`);
    }
    if (comments.length === 0) console.log('  No issues found.');
    console.log();
  }

  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`${plural(countIssues(results), 'issue')} in ${plural(files.length, 'file')}. Review took ${seconds}s`);
  if (below > 0) console.log(`Left out ${plural(below, 'finding')} below --min-severity ${minSeverity}.`);

  if (output) {
    const filePath = await writeReport(results, { seconds, outputPath: output });
    console.log(`\nReport written to ${filePath}`);
  }
  if (inActions()) {
    // Annotations show on the run page and in the PR's "Files changed" view; the report goes in the job summary.
    for (const line of annotationsFor(results)) console.log(line);
    await appendStepSummary(formatReport(results, { ...describeProvider(), seconds, date: new Date() }));
  }
  return results;
}

function countIssues(results) {
  return results.reduce((sum, r) => sum + r.comments.length, 0);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const SEVERITY_ICON = { security: '🔴', bug: '🟠', performance: '🟡', suggestion: '🔵' };

/** Render review results as a Markdown report. */
export function formatReport(results, { model, provider, seconds, date }) {
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
export async function writeReport(results, { seconds, outputPath, date = new Date(), ...used }) {
  const filePath = resolve(outputPath);
  const { model, provider } = used.model ? used : describeProvider();
  await writeFile(filePath, formatReport(results, { model, provider, seconds, date }), 'utf8');
  return filePath;
}
