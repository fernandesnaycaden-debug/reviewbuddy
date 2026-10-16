// Progress output. It goes to stdout, except while a JSON or SARIF document is being written
// there: then it goes to stderr, so stdout holds nothing but that document.

let toStderr = false;

/** Print progress, like console.log. */
export function info(...args) {
  (toStderr ? console.error : console.log)(...args);
}

/** Send info() to stderr (true) or back to stdout (false). */
export function logToStderr(on) {
  toStderr = on;
}
