import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  formatJson, formatSarif, lineRange, outputFormat, parseFormat, sarifUri, SARIF_LEVEL,
} from '../src/output.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const results = [
  {
    filename: 'src/a.js',
    diff: '',
    comments: [
      { line: 2, severity: 'security', message: 'Hardcoded key', suggestion: 'const key = process.env.KEY;' },
      {
        line: 5, endLine: 7, severity: 'bug', message: 'Off-by-one',
      },
      { line: 9, severity: 'performance', message: 'Slow loop' },
      { line: 12, severity: 'suggestion', message: 'Simplify' },
    ],
  },
  { filename: 'src\\win\\b.js', diff: '', comments: [] },
];

test('parseFormat reads a format in any case and rejects others', () => {
  assert.equal(parseFormat(' JSON '), 'json');
  assert.equal(parseFormat(''), undefined);
  assert.equal(parseFormat(undefined), undefined);
  assert.throws(() => parseFormat('xml'), /Unknown format "xml" in --format\. Use one of: text, json, sarif\./);
});

test('outputFormat: a set format wins, else --output\'s extension, else text', () => {
  assert.equal(outputFormat(undefined, undefined), 'text');
  assert.equal(outputFormat('json', undefined), 'json');
  assert.equal(outputFormat(undefined, 'out/report.json'), 'json');
  assert.equal(outputFormat(undefined, 'results.SARIF'), 'sarif');
  assert.equal(outputFormat(undefined, 'report.md'), 'text');
  assert.equal(outputFormat(undefined, 'report'), 'text');
  // --format wins over the extension.
  assert.equal(outputFormat('sarif', 'report.json'), 'sarif');
  assert.equal(outputFormat('text', 'report.sarif'), 'text');
});

test('formatJson has a stable, documented shape', () => {
  const doc = formatJson(results, { provider: 'groq', model: 'm', seconds: '1.5' });
  assert.deepEqual(doc, {
    schemaVersion: 1,
    tool: { name: 'reviewbuddy', version: pkg.version },
    provider: 'groq',
    model: 'm',
    durationSeconds: 1.5,
    summary: { files: 2, findings: 4, notReviewed: 0 },
    files: [
      {
        path: 'src/a.js',
        findings: [
          {
            line: 2, severity: 'security', message: 'Hardcoded key', suggestion: 'const key = process.env.KEY;',
          },
          {
            line: 5, endLine: 7, severity: 'bug', message: 'Off-by-one',
          },
          { line: 9, severity: 'performance', message: 'Slow loop' },
          { line: 12, severity: 'suggestion', message: 'Simplify' },
        ],
      },
      { path: 'src\\win\\b.js', findings: [] },
    ],
    notReviewed: [],
  });
  // It survives a round trip as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test('formatJson with nothing reviewed is still a complete document', () => {
  const doc = formatJson([], { provider: 'ollama', model: 'm', seconds: '0.0' });
  assert.deepEqual(doc.summary, { files: 0, findings: 0, notReviewed: 0 });
  assert.deepEqual(doc.notReviewed, []);
  assert.deepEqual(doc.files, []);
  assert.equal(doc.durationSeconds, 0);
});

test('sarifUri makes repo-relative URIs with forward slashes', () => {
  assert.equal(sarifUri('src\\win\\b.js'), 'src/win/b.js');
  assert.equal(sarifUri('./src/a.js'), 'src/a.js');
  assert.equal(sarifUri('src/a.js'), 'src/a.js');
});

/**
 * Check the parts of the SARIF 2.1.0 schema that consumers such as GitHub code scanning rely on,
 * by hand: required properties, their types, and references between them.
 */
function assertValidSarif(log) {
  assert.equal(log.version, '2.1.0');
  assert.equal(typeof log.$schema, 'string');
  assert.ok(Array.isArray(log.runs) && log.runs.length === 1, 'runs is a one-element array');
  for (const run of log.runs) {
    const { driver } = run.tool;
    assert.equal(typeof driver.name, 'string');
    assert.equal(typeof driver.version, 'string');
    assert.match(driver.informationUri, /^https:\/\//);
    assert.ok(Array.isArray(driver.rules));
    const ids = driver.rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
    for (const rule of driver.rules) {
      assert.equal(typeof rule.id, 'string');
      assert.equal(typeof rule.shortDescription.text, 'string');
      assert.ok(['none', 'note', 'warning', 'error'].includes(rule.defaultConfiguration.level));
    }
    assert.ok(Array.isArray(run.results));
    for (const result of run.results) {
      assert.equal(typeof result.message.text, 'string');
      assert.ok(result.message.text.length > 0);
      assert.ok(ids.includes(result.ruleId), `${result.ruleId} is a rule`);
      assert.equal(driver.rules[result.ruleIndex].id, result.ruleId, 'ruleIndex points at ruleId');
      assert.ok(['none', 'note', 'warning', 'error'].includes(result.level));
      assert.ok(Array.isArray(result.locations) && result.locations.length > 0);
      for (const { physicalLocation } of result.locations) {
        const { uri } = physicalLocation.artifactLocation;
        assert.equal(typeof uri, 'string');
        assert.doesNotMatch(uri, /\\/, 'no backslashes');
        assert.doesNotMatch(uri, /^(\/|[a-z]:|[a-z]+:\/\/)/i, 'relative');
        const { startLine, endLine } = physicalLocation.region;
        assert.ok(Number.isInteger(startLine) && startLine >= 1);
        if (endLine !== undefined) assert.ok(Number.isInteger(endLine) && endLine >= startLine);
      }
    }
  }
}

test('formatSarif writes a valid SARIF 2.1.0 log', () => {
  const log = formatSarif(results, { provider: 'groq', model: 'm' });
  assertValidSarif(JSON.parse(JSON.stringify(log)));
  const { driver } = log.runs[0].tool;
  assert.equal(driver.name, 'reviewbuddy');
  assert.equal(driver.version, pkg.version);
  assert.equal(driver.informationUri, 'https://github.com/fernandesnaycaden-debug/reviewbuddy');
  assert.deepEqual(driver.rules.map((r) => r.id), ['reviewbuddy/security', 'reviewbuddy/bug', 'reviewbuddy/performance', 'reviewbuddy/suggestion']);
  assert.deepEqual(log.runs[0].properties, { provider: 'groq', model: 'm' });
});

test('formatSarif maps severities to levels: security and bug are errors, performance a warning, suggestion a note', () => {
  assert.deepEqual(SARIF_LEVEL, {
    security: 'error', bug: 'error', performance: 'warning', suggestion: 'note',
  });
  const log = formatSarif(results, { provider: 'groq', model: 'm' });
  assert.deepEqual(log.runs[0].results.map((r) => [r.ruleId, r.level]), [
    ['reviewbuddy/security', 'error'],
    ['reviewbuddy/bug', 'error'],
    ['reviewbuddy/performance', 'warning'],
    ['reviewbuddy/suggestion', 'note'],
  ]);
  assert.deepEqual(log.runs[0].tool.driver.rules.map((r) => r.defaultConfiguration.level), ['error', 'error', 'warning', 'note']);
});

test('formatSarif gives each result its location, line range and suggested fix', () => {
  const [security, bug] = formatSarif(results, { provider: 'groq', model: 'm' }).runs[0].results;
  assert.deepEqual(security.locations, [{ physicalLocation: { artifactLocation: { uri: 'src/a.js' }, region: { startLine: 2 } } }]);
  assert.equal(security.message.text, 'Hardcoded key\n\nSuggested fix: const key = process.env.KEY;');
  assert.deepEqual(bug.locations[0].physicalLocation.region, { startLine: 5, endLine: 7 });
  assert.equal(bug.message.text, 'Off-by-one');
});

test('formatSarif with no findings is a valid log with an empty results array', () => {
  const log = formatSarif([], { provider: 'ollama', model: 'm' });
  assertValidSarif(log);
  assert.deepEqual(log.runs[0].results, []);
});

test('lineRange shows a line or a range', () => {
  assert.equal(lineRange({ line: 4 }), '4');
  assert.equal(lineRange({ line: 4, endLine: 9 }), '4-9');
});
