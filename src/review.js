import { addedLines, chunkDiff, numberDiffLines } from './diff.js';
import { chat } from './providers/ollama.js';

const SEVERITIES = ['bug', 'security', 'performance', 'suggestion'];

// Ollama constrains the reply to this schema, so the model can't answer in the wrong shape.
const COMMENTS_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          message: { type: 'string' },
        },
        required: ['line', 'severity', 'message'],
      },
    },
  },
  required: ['comments'],
};

// The context window is 8192 tokens. Code averages about 3 characters per token, and
// the system prompt and the reply need room too, so a piece of diff stays well under that.
const MAX_CHUNK_CHARS = 16000;

const SYSTEM_PROMPT = `You are a senior code reviewer. Review the diff you are given.

Rules:
- Report only real problems: bugs, security issues, performance problems, and bad error handling.
- Do NOT comment on style, formatting, naming, or missing comments.
- Only comment on added lines (marked with "+"). Ignore context and removed lines.
- Each added line is prefixed with its line number in the new file. Use that number for "line".
- If there are no real problems, return an empty list.

Reply with JSON only, in exactly this shape:
{"comments": [{"line": <number>, "severity": "bug" | "security" | "performance" | "suggestion", "message": "<short explanation and fix>"}]}`;

const RETRY_NOTE = '\n\nYour previous reply was not valid JSON in the required shape. Reply with JSON only, exactly as described.';

/**
 * Review a unified diff and return a list of { line, severity, message } comments.
 * Big diffs are reviewed in pieces. Comments on lines that weren't added are dropped.
 */
export async function reviewDiff(filename, diff) {
  const chunks = chunkDiff(diff, MAX_CHUNK_CHARS);
  const comments = [];
  for (const [i, chunk] of chunks.entries()) {
    if (chunks.length > 1) console.log(`  part ${i + 1}/${chunks.length} ...`);
    comments.push(...await reviewChunk(filename, chunk));
  }

  const added = addedLines(diff);
  const kept = comments.filter((c) => added.has(c.line));
  if (kept.length < comments.length) {
    console.warn(`  Dropped ${comments.length - kept.length} comment(s) on lines that weren't added.`);
  }
  return kept;
}

async function reviewChunk(filename, diff) {
  const userPrompt = `File: ${filename}\n\n${numberDiffLines(diff)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await chat(SYSTEM_PROMPT, attempt === 1 ? userPrompt : userPrompt + RETRY_NOTE, COMMENTS_SCHEMA);
    const comments = parseComments(reply);
    if (comments) return comments;
    if (attempt === 1) console.warn('Warning: model returned invalid JSON, retrying once...');
  }

  console.warn('Warning: model returned invalid JSON twice, skipping this part of the file.');
  return [];
}

/**
 * Parse the model's reply. Returns null if it isn't the JSON we asked for,
 * and silently drops individual comments that are malformed.
 */
export function parseComments(reply) {
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
