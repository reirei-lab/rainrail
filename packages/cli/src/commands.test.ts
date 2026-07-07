import { writeFileSync as realWriteFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  OFFICIAL_PLUGIN_CATALOG,
  type RainrailCliFileSystem,
  type RainrailStartOptions,
  discoverRainrailProject,
  getBuiltInCommand,
  getOfficialPluginByAlias,
  parseRainrailArguments,
  runRainrailCli,
  runRainrailCliAsync,
} from './index.js';

async function withTempDirectory(test: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'rainrail-cli-'));
  const originalSseBearerToken = process.env.SSE_BEARER_TOKEN;
  delete process.env.SSE_BEARER_TOKEN;
  try {
    await test(directory);
  } finally {
    if (originalSseBearerToken === undefined) {
      delete process.env.SSE_BEARER_TOKEN;
    } else {
      process.env.SSE_BEARER_TOKEN = originalSseBearerToken;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function initRainrailProject(parentDirectory: string, projectName: string): Promise<string> {
  const projectRoot = join(parentDirectory, projectName);
  await mkdir(projectRoot, { recursive: true });
  expect(runRainrailCli(['init', '--yes'], { cwd: projectRoot }).exitCode).toBe(0);
  return projectRoot;
}

async function getFreePort(host = '127.0.0.1'): Promise<number> {
  const server = net.createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to allocate a test port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function closeTestServer(result: { server?: { stop: () => void | Promise<void> } }): Promise<void> {
  await result.server?.stop();
}

function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function githubWebhookHeaders(
  secret: string,
  body: string,
  options: { readonly event?: string; readonly delivery?: string } = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-delivery': options.delivery ?? `delivery-${createHmac('sha256', secret).update(body).digest('hex').slice(0, 8)}`,
    'x-github-event': options.event ?? 'issues',
    'x-hub-signature-256': githubSignature(secret, body),
  };
}

describe('Rainrail CLI built-in commands', () => {
  it('defines the command table without provider or runtime specific handlers', () => {
    expect(BUILT_IN_COMMANDS.map((command) => command.name)).toEqual([
      'init',
      'setup',
      'start',
      'doctor',
      'plugins',
      'plugin',
      'update',
      'version',
      'help',
    ]);

    expect(BUILT_IN_COMMANDS.every((command) => command.kind === 'built-in')).toBe(true);
    expect(getBuiltInCommand('plugin')?.implemented).toBe(true);
  });

  it('parses shared options before and after the command name', () => {
    expect(
      parseRainrailArguments([
        '--config',
        'rainrail.config.json',
        '--json',
        'doctor',
        '--profile',
        'local',
        '--yes',
      ]),
    ).toEqual({
      commandName: 'doctor',
      commandArgs: [],
      options: {
        config: 'rainrail.config.json',
        json: true,
        profile: 'local',
        yes: true,
      },
      errors: [],
    });
  });

  it('defaults to help when no command is provided', () => {
    expect(parseRainrailArguments([]).commandName).toBe('help');
    expect(getBuiltInCommand('help')?.name).toBe('help');
  });

  it('reports parse errors for shared options that require a value', () => {
    expect(parseRainrailArguments(['--config'])).toEqual({
      commandName: 'help',
      commandArgs: [],
      options: {
        json: false,
        yes: false,
      },
      errors: ['Missing value for --config.'],
    });

    expect(parseRainrailArguments(['doctor', '--profile'])).toEqual({
      commandName: 'doctor',
      commandArgs: [],
      options: {
        json: false,
        yes: false,
      },
      errors: ['Missing value for --profile.'],
    });

    expect(parseRainrailArguments(['--config=', 'doctor']).errors).toEqual([
      'Missing value for --config.',
    ]);
    expect(parseRainrailArguments(['doctor', '--profile=']).errors).toEqual([
      'Missing value for --profile.',
    ]);
  });

  it('prints built-in commands from rainrail help', () => {
    const result = runRainrailCli(['help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: rainrail <command>');
    for (const command of BUILT_IN_COMMANDS) {
      expect(result.stdout).toContain(`  ${command.name}`);
    }
    expect(result.stdout).toContain('Start the local Rainrail harness server in the foreground.');
    expect(result.stdout).toContain('Official plugin aliases:');
    expect(result.stdout).toContain('  github');
    expect(result.stdout).toContain('  cloudflare');
    expect(result.stdout).toContain('  openclaw');
  });

  it('prints the CLI package version from rainrail version', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const result = runRainrailCli(['version']);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `rainrail ${packageJson.version}\n`,
      stderr: '',
    });
  });

  it('starts a foreground local server with built-in defaults from a Rainrail workspace', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'local-server');
      const starts: RainrailStartOptions[] = [];

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          starts.push(options);
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        host: '127.0.0.1',
        port: 8787,
        root: projectRoot,
        configPath: join(projectRoot, 'rainrail.config.json'),
      });
      expect(result.stdout).toContain('Rainrail local harness server starting');
      expect(result.stdout).toContain('Host: 127.0.0.1');
      expect(result.stdout).toContain('Port: 8787');
      expect(result.stdout).toContain(`Config: ${join(projectRoot, 'rainrail.config.json')}`);
      expect(result.stdout).toContain('Health: http://127.0.0.1:8787/healthz');
      expect(result.stdout).toContain('Dashboard: local harness control plane');
      expect(result.stdout).toContain('Event Stream: http://127.0.0.1:8787/events');
      expect(result.stdout).toContain('Dashboard API: http://127.0.0.1:8787/api/v1/overview');
      expect(result.stdout).not.toContain('EEP Bridge');
    });
  });

  it('does not invoke async server starters from the sync start command path', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sync-start-async-starter');
      let called = false;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: async () => {
          called = true;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('rainrail start requires the async CLI runner.\n');
      expect(called).toBe(false);
    });
  });

  it('uses rainrail.config.json server host and port for rainrail start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'configured-server');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: 'localhost',
          port: 9001,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions).toMatchObject({
        host: 'localhost',
        port: 9001,
      });
    });
  });

  it('expands environment variables while reading rainrail start config', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'expanded-config');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 8787,
        },
        sourceBundles: [
          {
            type: 'eep-bridge',
            name: 'local',
            sources: [
              {
                type: 'github-webhook',
                name: 'github-local',
                sourceType: 'github',
                provider: 'github',
                webhookSecret: '${GITHUB_WEBHOOK_SECRET}',
                endpoint: '/webhooks/github',
              },
            ],
          },
        ],
        sources: [],
        taskProviders: {
          github: {
            token: '${GITHUB_TOKEN}',
          },
        },
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        env: {
          GITHUB_TOKEN: 'expanded-token',
          GITHUB_WEBHOOK_SECRET: 'expanded-secret',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Local intake:');
      expect(result.stdout).toContain('  github-local (github): http://127.0.0.1:8787/webhooks/github');
      expect(result.stdout).not.toContain('EEP Bridge');
      expect(startOptions?.sources).toMatchObject([{
        endpoint: '/webhooks/github',
        name: 'github-local',
        sourceType: 'github',
        transport: 'http',
        authConfigured: true,
        webhookSecret: 'expanded-secret',
      }]);
    });
  });

  it('parses rainrail start config after env JSON fragment expansion', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'expanded-source-fragment');
      await writeFile(join(projectRoot, 'rainrail.config.json'), [
        '{',
        '  "server": { "host": "127.0.0.1", "port": 8787 },',
        '  "sourceBundles": [],',
        '  "sources": ${RAINRAIL_SOURCES},',
        '  "taskProviders": {},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      let startOptions: RainrailStartOptions | undefined;
      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        env: {
          RAINRAIL_SOURCES: JSON.stringify([{
            type: 'github',
            name: 'github-local',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }]),
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(startOptions?.sources).toMatchObject([{
        name: 'github-local',
        sourceType: 'github',
        endpoint: '/webhooks/github',
      }]);
    });
  });

  it('keeps uppercase webhookSecret values expanded inside env JSON fragments', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'expanded-fragment-uppercase-secret');
      await writeFile(join(projectRoot, 'rainrail.config.json'), [
        '{',
        '  "sourceBundles": ${RAINRAIL_SOURCE_BUNDLES},',
        '  "sources": [],',
        '  "taskProviders": {},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        env: {
          GITHUB_WEBHOOK_SECRET: 'ABC123',
          RAINRAIL_SOURCE_BUNDLES: JSON.stringify([{
            type: 'eep-bridge',
            name: 'local',
            sources: [{
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: '${GITHUB_WEBHOOK_SECRET}',
              endpoint: '/webhooks/github',
            }],
          }]),
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(startOptions?.sources[0]?.webhookSecret).toBe('ABC123');
    });
  });

  it('rejects string server ports from start config files', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'string-config-port');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port: '8787' },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('config.server.port must be an integer from 1 to 65535');
    });
  });

  it('rejects malformed source bundle source contracts before starting', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'source-bundle-contract');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-brigde',
          name: 'local',
          sources: [],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const badBundleType = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(badBundleType.exitCode).toBe(1);
      expect(badBundleType.stderr).toContain('config.sourceBundles[0].type must be one of: eep-bridge');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: '',
          sources: [],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const missingBundleName = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(missingBundleName.exitCode).toBe(1);
      expect(missingBundleName.stderr).toContain('config.sourceBundles[0].name must be a non-empty string');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhok',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const badType = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(badType.exitCode).toBe(1);
      expect(badType.stderr).toContain('config.sourceBundles[0].sources[0].type must be one of: github-webhook, cloudflare-tail, manual-chat');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const missingSourceType = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(missingSourceType.exitCode).toBe(1);
      expect(missingSourceType.stderr).toContain('config.sourceBundles[0].sources[0].sourceType must be a non-empty string');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github.webhook:local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      let startOptions: RainrailStartOptions | undefined;
      const validName = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });
      expect(validName.exitCode).toBe(0);
      expect(startOptions?.sources[0]?.name).toBe('github.webhook:local');
    });
  });

  it('rejects malformed top-level local sources before starting', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'top-level-source-contract');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [],
        sources: [{ type: 'github', endpoint: '/webhooks/github', webhookSecret: 'secret' }],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const missingName = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(missingName.exitCode).toBe(1);
      expect(missingName.stderr).toContain('config.sources[0].name must be a non-empty string');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [],
        sources: [{ type: 'manual', name: 'manual-local' }],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const missingEndpoint = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(missingEndpoint.exitCode).toBe(1);
      expect(missingEndpoint.stderr).toContain('config.sources[0].endpoint must be a string');
    });
  });

  it('uses top-level source type as local sourceType', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'top-level-manual-source');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [],
        sources: [{ type: 'manual', name: 'manual-local', endpoint: '/manual' }],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(startOptions?.sources).toMatchObject([{
        name: 'manual-local',
        sourceType: 'manual',
        endpoint: '/manual',
      }]);
    });
  });

  it('skips endpoint-less non-HTTP source bundle sources', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'route-less-bundle-source');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
            {
              type: 'cloudflare-tail',
              name: 'cloudflare-tail',
              sourceType: 'cloudflare',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(startOptions?.sources).toMatchObject([
        { name: 'github-local', endpoint: '/webhooks/github' },
      ]);
    });
  });

  it('lets RAINRAIL_HOST and RAINRAIL_PORT override start config when flags are absent', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'env-server');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 8787,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        env: {
          RAINRAIL_HOST: '0.0.0.0',
          RAINRAIL_PORT: '9999',
          SSE_BEARER_TOKEN: 'events-token',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions).toMatchObject({
        host: '0.0.0.0',
        port: 9999,
        dashboardAuth: { readOnlyToken: 'events-token' },
      });
    });
  });

  it('passes configured dashboardAuth into rainrail start options', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'configured-dashboard-auth');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        dashboardAuth: {
          readOnlyToken: 'read-token',
          operatorToken: 'operator-token',
          adminToken: 'admin-token',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(startOptions?.dashboardAuth).toEqual({
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      });
    });
  });

  it('keeps SSE_BEARER_TOKEN valid when dashboardAuth.readOnlyToken is configured', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-compat');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        dashboardAuth: {
          readOnlyToken: 'configured-read-token',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'legacy-events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        for (const token of ['configured-read-token', 'legacy-events-token']) {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          expect(response.status, token).toBe(200);
        }
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('lets --host and --port override start environment and config', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'flag-server');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 8787,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start', '--host', 'localhost', '--port', '7070'], {
        cwd: projectRoot,
        env: {
          RAINRAIL_HOST: '0.0.0.0',
          RAINRAIL_PORT: '9999',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions).toMatchObject({
        host: 'localhost',
        port: 7070,
      });
    });
  });

  it('rejects invalid rainrail start ports before opening the server', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'invalid-server');
      let started = false;

      const result = runRainrailCli(['start', '--port', '70000'], {
        cwd: projectRoot,
        serverStarter: () => {
          started = true;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('rainrail start --port must be an integer from 1 to 65535');
      expect(started).toBe(false);
    });
  });

  it('reports bind failures before printing start success', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'bind-failure');
      const occupied = net.createServer();
      occupied.listen(0, '127.0.0.1');
      await once(occupied, 'listening');
      const address = occupied.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to allocate occupied port');
      }

      try {
        const result = await runRainrailCliAsync(['start', '--port', String(address.port)], {
          cwd: projectRoot,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Unable to bind Rainrail local server');
      } finally {
        occupied.close();
        await once(occupied, 'close');
      }
    });
  });

  it('serves configured intake routes and dashboard v1 collections from rainrail start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'configured-intake');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port,
        },
        sourceBundles: [
          {
            type: 'eep-bridge',
            name: 'local',
            sources: [
              {
                type: 'github-webhook',
                name: 'github-local',
                sourceType: 'github',
                provider: 'github',
                webhookSecret: 'secret',
                endpoint: '/webhooks/github',
              },
            ],
          },
        ],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const acceptedBody = JSON.stringify({ action: 'opened' });
        const acceptedDelivery = 'delivery-local-1';
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', acceptedBody, { delivery: acceptedDelivery, event: 'issues' }),
          body: acceptedBody,
        });
        expect(accepted.status).toBe(202);

        const overview = await fetch(`http://127.0.0.1:${port}/api/v1/overview`);
        await expect(overview.json()).resolves.toMatchObject({
          data: {
            counts: { events: 1 },
            warnings: { staleProjectClaims: [] },
            recentActivity: [],
            links: {
              events: '/api/v1/events',
              workflowRuns: '/api/v1/workflow-runs',
              agentTasks: '/api/v1/agent-tasks',
              sources: '/api/v1/sources',
              queue: '/api/v1/queue',
              settings: '/api/v1/settings',
            },
          },
        });

        for (const route of [
          '/api/v1/events',
          '/api/v1/workflow-runs',
          '/api/v1/agent-tasks',
          '/api/v1/sources',
          '/api/v1/queue',
          '/api/v1/settings',
        ]) {
          const response = await fetch(`http://127.0.0.1:${port}${route}`);
          expect(response.status, route).toBe(200);
          await expect(response.json(), route).resolves.toMatchObject({
            data: expect.any(Array),
            page: { limit: 50, nextCursor: null },
          });
        }

        const sources = await fetch(`http://127.0.0.1:${port}/api/v1/sources`);
        await expect(sources.json()).resolves.toMatchObject({
          data: [{
            id: 'github-local',
            type: 'source',
            status: 'configured',
            sourceType: 'github',
            name: 'github-local',
            endpoint: '/webhooks/github',
            auth: { status: 'configured' },
          }],
        });

        const events = await fetch(`http://127.0.0.1:${port}/api/v1/events`);
        await expect(events.json()).resolves.toMatchObject({
          data: [{
            id: 'local-event-000001',
            type: 'event',
            name: 'github.issue',
            status: 'received',
            deliveryId: acceptedDelivery,
            rawPayloadReference: 'local://events/local-event-000001',
            workflowRunCount: 0,
            handlerRetryCount: 0,
            source: { type: 'github', name: 'github-local' },
            subject: { type: 'issue', id: 'local-event-000001' },
            occurredAt: expect.any(String),
            receivedAt: expect.any(String),
          }],
        });
        const filtered = await fetch(`http://127.0.0.1:${port}/api/v1/events?filter[name]=github.issue`);
        await expect(filtered.json()).resolves.toMatchObject({
          data: [{ id: 'local-event-000001', name: 'github.issue' }],
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects malformed GitHub webhook payloads in local start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'github-webhook-contract');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const missingHeadersBody = '{}';
        const missingHeaders = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: { 'x-hub-signature-256': githubSignature('secret', missingHeadersBody) },
          body: missingHeadersBody,
        });
        expect(missingHeaders.status).toBe(400);
        await expect(missingHeaders.json()).resolves.toEqual({ error: 'missing_github_headers' });

        const invalidJsonBody = 'not-json';
        const invalidJson = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: {
            ...githubWebhookHeaders('secret', invalidJsonBody),
            'content-type': 'application/json',
          },
          body: invalidJsonBody,
        });
        expect(invalidJson.status).toBe(400);
        await expect(invalidJson.json()).resolves.toEqual({ error: 'invalid_json_payload' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('accepts URL-encoded GitHub webhook payloads in local start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'github-form-webhook');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const body = new URLSearchParams({ payload: JSON.stringify({ action: 'opened' }) }).toString();
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: {
            ...githubWebhookHeaders('secret', body),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('streams accepted intake events to connected SSE clients', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sse-broadcast');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      const controller = new AbortController();
      try {
        const eventsResponse = await fetch(`http://127.0.0.1:${port}/events`, {
          signal: controller.signal,
        });
        expect(eventsResponse.status).toBe(200);
        const reader = eventsResponse.body?.getReader();
        if (reader === undefined) throw new Error('missing events reader');
        await reader.read();

        const posted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', '{}'),
          body: '{}',
        });
        expect(posted.status).toBe(202);

        const chunk = await reader.read();
        const frame = new TextDecoder().decode(chunk.value);
        expect(frame).toContain('id: local-event-000001');
        expect(frame).toContain('event: github.issue');
      } finally {
        controller.abort();
        await closeTestServer(result);
      }
    });
  });

  it('serves event detail self links and paginates local events', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'event-detail-pagination');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        for (let index = 0; index < 3; index += 1) {
          const posted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
            method: 'POST',
            headers: githubWebhookHeaders('secret', '{}'),
            body: '{}',
          });
          expect(posted.status).toBe(202);
        }

        const firstPage = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=2`);
        const firstPageBody = await firstPage.json() as { data: Array<{ id: string; links: { self: string } }>; page: { nextCursor: string | null } };
        expect(firstPageBody.data).toHaveLength(2);
        expect(firstPageBody.data.map((event) => event.id)).toEqual([
          'local-event-000003',
          'local-event-000002',
        ]);
        expect(firstPageBody.page.nextCursor).toEqual(expect.any(String));

        const detail = await fetch(`http://127.0.0.1:${port}${firstPageBody.data[0]!.links.self}`);
        expect(detail.status).toBe(200);
        await expect(detail.json()).resolves.toMatchObject({
          data: {
            id: firstPageBody.data[0]!.id,
            type: 'event',
            compact: { id: firstPageBody.data[0]!.id, name: 'github.issue' },
            record: {
              name: 'github.issue',
              envelope: {
                id: firstPageBody.data[0]!.id,
                name: 'github.issue',
              },
            },
          },
        });

        const secondPage = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=2&cursor=${firstPageBody.page.nextCursor}`);
        const secondPageBody = await secondPage.json() as { data: Array<{ id: string }>; page: { nextCursor: string | null } };
        expect(secondPageBody.data).toHaveLength(1);
        expect(secondPageBody.data.map((event) => event.id)).toEqual(['local-event-000001']);
        expect(secondPageBody.page.nextCursor).toBeNull();
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('keeps only the latest local intake events in memory', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'event-history-limit');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        for (let index = 0; index < 55; index += 1) {
          const body = JSON.stringify({ index });
          const posted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
            method: 'POST',
            headers: githubWebhookHeaders('secret', body, { delivery: `delivery-${index}` }),
            body,
          });
          expect(posted.status).toBe(202);
        }

        const events = await fetch(`http://127.0.0.1:${port}/api/v1/events`);
        const body = await events.json() as { data: Array<{ id: string }>; page: { nextCursor: string | null } };
        expect(body.data).toHaveLength(50);
        expect(body.data[0]?.id).toBe('local-event-000055');
        expect(body.data.at(-1)?.id).toBe('local-event-000006');
        expect(body.data.some((event) => event.id === 'local-event-000001')).toBe(false);
        expect(body.page.nextCursor).toBeNull();
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('filters local events by source type and event name before pagination', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'event-filters');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
            {
              type: 'manual-chat',
              name: 'manual-local',
              sourceType: 'manual',
              endpoint: '/manual',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect((await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', '{}'),
          body: '{}',
        })).status).toBe(202);
        expect((await fetch(`http://127.0.0.1:${port}/manual`, { method: 'POST', body: '{}' })).status).toBe(202);

        const manualEvents = await fetch(`http://127.0.0.1:${port}/api/v1/events?filter[source]=manual`);
        await expect(manualEvents.json()).resolves.toMatchObject({
          data: [{ source: { type: 'manual', name: 'manual-local' }, name: 'manual.event' }],
          page: { nextCursor: null },
        });

        const githubEvents = await fetch(`http://127.0.0.1:${port}/api/v1/events?filter[name]=github.issue`);
        await expect(githubEvents.json()).resolves.toMatchObject({
          data: [{ source: { type: 'github', name: 'github-local' }, name: 'github.issue' }],
          page: { nextCursor: null },
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects invalid local event cursors', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'invalid-event-cursor');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/events?cursor=not-a-cursor`);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_cursor' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects invalid local collection limits', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'invalid-event-limit');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        for (const limit of ['0', '1000']) {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=${limit}`);
          expect(response.status).toBe(400);
          await expect(response.json()).resolves.toEqual({ error: 'invalid_limit' });
        }
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects malformed sourceBundles before starting', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'malformed-source-bundles');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: {},
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      let started = false;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => {
          started = true;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('config.sourceBundles must be an array');
      expect(started).toBe(false);
    });
  });

  it('accepts bracketed IPv6 localhost Host headers', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'ipv6-localhost');
      const port = await getFreePort('::1');

      const result = await runRainrailCliAsync(['start', '--host', '::1', '--port', String(port)], {
        cwd: projectRoot,
      });
      try {
        expect(result.exitCode).toBe(0);
        const health = await fetch(`http://[::1]:${port}/healthz`);
        expect(health.status).toBe(200);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('normalizes bracketed IPv6 bind hosts before listening', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'ipv6-bracket-bind');
      const port = await getFreePort('::1');

      const result = await runRainrailCliAsync(['start', '--host', '[::1]', '--port', String(port)], {
        cwd: projectRoot,
      });
      try {
        expect(result.exitCode).toBe(0);
        const health = await fetch(`http://[::1]:${port}/healthz`);
        expect(health.status).toBe(200);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('uses configured allowed hosts for authenticated public dashboard requests', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'public-allowed-host');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port, allowedHosts: ['192.168.1.10'] },
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.write([
          'GET /api/v1/overview HTTP/1.1',
          `Host: 192.168.1.10:${port}`,
          'Authorization: Bearer events-token',
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          response += chunk;
        });
        await once(socket, 'end');

        expect(response).toContain('200 OK');
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('matches dashboard bearer auth error contracts', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-contract');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);

        const missing = await fetch(`http://127.0.0.1:${port}/api/v1/overview`);
        expect(missing.status).toBe(401);
        await expect(missing.json()).resolves.toEqual({ error: 'missing_bearer_token' });

        const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
          headers: { Authorization: 'Bearer wrong-token' },
        });
        expect(invalid.status).toBe(403);
        await expect(invalid.json()).resolves.toEqual({ error: 'invalid_bearer_token' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('requires source-specific signatures instead of dashboard bearer auth for public intake routes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'public-intake-auth');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const rejected = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          body,
        });
        expect(rejected.status).toBe(401);

        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('requires configured intake signatures on localhost', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'localhost-intake-auth');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const rejected = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          body,
        });
        expect(rejected.status).toBe(401);

        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('accepts signed public intake routes under non-core api paths', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'api-intake-route');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/api/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const accepted = await fetch(`http://127.0.0.1:${port}/api/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('resolves configured webhookSecret names from the environment for public intake routes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'webhook-secret-name');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: {
          GITHUB_WEBHOOK_SECRET: 'actual-secret',
          SSE_BEARER_TOKEN: 'events-token',
        },
      });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('actual-secret', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('keeps uppercase webhookSecret values expanded from config env references', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'uppercase-expanded-secret');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: '${GITHUB_WEBHOOK_SECRET}',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: {
          GITHUB_WEBHOOK_SECRET: 'ABC123',
          SSE_BEARER_TOKEN: 'events-token',
        },
      });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('ABC123', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('does not treat unrelated expanded values as webhookSecret expansion', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'unrelated-expanded-secret-name');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {
          github: { token: '${TOKEN_ALIAS}' },
        },
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: {
          SSE_BEARER_TOKEN: 'events-token',
          TOKEN_ALIAS: 'GITHUB_WEBHOOK_SECRET',
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('config.sourceBundles[0].sources[0].webhookSecret must resolve to a non-empty string for GitHub webhook sources');
    });
  });

  it('tracks webhookSecret env expansion per source', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'per-source-webhook-secret-expansion');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-expanded',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: '${SECRET_A}',
              endpoint: '/webhooks/github-expanded',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: {
          SSE_BEARER_TOKEN: 'events-token',
          SECRET_A: 'GITHUB_WEBHOOK_SECRET',
        },
      });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github-expanded`, {
          method: 'POST',
          headers: githubWebhookHeaders('GITHUB_WEBHOOK_SECRET', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('uses the default github webhook endpoint for top-level github sources', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'top-level-github-source');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [],
        sources: [{
          type: 'github',
          name: 'github-webhook',
          webhookSecret: 'secret',
        }],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const sources = await fetch(`http://127.0.0.1:${port}/api/v1/sources`);
        await expect(sources.json()).resolves.toMatchObject({
          data: [{
            name: 'github-webhook',
            sourceType: 'github',
            endpoint: '/webhooks/github',
            auth: { status: 'configured' },
          }],
        });
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', '{}'),
          body: '{}',
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('treats empty SSE_BEARER_TOKEN as unset on localhost', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'empty-events-token');
      const port = await getFreePort();

      const result = await runRainrailCliAsync(['start', '--port', String(port)], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: '' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const overview = await fetch(`http://127.0.0.1:${port}/api/v1/overview`);
        expect(overview.status).toBe(200);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects endpoint values that are not plain paths and duplicate endpoints', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'invalid-endpoints');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github?x=1',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const invalidEndpoint = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(invalidEndpoint.exitCode).toBe(1);
      expect(invalidEndpoint.stderr).toContain('config endpoint must be a path without query or fragment');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: 'webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const relativeEndpoint = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(relativeEndpoint.exitCode).toBe(1);
      expect(relativeEndpoint.stderr).toContain('config endpoint must start with "/"');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/api/v1/events',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const coreEndpoint = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(coreEndpoint.exitCode).toBe(1);
      expect(coreEndpoint.stderr).toContain('config endpoint must not use a Rainrail core route');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'cloudflare',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const mismatchedSourceType = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(mismatchedSourceType.exitCode).toBe(1);
      expect(mismatchedSourceType.stderr).toContain('config.sourceBundles[0].sources[0].sourceType must be "github" for github-webhook sources');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const missingWebhookSecret = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(missingWebhookSecret.exitCode).toBe(1);
      expect(missingWebhookSecret.stderr).toContain('config.sourceBundles[0].sources[0].webhookSecret must be a non-empty string for github-webhook sources');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'a'.repeat(54),
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const longGitHubWebhookName = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(longGitHubWebhookName.exitCode).toBe(1);
      expect(longGitHubWebhookName.stderr).toContain('config.sourceBundles[0].sources[0].name must be 53 characters or fewer for github-webhook sources');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-one',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
            {
              type: 'github-webhook',
              name: 'github-two',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const duplicateEndpoint = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(duplicateEndpoint.exitCode).toBe(1);
      expect(duplicateEndpoint.stderr).toContain('config endpoints must be unique');

      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
            {
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github-2',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const duplicateName = runRainrailCli(['start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });
      expect(duplicateName.exitCode).toBe(1);
      expect(duplicateName.stderr).toContain('config source names must be unique');
    });
  });

  it('rejects non-loopback Host headers on localhost start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'host-allowlist');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.write('GET /api/v1/overview HTTP/1.1\\r\\nHost: attacker.example:8787\\r\\nConnection: close\\r\\n\\r\\n');
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          response += chunk;
        });
        await once(socket, 'end');

        expect(response).toContain('400 Bad Request');
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects unresolved webhookSecret names before opening GitHub intake routes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'unresolved-webhook-secret');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '0.0.0.0', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('config.sourceBundles[0].sources[0].webhookSecret must resolve to a non-empty string for GitHub webhook sources');
    });
  });

  it('filters and paginates local dashboard sources', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'source-filters');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-local',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'secret',
              endpoint: '/webhooks/github',
            },
            {
              type: 'manual-chat',
              name: 'manual-local',
              sourceType: 'manual',
              endpoint: '/manual',
            },
          ],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const filtered = await fetch(`http://127.0.0.1:${port}/api/v1/sources?filter[source]=github`);
        await expect(filtered.json()).resolves.toMatchObject({
          data: [{ name: 'github-local', sourceType: 'github' }],
          page: { limit: 50, nextCursor: null },
        });

        const firstPage = await fetch(`http://127.0.0.1:${port}/api/v1/sources?limit=1`);
        const firstPageBody = await firstPage.json() as { data: Array<{ name: string }>; page: { nextCursor: string | null } };
        expect(firstPageBody.data).toHaveLength(1);
        expect(firstPageBody.page.nextCursor).toEqual(expect.any(String));

        const secondPage = await fetch(`http://127.0.0.1:${port}/api/v1/sources?limit=1&cursor=${firstPageBody.page.nextCursor}`);
        const secondPageBody = await secondPage.json() as { data: Array<{ name: string }>; page: { nextCursor: string | null } };
        expect(secondPageBody.data).toHaveLength(1);
        expect(secondPageBody.page.nextCursor).toBeNull();
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('serves local source detail self links and last delivery state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'source-detail');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const body = '{}';
        const intake = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body),
          body,
        });
        expect(intake.status).toBe(202);

        const sources = await fetch(`http://127.0.0.1:${port}/api/v1/sources`);
        const sourcesBody = await sources.json() as { data: Array<{ links: { self: string }; lastDelivery?: unknown }> };
        expect(sourcesBody.data[0]?.lastDelivery).toMatchObject({
          id: 'local-event-000001',
          status: 'received',
        });

        const detail = await fetch(`http://127.0.0.1:${port}${sourcesBody.data[0]?.links.self}`);
        expect(detail.status).toBe(200);
        await expect(detail.json()).resolves.toMatchObject({
          data: {
            id: 'github-local',
            type: 'source',
            lastDelivery: { id: 'local-event-000001' },
          },
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('rejects unsupported local dashboard filters and sorts', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'unsupported-query');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const badFilter = await fetch(`http://127.0.0.1:${port}/api/v1/events?filter[status]=failed`);
        expect(badFilter.status).toBe(400);
        await expect(badFilter.json()).resolves.toEqual({ error: 'unsupported_filter', filter: 'filter[status]' });

        const badSort = await fetch(`http://127.0.0.1:${port}/api/v1/events?sort=oldest`);
        expect(badSort.status).toBe(400);
        await expect(badSort.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'oldest' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('applies collection query contracts to empty local dashboard collections', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'empty-collection-query-contract');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const workflowRuns = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs?limit=25`);
        await expect(workflowRuns.json()).resolves.toMatchObject({
          data: [],
          page: { limit: 25, nextCursor: null },
        });

        const badAgentTaskCursor = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks?cursor=not-a-cursor`);
        expect(badAgentTaskCursor.status).toBe(400);
        await expect(badAgentTaskCursor.json()).resolves.toEqual({ error: 'invalid_cursor' });

        const badQueueFilter = await fetch(`http://127.0.0.1:${port}/api/v1/queue?filter[unknown]=upcoming`);
        expect(badQueueFilter.status).toBe(400);
        await expect(badQueueFilter.json()).resolves.toEqual({ error: 'unsupported_filter', filter: 'filter[unknown]' });

        const badWorkflowSort = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs?sort=newest`);
        expect(badWorkflowSort.status).toBe(400);
        await expect(badWorkflowSort.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'newest' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('paginates local dashboard settings', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'settings-pagination');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const firstPage = await fetch(`http://127.0.0.1:${port}/api/v1/settings?limit=1`);
        const firstPageBody = await firstPage.json() as { data: Array<{ id: string }>; page: { limit: number; nextCursor: string | null } };
        expect(firstPage.status).toBe(200);
        expect(firstPageBody.data).toEqual([
          { id: 'max-concurrency', type: 'setting', status: 'read-only', label: 'Max concurrency', value: '1 task' },
        ]);
        expect(firstPageBody.page).toMatchObject({ limit: 1, nextCursor: expect.any(String) });

        const secondPage = await fetch(`http://127.0.0.1:${port}/api/v1/settings?limit=1&cursor=${firstPageBody.page.nextCursor}`);
        await expect(secondPage.json()).resolves.toMatchObject({
          data: [{ id: 'auto-start' }],
          page: { limit: 1, nextCursor: expect.any(String) },
        });

        const fullCollection = await fetch(`http://127.0.0.1:${port}/api/v1/settings`);
        const fullBody = await fullCollection.json() as { data: Array<{ id: string }> };
        expect(fullBody.data.map((row) => row.id)).toEqual([
          'max-concurrency',
          'auto-start',
          'retry-policy',
          'operational-snapshot-limit',
          'dashboard-auth',
          'runtime',
        ]);

        const badCursor = await fetch(`http://127.0.0.1:${port}/api/v1/settings?cursor=not-a-cursor`);
        expect(badCursor.status).toBe(400);
        await expect(badCursor.json()).resolves.toEqual({ error: 'invalid_cursor' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('returns 405 for configured intake method mismatches', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'intake-method');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const mismatch = await fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: 'PUT' });
        expect(mismatch.status).toBe(405);
        expect(mismatch.headers.get('allow')).toBe('POST, OPTIONS');
        await expect(mismatch.json()).resolves.toEqual({ error: 'method_not_allowed' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('returns 405 for local dashboard route method mismatches', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-method');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const mismatch = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, { method: 'POST' });
        expect(mismatch.status).toBe(405);
        expect(mismatch.headers.get('allow')).toBe('GET, OPTIONS');
        await expect(mismatch.json()).resolves.toEqual({ error: 'method_not_allowed' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('paginates UTF-8 local source names', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'utf8-source-cursor');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [],
        sources: [
          {
            type: 'github',
            name: '日本語-source',
            webhookSecret: 'secret-a',
            endpoint: '/manual-a',
          },
          {
            type: 'github',
            name: 'manual-local',
            webhookSecret: 'secret-b',
            endpoint: '/manual-b',
          },
        ],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const firstPage = await fetch(`http://127.0.0.1:${port}/api/v1/sources?limit=1`);
        expect(firstPage.status).toBe(200);
        const firstPageBody = await firstPage.json() as { page: { nextCursor: string | null } };
        expect(firstPageBody.page.nextCursor).toEqual(expect.any(String));

        const secondPage = await fetch(`http://127.0.0.1:${port}/api/v1/sources?limit=1&cursor=${firstPageBody.page.nextCursor}`);
        expect(secondPage.status).toBe(200);
        await expect(secondPage.json()).resolves.toMatchObject({
          data: [{ name: 'manual-local' }],
          page: { nextCursor: null },
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('answers dashboard API CORS preflight before bearer auth', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-preflight');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--host', '0.0.0.0', '--port', String(port)], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const preflight = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:3000',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
          },
        });

        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
        expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('does not grant CORS access to arbitrary origins', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-cors-origin');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
          headers: { Origin: 'https://attacker.example' },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('adds CORS headers to local SSE streams', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'events-cors');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      const controller = new AbortController();
      try {
        expect(result.exitCode).toBe(0);
        const events = await fetch(`http://127.0.0.1:${port}/events`, {
          headers: { Origin: 'http://localhost:3000' },
          signal: controller.signal,
        });
        expect(events.status).toBe(200);
        expect(events.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      } finally {
        controller.abort();
        await closeTestServer(result);
      }
    });
  });

  it('does not expose workspace paths on public health checks', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'public-healthz');
      const port = await getFreePort();
      const result = await runRainrailCliAsync(['start', '--host', '0.0.0.0', '--port', String(port)], {
        cwd: projectRoot,
        env: { SSE_BEARER_TOKEN: 'events-token' },
      });
      try {
        expect(result.exitCode).toBe(0);
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ ok: true, runtime: 'node' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('applies configured intake body size limits', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'body-limit');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
            maxBodyBytes: 4,
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        const rejected = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          body: '12345',
        });
        expect(rejected.status).toBe(413);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('uses the existing 25 MiB default intake body limit', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'default-body-limit');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        sourceBundles: [{
          type: 'eep-bridge',
          name: 'local',
          sources: [{
            type: 'github-webhook',
            name: 'github-local',
            sourceType: 'github',
            provider: 'github',
            webhookSecret: 'secret',
            endpoint: '/webhooks/github',
          }],
        }],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        const body = JSON.stringify({ payload: 'x'.repeat(1024 * 1024 + 1) });
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('keeps running after receiving an invalid Host header', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'bad-host');
      const port = await getFreePort();

      const result = await runRainrailCliAsync(['start', '--port', String(port)], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.write('GET /healthz HTTP/1.1\\r\\nHost: bad host\\r\\nConnection: close\\r\\n\\r\\n');
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          response += chunk;
        });
        await once(socket, 'end');

        expect(response).toContain('400 Bad Request');
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('requires an SSE bearer token before binding to public interfaces', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'public-bind');
      const port = await getFreePort();

      const result = await runRainrailCliAsync(['start', '--host', '0.0.0.0', '--port', String(port)], {
        cwd: projectRoot,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, dashboardAuth.adminToken, or SSE_BEARER_TOKEN is required when rainrail start binds outside localhost');
    });
  });

  it('ships static metadata for initial official plugin command discovery', () => {
    expect(OFFICIAL_PLUGIN_CATALOG.map((plugin) => plugin.alias)).toEqual([
      'github',
      'cloudflare',
      'openclaw',
    ]);
    expect(getOfficialPluginByAlias('gh')?.alias).toBe('github');
    expect(getOfficialPluginByAlias('cf')?.alias).toBe('cloudflare');
    expect(getOfficialPluginByAlias('oc')?.alias).toBe('openclaw');
    expect(getOfficialPluginByAlias('__proto__')).toBeUndefined();
  });

  it('prints plugin help from static metadata without requiring a project config', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['github', 'help'], { cwd: directory });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: rainrail github <command>');
      expect(result.stdout).toContain('GitHub official plugin');
      expect(result.stdout).toContain('  setup');
      expect(result.stdout).toContain('  doctor');
      expect(result.stdout).toContain('  webhook add');
    });
  });

  it('prints official plugin command help from static metadata', () => {
    const result = runRainrailCli(['github', 'webhook', 'add', 'help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: rainrail github webhook add <owner/repo>');
    expect(result.stdout).toContain('Register a GitHub webhook endpoint for a repository.');
  });

  it('prints canonical plugin command help from canonical plugin routing', () => {
    const result = runRainrailCli(['plugin', 'github', 'setup', 'help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: rainrail plugin github setup [options]');
    expect(result.stdout).not.toContain('Usage: rainrail github setup [options]');
  });

  it('resolves official plugin aliases before project-local plugin execution', () => {
    const result = runRainrailCli(['gh', 'doctor']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail github doctor requires plugin execution');
  });

  it('runs canonical official plugin setup through the bundled command route', () => {
    const result = runRainrailCli(['plugin', 'github', 'setup']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Official plugin github setup completed. No bundled setup actions are registered yet.\n',
    );
    expect(result.stderr).toBe('');
  });

  it('runs official plugin alias setup after built-in command lookup', () => {
    const result = runRainrailCli(['github', 'setup']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Official plugin github setup completed. No bundled setup actions are registered yet.\n',
    );
    expect(result.stderr).toBe('');
  });

  it('rejects unsupported official plugin setup arguments', () => {
    const result = runRainrailCli(['plugin', 'github', 'setup', 'typo']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown rainrail plugin github command: setup typo');
  });

  it('keeps built-in commands ahead of plugin aliases and points verbose callers to canonical plugin form', () => {
    const result = runRainrailCli(['--verbose', 'plugins', 'run'], {
      pluginAliasResolver: (alias) => alias === 'plugins'
        ? {
            name: 'plugins',
            alias: 'plugins',
            aliases: ['plugins'],
            version: '0.1.0',
            summary: 'Conflicting plugin.',
            helpText: 'Conflicting plugin metadata.',
            commands: [
              {
                name: 'run',
                summary: 'Run the conflicting plugin.',
                helpText: 'Usage: rainrail plugin plugins run',
              },
            ],
          }
        : undefined,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail plugins is a built-in command.');
    expect(result.stderr).toContain('A plugin named "plugins" also exists.');
    expect(result.stderr).toContain('Use `rainrail plugin plugins run` to call the plugin.');
  });

  it('lets removed built-in command names resolve as plugins', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--verbose', 'new', 'run'], {
        cwd: directory,
        pluginAliasResolver: (alias) => alias === 'new'
          ? {
              name: 'new',
              alias: 'new',
              aliases: ['new'],
              version: '0.1.0',
              summary: 'Conflicting implemented built-in plugin.',
              helpText: 'Conflicting implemented built-in plugin metadata.',
              commands: [
                {
                  name: 'run',
                  summary: 'Run the conflicting plugin.',
                  helpText: 'Usage: rainrail plugin new run',
                },
              ],
            }
          : undefined,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('rainrail new run requires plugin execution');
      await expect(stat(join(directory, 'run'))).rejects.toThrow();
    });
  });

  it('lets canonical plugin commands call plugins whose names collide with built-ins', () => {
    const result = runRainrailCli(['plugin', 'plugins', 'run'], {
      pluginAliasResolver: (alias) => alias === 'plugins'
        ? {
            name: 'plugins',
            alias: 'plugins',
            aliases: ['plugins'],
            version: '0.1.0',
            summary: 'Conflicting plugin.',
            helpText: 'Conflicting plugin metadata.',
            commands: [
              {
                name: 'run',
                summary: 'Run the conflicting plugin.',
                helpText: 'Usage: rainrail plugin plugins run',
              },
            ],
          }
        : undefined,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail plugin plugins run requires plugin execution');
  });

  it('prints canonical plugin help when a plugin name collides with a built-in command', () => {
    const result = runRainrailCli(['plugin', 'plugins', 'help'], {
      pluginAliasResolver: (alias) => alias === 'plugins'
        ? {
            name: 'plugins',
            alias: 'plugins',
            aliases: ['plugins'],
            version: '0.1.0',
            summary: 'Conflicting plugin.',
            helpText: 'Conflicting plugin metadata.',
            commands: [
              {
                name: 'run',
                summary: 'Run the conflicting plugin.',
                helpText: 'Usage: rainrail plugin plugins run',
              },
            ],
          }
        : undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: rainrail plugin plugins <command>');
    expect(result.stdout).not.toContain('Usage: rainrail plugins <command>');
  });

  it('prints help from the --help flag', () => {
    expect(runRainrailCli(['--help'])).toEqual(runRainrailCli(['help']));
  });

  it('prints official setup choices without mutating the project when --yes is omitted', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['setup'], { cwd: projectRoot });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Official plugins available for setup:');
      expect(result.stdout).toContain('  github');
      expect(result.stdout).toContain('  cloudflare');
      expect(result.stdout).toContain('  openclaw');
      expect(result.stdout).toContain('Run `rainrail setup --yes` to install and set up all official plugins.');
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"plugins": []',
      );
    });
  });

  it('prints only selected official setup choices when plugin arguments are provided', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['setup', 'gh'], { cwd: projectRoot });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Official plugins selected for setup:');
      expect(result.stdout).toContain('  github');
      expect(result.stdout).not.toContain('  cloudflare');
      expect(result.stdout).not.toContain('  openclaw');
      expect(result.stdout).toContain('Run `rainrail setup github --yes` to install and set up selected official plugins.');
    });
  });

  it('includes target options in selected setup text preview next action', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'target-project');
      const configPath = join(projectRoot, 'rainrail.config.json');

      const result = runRainrailCli([
        '--config',
        configPath,
        '--profile',
        'ci',
        'setup',
        'gh',
      ], { cwd: directory });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        `Run \`rainrail --config ${configPath} --profile ci setup github --yes\` to install and set up selected official plugins.`,
      );
    });
  });

  it('orchestrates official plugin install and setup commands in --yes mode', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const calls: Array<{
        command: string;
        args: readonly string[];
        options: unknown;
      }> = [];

      const result = runRainrailCli(['setup', '--yes'], {
        cwd: projectRoot,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stdout: `${args.join(' ')} complete\n`, stderr: '' };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken in rainrail.config.json');
      expect(result.stdout).toContain('Added official plugin github@0.1.0');
      expect(result.stdout).toContain('plugin github setup --yes complete');
      expect(result.stdout).toContain('Added official plugin cloudflare@0.1.0');
      expect(result.stdout).toContain('plugin cloudflare setup --yes complete');
      expect(result.stdout).toContain('Added official plugin openclaw@0.1.0');
      expect(result.stdout).toContain('plugin openclaw setup --yes complete');
      expect(calls).toEqual([
        {
          command: '/opt/rainrail/bin/rainrail',
          args: ['plugin', 'github', 'setup', '--yes'],
          options: { stdio: 'pipe', cwd: projectRoot },
        },
        {
          command: '/opt/rainrail/bin/rainrail',
          args: ['plugin', 'cloudflare', 'setup', '--yes'],
          options: { stdio: 'pipe', cwd: projectRoot },
        },
        {
          command: '/opt/rainrail/bin/rainrail',
          args: ['plugin', 'openclaw', 'setup', '--yes'],
          options: { stdio: 'pipe', cwd: projectRoot },
        },
      ]);
      const lockfile = await readFile(join(projectRoot, 'rainrail.lock'), 'utf8');
      expect(lockfile).toContain('"name": "cloudflare"');
      expect(lockfile).toContain('"name": "github"');
      expect(lockfile).toContain('"name": "openclaw"');
    });
  });

  it('uses the bundled official plugin setup route when no command runner is injected', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['setup', 'github', '--yes'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 0,
        stdout:
          'Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken in rainrail.config.json.\n' +
          'Added official plugin github@0.1.0\n' +
          'Official plugin github setup completed. No bundled setup actions are registered yet.\n',
        stderr: '',
      });
    });
  });

  it('generates stable local dashboard auth tokens during setup --yes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-setup');
      const configPath = join(projectRoot, 'rainrail.config.json');

      const first = runRainrailCli(['setup', 'github', '--yes'], { cwd: projectRoot });
      const firstConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };
      const second = runRainrailCli(['setup', 'github', '--yes'], { cwd: projectRoot });
      const secondConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain('Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken');
      expect(firstConfig.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(firstConfig.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).not.toContain('Generated dashboardAuth');
      expect(secondConfig.dashboardAuth).toEqual(firstConfig.dashboardAuth);
    });
  });

  it('preserves dashboard auth environment references when generating missing setup tokens', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-env-reference');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, `${JSON.stringify({
        project: { name: 'dashboard-auth-env-reference' },
        dashboardAuth: {
          readOnlyToken: '${DASHBOARD_READ_TOKEN}',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { DASHBOARD_READ_TOKEN: 'actual-read-secret' },
      });
      const rawConfig = await readFile(configPath, 'utf8');

      expect(result.exitCode).toBe(0);
      expect(rawConfig).toContain('"readOnlyToken": "${DASHBOARD_READ_TOKEN}"');
      expect(rawConfig).not.toContain('actual-read-secret');
      expect(rawConfig).toMatch(/"operatorToken": "rr_local_operator_[A-Za-z0-9_-]+"/u);
    });
  });

  it('preserves unresolved dashboard auth environment references while generating missing setup tokens', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-unresolved-env-reference');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-unresolved-env-reference" },',
        '  "dashboardAuth": {',
        '    "readOnlyToken": "${DASHBOARD_READ_TOKEN}"',
        '  },',
        '  "sourceBundles": [],',
        '  "sources": [],',
        '  "taskProviders": ${TASK_PROVIDERS},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { TASK_PROVIDERS: '{}' },
      });
      const rawConfig = await readFile(configPath, 'utf8');

      expect(result.exitCode).toBe(0);
      expect(rawConfig).toContain('"readOnlyToken": "${DASHBOARD_READ_TOKEN}"');
      expect(rawConfig).toContain('"taskProviders": ${TASK_PROVIDERS}');
      expect(rawConfig).toMatch(/"operatorToken": "rr_local_operator_[A-Za-z0-9_-]+"/u);
    });
  });

  it('validates project-local state before writing dashboard auth tokens during setup', async () => {
    await withTempDirectory(async (directory) => {
      const configPath = join(directory, 'rainrail.config.json');
      await writeFile(configPath, `${JSON.stringify({
        project: { name: 'not-a-complete-project' },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['--config', configPath, 'setup', 'github', '--yes'], { cwd: directory });
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { dashboardAuth?: unknown };

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('rainrail setup requires a complete Rainrail project');
      expect(config.dashboardAuth).toBeUndefined();
    });
  });

  it('expands config environment fragments before generating dashboard auth tokens during setup', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-expanded-config');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-expanded-config" },',
        '  "sourceBundles": [],',
        '  "sources": ${RAINRAIL_SOURCES},',
        '  "taskProviders": {},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { RAINRAIL_SOURCES: '[]' },
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const config = JSON.parse(rawConfig.replace('${RAINRAIL_SOURCES}', '[]')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(rawConfig).toContain('"sources": ${RAINRAIL_SOURCES}');
      expect(config.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
    });
  });

  it('preserves env fragments when dashboardAuth already exists during setup token generation', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-existing-fragment');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-existing-fragment" },',
        '  "dashboardAuth": {},',
        '  "sourceBundles": [],',
        '  "sources": [],',
        '  "taskProviders": ${TASK_PROVIDERS},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { TASK_PROVIDERS: '{"github":{"token":"actual-provider-secret"}}' },
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const parseableConfig = JSON.parse(rawConfig.replace('${TASK_PROVIDERS}', '{}')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(rawConfig).toContain('"taskProviders": ${TASK_PROVIDERS}');
      expect(rawConfig).not.toContain('actual-provider-secret');
      expect(parseableConfig.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(parseableConfig.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
    });
  });

  it('does not insert duplicate dashboardAuth when the whole object is an environment fragment', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-object-fragment');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const originalConfig = [
        '{',
        '  "project": { "name": "dashboard-auth-object-fragment" },',
        '  "dashboardAuth": ${DASHBOARD_AUTH},',
        '  "sourceBundles": [],',
        '  "sources": [],',
        '  "taskProviders": {},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n');
      await writeFile(configPath, originalConfig);

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { DASHBOARD_AUTH: '{"readOnlyToken":"fragment-read-token"}' },
      });
      const rawConfig = await readFile(configPath, 'utf8');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('config.dashboardAuth must be an object in rainrail.config.json');
      expect(rawConfig).toBe(originalConfig);
      expect(rawConfig.match(/"dashboardAuth"/gu)).toHaveLength(1);
      expect(rawConfig).not.toContain('rr_local_operator');
    });
  });

  it('limits setup orchestration to explicitly selected official plugins', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const calls: Array<{ args: readonly string[] }> = [];

      const result = runRainrailCli(['--yes', 'setup', 'gh', 'oc'], {
        cwd: projectRoot,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: (_command, args) => {
          calls.push({ args });
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(calls.map((call) => call.args)).toEqual([
        ['plugin', 'github', 'setup', '--yes'],
        ['plugin', 'openclaw', 'setup', '--yes'],
      ]);
      const lockfile = await readFile(join(projectRoot, 'rainrail.lock'), 'utf8');
      expect(lockfile).toContain('"name": "github"');
      expect(lockfile).not.toContain('"name": "cloudflare"');
      expect(lockfile).toContain('"name": "openclaw"');
    });
  });

  it('returns setup orchestration steps as JSON for automation', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['--json', '--yes', 'setup', 'github'], {
        cwd: projectRoot,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: () => ({ status: 0, stdout: 'github setup ok\n', stderr: '' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        command: 'setup',
        completed: true,
        plugins: ['github'],
        steps: [
          {
            plugin: 'github',
            action: 'install',
            command: ['rainrail', 'plugins', 'add', 'github'],
            exitCode: 0,
            status: 'completed',
            stdout: 'Added official plugin github@0.1.0\n',
            stderr: '',
          },
          {
            plugin: 'github',
            action: 'setup',
            command: ['rainrail', 'plugin', 'github', 'setup', '--yes', '--json'],
            exitCode: 0,
            status: 'completed',
            stdout: 'github setup ok\n',
            stderr: '',
          },
        ],
      });
    });
  });

  it('returns setup preview as JSON when --json is used without --yes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['--json', 'setup', 'gh'], { cwd: projectRoot });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        command: 'setup',
        completed: false,
        plugins: ['github'],
        steps: [],
        nextAction: 'rainrail setup github --yes',
      });
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"plugins": []',
      );
    });
  });

  it('includes target options in setup JSON preview nextAction', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'target-project');
      const configPath = join(projectRoot, 'rainrail.config.json');

      const result = runRainrailCli([
        '--json',
        '--config',
        configPath,
        '--profile',
        'ci',
        'setup',
        'gh',
      ], { cwd: directory });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        plugins: ['github'],
        nextAction: `rainrail --config ${configPath} --profile ci setup github --yes`,
      });
    });
  });

  it('shell-quotes unsafe setup JSON preview nextAction arguments', async () => {
    await withTempDirectory(async (directory) => {
      const spacedParent = join(directory, 'space parent');
      await mkdir(spacedParent);
      const projectRoot = await initRainrailProject(spacedParent, 'target-project');
      const configPath = join(projectRoot, 'rainrail.config.json');

      const result = runRainrailCli([
        '--json',
        '--config',
        configPath,
        'setup',
        'gh',
      ], { cwd: directory });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        nextAction: `rainrail --config '${configPath}' setup github --yes`,
      });
    });
  });

  it('includes target options in setup JSON step commands', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'target-project');
      const nested = join(projectRoot, 'nested');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await mkdir(nested);

      const result = runRainrailCli([
        '--config',
        '../rainrail.config.json',
        '--json',
        '--yes',
        'setup',
        'github',
      ], {
        cwd: nested,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: () => ({ status: 0, stdout: 'github setup ok\n', stderr: '' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        steps: [
          {
            action: 'install',
            command: ['rainrail', '--config', configPath, 'plugins', 'add', 'github'],
          },
          {
            action: 'setup',
            command: [
              'rainrail',
              '--config',
              configPath,
              'plugin',
              'github',
              'setup',
              '--yes',
              '--json',
            ],
          },
        ],
      });
    });
  });

  it('returns setup input errors as JSON when --json is used', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['--json', '--yes', 'setup', 'typo'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        command: 'setup',
        completed: false,
        plugins: [],
        steps: [],
        error:
          'Unknown official plugin: typo. Third-party and Git URL plugins are not supported by rainrail setup.',
      });
    });
  });

  it('resolves relative setup --config before changing into the project root', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'target-project');
      const nested = join(projectRoot, 'nested');
      await mkdir(nested);

      const result = runRainrailCli([
        '--config',
        '../rainrail.config.json',
        '--yes',
        'setup',
        'github',
      ], { cwd: nested });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"name": "github"',
      );
    });
  });

  it('keeps successful plugin setup stderr visible in the top-level result', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: () => ({
          status: 0,
          stdout: 'github setup ok\n',
          stderr: 'github setup warning\n',
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('github setup ok\n');
      expect(result.stderr).toBe('github setup warning\n');
    });
  });

  it('stops setup orchestration at the failed plugin setup step', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const calls: Array<{ args: readonly string[] }> = [];

      const result = runRainrailCli(['--yes', 'setup'], {
        cwd: projectRoot,
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: (_command, args) => {
          calls.push({ args });
          return args[1] === 'cloudflare'
            ? { status: 2, stdout: '', stderr: 'cloudflare missing credentials\n' }
            : { status: 0, stdout: '', stderr: '' };
        },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken');
      expect(result.stdout).toContain('Added official plugin github@0.1.0');
      expect(result.stdout).toContain('Added official plugin cloudflare@0.1.0');
      expect(result.stderr).toBe(
        'rainrail plugin cloudflare setup --yes failed with exit code 2.\ncloudflare missing credentials\n',
      );
      expect(calls.map((call) => call.args[1])).toEqual(['github', 'cloudflare']);
      const lockfile = await readFile(join(projectRoot, 'rainrail.lock'), 'utf8');
      expect(lockfile).toContain('"name": "github"');
      expect(lockfile).toContain('"name": "cloudflare"');
      expect(lockfile).not.toContain('"name": "openclaw"');
    });
  });

  it('returns a clear placeholder error for commands that are not implemented yet', () => {
    const result = runRainrailCli(['doctor']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail doctor is not implemented yet.');
  });

  it('runs the shared installer for rainrail update', () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: unknown;
    }> = [];

    const result = runRainrailCli(
      ['--yes', 'update', '--version', '1.2.3', '--installer', '/tmp/install.sh'],
      {
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stdout: 'installed\n', stderr: '' };
        },
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'installed\n',
      stderr: '',
    });
    expect(calls).toEqual([
      {
        command: 'bash',
        args: [
          '/tmp/install.sh',
          '--version',
          '1.2.3',
          '--prefix',
          '/opt/rainrail',
          '--yes',
        ],
        options: { stdio: 'pipe' },
      },
    ]);
  });

  it('keeps an explicitly provided update prefix', () => {
    const calls: Array<{ args: readonly string[] }> = [];

    const result = runRainrailCli(
      [
        'update',
        '--installer',
        '/tmp/install.sh',
        '--prefix',
        '/custom/rainrail',
        '--version=1.2.3',
      ],
      {
        currentBinPath: '/opt/rainrail/bin/rainrail',
        commandRunner: (_command, args) => {
          calls.push({ args });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual([
      '/tmp/install.sh',
      '--prefix',
      '/custom/rainrail',
      '--version',
      '1.2.3',
    ]);
  });

  it('infers the update prefix from an installed package bin path', () => {
    const calls: Array<{ args: readonly string[] }> = [];

    const result = runRainrailCli(['update', '--installer', '/tmp/install.sh'], {
      currentBinPath: '/opt/rainrail/lib/rainrail/1.2.3/dist/bin/rainrail.js',
      commandRunner: (_command, args) => {
        calls.push({ args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual([
      '/tmp/install.sh',
      '--prefix',
      '/opt/rainrail',
    ]);
  });

  it('rejects rainrail update when no prefix can be inferred or provided', () => {
    const result = runRainrailCli(['update', '--installer', '/tmp/install.sh'], {
      currentBinPath: '/workspace/rainrail/packages/cli/dist/bin/rainrail.js',
      commandRunner: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr:
        'Unable to infer the current Rainrail install prefix. Re-run rainrail update with --prefix <path>.\n',
    });
  });

  it('inherits stdio when rainrail update may prompt through the installer', () => {
    const calls: Array<{ options: unknown }> = [];

    const result = runRainrailCli(
      ['update', '--installer', '/tmp/install.sh', '--prefix', '/opt/rainrail', '--add-to-shell'],
      {
        commandRunner: (_command, _args, options) => {
          calls.push({ options });
          return { status: 0 };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ options: { stdio: 'inherit' } }]);
  });

  it('treats inherited installer output as empty when spawnSync returns null streams', () => {
    const result = runRainrailCli(
      ['update', '--installer', '/tmp/install.sh', '--prefix', '/opt/rainrail', '--add-to-shell'],
      {
        commandRunner: () => ({ status: 0, stdout: null, stderr: null }),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('infers the update prefix from the last installed package marker', () => {
    const calls: Array<{ args: readonly string[] }> = [];

    const result = runRainrailCli(['update', '--installer', '/tmp/install.sh'], {
      currentBinPath:
        '/opt/lib/rainrail/tools/lib/rainrail/1.2.3/dist/bin/rainrail.js',
      commandRunner: (_command, args) => {
        calls.push({ args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual([
      '/tmp/install.sh',
      '--prefix',
      '/opt/lib/rainrail/tools',
    ]);
  });

  it('checks GitHub Releases latest and reports an available stable update as JSON', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        now: () => new Date('2026-07-05T00:00:00.000Z'),
        releaseFetcher: (url) => {
          expect(url).toBe('https://api.github.com/repos/reirei-lab/rainrail/releases/latest');
          return {
            status: 200,
            body: JSON.stringify({
              tag_name: 'release/0.2.1',
              prerelease: false,
              assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'uploaded', size: 123 }],
            }),
          };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        command: 'update check',
        checkedAt: '2026-07-05T00:00:00.000Z',
        currentVersion: '0.2.0',
        latestVersion: '0.2.1',
        updateAvailable: true,
        updateCommand: 'rainrail update --version release/0.2.1',
        cached: false,
      });
    });
  });

  it('normalizes v-prefixed release tags and reports no update for the current version', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.1',
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.2.1',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'uploaded', size: 123 }],
          }),
        }),
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'Rainrail is up to date (0.2.1).\n',
        stderr: '',
      });
    });
  });

  it('offers a stable release update to users currently on a prerelease', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.3.0-beta.1',
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.3.0',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.3.0.tgz', state: 'uploaded', size: 123 }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        currentVersion: '0.3.0-beta.1',
        latestVersion: '0.3.0',
        updateAvailable: true,
        updateCommand: 'rainrail update --version v0.3.0',
      });
    });
  });

  it('does not describe failed update checks as up to date in text output', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.1',
        releaseFetcher: () => ({ status: 403, body: '' }),
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'Unable to check Rainrail updates. Try again later.\n',
        stderr: '',
      });
    });
  });

  it('does not report an update before the matching CLI release asset is published', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.2.1',
            prerelease: false,
            assets: [{ name: 'rainrail-source-v0.2.1.zip' }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        latestVersion: null,
        updateAvailable: false,
        updateCommand: null,
      });
      await expect(readFile(join(directory, 'cache', 'update-check.json'), 'utf8'))
        .rejects.toThrow();
    });
  });

  it('does not report an update while the matching CLI asset upload is incomplete', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'release/0.2.1',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'starter', size: 0 }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        latestVersion: null,
        updateAvailable: false,
        updateCommand: null,
      });
    });
  });

  it('passes v-prefixed release tags through the generated update command', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.2.1',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'uploaded', size: 123 }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        latestVersion: '0.2.1',
        updateAvailable: true,
        updateCommand: 'rainrail update --version v0.2.1',
      });
    });
  });

  it('uses curl HTTP codes and timeouts for the default GitHub Releases check', async () => {
    await withTempDirectory(async (directory) => {
      const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        commandRunner: (command, args, options) => {
          calls.push({ command, args, options });
          return {
            status: 0,
            stdout: `${JSON.stringify({
              tag_name: 'v0.2.1',
              prerelease: false,
              assets: [{ name: 'rainrail-cli-v0.2.1.tgz', state: 'uploaded', size: 123 }],
            })}\n200`,
            stderr: '',
          };
        },
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        latestVersion: '0.2.1',
        updateAvailable: true,
      });
      expect(calls).toEqual([
        {
          command: 'curl',
          args: [
            '-fsSL',
            '--connect-timeout',
            '5',
            '--max-time',
            '10',
            '-H',
            'Accept: application/vnd.github+json',
            '-H',
            'User-Agent: rainrail-cli',
            '-w',
            '\n%{http_code}',
            'https://api.github.com/repos/reirei-lab/rainrail/releases/latest',
          ],
          options: { stdio: 'pipe' },
        },
      ]);
    });
  });

  it('uses a fresh update check cache without calling GitHub Releases again', async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, 'cache'), { recursive: true });
      await writeFile(
        join(directory, 'cache', 'update-check.json'),
        JSON.stringify({
          checkedAt: '2026-07-05T00:00:00.000Z',
          currentVersion: '0.2.0',
          latestVersion: '0.2.2',
          updateAvailable: true,
          updateCommand: 'rainrail update --version 0.2.2',
        }),
      );

      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        now: () => new Date('2026-07-05T12:00:00.000Z'),
        releaseFetcher: () => {
          throw new Error('releaseFetcher should not be called on cache hit');
        },
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        checkedAt: '2026-07-05T00:00:00.000Z',
        latestVersion: '0.2.2',
        updateAvailable: true,
        cached: true,
      });
    });
  });

  it('refreshes a stale update check cache and writes the latest result', async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, 'cache'), { recursive: true });
      await writeFile(
        join(directory, 'cache', 'update-check.json'),
        JSON.stringify({
          checkedAt: '2026-07-03T23:59:00.000Z',
          currentVersion: '0.2.0',
          latestVersion: '0.2.1',
          updateAvailable: true,
          updateCommand: 'rainrail update --version 0.2.1',
        }),
      );

      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        now: () => new Date('2026-07-05T00:00:00.000Z'),
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.2.3',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.2.3.tgz', state: 'uploaded', size: 123 }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        checkedAt: '2026-07-05T00:00:00.000Z',
        latestVersion: '0.2.3',
        updateAvailable: true,
        cached: false,
      });
      await expect(readFile(join(directory, 'cache', 'update-check.json'), 'utf8'))
        .resolves.toContain('"latestVersion": "0.2.3"');
    });
  });

  it('treats fetch failures, invalid JSON, unknown tags, and prereleases as no-op checks', async () => {
    const cases = [
      () => {
        throw new Error('rate limited');
      },
      () => ({ status: 200, body: '{' }),
      () => ({
        status: 200,
        body: JSON.stringify({ tag_name: 'nightly', prerelease: false }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify({
          tag_name: 'v0.3.0-beta.1',
          prerelease: true,
          assets: [{ name: 'rainrail-cli-v0.3.0-beta.1.tgz', state: 'uploaded', size: 123 }],
        }),
      }),
    ];

    await withTempDirectory(async (directory) => {
      for (const [index, releaseFetcher] of cases.entries()) {
        const result = runRainrailCli(['--json', 'update', 'check'], {
          cacheDirectory: join(directory, `cache-${index}`),
          currentVersion: '0.2.0',
          now: () => new Date('2026-07-05T00:00:00.000Z'),
          releaseFetcher,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout) as unknown).toMatchObject({
          currentVersion: '0.2.0',
          latestVersion: null,
          updateAvailable: false,
          updateCommand: null,
        });
      }
    });
  });

  it('treats update check cache timestamps in the future as stale', async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, 'cache'), { recursive: true });
      await writeFile(
        join(directory, 'cache', 'update-check.json'),
        JSON.stringify({
          checkedAt: '2026-07-06T00:00:00.000Z',
          currentVersion: '0.2.0',
          latestVersion: '0.2.1',
          updateAvailable: true,
          updateCommand: 'rainrail update --version 0.2.1',
        }),
      );

      const result = runRainrailCli(['--json', 'update', 'check'], {
        cacheDirectory: join(directory, 'cache'),
        currentVersion: '0.2.0',
        now: () => new Date('2026-07-05T00:00:00.000Z'),
        releaseFetcher: () => ({
          status: 200,
          body: JSON.stringify({
            tag_name: 'v0.2.3',
            prerelease: false,
            assets: [{ name: 'rainrail-cli-v0.2.3.tgz', state: 'uploaded', size: 123 }],
          }),
        }),
      });

      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        checkedAt: '2026-07-05T00:00:00.000Z',
        latestVersion: '0.2.3',
        updateAvailable: true,
        cached: false,
      });
    });
  });

  it('scaffolds a project-local config, lockfile, and plugin directory', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = join(directory, 'my-agent-ops');
      await mkdir(projectRoot);
      const result = runRainrailCli(['init'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 0,
        stdout: `Initialized Rainrail workspace at ${projectRoot}\n`,
        stderr: '',
      });
      const config = await readFile(join(projectRoot, 'rainrail.config.json'), 'utf8');
      expect(JSON.parse(config) as unknown).toEqual({
        project: { name: 'my-agent-ops' },
        server: {
          host: '127.0.0.1',
          port: 8787,
        },
        dashboardAuth: {},
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      });
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toBe(
        `${JSON.stringify({
          lockfileVersion: 1,
          project: { name: 'my-agent-ops' },
          plugins: [],
        }, null, 2)}\n`,
      );
      await expect(readFile(join(projectRoot, '.rainrail', 'plugins', '.gitkeep'), 'utf8')).resolves.toBe('');
      await expect(stat(join(projectRoot, 'my-agent-ops'))).rejects.toThrow();
    });
  });

  it('scaffolds a project-local layout through the injected filesystem', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = join(directory, 'virtual-cwd');
      const directories = new Set<string>();
      const files = new Map<string, string>();
      const statsFor = (path: string) => ({
        isDirectory: () => directories.has(path),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
      });
      const virtualFileSystem: Partial<RainrailCliFileSystem> = {
        existsSync: (path) => directories.has(String(path)) || files.has(String(path)),
        lstatSync: ((path) => statsFor(String(path))) as RainrailCliFileSystem['lstatSync'],
        mkdirSync: ((path) => {
          directories.add(String(path));
          return undefined;
        }) as RainrailCliFileSystem['mkdirSync'],
        readdirSync: ((path) => {
          if (!directories.has(String(path))) {
            throw new Error(`missing virtual directory: ${String(path)}`);
          }
          return [];
        }) as RainrailCliFileSystem['readdirSync'],
        readFileSync: ((path) => {
          const content = files.get(String(path));
          if (content === undefined) {
            throw new Error(`missing virtual file: ${String(path)}`);
          }
          return content;
        }) as RainrailCliFileSystem['readFileSync'],
        writeFileSync: ((path, data) => {
          if (files.has(String(path))) {
            throw new Error(`virtual file already exists: ${String(path)}`);
          }
          files.set(String(path), String(data));
        }) as RainrailCliFileSystem['writeFileSync'],
      };
      directories.add(projectRoot);

      expect(runRainrailCli(['init'], {
        cwd: projectRoot,
        fileSystem: virtualFileSystem,
      })).toEqual({
        exitCode: 0,
        stdout: `Initialized Rainrail workspace at ${projectRoot}\n`,
        stderr: '',
      });

      expect(directories.has(projectRoot)).toBe(true);
      expect(directories.has(join(projectRoot, '.rainrail'))).toBe(true);
      expect(directories.has(join(projectRoot, '.rainrail', 'plugins'))).toBe(true);
      expect(files.get(join(projectRoot, 'rainrail.config.json'))).toContain('"name": "virtual-cwd"');
      expect(files.get(join(projectRoot, 'rainrail.lock'))).toContain('"plugins": []');
      expect(files.get(join(projectRoot, '.rainrail', 'plugins', '.gitkeep'))).toBe('');
      await expect(stat(join(projectRoot, 'my-agent-ops'))).rejects.toThrow();
    });
  });

  it('treats repeated scaffolding as safe when generated files are unchanged', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      expect(runRainrailCli(['init'], { cwd: projectRoot })).toEqual({
        exitCode: 0,
        stdout: `Rainrail workspace already initialized at ${projectRoot}\n`,
        stderr: '',
      });
    });
  });

  it('treats initialized workspaces with installed plugins as safe when init is rerun', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);

      expect(runRainrailCli(['init'], { cwd: projectRoot })).toEqual({
        exitCode: 0,
        stdout: `Rainrail workspace already initialized at ${projectRoot}\n`,
        stderr: '',
      });
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"name": "github"',
      );
    });
  });

  it('refuses invalid project-local lockfiles during scaffolding', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      await writeFile(join(projectRoot, 'rainrail.lock'), '{"plugins":["custom"]}\n');

      expect(runRainrailCli(['init'], { cwd: projectRoot })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported Rainrail lockfile format: ${join(projectRoot, 'rainrail.lock')}\n`,
      });
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toBe(
        '{"plugins":["custom"]}\n',
      );
    });
  });

  it('asks before initializing a non-empty directory and treats yes as confirmation', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'README.md'), 'existing workspace\n');

      expect(runRainrailCli(['init'], { cwd: directory })).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: 'Current directory is not empty. Initialize Rainrail workspace here? [y/N]\n',
      });
      await expect(stat(join(directory, 'rainrail.config.json'))).rejects.toThrow();

      expect(runRainrailCli(['init'], { cwd: directory, stdin: 'yes\n' }).exitCode).toBe(0);
      await expect(readFile(join(directory, 'rainrail.config.json'), 'utf8')).resolves.toContain(
        `"name": "${directory.split('/').at(-1)}"`,
      );
    });
  });

  it('writes the init confirmation prompt before reading stdin in the binary path', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'README.md'), 'existing workspace\n');
      const calls: string[] = [];

      const result = runRainrailCli(['init'], {
        cwd: directory,
        stderrWriter: (message) => {
          calls.push(`stderr:${message}`);
        },
        stdinReader: () => {
          calls.push('stdin');
          return 'n\n';
        },
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      expect(calls).toEqual([
        'stderr:Current directory is not empty. Initialize Rainrail workspace here? [y/N]\n',
        'stdin',
      ]);
      await expect(stat(join(directory, 'rainrail.config.json'))).rejects.toThrow();
    });
  });

  it('does not read stdin in embedded mode when no prompt writer is provided', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'README.md'), 'existing workspace\n');

      expect(runRainrailCli(['init'], { cwd: directory })).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: 'Current directory is not empty. Initialize Rainrail workspace here? [y/N]\n',
      });
      await expect(stat(join(directory, 'rainrail.config.json'))).rejects.toThrow();
    });
  });

  it('returns directory listing failures as CLI errors during init confirmation checks', async () => {
    await withTempDirectory(async (directory) => {
      const cwd = join(directory, 'no-read-project');
      const directories = new Set<string>([cwd]);
      const files = new Map<string, string>();
      const statsFor = (path: string) => ({
        isDirectory: () => directories.has(path),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
      });
      const missing = (path: string) => Object.assign(new Error(`missing: ${path}`), {
        code: 'ENOENT',
      });
      const virtualFileSystem: Partial<RainrailCliFileSystem> = {
        existsSync: (path) => directories.has(String(path)) || files.has(String(path)),
        lstatSync: ((path) => {
          const value = String(path);
          if (!directories.has(value) && !files.has(value)) {
            throw missing(value);
          }
          return statsFor(value);
        }) as RainrailCliFileSystem['lstatSync'],
        readdirSync: (() => {
          throw Object.assign(new Error('mock directory read failed'), {
            code: 'EACCES',
          });
        }) as RainrailCliFileSystem['readdirSync'],
      };

      expect(runRainrailCli(['init'], {
        cwd,
        fileSystem: virtualFileSystem,
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'mock directory read failed\n',
      });
    });
  });

  it('still asks before initializing a non-empty directory that only has a config file', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'rainrail.config.json'), '{}\n');

      expect(runRainrailCli(['init'], { cwd: directory })).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: 'Current directory is not empty. Initialize Rainrail workspace here? [y/N]\n',
      });
      await expect(stat(join(directory, 'rainrail.lock'))).rejects.toThrow();
    });
  });

  it('skips the non-empty directory prompt when --yes is provided', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'README.md'), 'existing workspace\n');

      expect(runRainrailCli(['init', '--yes'], { cwd: directory })).toEqual({
        exitCode: 0,
        stdout: `Initialized Rainrail workspace at ${directory}\n`,
        stderr: '',
      });
      await expect(readFile(join(directory, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"plugins": []',
      );
    });
  });

  it('does not read the current directory listing when --yes skips the prompt', async () => {
    await withTempDirectory(async (directory) => {
      const cwd = join(directory, 'no-read-project');
      const directories = new Set<string>([cwd]);
      const files = new Map<string, string>();
      const statsFor = (path: string) => ({
        isDirectory: () => directories.has(path),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
      });
      const missing = (path: string) => Object.assign(new Error(`missing: ${path}`), {
        code: 'ENOENT',
      });
      const virtualFileSystem: Partial<RainrailCliFileSystem> = {
        existsSync: (path) => directories.has(String(path)) || files.has(String(path)),
        lstatSync: ((path) => {
          const value = String(path);
          if (!directories.has(value) && !files.has(value)) {
            throw missing(value);
          }
          return statsFor(value);
        }) as RainrailCliFileSystem['lstatSync'],
        mkdirSync: ((path) => {
          directories.add(String(path));
          return undefined;
        }) as RainrailCliFileSystem['mkdirSync'],
        readdirSync: (() => {
          throw Object.assign(new Error('directory listing should not be read'), {
            code: 'EACCES',
          });
        }) as RainrailCliFileSystem['readdirSync'],
        readFileSync: ((path) => {
          const content = files.get(String(path));
          if (content === undefined) {
            throw missing(String(path));
          }
          return content;
        }) as RainrailCliFileSystem['readFileSync'],
        writeFileSync: ((path, data) => {
          files.set(String(path), String(data));
        }) as RainrailCliFileSystem['writeFileSync'],
      };

      expect(runRainrailCli(['init', '--yes'], {
        cwd,
        fileSystem: virtualFileSystem,
      })).toEqual({
        exitCode: 0,
        stdout: `Initialized Rainrail workspace at ${cwd}\n`,
        stderr: '',
      });
      expect(files.get(join(cwd, 'rainrail.config.json'))).toContain('"name": "no-read-project"');
    });
  });

  it('discovers the Rainrail project root from a nested directory', async () => {
    await withTempDirectory(async (directory) => {
      await initRainrailProject(directory, 'my-agent-ops');
      const nested = join(directory, 'my-agent-ops', 'workflows', 'github');
      await mkdir(nested, { recursive: true });

      expect(discoverRainrailProject(nested)).toEqual({
        root: join(directory, 'my-agent-ops'),
        configPath: join(directory, 'my-agent-ops', 'rainrail.config.json'),
        lockPath: join(directory, 'my-agent-ops', 'rainrail.lock'),
        pluginDirectory: join(directory, 'my-agent-ops', '.rainrail', 'plugins'),
      });
    });
  });

  it('does not discover directories named like Rainrail config files as projects', async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, 'repo', 'rainrail.config.json'), { recursive: true });
      await writeFile(join(directory, 'repo', 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'repo' },
        plugins: [],
      }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: join(directory, 'repo') });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'rainrail plugins requires a Rainrail project. Run it inside a directory with rainrail.config.json.\n',
      });
      await expect(stat(join(directory, 'repo', '.rainrail'))).rejects.toThrow();
    });
  });

  it('adds, lists, and removes official plugins from project-local state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot })).toEqual({
        exitCode: 0,
        stdout: 'Added official plugin github@0.1.0\n',
        stderr: '',
      });

      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toBe(
        `${JSON.stringify({
          lockfileVersion: 1,
          project: { name: 'my-agent-ops' },
          plugins: [
            {
              name: 'github',
              version: '0.1.0',
              resolvedSource: 'official:github@0.1.0',
            },
          ],
        }, null, 2)}\n`,
      );
      await expect(
        readFile(join(projectRoot, '.rainrail', 'plugins', 'github', 'plugin.json'), 'utf8'),
      ).resolves.toBe(
        `${JSON.stringify({
          name: 'github',
          version: '0.1.0',
          resolvedSource: 'official:github@0.1.0',
        }, null, 2)}\n`,
      );

      expect(runRainrailCli(['plugins', 'list'], { cwd: join(projectRoot, '.rainrail') })).toEqual({
        exitCode: 0,
        stdout: 'github@0.1.0 official:github@0.1.0\n',
        stderr: '',
      });

      expect(runRainrailCli(['plugins', 'remove', 'github'], { cwd: projectRoot })).toEqual({
        exitCode: 0,
        stdout: 'Removed official plugin github\n',
        stderr: '',
      });
      await expect(readFile(join(projectRoot, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"plugins": []',
      );
      await expect(stat(join(projectRoot, '.rainrail', 'plugins', 'github'))).rejects.toThrow();
    });
  });

  it('uses --config to choose the project-local plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const currentProject = await initRainrailProject(directory, 'current-project');
      const targetProject = await initRainrailProject(directory, 'target-project');

      expect(runRainrailCli([
        '--config',
        join(targetProject, 'rainrail.config.json'),
        'plugins',
        'add',
        'github',
      ], { cwd: currentProject })).toEqual({
        exitCode: 0,
        stdout: 'Added official plugin github@0.1.0\n',
        stderr: '',
      });

      await expect(readFile(join(targetProject, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"name": "github"',
      );
      await expect(readFile(join(currentProject, 'rainrail.lock'), 'utf8')).resolves.toContain(
        '"plugins": []',
      );
    });
  });

  it('discovers projects through the injected filesystem when --config is omitted', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = join(directory, 'virtual-project');
      const nested = join(projectRoot, 'nested');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginDirectory = join(projectRoot, '.rainrail', 'plugins');
      const manifestPath = join(pluginDirectory, 'github', 'plugin.json');
      const directories = new Set([
        projectRoot,
        nested,
        join(projectRoot, '.rainrail'),
        pluginDirectory,
        join(pluginDirectory, 'github'),
      ]);
      const files = new Map([
        [configPath, '{}\n'],
        [lockPath, `${JSON.stringify({
          lockfileVersion: 1,
          project: { name: 'virtual-project' },
          plugins: [
            {
              name: 'github',
              version: '0.1.0',
              resolvedSource: 'official:github@0.1.0',
            },
          ],
        }, null, 2)}\n`],
        [manifestPath, `${JSON.stringify({
          name: 'github',
          version: '0.1.0',
          resolvedSource: 'official:github@0.1.0',
        }, null, 2)}\n`],
      ]);
      const statsFor = (path: string) => ({
        isDirectory: () => directories.has(path),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
      });
      const virtualFileSystem: Partial<RainrailCliFileSystem> = {
        existsSync: (path) => directories.has(String(path)) || files.has(String(path)),
        lstatSync: ((path) => statsFor(String(path))) as RainrailCliFileSystem['lstatSync'],
        readFileSync: ((path) => {
          const content = files.get(String(path));
          if (content === undefined) {
            throw new Error(`missing virtual file: ${String(path)}`);
          }
          return content;
        }) as RainrailCliFileSystem['readFileSync'],
        statSync: ((path) => statsFor(String(path))) as RainrailCliFileSystem['statSync'],
      };

      expect(runRainrailCli(['plugins', 'list'], {
        cwd: nested,
        fileSystem: virtualFileSystem,
      })).toEqual({
        exitCode: 0,
        stdout: 'github@0.1.0 official:github@0.1.0\n',
        stderr: '',
      });
    });
  });

  it('keeps plugin management idempotent and resolves official aliases', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      expect(runRainrailCli(['plugins', 'add', 'gh'], { cwd: projectRoot }).stdout).toBe(
        'Added official plugin github@0.1.0\n',
      );
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).stdout).toBe(
        'Official plugin github is already installed.\n',
      );
      await rm(join(projectRoot, '.rainrail', 'plugins', 'github'), { recursive: true });
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).stdout).toBe(
        'Official plugin github is already installed.\n',
      );
      await expect(
        readFile(join(projectRoot, '.rainrail', 'plugins', 'github', 'plugin.json'), 'utf8'),
      ).resolves.toContain('"resolvedSource": "official:github@0.1.0"');
      expect(runRainrailCli(['plugins', 'remove', 'gh'], { cwd: projectRoot }).stdout).toBe(
        'Removed official plugin github\n',
      );
      expect(runRainrailCli(['plugins', 'remove', 'github'], { cwd: projectRoot }).stdout).toBe(
        'Official plugin github is not installed.\n',
      );
    });
  });

  it('reports clear plugin management errors outside projects and for unknown plugins', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['plugins', 'list'], { cwd: directory })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'rainrail plugins requires a Rainrail project. Run it inside a directory with rainrail.config.json.\n',
      });

      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      expect(runRainrailCli(['plugins', 'add', 'https://example.com/plugin.git'], {
        cwd: projectRoot,
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr:
          'Unknown official plugin: https://example.com/plugin.git. Third-party and Git URL plugins are not supported yet.\n',
      });
    });
  });

  it('rejects extra arguments for rainrail plugins list', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');

      expect(runRainrailCli(['plugins', 'list', 'github'], {
        cwd: projectRoot,
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'Usage: rainrail plugins list\n',
      });
    });
  });

  it('returns plugin filesystem failures as CLI results', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      await rm(join(projectRoot, '.rainrail', 'plugins'), { recursive: true });
      await writeFile(join(projectRoot, '.rainrail', 'plugins'), 'not a directory\n');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `Plugin root is not a regular directory: ${join(projectRoot, '.rainrail', 'plugins')}\n`,
      );
      expect(result.stderr).not.toContain('Error:');
    });
  });

  it('keeps the plugin manifest when remove cannot update the lockfile', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const manifestPath = join(projectRoot, '.rainrail', 'plugins', 'github', 'plugin.json');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);

      const result = runRainrailCli(['plugins', 'remove', 'github'], {
        cwd: projectRoot,
        fileSystem: {
          writeFileSync: (path, data, options) => {
            if (path === lockPath) {
              throw new Error('mock lock write failed');
            }
            realWriteFileSync(path, data, options);
          },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mock lock write failed\n');
      expect(result.stderr).not.toContain('Error:');
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"name": "github"');
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"name": "github"');
    });
  });

  it('removes the created plugin manifest when add cannot update the lockfile', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');

      const result = runRainrailCli(['plugins', 'add', 'github'], {
        cwd: projectRoot,
        fileSystem: {
          writeFileSync: (path, data, options) => {
            if (path === lockPath) {
              throw new Error('mock lock write failed');
            }
            realWriteFileSync(path, data, options);
          },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mock lock write failed\n');
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"plugins": []');
      await expect(stat(pluginPath)).rejects.toThrow();
    });
  });

  it('preserves pre-existing plugin directory contents when add lockfile update fails', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      await mkdir(pluginPath, { recursive: true });
      await writeFile(join(pluginPath, 'README.md'), 'manual note\n');

      const result = runRainrailCli(['plugins', 'add', 'github'], {
        cwd: projectRoot,
        fileSystem: {
          writeFileSync: (path, data, options) => {
            if (path === lockPath) {
              throw new Error('mock lock write failed');
            }
            realWriteFileSync(path, data, options);
          },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mock lock write failed\n');
      await expect(readFile(join(pluginPath, 'README.md'), 'utf8')).resolves.toBe('manual note\n');
      await expect(stat(join(pluginPath, 'plugin.json'))).rejects.toThrow();
    });
  });

  it('restores a pre-existing plugin manifest when add lockfile update fails', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      const manifestPath = join(pluginPath, 'plugin.json');
      await mkdir(pluginPath, { recursive: true });
      await writeFile(manifestPath, 'manual manifest\n');

      const result = runRainrailCli(['plugins', 'add', 'github'], {
        cwd: projectRoot,
        fileSystem: {
          writeFileSync: (path, data, options) => {
            if (path === lockPath) {
              throw new Error('mock lock write failed');
            }
            realWriteFileSync(path, data, options);
          },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mock lock write failed\n');
      await expect(readFile(manifestPath, 'utf8')).resolves.toBe('manual manifest\n');
    });
  });

  it('rejects symlinked plugin manifest directories before writing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      const outsideTarget = join(directory, 'outside-target');
      await mkdir(outsideTarget);
      await symlink(outsideTarget, pluginPath, 'dir');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin manifest directory is not a regular directory: ${pluginPath}\n`);
      await expect(stat(join(outsideTarget, 'plugin.json'))).rejects.toThrow();
    });
  });

  it('rejects symlinked plugin manifest files before writing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      const manifestPath = join(pluginPath, 'plugin.json');
      const outsideTarget = join(directory, 'outside-manifest.json');
      await mkdir(pluginPath, { recursive: true });
      await writeFile(outsideTarget, 'outside content\n');
      await symlink(outsideTarget, manifestPath, 'file');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin manifest path is not a regular file: ${manifestPath}\n`);
      await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside content\n');
    });
  });

  it('rejects broken symlinked plugin manifest files before writing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      const manifestPath = join(pluginPath, 'plugin.json');
      const outsideTarget = join(directory, 'missing-outside-manifest.json');
      await mkdir(pluginPath, { recursive: true });
      await symlink(outsideTarget, manifestPath, 'file');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin manifest path is not a regular file: ${manifestPath}\n`);
      await expect(stat(outsideTarget)).rejects.toThrow();
    });
  });

  it('rejects symlinked plugin manifest files before listing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const manifestPath = join(projectRoot, '.rainrail', 'plugins', 'github', 'plugin.json');
      const outsideTarget = join(directory, 'outside-list-manifest.json');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);
      await writeFile(outsideTarget, `${JSON.stringify({
        name: 'github',
        version: '0.1.0',
        resolvedSource: 'official:github@0.1.0',
      }, null, 2)}\n`);
      await rm(manifestPath);
      await symlink(outsideTarget, manifestPath, 'file');

      const result = runRainrailCli(['plugins', 'list'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin manifest path is not a regular file: ${manifestPath}\n`);
    });
  });

  it('rejects symlinked plugin manifest directories before listing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      const outsidePluginPath = join(directory, 'outside-list-plugin');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);
      await mkdir(outsidePluginPath);
      await writeFile(join(outsidePluginPath, 'plugin.json'), `${JSON.stringify({
        name: 'github',
        version: '0.1.0',
        resolvedSource: 'official:github@0.1.0',
      }, null, 2)}\n`);
      await rm(pluginPath, { recursive: true });
      await symlink(outsidePluginPath, pluginPath, 'dir');

      const result = runRainrailCli(['plugins', 'list'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin manifest directory is not a regular directory: ${pluginPath}\n`);
    });
  });

  it('rejects symlinked plugin roots before removing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginRoot = join(projectRoot, '.rainrail', 'plugins');
      const outsideRoot = join(directory, 'outside-plugin-root');
      const outsidePlugin = join(outsideRoot, 'github');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);
      await rm(pluginRoot, { recursive: true });
      await mkdir(outsidePlugin, { recursive: true });
      await writeFile(join(outsidePlugin, 'sentinel.txt'), 'keep me\n');
      await symlink(outsideRoot, pluginRoot, 'dir');

      const result = runRainrailCli(['plugins', 'remove', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Plugin root is not a regular directory: ${pluginRoot}\n`);
      await expect(readFile(join(outsidePlugin, 'sentinel.txt'), 'utf8')).resolves.toBe('keep me\n');
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"name": "github"');
    });
  });

  it('rejects symlinked Rainrail state directories before writing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const stateDirectory = join(projectRoot, '.rainrail');
      const outsideStateDirectory = join(directory, 'outside-state');
      await rm(stateDirectory, { recursive: true });
      await mkdir(outsideStateDirectory);
      await symlink(outsideStateDirectory, stateDirectory, 'dir');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `Rainrail state directory is not a regular directory: ${stateDirectory}\n`,
      );
      await expect(stat(join(outsideStateDirectory, 'plugins'))).rejects.toThrow();
    });
  });

  it('rejects symlinked lockfiles before writing plugin state', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const outsideLockPath = join(directory, 'outside-rainrail.lock');
      await writeFile(outsideLockPath, `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'outside-project' },
        plugins: [],
      }, null, 2)}\n`);
      await rm(lockPath);
      await symlink(outsideLockPath, lockPath, 'file');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Rainrail lockfile is not a regular file: ${lockPath}\n`);
      await expect(readFile(outsideLockPath, 'utf8')).resolves.not.toContain('"name": "github"');
    });
  });

  it('restores the lockfile when remove cannot delete the plugin manifest directory', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      const pluginPath = join(projectRoot, '.rainrail', 'plugins', 'github');
      expect(runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot }).exitCode).toBe(0);

      const result = runRainrailCli(['plugins', 'remove', 'github'], {
        cwd: projectRoot,
        fileSystem: {
          rmSync: (path) => {
            if (path === pluginPath) {
              throw new Error('mock plugin delete failed');
            }
          },
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mock plugin delete failed\n');
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"name": "github"');
      await expect(readFile(join(pluginPath, 'plugin.json'), 'utf8')).resolves.toContain(
        '"name": "github"',
      );
    });
  });

  it('rejects lockfiles without a string project name before writing changes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const lockPath = join(projectRoot, 'rainrail.lock');
      await writeFile(lockPath, `${JSON.stringify({ lockfileVersion: 1, plugins: [] }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported Rainrail lockfile format: ${lockPath}\n`,
      });
      await expect(readFile(lockPath, 'utf8')).resolves.not.toContain('"name": "github"');
    });
  });

  it('rejects lockfile plugin names that are not official canonical aliases', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const maliciousPlugin = {
        name: '../escape',
        version: '0.1.0',
        resolvedSource: 'official:../escape@0.1.0',
      };
      await writeFile(join(projectRoot, 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'my-agent-ops' },
        plugins: [maliciousPlugin],
      }, null, 2)}\n`);
      await mkdir(join(projectRoot, '.rainrail', 'escape'), { recursive: true });
      await writeFile(
        join(projectRoot, '.rainrail', 'escape', 'plugin.json'),
        `${JSON.stringify(maliciousPlugin, null, 2)}\n`,
      );

      const result = runRainrailCli(['plugins', 'list'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported Rainrail lockfile plugin entry in ${join(projectRoot, 'rainrail.lock')}\n`,
      });
    });
  });

  it('rejects lockfile plugin entries with invalid versions', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      await writeFile(join(projectRoot, 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'my-agent-ops' },
        plugins: [
          {
            name: 'github',
            version: 'not-semver',
            resolvedSource: 'official:github@not-semver',
          },
        ],
      }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported Rainrail lockfile plugin entry in ${join(projectRoot, 'rainrail.lock')}\n`,
      });
    });
  });

  it('rejects lockfile plugin entries with invalid SemVer prerelease identifiers', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      await writeFile(join(projectRoot, 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'my-agent-ops' },
        plugins: [
          {
            name: 'github',
            version: '1.0.0-alpha..1',
            resolvedSource: 'official:github@1.0.0-alpha..1',
          },
        ],
      }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'list'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported Rainrail lockfile plugin entry in ${join(projectRoot, 'rainrail.lock')}\n`,
      });
    });
  });

  it('normalizes extra lockfile plugin entry fields before repairing manifests', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      const manifestPath = join(projectRoot, '.rainrail', 'plugins', 'github', 'plugin.json');
      await rm(join(projectRoot, '.rainrail', 'plugins', 'github'), { recursive: true, force: true });
      await writeFile(join(projectRoot, 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'my-agent-ops' },
        plugins: [
          {
            name: 'github',
            version: '0.1.0',
            resolvedSource: 'official:github@0.1.0',
            unexpected: 'must not reach plugin.json',
          },
        ],
      }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'Official plugin github is already installed.\n',
        stderr: '',
      });
      await expect(readFile(manifestPath, 'utf8')).resolves.toBe(`${JSON.stringify({
        name: 'github',
        version: '0.1.0',
        resolvedSource: 'official:github@0.1.0',
      }, null, 2)}\n`);
    });
  });

  it('rejects duplicate lockfile plugin names', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'my-agent-ops');
      await writeFile(join(projectRoot, 'rainrail.lock'), `${JSON.stringify({
        lockfileVersion: 1,
        project: { name: 'my-agent-ops' },
        plugins: [
          {
            name: 'github',
            version: '0.1.0',
            resolvedSource: 'official:github@0.1.0',
          },
          {
            name: 'github',
            version: '0.2.0',
            resolvedSource: 'official:github@0.2.0',
          },
        ],
      }, null, 2)}\n`);

      const result = runRainrailCli(['plugins', 'list'], { cwd: projectRoot });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Duplicate Rainrail lockfile plugin entry in ${join(projectRoot, 'rainrail.lock')}: github\n`,
      });
    });
  });

  it('validates init arguments and the current directory project name', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['init', 'my-agent-ops'], { cwd: directory }).stderr).toBe(
        'Usage: rainrail init\n',
      );
      const unsafeProjectRoot = join(directory, 'unsafe project');
      await mkdir(unsafeProjectRoot);
      expect(runRainrailCli(['init'], { cwd: unsafeProjectRoot }).stderr).toBe(
        'Current directory name must be a safe Rainrail project name.\n',
      );
      expect(runRainrailCli(['new'], { cwd: directory }).stderr).toContain(
        'Unknown rainrail command: new',
      );
    });
  });

  it('rejects the unsupported rainrail self-update command name', () => {
    const result = runRainrailCli(['self-update']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown rainrail command: self-update');
  });

  it('returns a parse error before running a command when required shared option values are missing', () => {
    expect(runRainrailCli(['--config'])).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Missing value for --config.\n',
    });
    expect(runRainrailCli(['doctor', '--profile']).stderr).toBe(
      'Missing value for --profile.\n',
    );
    expect(runRainrailCli(['doctor', '--profile=']).stderr).toBe(
      'Missing value for --profile.\n',
    );
  });

  it('returns a clear error for unknown commands', () => {
    const result = runRainrailCli(['deploy']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown rainrail command: deploy');
  });
});
