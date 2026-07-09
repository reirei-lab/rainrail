import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createStandaloneRainrailDispatchRunner,
  runRainrailCliEntrypoint,
} from './index.js';

describe('rainrail binary entrypoint', () => {
  it('runs through the CLI package entrypoint', () => {
    const bin = readFileSync(new URL('./bin/rainrail.ts', import.meta.url), 'utf8');

    expect(bin).toContain('#!/usr/bin/env node');
    expect(bin).toContain("from '../index.js'");
    expect(bin).toContain('await runRainrailCliEntrypoint(process.argv.slice(2)');
    expect(bin).toContain('createStandaloneRainrailDispatchRunner()');
    expect(bin).toContain('stderrWriter');
    expect(bin).toContain('process.exitCode = result.exitCode');
  });

  it('wires standalone dispatch through the default event delivery runner', async () => {
    const writes: string[] = [];

    const result = await runRainrailCliEntrypoint(
      ['dispatch', 'hello from standalone'],
      {
        stdout: { write: (value) => writes.push(`stdout:${value}`) },
        stderr: { write: (value) => writes.push(`stderr:${value}`) },
      },
      {
        dispatchRunner: createStandaloneRainrailDispatchRunner({
          deliver: (event) => [
            {
              pluginName: 'standalone-smoke',
              eventId: event.id,
              status: 'fulfilled',
              value: event.payload,
            },
          ],
        }),
        updateNoticeCheck: () => Promise.resolve(undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toEqual([
      expect.stringContaining('stdout:Dispatched rainrail.manual.message event cli:'),
    ]);
    expect(writes[0]).toContain('Workflow results: 1');
    expect(writes[0]).not.toContain('requires a dispatch runner');
  });

  it('preserves caller-provided envelope data when standalone dispatch uses JSON output', async () => {
    const writes: string[] = [];
    const envelopeJson = '{"id":"manual-source:delivery-standalone:rainrail.manual.message","schemaVersion":"rainrail.event.v1","source":{"type":"manual","name":"manual-source"},"name":"rainrail.manual.message","delivery":{"id":"delivery-standalone","receivedAt":"2026-07-09T00:00:00.000Z"},"occurredAt":"2026-07-09T00:00:00.000Z","subject":{"type":"conversation","id":"thread-standalone"},"payload":{"provider":"rainrail","channel":"manual","action":"message","conversation":{"id":"thread-standalone"},"message":{"id":"message-standalone","text":"hello JSON"},"numericId":9007199254740993},"rawPayload":{"kind":"inline-redacted","reference":"manual://deliveries/delivery-standalone"}}';

    const result = await runRainrailCliEntrypoint(
      ['--json', 'dispatch', '--envelope-json', envelopeJson],
      {
        stdout: { write: (value) => writes.push(value) },
        stderr: { write: (value) => writes.push(value) },
      },
      {
        dispatchRunner: createStandaloneRainrailDispatchRunner({
          deliver: (event) => [
            {
              pluginName: 'standalone-json-smoke',
              eventId: event.id,
              status: 'fulfilled',
              value: event.payload,
            },
          ],
        }),
        updateNoticeCheck: () => Promise.resolve(undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"eventId":"manual-source:delivery-standalone:rainrail.manual.message"');
    expect(writes[0]).toContain('"workflowResultCount":1');
    expect(writes[0]).toContain('9007199254740993');
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
