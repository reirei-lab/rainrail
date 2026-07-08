import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runRainrailCliEntrypoint } from './index.js';

describe('rainrail binary entrypoint', () => {
  it('runs through the CLI package entrypoint', () => {
    const bin = readFileSync(new URL('./bin/rainrail.ts', import.meta.url), 'utf8');

    expect(bin).toContain('#!/usr/bin/env node');
    expect(bin).toContain("from '../index.js'");
    expect(bin).toContain('await runRainrailCliEntrypoint(process.argv.slice(2)');
    expect(bin).toContain('stderrWriter');
    expect(bin).toContain('process.exitCode = result.exitCode');
  });

  it('starts the update notice check before running the synchronous CLI and prints it after successful output', async () => {
    const writes: string[] = [];
    const order: string[] = [];

    const result = await runRainrailCliEntrypoint(
      ['doctor'],
      {
        stdout: { write: (value) => writes.push(`stdout:${value}`) },
        stderr: { write: (value) => writes.push(`stderr:${value}`) },
      },
      {
        runCli: () => {
          order.push('run-cli');
          return { exitCode: 0, stdout: 'doctor ok\n', stderr: '' };
        },
        updateNoticeCheck: () => {
          order.push('start-update-check');
          return Promise.resolve('Rainrail 0.2.1 is available. Run `rainrail update --version release/0.2.1` to update.\n');
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['start-update-check', 'run-cli']);
    expect(writes).toEqual([
      'stdout:doctor ok\n',
      'stderr:Rainrail 0.2.1 is available. Run `rainrail update --version release/0.2.1` to update.\n',
    ]);
  });

  it('suppresses a ready update notice when the CLI exits unsuccessfully', async () => {
    const writes: string[] = [];
    let aborted = false;

    const result = await runRainrailCliEntrypoint(
      ['doctor'],
      {
        stdout: { write: (value) => writes.push(`stdout:${value}`) },
        stderr: { write: (value) => writes.push(`stderr:${value}`) },
      },
      {
        runCli: () => ({ exitCode: 2, stdout: '', stderr: 'doctor failed\n' }),
        updateNoticeCheck: (signal) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return Promise.resolve('Rainrail 0.2.1 is available.\n');
        },
      },
    );

    expect(result.exitCode).toBe(2);
    expect(aborted).toBe(true);
    expect(writes).toEqual(['stderr:doctor failed\n']);
  });

  it('does not wait for a slow update notice check before returning from a successful CLI run', async () => {
    const writes: string[] = [];
    let aborted = false;

    const result = await runRainrailCliEntrypoint(
      ['doctor'],
      {
        stdout: { write: (value) => writes.push(`stdout:${value}`) },
        stderr: { write: (value) => writes.push(`stderr:${value}`) },
      },
      {
        runCli: () => ({ exitCode: 0, stdout: 'doctor ok\n', stderr: '' }),
        updateNoticeCheck: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve(undefined);
            });
          }),
        updateNoticeTimeoutMs: 0,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(aborted).toBe(true);
    expect(writes).toEqual(['stdout:doctor ok\n']);
  });

  it('formats the default asynchronous release check as an update notice only when an update is available', async () => {
    const writes: string[] = [];

    await runRainrailCliEntrypoint(
      ['doctor'],
      {
        stdout: { write: (value) => writes.push(`stdout:${value}`) },
        stderr: { write: (value) => writes.push(`stderr:${value}`) },
      },
      {
        cacheDirectory: '/dev/null',
        currentVersion: '0.2.0',
        now: () => new Date('2026-07-05T00:00:00.000Z'),
        runCli: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        asyncReleaseFetcher: (url, options) => {
          expect(url).toBe('https://api.github.com/repos/reirei-lab/rainrail/releases/latest');
          expect(options.signal.aborted).toBe(false);
          return Promise.resolve({
            status: 200,
            body: JSON.stringify({
              tag_name: 'release/0.2.1',
              prerelease: false,
              assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'uploaded', size: 123 }],
            }),
          });
        },
      },
    );

    expect(writes).toEqual([
      'stderr:Rainrail 0.2.1 is available. Run `rainrail update --version release/0.2.1` to update.\n',
    ]);
  });

  it.each([
    ['help'],
    ['--help'],
    ['version'],
    ['update', 'check'],
    ['dispatch', 'help'],
    ['dispatch', '--help'],
    ['github', 'help'],
    ['github', 'webhook', 'add', 'help'],
    ['plugin', 'github', 'help'],
    ['plugin', 'github', 'webhook', 'add', 'help'],
  ])('skips the update notice check for %s', async (...argv) => {
    let updateCheckStarted = false;

    await runRainrailCliEntrypoint(
      argv,
      {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
      {
        runCli: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        updateNoticeCheck: () => {
          updateCheckStarted = true;
          return Promise.resolve('Rainrail 0.2.1 is available.\n');
        },
      },
    );

    expect(updateCheckStarted).toBe(false);
  });
});
