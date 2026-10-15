#!/usr/bin/env node
import { annotation, inActions } from '../src/actions.js';
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${err.message}`);
  // In GitHub Actions, also show it as an error annotation on the run page.
  if (inActions()) console.log(annotation('error', err.message));
  // Not process.exit(): exiting while fetch sockets close crashes Node on Windows.
  process.exitCode = 1;
});
