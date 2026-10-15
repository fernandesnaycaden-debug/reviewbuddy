// Gemini provider: Google's Generative Language API (generateContent). Has a free tier.

import { DEFAULT_TIMEOUT_MS, postJson, requireKey, withSchemaFallback } from './cloud.js';

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const LABEL = 'Gemini';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
// Most user-prompt characters (diff plus file context) to send, about 20k tokens.
export const PROMPT_CHARS = 60_000;

const NO_COMMENTS = '{"comments":[]}';
const BLOCKED_FINISH_REASONS = ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'];

export function modelName() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

export function checkConfig() {
  return requireKey('GEMINI_API_KEY', LABEL, 'https://aistudio.google.com/apikey');
}

/**
 * Send a system + user prompt to Gemini and return the reply text, constrained to schema.
 * The key goes in a header rather than the URL, so it can't end up in an error message.
 */
export async function chat(systemPrompt, userPrompt, schema, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = checkConfig();
  const model = modelName();
  const reply = await withSchemaFallback({ label: LABEL, model }, schema, (schema) => postJson(`${API_URL}/${model}:generateContent`, {
    label: LABEL, model, timeoutMs,
    keyVar: 'GEMINI_API_KEY',
    modelVar: 'GEMINI_MODEL',
    schemaSent: Boolean(schema),
    headers: { 'x-goog-api-key': key },
    body: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseFormat: { text: { mimeType: 'application/json', ...(schema && { schema }) } },
      },
    },
  }));
  return replyText(reply);
}

/** Join the reply's text parts, leaving out thoughts. A blocked reply counts as no findings. */
function replyText(reply) {
  const candidate = reply.candidates?.[0];
  const blocked = reply.promptFeedback?.blockReason
    ?? (BLOCKED_FINISH_REASONS.includes(candidate?.finishReason) ? candidate.finishReason : null)
    ?? (candidate ? null : 'no reply');
  if (blocked) {
    console.warn(`  Gemini blocked this part (${blocked}), skipping it.`);
    return NO_COMMENTS;
  }
  return (candidate.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
}
