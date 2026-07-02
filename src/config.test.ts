import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, parseConfig } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('parseConfig', () => {
  const expectConfigError = (value: unknown, message: string): void => {
    expect(() => parseConfig(value)).toThrow(message);
  };

  it('parses source, task, and runtime provider config with GitHub App auth', () => {
    const config = parseConfig({
      sources: [
        { type: 'github', name: 'github-webhook', webhookSecret: 'secret-name' },
      ],
      taskProviders: {
        github: {
          token: 'pat-token',
          githubApp: {
            appId: '12345',
            installationId: '67890',
            privateKeyPath: '/tmp/private-key.pem',
          },
        },
      },
      runtimeProviders: {
        openclaw: {
          enabled: true,
          command: 'openclaw',
          agentId: 'main',
          sessionKeyPrefix: 'rainrail',
          timeoutSeconds: 600,
          logDirectory: 'var/agent-task-logs',
        },
      },
    });

    expect(config.sources).toEqual([
      { type: 'github', name: 'github-webhook', webhookSecret: 'secret-name' },
    ]);
    expect(config.taskProviders.github).toEqual({
      token: 'pat-token',
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: '/tmp/private-key.pem',
      },
    });
    expect(config.runtimeProviders.openclaw).toEqual({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 600,
      logDirectory: 'var/agent-task-logs',
    });
  });

  it('merges default task and runtime providers when provider sections are omitted', () => {
    expect(parseConfig({})).toEqual({
      sources: [],
      taskProviders: {
        github: {},
      },
      runtimeProviders: {
        openclaw: {
          enabled: false,
          command: 'openclaw',
          agentId: 'main',
          sessionKeyPrefix: 'rainrail',
          timeoutSeconds: 600,
          logDirectory: 'var/agent-task-logs',
        },
      },
    });
  });

  it.each([
    ['string', 'config.sources must be an array'],
    [{}, 'config.sources must be an array'],
  ])('rejects sources when it is %s', (sources, message) => {
    expectConfigError({ sources }, message);
  });

  it.each([
    [undefined, 'config.sources[0] must be an object'],
    [null, 'config.sources[0] must be an object'],
    ['github', 'config.sources[0] must be an object'],
    [{ type: '', name: 'github-webhook' }, 'config.sources[0].type must be a non-empty string'],
    [{ type: 42, name: 'github-webhook' }, 'config.sources[0].type must be a non-empty string'],
    [{ type: 'github', name: '' }, 'config.sources[0].name must be a non-empty string'],
    [{ type: 'github', name: false }, 'config.sources[0].name must be a non-empty string'],
    [
      { type: 'github', name: 'github-webhook', webhookSecret: '' },
      'config.sources[0].webhookSecret must be a non-empty string',
    ],
    [
      { type: 'github', name: 'github-webhook', webhookSecret: 42 },
      'config.sources[0].webhookSecret must be a non-empty string',
    ],
    [
      { type: 'github', name: 'github-webhook', endpoint: '' },
      'config.sources[0].endpoint must be a non-empty string',
    ],
    [
      { type: 'github', name: 'github-webhook', endpoint: true },
      'config.sources[0].endpoint must be a non-empty string',
    ],
  ])('rejects invalid source entry %# with a config path', (source, message) => {
    expectConfigError({ sources: [source] }, message);
  });

  it.each([
    ['token', 'config.taskProviders must be an object'],
    [[], 'config.taskProviders must be an object'],
    [42, 'config.taskProviders must be an object'],
  ])('rejects taskProviders when it is %#', (taskProviders, message) => {
    expectConfigError({ taskProviders }, message);
  });

  it.each([
    ['openclaw', 'config.runtimeProviders must be an object'],
    [[], 'config.runtimeProviders must be an object'],
    [42, 'config.runtimeProviders must be an object'],
  ])('rejects runtimeProviders when it is %#', (runtimeProviders, message) => {
    expectConfigError({ runtimeProviders }, message);
  });

  it.each([
    ['enabled', 'yes', 'config.runtimeProviders.openclaw.enabled must be a boolean'],
    ['command', '', 'config.runtimeProviders.openclaw.command must be a non-empty string'],
    ['command', 42, 'config.runtimeProviders.openclaw.command must be a non-empty string'],
    ['agentId', '', 'config.runtimeProviders.openclaw.agentId must be a non-empty string'],
    ['agentId', false, 'config.runtimeProviders.openclaw.agentId must be a non-empty string'],
    [
      'sessionKeyPrefix',
      '',
      'config.runtimeProviders.openclaw.sessionKeyPrefix must be a non-empty string',
    ],
    [
      'sessionKeyPrefix',
      42,
      'config.runtimeProviders.openclaw.sessionKeyPrefix must be a non-empty string',
    ],
    [
      'timeoutSeconds',
      '600',
      'config.runtimeProviders.openclaw.timeoutSeconds must be a finite number',
    ],
    [
      'timeoutSeconds',
      Number.POSITIVE_INFINITY,
      'config.runtimeProviders.openclaw.timeoutSeconds must be a finite number',
    ],
    [
      'timeoutSeconds',
      -1,
      'config.runtimeProviders.openclaw.timeoutSeconds must be a finite non-negative number',
    ],
    ['logDirectory', '', 'config.runtimeProviders.openclaw.logDirectory must be a non-empty string'],
    ['logDirectory', 42, 'config.runtimeProviders.openclaw.logDirectory must be a non-empty string'],
  ])('rejects invalid openclaw %s with a config path', (key, value, message) => {
    expectConfigError({
      runtimeProviders: {
        openclaw: {
          [key]: value,
        },
      },
    }, message);
  });

  it.each([
    ['string', 'config.runtimeProviders.openclaw must be an object'],
    [[], 'config.runtimeProviders.openclaw must be an object'],
    [42, 'config.runtimeProviders.openclaw must be an object'],
  ])('rejects openclaw provider when it is %#', (openclaw, message) => {
    expectConfigError({ runtimeProviders: { openclaw } }, message);
  });

  it('merges openclaw defaults with explicitly provided fields', () => {
    expect(parseConfig({
      runtimeProviders: {
        openclaw: {
          enabled: true,
          command: 'custom-openclaw',
        },
      },
    }).runtimeProviders.openclaw).toEqual({
      enabled: true,
      command: 'custom-openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 600,
      logDirectory: 'var/agent-task-logs',
    });
  });

  it.each([0, 0.5])('allows finite non-negative timeoutSeconds boundary value %s', (timeoutSeconds) => {
    expect(parseConfig({
      runtimeProviders: {
        openclaw: {
          timeoutSeconds,
        },
      },
    }).runtimeProviders.openclaw.timeoutSeconds).toBe(timeoutSeconds);
  });

  it('expands environment variables as JSON string content before parsing', async () => {
    vi.stubEnv('RAINRAIL_GITHUB_TOKEN', 'expanded-"token"\\with\nnewline');
    const directory = join(tmpdir(), `rainrail-config-${crypto.randomUUID()}`);
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'rainrail.json');
    await writeFile(path, JSON.stringify({
      taskProviders: {
        github: {
          token: '${RAINRAIL_GITHUB_TOKEN}',
        },
      },
    }), 'utf8');

    await expect(loadConfig(path)).resolves.toMatchObject({
      taskProviders: {
        github: {
          token: 'expanded-"token"\\with\nnewline',
        },
      },
    });
  });

  it('reports JSON parse errors when environment expansion creates invalid JSON', async () => {
    vi.stubEnv('RAINRAIL_CONFIG_FRAGMENT', '[');
    const directory = join(tmpdir(), `rainrail-config-${crypto.randomUUID()}`);
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'rainrail.json');
    await writeFile(path, '{"sources": ${RAINRAIL_CONFIG_FRAGMENT}}', 'utf8');

    await expect(loadConfig(path)).rejects.toThrow(SyntaxError);
  });

  it('expands undefined environment variables to empty string content before parsing', async () => {
    const envName = `RAINRAIL_UNDEFINED_${crypto.randomUUID().replaceAll('-', '_').toUpperCase()}`;
    delete process.env[envName];
    const directory = join(tmpdir(), `rainrail-config-${crypto.randomUUID()}`);
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'rainrail.json');
    await writeFile(path, JSON.stringify({
      sources: [
        { type: 'github', name: `github-\${${envName}}-webhook` },
      ],
    }), 'utf8');

    await expect(loadConfig(path)).resolves.toMatchObject({
      sources: [
        { type: 'github', name: 'github--webhook' },
      ],
    });
  });

  it('rejects incomplete GitHub App auth config', () => {
    expect(() => parseConfig({
      taskProviders: {
        github: {
          githubApp: {
            appId: '12345',
            installationId: '67890',
          },
        },
      },
    })).toThrow('config.taskProviders.github.githubApp.privateKeyPath must be a non-empty string');
  });
});
