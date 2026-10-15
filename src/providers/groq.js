// Groq provider: hosted open models through Groq's OpenAI-compatible API. Has a free tier.

import { openAICompatible } from './openai-compatible.js';

export const { chat, modelName, checkConfig, DEFAULT_MODEL, PROMPT_CHARS } = openAICompatible({
  label: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  keyVar: 'GROQ_API_KEY',
  keyUrl: 'https://console.groq.com/keys',
  modelVar: 'GROQ_MODEL',
  defaultModel: 'openai/gpt-oss-20b',
  // Kept small: the free tier limits tokens per minute.
  promptChars: 24_000,
});
