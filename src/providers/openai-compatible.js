// Shared client for APIs that speak OpenAI's chat completions format (Groq, OpenRouter).

import {
  DEFAULT_TIMEOUT_MS, InvalidReplyError, postJson, requireKey, withSchemaFallback,
} from './cloud.js';

/**
 * Build a provider for an OpenAI-compatible /chat/completions endpoint.
 * headers are sent with every request; schemaBody is merged into requests that carry a schema.
 */
export function openAICompatible({ label, url, keyVar, keyUrl, modelVar, defaultModel, headers = {}, schemaBody = {}, hints }) {
  const modelName = () => process.env[modelVar] || defaultModel;
  const checkConfig = () => requireKey(keyVar, label, keyUrl);

  /**
   * Send a system + user prompt and return the reply text, constrained to schema where the model allows.
   * A reply the API rejected as invalid JSON is returned as is; the reviewer retries it like any bad reply.
   */
  async function chat(systemPrompt, userPrompt, schema, options) {
    try {
      return await send(systemPrompt, userPrompt, schema, options);
    } catch (err) {
      if (!(err instanceof InvalidReplyError)) throw err;
      console.warn(`Warning: ${err.message}`);
      return err.output;
    }
  }

  async function send(systemPrompt, userPrompt, schema, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const key = checkConfig();
    const model = modelName();
    const reply = await withSchemaFallback({ label, model }, schema, (schema) => postJson(url, {
      label, model, keyVar, modelVar, timeoutMs, hints,
      schemaSent: Boolean(schema),
      headers: { Authorization: `Bearer ${key}`, ...headers },
      body: {
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: schema
          ? { type: 'json_schema', json_schema: { name: 'review', strict: true, schema } }
          : { type: 'json_object' },
        ...(schema && schemaBody),
      },
    }));
    return reply.choices?.[0]?.message?.content ?? '';
  }

  return { chat, modelName, checkConfig, DEFAULT_MODEL: defaultModel };
}
