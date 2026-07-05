#!/usr/bin/env node
import { runRainrailCliEntrypoint } from '../index.js';

const result = await runRainrailCliEntrypoint(process.argv.slice(2), undefined, {
  stderrWriter: (message) => {
    process.stderr.write(message);
  },
});

process.exitCode = result.exitCode;
