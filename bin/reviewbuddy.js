#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${err.message}`);
  // Not process.exit(): exiting while fetch sockets close crashes Node on Windows.
  process.exitCode = 1;
});
