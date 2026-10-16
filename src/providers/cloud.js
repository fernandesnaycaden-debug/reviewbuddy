// Shared plumbing for the cloud providers: API keys, HTTP errors, and falling back
// to plain JSON mode when an API or model won't take a JSON schema.

import { fetchWithRetry } from '../http.js';
import { warn } from '../log.js';

export const DEFAULT_TIMEOUT_MS = 300_000;
// Files reviewed at once on a paid API. Free tiers get less (see groq.js, openrouter.js).
export const DEFAULT_CONCURRENCY = 4;

/** Return the API key in keyVar, or explain where to get one. The error has code MISSING_API_KEY. */
export function requireKey(keyVar, label, keyUrl) {
  const key = process.env[keyVar];
  if (!key) {
    throw Object.assign(new Error(`Set ${keyVar} to use ${label}. Get a key at ${keyUrl}`), { code: 'MISSING_API_KEY' });
  }
  return key;
}

/** The API refused the structured-output request itself, so plain JSON mode is worth a try. */
class SchemaRejectedError extends Error {}

/**
 * The model's reply didn't match the requested JSON, and the API refused it (Groq's json_validate_failed).
 * output is the model's raw reply, so the caller can treat it like any other invalid reply.
 */
export class InvalidReplyError extends Error {
  constructor(message, output) {
    super(message);
    this.output = output;
  }
}

/**
 * POST body as JSON and return the parsed reply. Errors name the provider and say
 * what to fix. They are built from the status and the API's own message, never the key.
 * schemaSent: a 400 may mean the schema isn't supported, so throw SchemaRejectedError for it.
 */
export async function postJson(url, { label, headers, body, timeoutMs, model, keyVar, modelVar, schemaSent = false, hints = {} }) {
  let response;
  try {
    response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }, { label, timeoutMs });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`${label} didn't reply within ${timeoutMs / 1000}s. Try a smaller model or raise --timeout.`);
    }
    throw new Error(`Request to ${label} failed: ${err.cause?.message || err.message}`);
  }
  if (response.ok) return response.json();

  const details = await response.text();
  const { status } = response;
  const message = errorMessage(details);
  const badKey = status === 401 || status === 403 || /API_KEY_INVALID/.test(details);
  // The model answered, but not in the requested shape. That's about this reply, not about schema support.
  const failed = errorBody(details)?.error;
  if (status === 400 && failed?.code === 'json_validate_failed') {
    throw new InvalidReplyError(`${label} returned HTTP ${status}: ${message}`, failed.failed_generation ?? '');
  }
  // OpenRouter answers 404 when no provider for the model supports the requested parameters.
  if (schemaSent && !badKey && (status === 400 || (status === 404 && /support/i.test(details)))) {
    throw new SchemaRejectedError(`${label} returned HTTP ${status}: ${message}`);
  }

  // These fail every file the same way, so the run stops instead of trying the rest (see mapPool).
  const fatal = badKey || status === 404 || status === 402;
  const hint = badKey ? `${label} rejected the API key in ${keyVar}`
    : status === 404 ? `model "${model}" not found: set ${modelVar} to a model ${label} offers`
    : status === 429 ? `rate limited: ${label}'s free tier has per-minute and daily limits. Wait a bit, or switch provider`
    : hints[status];
  throw Object.assign(new Error(`${label} returned HTTP ${status}${hint ? ` (${hint})` : ''}: ${message}`), { fatal });
}

/** The error text from an API's JSON error body, or the raw body if it isn't one. */
function errorMessage(details) {
  const parsed = errorBody(details);
  return parsed?.error?.message ?? parsed?.message ?? details;
}

/** An API's error body parsed as JSON, or null if it isn't JSON. */
function errorBody(details) {
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

// label/model pairs that rejected a schema, so later requests skip straight to JSON mode.
const schemaRejected = new Set();

/**
 * Call send(schema) and return its result. If the API rejects the schema, warn and
 * call send(null) for plain JSON mode, for this and every later request to that model.
 */
export async function withSchemaFallback({ label, model }, schema, send) {
  const key = `${label}:${model}`;
  if (!schema || schemaRejected.has(key)) return send(null);
  try {
    return await send(schema);
  } catch (err) {
    if (!(err instanceof SchemaRejectedError)) throw err;
    schemaRejected.add(key);
    warn(`Warning: ${err.message}\nRetrying without the JSON schema, in plain JSON mode...`);
    return send(null);
  }
}
