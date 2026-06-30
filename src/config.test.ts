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
