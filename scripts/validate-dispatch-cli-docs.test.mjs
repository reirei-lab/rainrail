import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runRainrailCli } from '../packages/cli/src/index.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const projectLocalLayout = readFileSync(
  new URL('../docs/project-local-layout.md', import.meta.url),
  'utf8',
);

const completeEnvelope = {
  source: { type: 'manual', name: 'manual-source' },
  name: 'rainrail.manual.message',
  delivery: { id: 'delivery-docs-smoke', receivedAt: '2026-07-09T00:00:00.000Z' },
  occurredAt: '2026-07-09T00:00:00.000Z',
  subject: { type: 'conversation', id: 'thread-docs-smoke' },
  payload: {
    provider: 'rainrail',
    channel: 'manual',
    action: 'message',
    conversation: { id: 'thread-docs-smoke' },
    message: { id: 'message-docs-smoke', text: 'hello from docs smoke' },
  },
  rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-docs-smoke' },
};

/** @typedef {import('../packages/cli/src/index.js').RainrailDispatchRequest} RainrailDispatchRequest */

describe('rainrail dispatch CLI documentation', () => {
  it('documents every supported dispatch input mode shown by command help', () => {
    const help = runRainrailCli(['dispatch', 'help']);

    expect(help.exitCode).toBe(0);
    for (const documentedMode of [
      'rainrail dispatch "please inspect issue #263"',
      'rainrail dispatch --message "please inspect issue #263"',
      'rainrail dispatch --stdin',
      'rainrail dispatch --json ./event.json',
      'rainrail dispatch --json --stdin',
      'rainrail dispatch --envelope-json',
    ]) {
      expect(readme).toContain(documentedMode);
    }
    for (const helpMode of [
      '<message>',
      '--stdin',
      '--message <text>',
      '--json <file>',
      '--json --stdin',
      '--envelope-json <json>',
    ]) {
      expect(help.stdout).toContain(helpMode);
    }
  });

  it('smoke tests the README message-only and complete-envelope examples', () => {
    /** @type {RainrailDispatchRequest[]} */
    const dispatched = [];
    /**
     * @param {RainrailDispatchRequest} request
     */
    const dispatchRunner = (request) => {
      dispatched.push(request);
      return {
        exitCode: 0,
        stdout: 'accepted docs example\n',
        stderr: '',
      };
    };

    expect(runRainrailCli(['dispatch', 'please inspect issue #263'], { dispatchRunner }))
      .toMatchObject({ exitCode: 0, stdout: 'accepted docs example\n', stderr: '' });
    expect(runRainrailCli(['dispatch', '--message', 'please inspect issue #263'], { dispatchRunner }))
      .toMatchObject({ exitCode: 0 });
    expect(runRainrailCli(['dispatch', '--stdin'], {
      stdin: 'please inspect issue #263\n',
      dispatchRunner,
    })).toMatchObject({ exitCode: 0 });
    expect(runRainrailCli(['dispatch', '--envelope-json', JSON.stringify(completeEnvelope)], { dispatchRunner }))
      .toMatchObject({ exitCode: 0 });

    expect(dispatched.map((request) => request.mode)).toEqual([
      'message',
      'message',
      'message',
      'envelope-json',
    ]);
    expect(dispatched[0]).toMatchObject({
      event: {
        payload: {
          message: {
            text: 'please inspect issue #263',
          },
        },
      },
    });
    expect(dispatched[3]).toMatchObject({
      mode: 'envelope-json',
      input: expect.stringContaining('"schemaVersion":"rainrail.event.v1"'),
    });
  });

  it('documents the intentionally omitted per-field metadata flags', () => {
    expect(readme).toContain('does not expose per-field metadata flags');
    expect(projectLocalLayout).toContain('per-field');
    expect(projectLocalLayout).toContain('metadata flags');
    expect(projectLocalLayout).toContain('complete envelope JSON');
    const result = runRainrailCli(['dispatch', '--source-name', 'cli', '--message', 'hello']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown rainrail dispatch option: --source-name.');
  });

  it('keeps documented error behavior aligned with the CLI', () => {
    expect(readme).toContain('Blank messages are rejected before dispatch.');
    expect(runRainrailCli(['dispatch', '   '], {
      dispatchRunner: () => ({ exitCode: 0, stdout: 'unexpected\n', stderr: '' }),
    })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Message must not be empty.\n',
    });
  });
});
