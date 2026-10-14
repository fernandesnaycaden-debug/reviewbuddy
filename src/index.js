import { readFile } from 'node:fs/promises';
import { splitDiff } from './diff.js';
import { reviewDiff } from './review.js';

const diffPath = process.argv[2] || 'samples/buggy.diff';

async function main() {
  const files = splitDiff(await readFile(diffPath, 'utf8'));
  if (files.length === 0) {
    console.log(`No added lines to review in ${diffPath}.`);
    return;
  }

  const start = performance.now();
  let total = 0;

  for (const [i, file] of files.entries()) {
    console.log(`Reviewing ${file.filename} (${i + 1}/${files.length}) ...`);
    const comments = await reviewDiff(file.filename, file.diff);
    total += comments.length;

    for (const c of comments) {
      console.log(`  ${file.filename}:${c.line} [${c.severity.toUpperCase()}] ${c.message}`);
    }
    if (comments.length === 0) console.log('  No issues found.');
    console.log();
  }

  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const fileWord = files.length === 1 ? 'file' : 'files';
  const issueWord = total === 1 ? 'issue' : 'issues';
  console.log(`${total} ${issueWord} in ${files.length} ${fileWord}. Review took ${seconds}s`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
