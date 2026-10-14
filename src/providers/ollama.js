// Ollama provider: talks to a model running locally via the Ollama REST API.
// Every provider in src/providers/ exports the same chat(systemPrompt, userPrompt)
// function, so the reviewer doesn't care which backend it is using.

const DEFAULT_URL = 'http://localhost:11434';
export const DEFAULT_MODEL ='qwen3.5:4b';

/**
 * Send a system + user prompt to Ollama and return the model's reply as text.
 * The model is asked to answer in JSON, but parsing is left to the caller.
 */
export async function chat(systemPrompt, userPrompt) {
  const baseUrl = process.env.OLLAMA_URL || DEFAULT_URL;
  const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to Ollama at ${baseUrl}. Is it running? Start it with "ollama serve".`);
    }
    throw new Error(`Request to Ollama at ${baseUrl} failed: ${err.cause?.message || err.message}`);
  }

  if (!response.ok) {
    const details = await response.text();
    const hint = response.status === 404
      ? ` (model "${model}" isn't installed: set OLLAMA_MODEL to one listed by "ollama list", or run "ollama pull ${model}")`
      : '';
    throw new Error(`Ollama returned HTTP ${response.status}${hint}: ${details}`);
  }

  const data = await response.json();
  return data.message?.content ?? '';
}
