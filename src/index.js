import { readFile } from 'node:fs/promises';
import { reviewDiff } from './review.js';

const diffPath = process.argv[2] || 'samples/buggy.diff';

async function main() {
  const diff = await readFile(diffPath, 'utf8');

  // Use the file name from the "+++ b/path" header, falling back to the diff file name.
  const filename = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1]?.trim() || diffPath;

  console.log(`Reviewing ${filename} ...\n`);
  const start = performance.now();
  const comments = await reviewDiff(filename, diff);
  const seconds = ((performance.now() - start) / 1000).toFixed(1);

  if (comments.length === 0) {
    console.log('No issues found.');
  }
  for (const c of comments) {
    console.log(`[${c.severity.toUpperCase()}] line ${c.line}: ${c.message}`);
  }
  console.log(`\nReview took ${seconds}s`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
