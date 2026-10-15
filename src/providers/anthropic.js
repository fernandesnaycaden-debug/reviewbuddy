// Anthropic provider: Claude through the Messages API.

import { DEFAULT_TIMEOUT_MS, postJson, requireKey, withSchemaFallback } from './cloud.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const LABEL = 'Anthropic';
export const DEFAULT_MODEL = 'claude-opus-5-5';

const NO_COMMENTS = '{"comments":[]}';
// Models that can hand a declined request to another Claude model server-side.
// Security-focused reviews can trip a safety classifier, so this keeps the review going.
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

export function modelName() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export function checkConfig() {
  return requireKey('ANTHROPIC_API_KEY', LABEL, 'https://platform.claude.com/settings/keys');
}

/**
 * Send a system + user prompt to Claude and return the reply text, constrained to schema.
 * No temperature: current Claude models reject it.
 */
export async function chat(systemPrompt, userPrompt, schema, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = checkConfig();
  const model = modelName();
  const fallback = FALLBACK_MODELS.includes(model);
  const reply = await withSchemaFallback({ label: LABEL, model }, schema, (schema) => postJson(API_URL, {
    label: LABEL, model, timeoutMs,
    keyVar: 'ANTHROPIC_API_KEY',
    modelVar: 'ANTHROPIC_MODEL',
    schemaSent: Boolean(schema),
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(fallback && { 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
    },
    body: {
      model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...(schema && { output_config: { format: { type: 'json_schema', schema } } }),
      ...(fallback && { fallbacks: 'default' }),
    },
  }));

  if (reply.stop_reason === 'refusal') {
    console.warn(`  Claude declined to review this part (${reply.stop_details?.category ?? 'refusal'}), skipping it.`);
    return NO_COMMENTS;
  }
  // Thinking blocks come first; the answer is in the text blocks.
  return (reply.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
