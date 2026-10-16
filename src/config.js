// Settings for a run. Each one comes from the first of: a CLI flag, an environment variable
// (Action inputs become these), the reviewed repo's .reviewbuddy.json, the built-in default.
// Also loads .reviewbuddy.md, the repo's own review rules for the prompt.

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getFileContent } from './github.js';
import { DEFAULT_IGNORE, parsePatterns } from './ignore.js';
import { FORMATS, parseFormat } from './output.js';
import { modelVarFor, PROVIDER_NAMES } from './providers/index.js';
import { SEVERITIES, SEVERITY_ORDER } from './review.js';

export const CONFIG_FILE = '.reviewbuddy.json';
export const RULES_FILE = '.reviewbuddy.md';
// About 1,300 tokens. The rules go into every request, and Ollama's whole prompt budget is 16,000 characters.
export const MAX_RULES_CHARS = 4000;

// Key names that hold credentials. Those belong in environment variables or Actions secrets, never in the repo.
const SECRET_KEY = /api[-_]?key|token|secret|password|credential|_key$/i;

/** Validators for each .reviewbuddy.json key: (value, where) => the settings it sets. */
const FIELDS = {
  provider(value, where) {
    if (typeof value !== 'string' || !PROVIDER_NAMES.includes(value.toLowerCase())) {
      throw new Error(`${where} must be one of: ${PROVIDER_NAMES.join(', ')}.`);
    }
    return { provider: value.toLowerCase() };
  },
  model(value, where) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a model name.`);
    return { model: value.trim() };
  },
  ignore(value, where) {
    if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.trim())) {
      throw new Error(`${where} must be an array of file patterns, like ["src/generated/", "*.pb.js"].`);
    }
    return { ignore: value.map((p) => p.trim()) };
  },
  defaultIgnore(value, where) {
    if (typeof value !== 'boolean') throw new Error(`${where} must be true or false.`);
    return { defaultIgnore: value };
  },
  minSeverity(value, where) {
    if (typeof value !== 'string' || !SEVERITY_ORDER.includes(value.toLowerCase())) {
      throw new Error(`${where} must be one of: ${SEVERITY_ORDER.join(', ')}.`);
    }
    return { minSeverity: value.toLowerCase() };
  },
  failOn(value, where) {
    if (!Array.isArray(value) || !value.every((s) => typeof s === 'string' && SEVERITIES.includes(s.toLowerCase()))) {
      throw new Error(`${where} must be an array of severities (${SEVERITIES.join(', ')}), like ["security", "bug"].`);
    }
    return { failOn: [...new Set(value.map((s) => s.toLowerCase()))] };
  },
  timeout(value, where) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${where} must be a number of seconds, or 0 for no limit.`);
    }
    return { timeoutMs: value * 1000 };
  },
  format(value, where) {
    if (typeof value !== 'string' || !FORMATS.includes(value.toLowerCase())) {
      throw new Error(`${where} must be one of: ${FORMATS.join(', ')}.`);
    }
    return { format: value.toLowerCase() };
  },
};

/**
 * Parse and validate .reviewbuddy.json. label names the file in errors.
 * Returns { provider?, model?, ignore?, defaultIgnore?, minSeverity?, failOn?, timeoutMs?, format? }.
 * Unknown keys are warned about and skipped; anything that looks like a secret is an error.
 */
export function parseConfig(text, label = CONFIG_FILE) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must hold a JSON object, like {"minSeverity": "bug"}.`);
  }
  const secret = secretKey(raw);
  if (secret) {
    throw new Error(`${label} must not contain secrets, but it has "${secret}". Put API keys and tokens in environment variables, or in GitHub Actions secrets passed to the action's api-key and github-token inputs.`);
  }

  const settings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(FIELDS, key)) {
      console.warn(`Warning: unknown key "${key}" in ${label}, ignoring it. Known keys: ${Object.keys(FIELDS).join(', ')}.`);
      continue;
    }
    Object.assign(settings, FIELDS[key](value, `"${key}" in ${label}`));
  }
  if (settings.model && !settings.provider) {
    throw new Error(`"model" in ${label} needs "provider" next to it: model names differ between providers.`);
  }
  return settings;
}

/** The first key, at any depth, whose name looks like it holds a credential, or undefined. */
function secretKey(value) {
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (!Array.isArray(value) && SECRET_KEY.test(key)) return key;
    const found = secretKey(inner);
    if (found) return found;
  }
  return undefined;
}

/** .reviewbuddy.md trimmed and cut to MAX_RULES_CHARS (with a warning), or undefined if it is blank. */
export function parseRules(text, label = RULES_FILE) {
  const rules = text.replace(/^﻿/, '').trim();
  if (!rules) return undefined;
  if (rules.length <= MAX_RULES_CHARS) return rules;
  const cut = rules.slice(0, MAX_RULES_CHARS);
  const lastLine = cut.lastIndexOf('\n');
  console.warn(`Warning: ${label} is ${rules.length} characters; only the first ${MAX_RULES_CHARS} go into the prompt.`);
  return (lastLine > 0 ? cut.slice(0, lastLine) : cut).trimEnd();
}

/**
 * Find .reviewbuddy.json and .reviewbuddy.md for a local review: each is the nearest one in dir
 * or a parent, up to the git root. Outside a git repo only dir itself is checked, so a stray file
 * in a home or temp directory is never picked up. Returns { [name]: { text, label } }.
 */
export async function findLocalConfig(dir = '.') {
  const dirs = await searchDirs(dir);
  const found = {};
  for (const name of [CONFIG_FILE, RULES_FILE]) {
    for (const d of dirs) {
      const path = join(d, name);
      const text = await readText(path);
      if (text !== null) {
        found[name] = { text, label: path };
        break;
      }
    }
  }
  return found;
}

/** dir and its parents up to the one holding .git, nearest first. Just dir if there is no .git. */
async function searchDirs(dir) {
  const start = resolve(dir);
  const dirs = [];
  for (let d = start; ; d = dirname(d)) {
    dirs.push(d);
    if (await exists(join(d, '.git'))) return dirs;
    if (dirname(d) === d) return [start];
  }
}

/** True if path exists. .git is a directory, or a file in worktrees and submodules. */
function exists(path) {
  return stat(path).then(() => true, () => false);
}

/** A file's text, or null if it isn't there. */
async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
}

/**
 * Fetch .reviewbuddy.json and .reviewbuddy.md for a PR from its BASE commit, never its head.
 * The head is whatever the PR's author pushed: read from there, a PR could drop failOn, ignore
 * its own files or tell the model to report no issues. A config change applies once it is merged.
 * base is the PR's base ({ sha, ref }). Returns { [name]: { text, label } }.
 */
export async function loadRemoteConfig(pr, token, base) {
  const where = `base branch ${base.ref} @ ${base.sha.slice(0, 7)}`;
  const found = {};
  for (const name of [CONFIG_FILE, RULES_FILE]) {
    let text;
    try {
      text = await getFileContent(pr, token, name, base.sha);
    } catch (err) {
      const hint = err.status === 403 ? ' The token needs "Contents: Read".' : '';
      throw new Error(`Could not read ${name} from the ${where}: ${err.message}${hint} Pass --no-config (or set the action's config input to false) to review without it.`);
    }
    if (text !== null) found[name] = { text, label: `${name} (${where})` };
  }
  return found;
}

/**
 * Parse what findLocalConfig or loadRemoteConfig found: { file, rules, summary }.
 * file: the validated settings ({} without a .reviewbuddy.json). rules: .reviewbuddy.md's text, or undefined.
 * summary: the line saying what was loaded, or null if neither file exists.
 */
export function loadConfig(found) {
  const json = found[CONFIG_FILE];
  const md = found[RULES_FILE];
  const labels = [json, md].filter(Boolean).map((f) => f.label);
  return {
    file: json ? parseConfig(json.text, json.label) : {},
    rules: md ? parseRules(md.text, md.label) : undefined,
    summary: labels.length > 0 ? `Config: ${labels.join(', ')}` : null,
  };
}

/**
 * The settings for this run, from flags (parseArgs values), env (process.env) and file (parseConfig's result).
 * Each setting takes the first of: flag, environment variable, file, default. An empty variable
 * counts as unset, since the action passes empty inputs as empty variables.
 * Ignore patterns add up: the defaults (unless turned off), then the file's, the variable's and the flag's.
 * providerSource says where the provider came from: a flag or variable name, CONFIG_FILE or 'default'.
 */
export function resolveSettings({ flags = {}, env = {}, file = {} }) {
  const cliProvider = given(flags, env, 'provider', 'REVIEWBUDDY_PROVIDER');
  const provider = cliProvider?.value || file.provider || 'ollama';
  const providerSource = cliProvider ? cliProvider.label : file.provider ? CONFIG_FILE : 'default';

  const failOn = given(flags, env, 'fail-on', 'REVIEWBUDDY_FAIL_ON');
  const minSeverity = given(flags, env, 'min-severity', 'REVIEWBUDDY_MIN_SEVERITY');
  const timeout = given(flags, env, 'timeout', 'REVIEWBUDDY_TIMEOUT');
  const format = given(flags, env, 'format', 'REVIEWBUDDY_FORMAT');
  const defaultIgnore = flags['no-default-ignore'] ? false : file.defaultIgnore ?? true;

  return {
    provider,
    providerSource,
    model: resolveModel(provider, providerSource, env, file),
    failOn: failOn ? parseFailOn(failOn.value, failOn.label) : file.failOn ?? [],
    minSeverity: minSeverity ? parseMinSeverity(minSeverity.value, minSeverity.label) : file.minSeverity,
    timeoutMs: timeout ? parseTimeout(timeout.value, timeout.label) : file.timeoutMs,
    // undefined: --output's extension decides, else text.
    format: format ? parseFormat(format.value, format.label) : file.format,
    defaultIgnore,
    ignorePatterns: [
      ...(defaultIgnore ? DEFAULT_IGNORE : []),
      ...(file.ignore ?? []),
      ...parsePatterns(env.REVIEWBUDDY_IGNORE),
      ...parsePatterns(flags.ignore),
    ],
  };
}

/** { value, label } from the flag if passed, else from a non-empty variable, else undefined. */
function given(flags, env, flag, envVar) {
  if (flags[flag] !== undefined) return { value: flags[flag], label: `--${flag}` };
  if (env[envVar]) return { value: env[envVar], label: envVar };
  return undefined;
}

/**
 * The model: the provider's *_MODEL variable, else the file's model if the file's provider is the
 * one in use, else undefined for the provider's default. An unknown provider is reported by useProvider.
 */
function resolveModel(provider, providerSource, env, file) {
  const key = provider.toLowerCase();
  if (!PROVIDER_NAMES.includes(key)) return undefined;
  const fromEnv = env[modelVarFor(key)];
  if (fromEnv) return fromEnv;
  if (!file.model) return undefined;
  if (file.provider === key) return file.model;
  console.warn(`Warning: not using "model" from ${CONFIG_FILE}: it is for ${file.provider}, but ${providerSource} selects ${key}.`);
  return undefined;
}

/** Severities from a comma-separated list ("security,bug"). [] means never fail. label names the source in errors. */
export function parseFailOn(value, label = '--fail-on') {
  if (!value) return [];
  const wanted = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.find((s) => !SEVERITIES.includes(s));
  if (unknown !== undefined) {
    throw new Error(`Unknown severity "${unknown}" in ${label}. Use a comma-separated list of: ${SEVERITIES.join(', ')}.`);
  }
  return [...new Set(wanted)];
}

/** The least serious severity to keep. undefined keeps everything. label names the source in errors. */
export function parseMinSeverity(value, label = '--min-severity') {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return undefined;
  if (!SEVERITY_ORDER.includes(wanted)) {
    throw new Error(`Unknown severity "${value.trim()}" in ${label}. Use one of: ${SEVERITY_ORDER.join(', ')}.`);
  }
  return wanted;
}

/** Seconds, in milliseconds. undefined = the provider's default. label names the source in errors. */
export function parseTimeout(value, label = '--timeout') {
  if (value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid timeout "${value}" in ${label}: give a number of seconds, or 0 for no limit.`);
  }
  return seconds * 1000;
}
