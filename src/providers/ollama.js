// Ollama provider: talks to a model running locally via the Ollama REST API.
// Every provider in src/providers/ exports the same chat(systemPrompt, userPrompt, schema, options)
// function, so the reviewer doesn't care which backend it is using.

import { fetchWithRetry } from '../http.js';

const DEFAULT_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'qwen3.5:4b';
export const MODEL_VAR = 'OLLAMA_MODEL';
export const DEFAULT_TIMEOUT_MS = 600_000;
const NUM_CTX = 8192;
// Most user-prompt characters (diff plus file context) to send. num_ctx is 8192 tokens at about
// 3 characters each, and the system prompt and the reply need room too.
export const PROMPT_CHARS = 16_000;

export function modelName() {
  return process.env[MODEL_VAR] || DEFAULT_MODEL;
}

/**
 * Send a system + user prompt to Ollama and return the model's reply as text.
 * If a JSON schema is given, Ollama constrains the reply to it; otherwise the
 * reply is just some JSON. Parsing is left to the caller either way.
 *
 * The reply is streamed: Node's fetch gives up if no response headers arrive within
 * 5 minutes, and a slow model can take longer than that to finish a whole reply.
 * timeoutMs limits the whole request instead (0 = no limit). model defaults to modelName().
 */
export async function chat(systemPrompt, userPrompt, schema, { timeoutMs = DEFAULT_TIMEOUT_MS, model = modelName() } = {}) {
  const baseUrl = process.env.OLLAMA_URL || DEFAULT_URL;

  try {
    const response = await fetchWithRetry(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        format: schema ?? 'json',
        options: { temperature: 0.2, num_ctx: NUM_CTX },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    }, { label: 'Ollama', timeoutMs });

    if (!response.ok) {
      const details = await response.text();
      const hint = response.status === 404
        ? ` (model "${model}" isn't installed: set OLLAMA_MODEL to one listed by "ollama list", or run "ollama pull ${model}")`
        : '';
      throw new Error(`Ollama returned HTTP ${response.status}${hint}: ${details}`);
    }
    return await readStream(response);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Ollama didn't finish within ${timeoutMs / 1000}s. Use a smaller model or raise --timeout.`);
    }
    if (err.message.startsWith('Ollama')) throw err;
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to Ollama at ${baseUrl}. Is it running? Start it with "ollama serve".`);
    }
    throw new Error(`Request to Ollama at ${baseUrl} failed: ${err.cause?.message || err.message}`);
  }
}

/** Join the message content of Ollama's newline-delimited JSON chunks. */
async function readStream(response) {
  let content = '';
  let buffered = '';
  const handle = (line) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`Ollama failed: ${chunk.error}`);
    content += chunk.message?.content ?? '';
  };

  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop();
    lines.forEach(handle);
  }
  handle(buffered + decoder.decode());
  return content;
}
