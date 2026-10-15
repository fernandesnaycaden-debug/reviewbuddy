import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { main } from '../src/index.js';
import * as anthropic from '../src/providers/anthropic.js';
import * as gemini from '../src/providers/gemini.js';
import * as groq from '../src/providers/groq.js';
import { chat, describe, useProvider } from '../src/providers/index.js';
import * as openrouter from '../src/providers/openrouter.js';

const SCHEMA = { type: 'object', properties: { comments: { type: 'array' } }, required: ['comments'], additionalProperties: false };
const REPLY = '{"comments":[]}';
const KEY = 'sk-secret-test-key';

const PROVIDER_VARS = [
  'REVIEWBUDDY_PROVIDER', 'OLLAMA_MODEL',
  'GROQ_API_KEY', 'GROQ_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  // When the tests themselves run in GitHub Actions.
  'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_EVENT_PATH', 'REVIEWBUDDY_FAIL_ON',
];

let saved;
beforeEach(() => {
  // Start every test from a clean slate, whatever the developer's shell has set.
  saved = Object.fromEntries(PROVIDER_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_VARS) delete process.env[k];
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Mock fetch with a list of responses, one per call, and record each request. */
function mockFetch(...responses) {
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return responses.shift();
  });
  return requests;
}

/** An error response. Retry-After: 0 keeps fetchWithRetry's retries of 429 instant. */
function errorReply(status, message) {
  return Response.json({ error: { message } }, { status, headers: { 'Retry-After': '0' } });
}

// Selection

test('useProvider defaults to ollama', () => {
  assert.deepEqual(useProvider(), { provider: 'ollama', model: 'qwen3.5:4b' });
});

test('useProvider reads REVIEWBUDDY_PROVIDER, and a name passed in wins over it', () => {
  process.env.REVIEWBUDDY_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = KEY;
  process.env.GEMINI_API_KEY = KEY;
  assert.deepEqual(useProvider(), { provider: 'groq', model: 'openai/gpt-oss-20b' });
  assert.deepEqual(useProvider('Gemini'), { provider: 'gemini', model: 'gemini-3.8-flash' });
  assert.deepEqual(describe(), { provider: 'gemini', model: 'gemini-3.8-flash' });
});

test('useProvider rejects an unknown provider', () => {
  assert.throws(() => useProvider('nope'), /Unknown provider "nope"\. Choose one of: ollama, groq, openrouter, gemini, anthropic\./);
});

test('useProvider fails fast when the API key is missing', () => {
  assert.throws(() => useProvider('groq'), /Set GROQ_API_KEY to use Groq/);
  assert.throws(() => useProvider('openrouter'), /Set OPENROUTER_API_KEY/);
  assert.throws(() => useProvider('gemini'), /Set GEMINI_API_KEY/);
  assert.throws(() => useProvider('anthropic'), /Set ANTHROPIC_API_KEY/);
});

test('main checks the provider before reviewing anything', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
  await assert.rejects(main(['--provider', 'gemini', 'missing.diff']), /Set GEMINI_API_KEY/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('main uses --provider over REVIEWBUDDY_PROVIDER', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reviewbuddy-'));
  try {
    const diffPath = join(dir, 'changes.diff');
    await writeFile(diffPath, 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+x\n');
    process.env.REVIEWBUDDY_PROVIDER = 'gemini';
    process.env.GROQ_API_KEY = KEY;
    const requests = mockFetch(Response.json({ choices: [{ message: { content: REPLY } }] }));
    await main(['--provider', 'groq', diffPath]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chat goes to the selected provider', async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  useProvider('anthropic');
  const requests = mockFetch(Response.json({ content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn' }));
  assert.equal(await chat('sys', 'user', SCHEMA), REPLY);
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
});

// Groq and OpenRouter

test('groq sends an OpenAI-style request with a strict JSON schema', async () => {
  process.env.GROQ_API_KEY = KEY;
  const requests = mockFetch(Response.json({ choices: [{ message: { content: REPLY } }] }));

  assert.equal(await groq.chat('sys', 'user', SCHEMA), REPLY);

  const [{ url, headers, body }] = requests;
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }]);
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'review', strict: true, schema: SCHEMA } });
  assert.equal(body.provider, undefined);
});

test('groq falls back to JSON mode when the model rejects the schema, and remembers it', async () => {
  process.env.GROQ_API_KEY = KEY;
  process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
  const requests = mockFetch(
    errorReply(400, 'response_format json_schema is not supported by this model'),
    Response.json({ choices: [{ message: { content: REPLY } }] }),
    Response.json({ choices: [{ message: { content: REPLY } }] }),
  );

  assert.equal(await groq.chat('sys', 'user', SCHEMA), REPLY);
  assert.equal(await groq.chat('sys', 'user', SCHEMA), REPLY);

  assert.equal(requests[0].body.model, 'llama-3.3-70b-versatile');
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.deepEqual(requests[1].body.response_format, { type: 'json_object' });
  assert.deepEqual(requests[2].body.response_format, { type: 'json_object' });
  assert.equal(console.warn.mock.callCount(), 1);
});

test('groq returns a reply it rejected as invalid JSON, so the reviewer can retry, and keeps the schema', async () => {
  process.env.GROQ_API_KEY = KEY;
  const requests = mockFetch(
    Response.json({ error: { message: 'Failed to validate JSON.', code: 'json_validate_failed', failed_generation: '{"comments": [' } }, { status: 400 }),
    Response.json({ choices: [{ message: { content: REPLY } }] }),
  );

  assert.equal(await groq.chat('sys', 'user', SCHEMA), '{"comments": [');
  assert.equal(await groq.chat('sys', 'user', SCHEMA), REPLY);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.response_format.type, 'json_schema');
  assert.match(console.warn.mock.calls[0].arguments[0], /Groq returned HTTP 400: Failed to validate JSON\./);
});

test('openrouter adds attribution headers and only routes to providers that honour the schema', async () => {
  process.env.OPENROUTER_API_KEY = KEY;
  const requests = mockFetch(Response.json({ choices: [{ message: { content: REPLY } }] }));

  assert.equal(await openrouter.chat('sys', 'user', SCHEMA), REPLY);

  const [{ url, headers, body }] = requests;
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers['X-Title'], 'reviewbuddy');
  assert.equal(body.model, 'openrouter/free');
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.equal(body.response_format.type, 'json_schema');
});

// Gemini

test('gemini puts the key in a header and the schema in responseFormat', async () => {
  process.env.GEMINI_API_KEY = KEY;
  const requests = mockFetch(Response.json({
    candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"comments":' }, { text: '[]}' }] } }],
  }));

  assert.equal(await gemini.chat('sys', 'user', SCHEMA), REPLY);

  const [{ url, headers, body }] = requests;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.ok(!url.includes(KEY));
  assert.equal(headers['x-goog-api-key'], KEY);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'user' }] }]);
  assert.deepEqual(body.generationConfig.responseFormat, { text: { mimeType: 'application/json', schema: SCHEMA } });
});

test('gemini treats a blocked prompt as no findings', async () => {
  process.env.GEMINI_API_KEY = KEY;
  mockFetch(Response.json({ promptFeedback: { blockReason: 'SAFETY' } }));
  assert.equal(await gemini.chat('sys', 'user', SCHEMA), REPLY);
  assert.match(console.warn.mock.calls[0].arguments[0], /Gemini blocked this part \(SAFETY\)/);
});

test('gemini reports an invalid key as a bad key, not a schema problem', async () => {
  process.env.GEMINI_API_KEY = KEY;
  const requests = mockFetch(Response.json(
    { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } },
    { status: 400 },
  ));
  await assert.rejects(gemini.chat('sys', 'user', SCHEMA), /Gemini returned HTTP 400 \(Gemini rejected the API key in GEMINI_API_KEY\)/);
  assert.equal(requests.length, 1);
});

// Anthropic

test('anthropic sends a Messages API request with structured output and refusal fallbacks', async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  const requests = mockFetch(Response.json({
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: REPLY }],
    stop_reason: 'end_turn',
  }));

  assert.equal(await anthropic.chat('sys', 'user', SCHEMA), REPLY);

  const [{ url, headers, body }] = requests;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'user' }]);
  assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: SCHEMA } });
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.temperature, undefined);
});

test('anthropic leaves out fallbacks for models without them', async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.ANTHROPIC_MODEL = 'claude-haiku-5-5';
  const requests = mockFetch(Response.json({ content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn' }));

  await anthropic.chat('sys', 'user', SCHEMA);

  assert.equal(requests[0].body.model, 'claude-haiku-5-5');
  assert.equal(requests[0].body.fallbacks, undefined);
  assert.equal(requests[0].headers['anthropic-beta'], undefined);
});

test('anthropic treats a refusal as no findings', async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  mockFetch(Response.json({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }));
  assert.equal(await anthropic.chat('sys', 'user', SCHEMA), REPLY);
  assert.match(console.warn.mock.calls[0].arguments[0], /Claude declined to review this part \(cyber\)/);
});

// Errors

test('a rejected key says which variable to fix, without printing the key', async () => {
  process.env.GROQ_API_KEY = KEY;
  mockFetch(errorReply(401, 'Invalid API Key'));
  await assert.rejects(groq.chat('sys', 'user', SCHEMA), (err) => {
    assert.match(err.message, /^Groq returned HTTP 401 \(Groq rejected the API key in GROQ_API_KEY\): Invalid API Key$/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('an unknown model says which variable to set', async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.ANTHROPIC_MODEL = 'claude-nope';
  mockFetch(errorReply(404, 'model: claude-nope'));
  await assert.rejects(anthropic.chat('sys', 'user', SCHEMA),
    /Anthropic returned HTTP 404 \(model "claude-nope" not found: set ANTHROPIC_MODEL to a model Anthropic offers\)/);
});

test('a rate limit is reported plainly once the retries run out', async () => {
  process.env.OPENROUTER_API_KEY = KEY;
  const requests = mockFetch(...Array.from({ length: 4 }, () => errorReply(429, 'Rate limit exceeded: free-models-per-day')));
  await assert.rejects(openrouter.chat('sys', 'user', SCHEMA), /OpenRouter returned HTTP 429 \(rate limited: .*\): Rate limit exceeded/);
  assert.equal(requests.length, 4);
});

test('openrouter explains running out of credits', async () => {
  process.env.OPENROUTER_API_KEY = KEY;
  mockFetch(errorReply(402, 'Insufficient credits'));
  await assert.rejects(openrouter.chat('sys', 'user', SCHEMA), /HTTP 402 \(out of credits: .*\): Insufficient credits/);
});
