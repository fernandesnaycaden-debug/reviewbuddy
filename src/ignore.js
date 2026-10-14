// Decides which changed files are not worth a model's time: lockfiles,
// minified and generated output, vendored code.

export const DEFAULT_IGNORE = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.min.*',
  '*.snap',
  '*.svg',
  '*.map',
  'dist/',
  'build/',
  'vendor/',
  'node_modules/',
];

/**
 * Does the path match any pattern? Patterns are simple globs where "*" matches
 * anything except "/":
 * - "dist/" (ending in "/") matches a directory of that name anywhere in the path.
 * - "*.min.*" (no "/") matches the file name, in any directory.
 * - "src/gen/*.js" (with "/") matches the whole path.
 */
export function isIgnored(path, patterns) {
  const parts = path.split('/');
  return patterns.some((pattern) => {
    if (pattern.endsWith('/')) {
      const dir = globToRegExp(pattern.slice(0, -1));
      return parts.slice(0, -1).some((part) => dir.test(part));
    }
    if (!pattern.includes('/')) return globToRegExp(pattern).test(parts.at(-1));
    return globToRegExp(pattern).test(path);
  });
}

/** Split a comma-separated list of patterns, dropping blanks. */
export function parsePatterns(list) {
  return (list ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}
