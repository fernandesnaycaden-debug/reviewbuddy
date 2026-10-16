/**
 * A diff file's or stdin's bytes as text. A UTF-8 byte order mark is dropped, and UTF-16 (LE or BE,
 * told apart by its byte order mark) is decoded: Windows PowerShell 5.1's `git diff > file` writes UTF-16 LE.
 * Anything else is read as UTF-8.
 */
export function decodeDiff(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Node has no UTF-16 BE decoder: swap each pair of bytes (a copy, dropping an odd last byte) and read it as LE.
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  return Buffer.from(bytes).toString('utf8');
}

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
 * One file from GitHub's files API ({ filename, previous_filename, status, patch }) as the
 * { filename, diff } splitDiff gives for it, so the rest of the review can't tell them apart.
 * The patch is only the hunks; this adds the headers. null without a patch or added lines.
 */
export function patchToFile({ filename, previous_filename: previous = filename, status, patch }) {
  if (!patch || !patch.split(/\r?\n/).some((line) => line.startsWith('+') && !line.startsWith('+++'))) return null;
  const diff = [
    `diff --git a/${previous} b/${filename}`,
    status === 'added' ? '--- /dev/null' : `--- a/${previous}`,
    `+++ b/${filename}`,
    patch.replace(/\r?\n$/, ''),
  ].join('\n');
  return { filename, diff };
}

/**
 * GitHub's files API entries as { files, tooLarge }: files as splitDiff would give them, and the
 * names of files with added lines but no patch, which GitHub leaves out when a file's diff is too large.
 * Binary files and pure renames have no added lines and are left out, as splitDiff does.
 */
export function filesFromApi(entries) {
  const files = [];
  const tooLarge = [];
  for (const entry of entries) {
    if (entry.patch) {
      const file = patchToFile(entry);
      if (file) files.push(file);
    } else if (entry.additions > 0) {
      tooLarge.push(entry.filename);
    }
  }
  return { files, tooLarge };
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

/** Line numbers (in the new file) of the added lines, the only ones the model may comment on. */
export function addedLines(diff) {
  return new Set(annotateLines(diff).filter((l) => l.newLine && l.text.startsWith('+')).map((l) => l.newLine));
}

/** The text of each added or context line (without its "+" or " "), by its line number in the new file. */
export function newLineTexts(diff) {
  return new Map(annotateLines(diff).filter((l) => l.newLine).map((l) => [l.newLine, l.text.slice(1)]));
}

/**
 * Split a single-file diff into pieces of at most maxChars, cutting only between
 * hunks, so a big file doesn't overflow the model's context window. Each piece keeps
 * the file header, and line numbers stay right because every hunk header carries them.
 * A single hunk bigger than maxChars becomes a piece of its own.
 */
export function chunkDiff(diff, maxChars) {
  const lines = diff.trimEnd().split(/\r?\n/);
  const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
  if (firstHunk === -1) return [diff];

  const header = lines.slice(0, firstHunk);
  const hunks = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@ ')) hunks.push([]);
    hunks.at(-1).push(line);
  }

  const chunks = [];
  let current = [];
  let size = 0;
  for (const hunk of hunks) {
    const hunkSize = hunk.join('\n').length;
    if (current.length > 0 && size + hunkSize > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(...hunk);
    size += hunkSize;
  }
  chunks.push(current);

  return chunks
    .filter((chunk) => chunk.some((line) => line.startsWith('+')))
    .map((chunk) => [...header, ...chunk].join('\n'));
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
