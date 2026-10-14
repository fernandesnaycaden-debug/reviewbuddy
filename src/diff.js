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

/**
 * Small models are bad at counting lines inside a diff, so we do it for them:
 * every added or context line gets its line number in the new file.
 */
export function numberDiffLines(diff) {
  return annotateLines(diff)
    .map(({ text, newLine }) => {
      if (newLine) return `${String(newLine).padStart(4)} ${text}`;
      if (text.startsWith('-') && !text.startsWith('---')) return `     ${text}`;
      return text;
    })
    .join('\n');
}

/**
 * Line numbers (in the new file) that GitHub accepts inline comments on:
 * the added and context lines inside the diff's hunks.
 */
export function commentableLines(diff) {
  return new Set(annotateLines(diff).map((l) => l.newLine).filter(Boolean));
}

/** Pair every line of a single-file diff with its new-file line number, or null if it has none. */
function annotateLines(diff) {
  let newLine = 0;
  return diff
    .trimEnd()
    .split(/\r?\n/)
    .map((text) => {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) {
        newLine = Number(hunk[1]);
        return { text, newLine: null };
      }
      if (text.startsWith('+++') || text.startsWith('---')) return { text, newLine: null };
      // An empty line is a blank context line whose leading space was stripped by an editor.
      if (newLine > 0 && text === '') text = ' ';
      if (newLine > 0 && (text.startsWith('+') || text.startsWith(' '))) return { text, newLine: newLine++ };
      return { text, newLine: null };
    });
}

/** Read the file path from the "+++ b/path" header, falling back to "diff --git a/x b/path". */
function fileName(section) {
  const plus = section.find((line) => line.startsWith('+++ '));
  // Drop the timestamp that `diff -u` appends after a tab.
  const path = plus?.slice(4).split('\t')[0].trim();
  if (path && path !== '/dev/null') return path.replace(/^b\//, '');
  return section[0].match(/^diff --git a\/.+ b\/(.+)$/)?.[1] ?? 'unknown file';
}
