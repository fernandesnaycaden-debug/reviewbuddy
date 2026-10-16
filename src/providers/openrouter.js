// OpenRouter provider: many hosted models behind one OpenAI-compatible API.
// The default, openrouter/free, routes each request to a free model.

import { openAICompatible } from './openai-compatible.js';

export const {
  chat, modelName, checkConfig, DEFAULT_MODEL, PROMPT_CHARS, MODEL_VAR,
} = openAICompatible({
  label: 'OpenRouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  keyVar: 'OPENROUTER_API_KEY',
  keyUrl: 'https://openrouter.ai/settings/keys',
  modelVar: 'OPENROUTER_MODEL',
  defaultModel: 'openrouter/free',
  // Free models' context windows vary, so stay well inside the smaller ones.
  promptChars: 40_000,
  // Optional attribution, shown on openrouter.ai.
  headers: { 'HTTP-Referer': 'https://github.com/fernandesnaycaden-debug/reviewbuddy', 'X-Title': 'reviewbuddy' },
  // Only route to providers that honour the JSON schema, rather than ones that ignore it.
  schemaBody: { provider: { require_parameters: true } },
  hints: { 402: 'out of credits: add credits on openrouter.ai, or use a free model' },
});
