#!/usr/bin/env node
import { runRainrailCli } from '../index.js';

const result = runRainrailCli(process.argv.slice(2), {
  stderrWriter: (message) => {
    process.stderr.write(message);
  },
});

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
