#!/usr/bin/env node
import { runRainrailCliEntrypoint } from '../index.js';

const result = await runRainrailCliEntrypoint(process.argv.slice(2));

process.exitCode = result.exitCode;
