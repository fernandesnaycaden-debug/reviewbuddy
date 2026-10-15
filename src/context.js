// The new version of a changed file, shown to the model next to the diff so it can see
// whether a value is checked, a function defined or an error handled outside the hunks.

import { addedLines, newLineTexts } from './diff.js';

export const CONTEXT_WINDOW = 40;
const GAP = '     ...';

/**
 * The file as reference for one piece of diff, within budgetChars: { kind: 'full', text } if the
 * whole numbered file fits, else { kind: 'window', text } with `window` lines around each hunk,
 * else null (also for no source or no budget). Lines are numbered like numberDiffLines.
 */
export function buildContext(source, diff, budgetChars, { window = CONTEXT_WINDOW } = {}) {
  if (source == null || budgetChars <= 0) return null;
  const lines = sourceLines(source);

  const full = numberSource(lines, 1, lines.length);
  if (full.length <= budgetChars) return { kind: 'full', text: full };

  const ranges = mergeRanges(hunkRanges(diff).map(([from, to]) => [
    Math.max(1, from - window),
    Math.min(lines.length, to + window),
  ]));
  if (ranges.length === 0) return null;
  // "..." stands for the lines left out before, between and after the windows.
  const parts = [];
  let next = 1;
  for (const [from, to] of ranges) {
    if (from > next) parts.push(GAP);
    parts.push(numberSource(lines, from, to));
    next = to + 1;
  }
  if (next <= lines.length) parts.push(GAP);
  const text = parts.join('\n');
  return text.length <= budgetChars ? { kind: 'window', text } : null;
}

/**
 * True if every added line of the diff is in source at its line number. False means the file
 * isn't the diff's new version (e.g. a different branch is checked out), so it would mislead.
 */
export function matchesDiff(source, diff) {
  const lines = sourceLines(source);
  const texts = newLineTexts(diff);
  return [...addedLines(diff)].every((n) => lines[n - 1] === texts.get(n));
}

/** "   12 code" for lines from..to (1-based, inclusive). */
function numberSource(lines, from, to) {
  return lines.slice(from - 1, to).map((text, i) => `${String(from + i).padStart(4)} ${text}`).join('\n');
}

function sourceLines(source) {
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  // A final newline doesn't start another line.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** [from, to] new-file line ranges of the diff's hunks. */
function hunkRanges(diff) {
  const ranges = [];
  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    ranges.push([start, start + Math.max(count, 1) - 1]);
  }
  return ranges;
}

/** Sort ranges and join the ones that overlap or touch. */
function mergeRanges(ranges) {
  const merged = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}
