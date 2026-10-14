import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { commentableLines, splitDiff } from './diff.js';
import { getPullRequest, getPullRequestDiff, parsePrUrl, postReview } from './github.js';
import { DEFAULT_MODEL } from './providers/ollama.js';
import { reviewDiff } from './review.js';

const { values: flags, positionals } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  allowPositionals: true,
});
const target = positionals[0] || 'samples/buggy.diff';

async function main() {
  const pr = parsePrUrl(target);
  if (pr) {
    await reviewPullRequest(pr);
  } else {
    await reviewDiffFile(target);
  }
}

async function reviewDiffFile(diffPath) {
  const files = splitDiff(await readFile(diffPath, 'utf8'));
  if (files.length === 0) {
    console.log(`No added lines to review in ${diffPath}.`);
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
  const files = splitDiff(await getPullRequestDiff(pr, token));
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
  return results;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  // Not process.exit(): exiting while fetch sockets close crashes Node on Windows.
  process.exitCode = 1;
});
