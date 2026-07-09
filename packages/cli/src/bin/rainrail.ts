#!/usr/bin/env node
import {
  createStandaloneRainrailDispatchRunner,
  runRainrailCliEntrypoint,
} from '../index.js';

const result = await runRainrailCliEntrypoint(process.argv.slice(2), undefined, {
  asyncDispatchRunner: createStandaloneRainrailDispatchRunner(),
  stderrWriter: (message) => {
    process.stderr.write(message);
  },
});

process.exitCode = result.exitCode;
