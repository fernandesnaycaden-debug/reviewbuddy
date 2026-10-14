/**
 * Split a unified diff that may touch several files into one diff per file,
 * so each file can be reviewed separately and comments can name their file.
 * Returns [{ filename, diff }]. Files with no added lines (deletions, pure
 * renames, binary changes) are left out, since there is nothing to review.
 */
export function splitDiff(diff) {
  // Strip the byte order mark that some Windows tools write at the start of a file.
  const lines = diff.replace(/^﻿/, '').split(/\r?\n/);

  // `git diff` starts every file with "diff --git". Plain `diff -u` output doesn't,
  // so there a file starts at a "--- " line directly followed by a "+++ " line.
  const isGit = lines.some((line) => line.startsWith('diff --git '));
  const startsFile = (i) => isGit
    ? lines[i].startsWith('diff --git ')
    : lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');

  const sections = [];
  let current = null;
  lines.forEach((line, i) => {
    if (startsFile(i)) {
      current = [];
      sections.push(current);
    }
    current?.push(line);
  });

  return sections
    .filter((section) => section.some((line) => line.startsWith('+') && !line.startsWith('+++')))
    .map((section) => ({ filename: fileName(section), diff: section.join('\n') }));
}

/** Read the file path from the "+++ b/path" header, falling back to "diff --git a/x b/path". */
function fileName(section) {
  const plus = section.find((line) => line.startsWith('+++ '));
  // Drop the timestamp that `diff -u` appends after a tab.
  const path = plus?.slice(4).split('\t')[0].trim();
  if (path && path !== '/dev/null') return path.replace(/^b\//, '');
  return section[0].match(/^diff --git a\/.+ b\/(.+)$/)?.[1] ?? 'unknown file';
}
