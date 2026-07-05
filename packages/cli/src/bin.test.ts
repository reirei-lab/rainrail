import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('rainrail binary entrypoint', () => {
  it('runs through the CLI package entrypoint', () => {
    const bin = readFileSync(new URL('./bin/rainrail.ts', import.meta.url), 'utf8');

    expect(bin).toContain('#!/usr/bin/env node');
    expect(bin).toContain("from '../index.js'");
    expect(bin).toContain('stderrWriter');
    expect(bin).toContain('process.exitCode = result.exitCode');
  });
});
