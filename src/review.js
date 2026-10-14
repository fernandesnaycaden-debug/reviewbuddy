import { chat } from './providers/ollama.js';

const SEVERITIES = ['bug', 'security', 'performance', 'suggestion'];

const SYSTEM_PROMPT = `You are a senior code reviewer. Review the diff you are given.

Rules:
- Report only real problems: bugs, security issues, performance problems, and bad error handling.
- Do NOT comment on style, formatting, naming, or missing comments.
- Only comment on added lines (marked with "+"). Ignore context and removed lines.
- Each added line is prefixed with its line number in the new file. Use that number for "line".
- If there are no real problems, return an empty list.

Reply with JSON only, in exactly this shape:
{"comments": [{"line": <number>, "severity": "bug" | "security" | "performance" | "suggestion", "message": "<short explanation and fix>"}]}`;

/**
 * Review a unified diff and return a list of { line, severity, message } comments.
 */
export async function reviewDiff(filename, diff) {
  const userPrompt = `File: ${filename}\n\n${numberDiffLines(diff)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await chat(SYSTEM_PROMPT, userPrompt);
    const comments = parseComments(reply);
    if (comments) return comments;
    if (attempt === 1) console.warn('Warning: model returned invalid JSON, retrying once...');
  }

  console.warn('Warning: model returned invalid JSON twice, skipping this file.');
  return [];
}

/**
 * Small models are bad at counting lines inside a diff, so we do it for them:
 * every added or context line gets its line number in the new file.
 */
function numberDiffLines(diff) {
  let newLine = 0;
  return diff
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) {
        newLine = Number(hunk[1]);
        return line;
      }
      if (line.startsWith('+++') || line.startsWith('---')) return line;
      // An empty line is a blank context line whose leading space was stripped by an editor.
      if (newLine > 0 && line === '') line = ' ';
      if (line.startsWith('+') || line.startsWith(' ')) return `${String(newLine++).padStart(4)} ${line}`;
      if (line.startsWith('-')) return `     ${line}`;
      return line;
    })
    .join('\n');
}

/**
 * Parse the model's reply. Returns null if it isn't the JSON we asked for,
 * and silently drops individual comments that are malformed.
 */
function parseComments(reply) {
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.comments)) return null;

  return parsed.comments
    .filter((c) => Number.isInteger(Number(c?.line)) && typeof c.message === 'string')
    .map((c) => {
      const severity = String(c.severity).toLowerCase();
      return {
        line: Number(c.line),
        severity: SEVERITIES.includes(severity) ? severity : 'suggestion',
        message: c.message.trim(),
      };
    });
}
