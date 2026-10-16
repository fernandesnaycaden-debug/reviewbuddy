// Machine-readable results: a JSON document of reviewbuddy's own, and SARIF 2.1.0 for code scanning tools.

import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { SEVERITY_ORDER } from './review.js';

const pkg = createRequire(import.meta.url)('../package.json');

export const FORMATS = ['text', 'json', 'sarif'];
// Bumped only when a field is removed or changes meaning; new fields can appear without a bump.
export const JSON_SCHEMA_VERSION = 1;
export const TOOL = { name: pkg.name, version: pkg.version, informationUri: pkg.homepage.replace(/#.*$/, '') };

/** The output format named by value, in any case. undefined if value is empty. label names the source in errors. */
export function parseFormat(value, label = '--format') {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return undefined;
  if (!FORMATS.includes(wanted)) throw new Error(`Unknown format "${value.trim()}" in ${label}. Use one of: ${FORMATS.join(', ')}.`);
  return wanted;
}

const BY_EXTENSION = { '.json': 'json', '.sarif': 'sarif' };

/**
 * The format to write: format if one was set (flag, variable or config file), else the one
 * outputPath's extension implies (.json, .sarif; anything else is the Markdown report), else text.
 */
export function outputFormat(format, outputPath) {
  if (format) return format;
  if (!outputPath) return 'text';
  return BY_EXTENSION[extname(outputPath).toLowerCase()] ?? 'text';
}

/** One finding as it appears in the JSON document. endLine and suggestion only when there is one. */
function jsonFinding(c) {
  return {
    line: c.line,
    ...(c.endLine && { endLine: c.endLine }),
    severity: c.severity,
    message: c.message,
    ...(c.suggestion && { suggestion: c.suggestion }),
  };
}

/** Review results ([{ filename, comments }]) as reviewbuddy's JSON document (see README, "JSON"). */
export function formatJson(results, { provider, model, seconds }) {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: TOOL.name, version: TOOL.version },
    provider: provider ?? null,
    model: model ?? null,
    durationSeconds: Number(seconds),
    summary: { files: results.length, findings: results.reduce((n, r) => n + r.comments.length, 0) },
    files: results.map((r) => ({ path: r.filename, findings: r.comments.map(jsonFinding) })),
  };
}

// Code scanning shows error, warning and note; security and bug findings should stand out.
export const SARIF_LEVEL = {
  security: 'error', bug: 'error', performance: 'warning', suggestion: 'note',
};

const RULE_TEXT = {
  security: 'Security issue found by an AI review',
  bug: 'Bug found by an AI review',
  performance: 'Performance problem found by an AI review',
  suggestion: 'Suggestion from an AI review',
};

/** One SARIF rule per severity, most serious first. */
function sarifRules() {
  return SEVERITY_ORDER.map((severity) => ({
    id: `reviewbuddy/${severity}`,
    name: severity,
    shortDescription: { text: RULE_TEXT[severity] },
    defaultConfiguration: { level: SARIF_LEVEL[severity] },
    // GitHub ranks security alerts by this score (7.0 to 8.9 is "high").
    properties: severity === 'security' ? { tags: ['security'], 'security-severity': '8.0' } : { tags: [severity] },
  }));
}

/** A diff path as a SARIF URI relative to the repository root: forward slashes, no leading "./". */
export function sarifUri(path) {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/** Review results as a SARIF 2.1.0 log with one run. */
export function formatSarif(results, { provider, model }) {
  const rules = sarifRules();
  const index = new Map(rules.map((r, i) => [r.name, i]));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { ...TOOL, rules } },
      results: results.flatMap(({ filename, comments }) => comments.map((c) => ({
        ruleId: `reviewbuddy/${c.severity}`,
        ruleIndex: index.get(c.severity),
        level: SARIF_LEVEL[c.severity],
        message: { text: c.suggestion ? `${c.message}\n\nSuggested fix: ${c.suggestion.trim()}` : c.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: sarifUri(filename) },
            region: { startLine: c.line, ...(c.endLine && { endLine: c.endLine }) },
          },
        }],
      }))),
      properties: { provider: provider ?? null, model: model ?? null },
    }],
  };
}
