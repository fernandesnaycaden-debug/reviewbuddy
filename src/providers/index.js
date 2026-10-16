// Picks the model backend for a run. Every provider exports chat(systemPrompt, userPrompt, schema, options),
// DEFAULT_MODEL, PROMPT_CHARS, MODEL_VAR and modelName(); cloud providers also export checkConfig(), which throws if the API key is missing.

import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import * as groq from './groq.js';
import * as ollama from './ollama.js';
import * as openrouter from './openrouter.js';

const PROVIDERS = { ollama, groq, openrouter, gemini, anthropic };
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

let selected;
let selectedModel;

/**
 * Select the provider by name (default Ollama) and, optionally, its model (default: the provider's own).
 * Which name and model win is decided in config.js. Throws now if the name is unknown or its
 * API key is missing, before any review starts. Returns describe().
 */
export function useProvider(name = 'ollama', { model } = {}) {
  const key = name.toLowerCase();
  if (!Object.hasOwn(PROVIDERS, key)) {
    throw new Error(`Unknown provider "${name}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  PROVIDERS[key].checkConfig?.();
  selected = key;
  selectedModel = model || PROVIDERS[key].modelName();
  return describe();
}

/** The environment variable holding the model name for a provider, e.g. GROQ_MODEL. */
export function modelVarFor(name) {
  return PROVIDERS[name.toLowerCase()].MODEL_VAR;
}

/** Send a prompt to the selected provider and model (see ollama.js for the arguments). */
export function chat(systemPrompt, userPrompt, schema, options = {}) {
  const provider = current();
  return provider.chat(systemPrompt, userPrompt, schema, { ...options, model: selectedModel });
}

/** The selected provider and model, for display: { provider, model }. */
export function describe() {
  current();
  return { provider: selected, model: selectedModel };
}

/** The most user-prompt characters (diff plus file context) the selected provider should get. */
export function promptChars() {
  return current().PROMPT_CHARS;
}

function current() {
  if (!selected) useProvider();
  return PROVIDERS[selected];
}
