// Helpers for running inside GitHub Actions: workflow-command annotations, the job summary, and fork detection.

import { appendFile, readFile } from 'node:fs/promises';
import { info } from './log.js';

/** True when running as a GitHub Actions step. */
export function inActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

/** Escape a workflow command's message, so a newline or % can't end or corrupt it. */
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow command property value, which also ends at : and ,. */
export function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** A workflow command such as "::error file=a.js,line=2,title=...::message". */
export function annotation(level, message, properties = {}) {
  const props = Object.entries(properties)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${escapeProperty(value)}`)
    .join(',');
  return `::${level}${props ? ` ${props}` : ''}::${escapeData(message)}`;
}

const ERROR_SEVERITIES = new Set(['security', 'bug']);

/** One annotation per finding: security and bug findings are errors, the rest warnings. */
export function annotationsFor(results) {
  return results.flatMap(({ filename, comments }) => comments.map((c) => annotation(
    ERROR_SEVERITIES.has(c.severity) ? 'error' : 'warning',
    c.message,
    { file: filename, line: c.line, title: `reviewbuddy: ${c.severity.toUpperCase()}` },
  )));
}

/** Print a warning that shows on the run page. */
export function warning(message) {
  info(annotation('warning', message));
}

/** Append Markdown to the job summary ($GITHUB_STEP_SUMMARY). Does nothing outside Actions. */
export async function appendStepSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!inActions() || !path) return;
  await appendFile(path, `${markdown}\n`, 'utf8');
}

/**
 * True if the triggering pull request comes from a fork (or a deleted one).
 * Fork PRs get no secrets and a read-only token. False if the event can't be read.
 */
export async function isForkPullRequest() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return false;
  let event;
  try {
    event = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return false;
  }
  const pr = event.pull_request;
  if (!pr) return false;
  return pr.head?.repo?.full_name !== pr.base?.repo?.full_name;
}
