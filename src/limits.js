// Limits for huge pull requests: which files to review under --max-files, and how many
// inline comments go into one posted review.

import { addedLines } from './diff.js';
import { SEVERITY_ORDER } from './review.js';

// GitHub documents no maximum, but a review with hundreds of comments is slow to post, may be
// refused, and buries the important findings. The most severe ones go inline, the rest in the body.
export const MAX_INLINE_COMMENTS = 50;

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i;
const DOC_OR_CONFIG = /(^|\/)docs?\/|\.(md|markdown|rst|txt|adoc|json|ya?ml|toml|ini|cfg|xml|csv)$/i;

/** 0 for source code, 1 for tests, 2 for docs and config: the order --max-files picks them in. */
export function fileRank(filename) {
  if (TEST_FILE.test(filename)) return 1;
  if (DOC_OR_CONFIG.test(filename)) return 2;
  return 0;
}

/**
 * Pick at most max files ([{ filename, diff }]) to review: source before tests before docs and config,
 * and within each, the ones with the most added lines first; ties keep the PR's order.
 * Returns { selected, skipped }, each in the PR's order. max of 0 or undefined keeps every file.
 */
export function selectFiles(files, max) {
  if (!max || files.length <= max) return { selected: files, skipped: [] };
  const ranked = files
    .map((file, index) => ({
      file, index, rank: fileRank(file.filename), added: addedLines(file.diff).size,
    }))
    .sort((a, b) => a.rank - b.rank || b.added - a.added || a.index - b.index);
  const keep = new Set(ranked.slice(0, max).map((r) => r.file));
  return {
    selected: files.filter((f) => keep.has(f)),
    skipped: files.filter((f) => !keep.has(f)),
  };
}

/**
 * Split inline comments ([{ comment, severity }] in file order) at max: the most severe go inline,
 * ties keeping file order. Returns { inline, overflow }, both in file order.
 */
export function capInlineComments(candidates, max = MAX_INLINE_COMMENTS) {
  if (candidates.length <= max) return { inline: candidates, overflow: [] };
  const keep = new Set(candidates
    .map((c, index) => ({ c, index, rank: SEVERITY_ORDER.indexOf(c.severity) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, max)
    .map((r) => r.c));
  return {
    inline: candidates.filter((c) => keep.has(c)),
    overflow: candidates.filter((c) => !keep.has(c)),
  };
}
