import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { commentableLines, splitDiff } from './diff.js';
import { getPullRequest, getPullRequestDiff, parsePrUrl, postReview } from './github.js';
import { DEFAULT_IGNORE, isIgnored, parsePatterns } from './ignore.js';
import { DEFAULT_MODEL } from './providers/ollama.js';
import { reviewDiff } from './review.js';

const { values: flags, positionals } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    ignore: { type: 'string' },
    'no-default-ignore': { type: 'boolean', default: false },
    output: { type: 'string', short: 'o' },
  },
  allowPositionals: true,
});
const target = positionals[0] || 'samples/buggy.diff';
const ignorePatterns = [
  ...(flags['no-default-ignore'] ? [] : DEFAULT_IGNORE),
  ...parsePatterns(process.env.REVIEWBUDDY_IGNORE),
  ...parsePatterns(flags.ignore),
];

async function main() {
  const pr = parsePrUrl(target);
  if (pr) {
    await reviewPullRequest(pr);
  } else {
    await reviewDiffFile(target);
  }
}

async function reviewDiffFile(diffPath) {
  const files = reviewable(splitDiff(await readFile(diffPath, 'utf8')));
  if (files.length === 0) {
    console.log(`Nothing to review in ${diffPath}.`);
    return;
  }
  await reviewFiles(files);
}

async function reviewPullRequest(pr) {
  const token = process.env.GITHUB_TOKEN;
  const dryRun = flags['dry-run'];
  // Fail now rather than after several minutes of model calls.
  if (!token && !dryRun) {
    throw new Error('Set GITHUB_TOKEN to post a review, or pass --dry-run to only print it.');
  }

  const { head } = await getPullRequest(pr, token);
  const files = reviewable(splitDiff(await getPullRequestDiff(pr, token)));
  console.log(`Pull request ${pr.owner}/${pr.repo}#${pr.number}: ${files.length} file(s) to review\n`);

  const results = files.length > 0 ? await reviewFiles(files) : [];

  // GitHub rejects the whole review if a comment points outside the diff,
  // so findings on other lines go into the review body instead.
  const comments = [];
  const leftovers = [];
  for (const { filename, diff, comments: found } of results) {
    const allowed = commentableLines(diff);
    for (const c of found) {
      const body = `**[${c.severity.toUpperCase()}]** ${c.message}`;
      if (allowed.has(c.line)) comments.push({ path: filename, line: c.line, body });
      else leftovers.push(`- \`${filename}:${c.line}\` ${body}`);
    }
  }

  const review = { commitId: head.sha, body: reviewBody(results, leftovers), comments };

  if (dryRun) {
    console.log('Dry run, not posting. The review would be:\n');
    console.log(JSON.stringify(review, null, 2));
    return;
  }
  const posted = await postReview(pr, token, review);
  console.log(`Posted review: ${posted.html_url}`);
}

/** Leave out lockfiles, generated files and anything else on the ignore list. */
function reviewable(files) {
  const kept = files.filter((f) => !isIgnored(f.filename, ignorePatterns));
  const skipped = files.filter((f) => !kept.includes(f));
  if (skipped.length > 0) {
    console.log(`Skipping ${plural(skipped.length, 'ignored file')}: ${skipped.map((f) => f.filename).join(', ')}\n`);
  }
  return kept;
}

function reviewBody(results, leftovers) {
  const total = results.reduce((sum, r) => sum + r.comments.length, 0);
  const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;
  const lines = [total === 0
    ? `reviewbuddy found no issues in ${plural(results.length, 'file')} (model \`${model}\`).`
    : `reviewbuddy found ${plural(total, 'issue')} in ${plural(results.length, 'file')} (model \`${model}\`).`];
  if (leftovers.length > 0) {
    lines.push('', 'These point at lines outside the diff, so they could not be posted inline:', ...leftovers);
  }
  return lines.join('\n');
}

/** Review each file, print the findings, and return [{ filename, diff, comments }]. */
async function reviewFiles(files) {
  const start = performance.now();
  const results = [];

  for (const [i, file] of files.entries()) {
    console.log(`Reviewing ${file.filename} (${i + 1}/${files.length}) ...`);
    const comments = await reviewDiff(file.filename, file.diff);
    results.push({ ...file, comments });

    for (const c of comments) {
      console.log(`  ${file.filename}:${c.line} [${c.severity.toUpperCase()}] ${c.message}`);
    }
    if (comments.length === 0) console.log('  No issues found.');
    console.log();
  }

  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const total = results.reduce((sum, r) => sum + r.comments.length, 0);
  console.log(`${plural(total, 'issue')} in ${plural(files.length, 'file')}. Review took ${seconds}s`);

  if (flags.output) {
    await writeReport(results, seconds, flags.output);
  }
  return results;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const SEVERITY_ICON = { security: '🔴', bug: '🟠', performance: '🟡', suggestion: '🔵' };

async function writeReport(results, seconds, outputPath) {
  const filePath = resolve(outputPath);
  const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;
  const total = results.reduce((sum, r) => sum + r.comments.length, 0);
  const now = new Date().toLocaleString();

  const lines = [
    '# 🔍 ReviewBuddy Report',
    '',
    `> **${plural(total, 'issue')}** found across **${plural(results.length, 'file')}** in ${seconds}s`,
    '',
    '| Detail | Value |',
    '|--------|-------|',
    `| Model | \`${model}\` |`,
    `| Date | ${now} |`,
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
      lines.push(`| ${c.line} | ${icon} **${c.severity.toUpperCase()}** | ${c.message} |`);
    }
    lines.push('');
  }

  await writeFile(filePath, lines.join('\n'), 'utf8');
  console.log(`\nReport written to ${filePath}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  // Not process.exit(): exiting while fetch sockets close crashes Node on Windows.
  process.exitCode = 1;
});
