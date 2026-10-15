// Picks the model backend for a run. Every provider exports chat(systemPrompt, userPrompt, schema, options),
// DEFAULT_MODEL, PROMPT_CHARS and modelName(); cloud providers also export checkConfig(), which throws if the API key is missing.

import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import * as groq from './groq.js';
import * as ollama from './ollama.js';
import * as openrouter from './openrouter.js';

const PROVIDERS = { ollama, groq, openrouter, gemini, anthropic };

let selected;

/**
 * Select the provider: name (from --provider), else REVIEWBUDDY_PROVIDER, else Ollama.
 * Throws now if the name is unknown or its API key is missing, before any review starts.
 * Returns describe().
 */
export function useProvider(name) {
  const wanted = name || process.env.REVIEWBUDDY_PROVIDER || 'ollama';
  const key = wanted.toLowerCase();
  if (!Object.hasOwn(PROVIDERS, key)) {
    throw new Error(`Unknown provider "${wanted}". Choose one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  PROVIDERS[key].checkConfig?.();
  selected = key;
  return describe();
}

/** Send a prompt to the selected provider (see ollama.js for the arguments). */
export function chat(...args) {
  return current().chat(...args);
}

/** The selected provider and model, for display: { provider, model }. */
export function describe() {
  const { modelName } = current();
  return { provider: selected, model: modelName() };
}

/** The most user-prompt characters (diff plus file context) the selected provider should get. */
export function promptChars() {
  return current().PROMPT_CHARS;
}

function current() {
  if (!selected) useProvider();
  return PROVIDERS[selected];
}
