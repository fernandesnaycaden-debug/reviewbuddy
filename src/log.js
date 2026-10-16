// Progress output. It goes to stdout, except while a JSON or SARIF document is being written
// there: then it goes to stderr, so stdout holds nothing but that document.
// While files are reviewed in parallel, each file's lines are held back and printed as one block.

import { AsyncLocalStorage } from 'node:async_hooks';

let toStderr = false;
const buffer = new AsyncLocalStorage();

/** Print progress, like console.log. */
export function info(...args) {
  write('info', args);
}

/** Print a warning, like console.warn. */
export function warn(...args) {
  write('warn', args);
}

/** Send info() to stderr (true) or back to stdout (false). */
export function logToStderr(on) {
  toStderr = on;
}

/**
 * Run fn, holding back what it (and everything it awaits) prints with info() and warn().
 * Returns { value, lines } on success; on failure the error carries the lines as err.lines.
 */
export async function buffered(fn) {
  const lines = [];
  try {
    return { value: await buffer.run(lines, fn), lines };
  } catch (err) {
    throw Object.assign(err, { lines });
  }
}

/** Print lines held back by buffered(), in order. */
export function flush(lines = []) {
  for (const [kind, args] of lines) print(kind, args);
}

function write(kind, args) {
  const lines = buffer.getStore();
  if (lines) lines.push([kind, args]);
  else print(kind, args);
}

function print(kind, args) {
  if (kind === 'warn') console.warn(...args);
  else (toStderr ? console.error : console.log)(...args);
}
