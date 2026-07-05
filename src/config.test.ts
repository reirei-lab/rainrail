import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, parseConfig, parseConfigJson } from './config.js';

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
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'production-ingress',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-production-webhook',
              sourceType: 'github',
              provider: 'github',
              runtime: 'openclaw',
              webhookSecret: 'GITHUB_WEBHOOK_SECRET',
              endpoint: '/webhooks/github',
              maxBodyBytes: 1024,
            },
            {
              type: 'cloudflare-tail',
              name: 'cloudflare-tail',
              sourceType: 'cloudflare',
            },
            {
              type: 'manual-chat',
              name: 'manual-chat',
              sourceType: 'manual',
              runtime: 'openclaw',
            },
            {
              type: 'manual-chat',
              name: 'web-chat',
              sourceType: 'chat',
              runtime: 'openclaw',
            },
          ],
        },
      ],
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
      server: {
        host: '127.0.0.1',
        port: 8787,
      },
    });

    expect(config.sourceBundles).toEqual([
      {
        type: 'eep-bridge',
        name: 'production-ingress',
        sources: [
          {
            type: 'github-webhook',
            name: 'github-production-webhook',
            sourceType: 'github',
            provider: 'github',
            runtime: 'openclaw',
            webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            endpoint: '/webhooks/github',
            maxBodyBytes: 1024,
          },
          {
            type: 'cloudflare-tail',
            name: 'cloudflare-tail',
            sourceType: 'cloudflare',
          },
          {
            type: 'manual-chat',
            name: 'manual-chat',
            sourceType: 'manual',
            runtime: 'openclaw',
          },
          {
            type: 'manual-chat',
            name: 'web-chat',
            sourceType: 'chat',
            runtime: 'openclaw',
          },
        ],
      },
    ]);
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
    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 8787,
    });
  });

  it('merges default task and runtime providers when provider sections are omitted', () => {
    expect(parseConfig({})).toEqual({
      server: {
        host: '127.0.0.1',
        port: 8787,
      },
      sourceBundles: [],
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

  it('parses server host and port configuration', () => {
    expect(parseConfig({
      server: {
        host: 'localhost',
        port: 9999,
      },
    }).server).toEqual({
      host: 'localhost',
      port: 9999,
    });
  });

  it.each([
    ['string', 'config.server must be an object'],
    [{ host: '', port: 8787 }, 'config.server.host must be a non-empty string'],
    [{ host: '127.0.0.1', port: '8787' }, 'config.server.port must be an integer from 1 to 65535'],
    [{ host: '127.0.0.1', port: 0 }, 'config.server.port must be an integer from 1 to 65535'],
    [{ host: '127.0.0.1', port: 65536 }, 'config.server.port must be an integer from 1 to 65535'],
    [{ host: '127.0.0.1', port: 8787.5 }, 'config.server.port must be an integer from 1 to 65535'],
  ])('rejects invalid server config %# with a config path', (server, message) => {
    expectConfigError({ server }, message);
  });

  it.each([
    ['string', 'config.sourceBundles must be an array'],
    [{}, 'config.sourceBundles must be an array'],
  ])('rejects sourceBundles when it is %s', (sourceBundles, message) => {
    expectConfigError({ sourceBundles }, message);
  });

  it.each([
    [undefined, 'config.sourceBundles[0] must be an object'],
    [null, 'config.sourceBundles[0] must be an object'],
    ['eep-bridge', 'config.sourceBundles[0] must be an object'],
    [{ type: 'unknown', name: 'ingress', sources: [] }, 'config.sourceBundles[0].type must be one of: eep-bridge'],
    [{ type: 'eep-bridge', name: '', sources: [] }, 'config.sourceBundles[0].name must be a non-empty string'],
    [{ type: 'eep-bridge', name: 'ingress' }, 'config.sourceBundles[0].sources must be an array'],
  ])('rejects invalid source bundle entry %# with a config path', (sourceBundle, message) => {
    expectConfigError({ sourceBundles: [sourceBundle] }, message);
  });

  it.each([
    [undefined, 'config.sourceBundles[0].sources[0] must be an object'],
    [{ type: 'rss-feed', name: 'rss', sourceType: 'system' }, 'config.sourceBundles[0].sources[0].type must be one of: github-webhook, cloudflare-tail, manual-chat'],
    [{ type: 'github-webhook', name: '', sourceType: 'github', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].name must be a non-empty string'],
    [{ type: 'github-webhook', name: 'github webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].name must be a safe identifier'],
    [{ type: 'github-webhook', name: 'a'.repeat(129), sourceType: 'github', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].name must be a safe identifier'],
    [{ type: 'github-webhook', name: 'a'.repeat(54), sourceType: 'github', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].name must be 53 characters or fewer for github-webhook sources'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'slack', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].sourceType must be one of: github, cloudflare, manual, chat, system'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'cloudflare', provider: 'github', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].sourceType must be "github" for github-webhook sources'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'gitlab', webhookSecret: 'secret' }, 'config.sourceBundles[0].sources[0].provider must reference a configured task provider'],
    [{ type: 'manual-chat', name: 'manual-chat', sourceType: 'manual', runtime: 'lambda' }, 'config.sourceBundles[0].sources[0].runtime must reference a configured runtime provider'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github' }, 'config.sourceBundles[0].sources[0].webhookSecret must be a non-empty string for github-webhook sources'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', endpoint: 'webhooks/github' }, 'config.sourceBundles[0].sources[0].endpoint must start with "/"'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', endpoint: '/github?x=1' }, 'config.sourceBundles[0].sources[0].endpoint must be a path without query or fragment'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', endpoint: '/github#frag' }, 'config.sourceBundles[0].sources[0].endpoint must be a path without query or fragment'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', endpoint: '/healthz' }, 'config.sourceBundles[0].sources[0].endpoint must not use a Rainrail core route'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', endpoint: '/api/v1/events/evt_1' }, 'config.sourceBundles[0].sources[0].endpoint must not use a Rainrail core route'],
    [{ type: 'github-webhook', name: 'github-webhook', sourceType: 'github', provider: 'github', webhookSecret: 'secret', maxBodyBytes: -1 }, 'config.sourceBundles[0].sources[0].maxBodyBytes must be a finite non-negative number'],
    [{ type: 'cloudflare-tail', name: 'cloudflare-tail', sourceType: 'github' }, 'config.sourceBundles[0].sources[0].sourceType must be "cloudflare" for cloudflare-tail sources'],
    [{ type: 'manual-chat', name: 'manual-chat', sourceType: 'github' }, 'config.sourceBundles[0].sources[0].sourceType must be "manual" or "chat" for manual-chat sources'],
  ])('rejects invalid source bundle source entry %# with a config path', (source, message) => {
    expectConfigError({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'ingress',
          sources: [source],
        },
      ],
    }, message);
  });

  it('rejects duplicate source names inside one source bundle', () => {
    expectConfigError({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'ingress',
          sources: [
            { type: 'manual-chat', name: 'manual-chat', sourceType: 'manual' },
            { type: 'manual-chat', name: 'manual-chat', sourceType: 'manual' },
          ],
        },
      ],
    }, 'config.sourceBundles[0].sources must not contain duplicate source name "manual-chat"');
  });

  it('rejects duplicate source bundle names', () => {
    expectConfigError({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'ingress',
          sources: [
            { type: 'manual-chat', name: 'manual-chat', sourceType: 'manual' },
          ],
        },
        {
          type: 'eep-bridge',
          name: 'ingress',
          sources: [
            { type: 'manual-chat', name: 'ops-chat', sourceType: 'manual' },
          ],
        },
      ],
    }, 'config.sourceBundles must not contain duplicate bundle name "ingress"');
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

  it('expands environment variables from an explicit env map before falling back to process env', () => {
    vi.stubEnv('RAINRAIL_CONFIG_BUNDLE_NAME', 'process-bundle');
    vi.stubEnv('RAINRAIL_CONFIG_SOURCE_NAME', 'process-source');

    const config = parseConfigJson(JSON.stringify({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: '${RAINRAIL_CONFIG_BUNDLE_NAME}',
          sources: [
            { type: 'manual-chat', name: '${RAINRAIL_CONFIG_SOURCE_NAME}', sourceType: 'manual' },
          ],
        },
      ],
    }), {
      RAINRAIL_CONFIG_BUNDLE_NAME: 'worker-bundle',
    });

    expect(config.sourceBundles[0]?.name).toBe('worker-bundle');
    expect(config.sourceBundles[0]?.sources[0]?.name).toBe('process-source');
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
