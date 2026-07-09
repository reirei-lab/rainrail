import { writeFileSync as realWriteFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  OFFICIAL_PLUGIN_CATALOG,
  type RainrailCliFileSystem,
  type RainrailStartOptions,
  createStandaloneRainrailDispatchRunner,
  discoverRainrailProject,
  getBuiltInCommand,
  getOfficialPluginByAlias,
  parseRainrailArguments,
  runRainrailCli,
  runRainrailCliAsync,
} from './index.js';

const testRequire = createRequire(import.meta.url);

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

function withSqliteDatabase<T>(databasePath: string, callback: (database: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: Array<string | number | null>): void;
    get(...values: Array<string | number | null>): unknown;
  };
}) => T): T {
  const { DatabaseSync } = testRequire('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...values: Array<string | number | null>): void;
        get(...values: Array<string | number | null>): unknown;
      };
      close(): void;
    };
  };
  const database = new DatabaseSync(databasePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

async function expectSqliteOperationalFilesProtected(databasePath: string): Promise<void> {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const file = await stat(path);
    expect(file.mode & 0o777, path).toBe(0o600);
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

function manualDispatchPayload(conversationId: string, text = 'hello'): Record<string, unknown> {
  return {
    provider: 'rainrail',
    channel: 'manual',
    action: 'message',
    conversation: { id: conversationId },
    message: { id: `message-${conversationId}`, text },
  };
}

describe('Rainrail CLI built-in commands', () => {
  it('defines the command table without provider or runtime specific handlers', () => {
    expect(BUILT_IN_COMMANDS.map((command) => command.name)).toEqual([
      'init',
      'setup',
      'start',
      'dispatch',
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
    expect(result.stdout).toContain('Dispatch an event into a Rainrail workflow.');
    expect(result.stdout).toContain('Official plugin aliases:');
    expect(result.stdout).toContain('  github');
    expect(result.stdout).toContain('  cloudflare');
    expect(result.stdout).toContain('  openclaw');
  });

  it('prints dispatch command help', () => {
    const result = runRainrailCli(['dispatch', 'help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: rainrail dispatch <message> | --stdin | --message <text> | --json <file> | --json --stdin | --envelope-json <json>');
    expect(result.stdout).toContain('<message>');
    expect(result.stdout).toContain('--stdin');
    expect(result.stdout).toContain('--message <text>');
    expect(result.stdout).toContain('--json <file>');
    expect(result.stdout).toContain('--json --stdin');
    expect(result.stdout).toContain('--envelope-json <json>');
  });

  it('requires exactly one dispatch input mode', () => {
    expect(runRainrailCli(['dispatch'])).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail dispatch <message> | --stdin | --message <text> | --json <file> | --json --stdin | --envelope-json <json>\n',
    });

    expect(runRainrailCli(['dispatch', '--message', 'hello', '--envelope-json', '{}'])).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Choose only one dispatch input mode.\n',
    });
  });

  it('dispatches a positional message as a manual Rainrail event envelope', () => {
    const dispatched: unknown[] = [];

    const result = runRainrailCli(['dispatch', '明日の13時に歯医者'], {
      now: () => new Date('2026-07-09T12:34:56.000Z'),
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted event\n',
          stderr: '',
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'accepted event\n',
      stderr: '',
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject(
      {
        mode: 'message',
        input: '明日の13時に歯医者',
        event: {
          schemaVersion: 'rainrail.event.v1',
          source: {
            type: 'manual',
            name: 'cli',
          },
          name: 'rainrail.manual.message',
          delivery: {
            receivedAt: '2026-07-09T12:34:56.000Z',
          },
          occurredAt: '2026-07-09T12:34:56.000Z',
          subject: {
            type: 'conversation',
            id: 'cli-manual',
          },
          payload: {
            provider: 'rainrail',
            channel: 'manual',
            action: 'message',
            conversation: {
              id: 'cli-manual',
            },
            message: {
              text: '明日の13時に歯医者',
            },
            actor: {
              id: 'rainrail-cli',
              displayName: 'Rainrail CLI',
              type: 'cli',
            },
          },
          rawPayload: {
            kind: 'inline-redacted',
            contentType: 'text/plain',
          },
        },
        options: {
          config: undefined,
          profile: undefined,
          json: false,
        },
      },
    );
    expect((dispatched[0] as { event: { id: string; delivery: { id: string }; rawPayload: { reference: string; sha256: string } } }).event.id)
      .toMatch(/^cli:cli-[a-f0-9]{16}-[a-z0-9]+-[a-f0-9]{16}:rainrail\.manual\.message$/u);
    expect((dispatched[0] as { event: { delivery: { id: string }; rawPayload: { reference: string; sha256: string } } }).event.rawPayload.reference)
      .toBe(`manual://deliveries/${(dispatched[0] as { event: { delivery: { id: string } } }).event.delivery.id}`);
    expect((dispatched[0] as { event: { rawPayload: { sha256: string } } }).event.rawPayload.sha256)
      .toMatch(/^[a-f0-9]{64}$/u);
  });

  it('dispatches stdin message input as a manual Rainrail event envelope', () => {
    const dispatched: unknown[] = [];

    const result = runRainrailCli(['dispatch', '--stdin'], {
      stdin: 'from stdin\n',
      now: () => new Date('2026-07-09T12:35:56.000Z'),
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toMatchObject([
      {
        input: 'from stdin\n',
        event: {
          payload: {
            message: {
              text: 'from stdin',
            },
          },
        },
      },
    ]);
  });

  it('rejects stdin message input that exceeds the dispatch byte limit', () => {
    const dispatched: unknown[] = [];

    expect(runRainrailCli(['dispatch', '--stdin'], {
      stdin: 'x'.repeat(65_537),
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Message from stdin must not exceed 65536 bytes.\n',
    });
    expect(dispatched).toEqual([]);
  });

  it('does not read stdin until dispatch input modes are valid', () => {
    const dispatched: unknown[] = [];
    let stdinReads = 0;

    expect(runRainrailCli(['dispatch', '--stdin', '--message', 'hello'], {
      stdinReader: () => {
        stdinReads += 1;
        return 'from stdin\n';
      },
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Choose only one dispatch input mode.\n',
    });

    expect(stdinReads).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it('rejects positional arguments after explicit dispatch input modes', () => {
    const dispatched: unknown[] = [];
    let stdinReads = 0;

    expect(runRainrailCli(['dispatch', '--message', 'hello', 'world'], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Unexpected rainrail dispatch argument: world.\n',
    });

    expect(runRainrailCli(['dispatch', '--stdin', 'trailing'], {
      stdinReader: () => {
        stdinReads += 1;
        return 'from stdin\n';
      },
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Unexpected rainrail dispatch argument: trailing.\n',
    });

    expect(stdinReads).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it('redacts and bounds CLI manual message event payload text', () => {
    const dispatched: unknown[] = [];
    const longSuffix = 'x'.repeat(9_000);

    const result = runRainrailCli(['dispatch', '--message', `DATABASE_URL=postgres://user:pass@db/prod ${longSuffix}`], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    const messageText = (dispatched[0] as { event: { payload: { message: { text: string } } } }).event.payload.message.text;
    expect(messageText).toContain('DATABASE_URL=[redacted-url]');
    expect(messageText).not.toContain('postgres://user:pass@db/prod');
    expect(messageText).toHaveLength(8_000);
  });

  it('generates unique manual delivery ids for repeated dispatches in the same millisecond', () => {
    const dispatched: unknown[] = [];

    for (let index = 0; index < 2; index += 1) {
      const result = runRainrailCli(['dispatch', 'same message'], {
        now: () => new Date('2026-07-09T12:36:56.000Z'),
        dispatchRunner: (request) => {
          dispatched.push(request);
          return {
            exitCode: 0,
            stdout: 'accepted message\n',
            stderr: '',
          };
        },
      });
      expect(result.exitCode).toBe(0);
    }

    const eventIds = dispatched.map((request) => (request as { event: { id: string } }).event.id);
    const deliveryIds = dispatched.map((request) => (request as { event: { delivery: { id: string } } }).event.delivery.id);
    expect(new Set(eventIds).size).toBe(2);
    expect(new Set(deliveryIds).size).toBe(2);
    expect(deliveryIds).toEqual([
      expect.stringMatching(/^cli-[a-f0-9]{16}-[a-z0-9]+-[a-f0-9]{16}$/u),
      expect.stringMatching(/^cli-[a-f0-9]{16}-[a-z0-9]+-[a-f0-9]{16}$/u),
    ]);
  });

  it('allows message-only dispatch input that starts with option syntax', () => {
    const dispatched: unknown[] = [];

    const result = runRainrailCli(['dispatch', '--message', '--review this'], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toMatchObject([
      {
        mode: 'message',
        input: '--review this',
        event: {
          payload: {
            message: {
              text: '--review this',
            },
          },
        },
      },
    ]);
  });

  it('protects dispatch input values that match shared option names', () => {
    const dispatched: unknown[] = [];

    const result = runRainrailCli(['dispatch', '--message', '--json'], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toMatchObject([
      {
        mode: 'message',
        input: '--json',
        event: {
          payload: {
            message: {
              text: '--json',
            },
          },
        },
        options: {
          config: undefined,
          profile: undefined,
          json: false,
        },
      },
    ]);
  });

  it('preserves the shared JSON output option after a dispatch message input mode', () => {
    const dispatched: unknown[] = [];

    const result = runRainrailCli(['dispatch', '--message', 'hello', '--json'], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: '{"accepted":true}\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toMatchObject([
      {
        mode: 'message',
        input: 'hello',
        options: {
          config: undefined,
          profile: undefined,
          json: true,
        },
      },
    ]);
  });

  it('rejects empty dispatch messages before dispatching', () => {
    const dispatched: unknown[] = [];

    expect(runRainrailCli(['dispatch', '   '], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Message must not be empty.\n',
    });

    expect(runRainrailCli(['dispatch', '--stdin'], {
      stdin: '\n\t',
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted message\n',
          stderr: '',
        };
      },
    })).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'Message must not be empty.\n',
    });
    expect(dispatched).toEqual([]);
  });

  it('routes validated envelope-json dispatch input into the shared dispatch boundary', () => {
    const dispatched: unknown[] = [];
    const envelopeJson = `{
  "id":"manual-source:delivery-inline:rainrail.manual.message",
  "schemaVersion":"rainrail.event.v1",
  "source":{"type":"manual","name":"manual-source"},
  "name":"rainrail.manual.message",
  "delivery":{"id":"delivery-inline","receivedAt":"2026-07-09T00:00:00.000Z"},
  "occurredAt":"2026-07-09T00:00:00.000Z",
  "subject":{"type":"conversation","id":"thread-inline"},
  "payload":{"provider":"rainrail","channel":"manual","action":"message","conversation":{"id":"thread-inline"},"message":{"id":"message-thread-inline","text":"hello inline"},"numericId":9007199254740993},
  "rawPayload":{"kind":"inline-redacted","reference":"manual://deliveries/delivery-inline"}
}`;

    const result = runRainrailCli(['--config', 'rainrail.config.json', 'dispatch', '--envelope-json', envelopeJson], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted envelope\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toEqual([
      {
        mode: 'envelope-json',
        input: envelopeJson,
        options: {
          config: 'rainrail.config.json',
          profile: undefined,
          json: false,
        },
      },
    ]);
    expect(JSON.stringify(dispatched)).toContain('9007199254740993');
  });

  it('dispatches a complete Rainrail event envelope from a JSON file', async () => {
    await withTempDirectory(async (directory) => {
      const eventPath = join(directory, 'event.json');
      const envelope = {
        id: 'manual-source:delivery-file:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        source: { type: 'manual', name: 'manual-source' },
        name: 'rainrail.manual.message',
        delivery: { id: 'delivery-file', receivedAt: '2026-07-09T00:00:00.000Z' },
        occurredAt: '2026-07-09T00:00:00.000Z',
        subject: { type: 'conversation', id: 'thread-file' },
        payload: manualDispatchPayload('thread-file', 'hello file'),
        rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-file' },
      };
      await writeFile(eventPath, JSON.stringify(envelope), 'utf8');
      const dispatched: unknown[] = [];

      const result = runRainrailCli(['dispatch', '--json', eventPath], {
        dispatchRunner: (request) => {
          dispatched.push(request);
          return {
            exitCode: 0,
            stdout: 'accepted file envelope\n',
            stderr: '',
          };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(dispatched).toEqual([
        expect.objectContaining({
          mode: 'envelope-json',
          input: JSON.stringify(envelope),
        }),
      ]);
    });
  });

  it('dispatches an accepted Rainrail event envelope input from stdin with defaults', () => {
    const dispatched: unknown[] = [];
    const envelopeInput = {
      source: { type: 'manual', name: 'manual-source' },
      name: 'rainrail.manual.message',
      delivery: { id: 'delivery-stdin', receivedAt: '2026-07-09T00:00:00.000Z' },
      occurredAt: '2026-07-09T00:00:00.000Z',
      subject: { type: 'conversation', id: 'thread-stdin' },
      payload: manualDispatchPayload('thread-stdin', 'hello stdin'),
      rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-stdin' },
    };

    const result = runRainrailCli(['dispatch', '--json', '--stdin'], {
      stdinReader: () => JSON.stringify(envelopeInput),
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted stdin envelope\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toEqual([
      expect.objectContaining({
        mode: 'envelope-json',
        input: `{"id":"manual-source:delivery-stdin:rainrail.manual.message","schemaVersion":"rainrail.event.v1",${JSON.stringify(envelopeInput).slice(1)}`,
      }),
    ]);
  });

  it('returns a clear error for invalid dispatch JSON', async () => {
    await withTempDirectory(async (directory) => {
      const eventPath = join(directory, 'event.json');
      await writeFile(eventPath, '{"source":', 'utf8');

      expect(runRainrailCli(['dispatch', '--json', eventPath], {
        dispatchRunner: () => ({ exitCode: 0, stdout: 'unexpected\n', stderr: '' }),
      })).toMatchObject({
        exitCode: 1,
        stdout: '',
        stderr: expect.stringContaining('Invalid JSON for rainrail dispatch envelope:'),
      });
    });
  });

  it('resolves dispatch JSON files relative to the CLI environment cwd', async () => {
    await withTempDirectory(async (directory) => {
      const envelope = {
        id: 'manual-source:delivery-cwd:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        source: { type: 'manual', name: 'manual-source' },
        name: 'rainrail.manual.message',
        delivery: { id: 'delivery-cwd', receivedAt: '2026-07-09T00:00:00.000Z' },
        occurredAt: '2026-07-09T00:00:00.000Z',
        subject: { type: 'conversation', id: 'thread-cwd' },
        payload: manualDispatchPayload('thread-cwd', 'hello from cwd'),
        rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-cwd' },
      };
      await writeFile(join(directory, 'event.json'), JSON.stringify(envelope), 'utf8');
      const dispatched: unknown[] = [];

      const result = runRainrailCli(['dispatch', '--json', 'event.json'], {
        cwd: directory,
        dispatchRunner: (request) => {
          dispatched.push(request);
          return {
            exitCode: 0,
            stdout: 'accepted cwd envelope\n',
            stderr: '',
          };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(dispatched).toEqual([
        expect.objectContaining({
          mode: 'envelope-json',
          input: JSON.stringify(envelope),
        }),
      ]);
    });
  });

  it('validates dispatch arguments before reading stdin', () => {
    let stdinRead = false;

    const result = runRainrailCli(['dispatch', '--json', '--stdin', 'typo'], {
      stdinReader: () => {
        stdinRead = true;
        return '{}';
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Unexpected rainrail dispatch argument: typo.\n',
    });
    expect(stdinRead).toBe(false);
  });

  it('returns the missing dispatch runner error before reading stdin', () => {
    let stdinRead = false;

    const result = runRainrailCli(['dispatch', '--json', '--stdin'], {
      stdinReader: () => {
        stdinRead = true;
        return '{}';
      },
    });

    expect(result).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'rainrail dispatch requires a dispatch runner, which is not implemented yet.\n',
    });
    expect(stdinRead).toBe(false);
  });

  it('rejects async dispatch runners in the synchronous CLI before side effects', () => {
    let publishStarted = false;
    let stdinRead = false;

    const result = runRainrailCli(['dispatch', '--json', '--stdin'], {
      asyncDispatchRunner: createStandaloneRainrailDispatchRunner({
        env: {
          RAINRAIL_PUBLISH_URL: 'https://rainrail.example/publish',
          RAINRAIL_PUBLISH_TOKEN: 'publish-token',
        },
        fetcher: () => {
          publishStarted = true;
          return Promise.resolve({ status: 200, body: '{}' });
        },
      }),
      stdinReader: () => {
        stdinRead = true;
        return '{}';
      },
    });

    expect(result).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'rainrail dispatch requires the async CLI runner for asynchronous dispatch runners.\n',
    });
    expect(stdinRead).toBe(false);
    expect(publishStarted).toBe(false);
  });

  it('returns a clear error for invalid dispatch envelope shapes', async () => {
    await withTempDirectory(async (directory) => {
      const eventPath = join(directory, 'event.json');
      await writeFile(eventPath, JSON.stringify({ source: { type: 'manual' } }), 'utf8');

      expect(runRainrailCli(['dispatch', '--json', eventPath], {
        dispatchRunner: () => ({ exitCode: 0, stdout: 'unexpected\n', stderr: '' }),
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'Invalid Rainrail event envelope: source.name must be a string.\n',
      });
    });
  });

  it.each([
    [
      'source.name',
      {
        source: { type: 'manual', name: 'bad\nname' },
      },
      'Invalid Rainrail event envelope: source.name must be a safe identifier.\n',
    ],
    [
      'delivery.receivedAt',
      {
        delivery: { id: 'delivery-invalid-date', receivedAt: 'not-a-date' },
      },
      'Invalid Rainrail event envelope: delivery.receivedAt must be a UTC ISO timestamp.\n',
    ],
    [
      'rawPayload.kind',
      {
        rawPayload: { kind: 'inline', reference: 'manual://deliveries/delivery-invalid-kind' },
      },
      'Invalid Rainrail event envelope: rawPayload.kind must be a known raw payload kind.\n',
    ],
    [
      'rawPayload.reference',
      {
        rawPayload: { kind: 'inline-redacted', reference: 'https://example.com/raw' },
      },
      'Invalid Rainrail event envelope: rawPayload.reference must be an allowed Rainrail event URL.\n',
    ],
  ])('rejects invalid dispatch envelope contract field %s', async (_field, override, expectedError) => {
    await withTempDirectory(async (directory) => {
      const eventPath = join(directory, 'event.json');
      const envelope = {
        id: 'manual-source:delivery-contract:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        source: { type: 'manual', name: 'manual-source' },
        name: 'rainrail.manual.message',
        delivery: { id: 'delivery-contract', receivedAt: '2026-07-09T00:00:00.000Z' },
        occurredAt: '2026-07-09T00:00:00.000Z',
        subject: { type: 'conversation', id: 'thread-contract' },
        payload: manualDispatchPayload('thread-contract', 'hello contract'),
        rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-contract' },
        ...override,
      };
      await writeFile(eventPath, JSON.stringify(envelope), 'utf8');

      expect(runRainrailCli(['dispatch', '--json', eventPath], {
        dispatchRunner: () => ({ exitCode: 0, stdout: 'unexpected\n', stderr: '' }),
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: expectedError,
      });
    });
  });

  it('preserves caller payload numbers when filling dispatch envelope defaults', () => {
    const dispatched: unknown[] = [];
    const envelopeInputJson = `{"source":{"type":"github","name":"github-webhook"},"name":"github.issue","delivery":{"id":"delivery-defaults","receivedAt":"2026-07-09T00:00:00.000Z"},"occurredAt":"2026-07-09T00:00:00.000Z","subject":{"type":"issue","id":"262","url":"https://github.com/reirei-lab/rainrail/issues/262"},"payload":{"provider":"github","resource":{"id":9007199254740993}},"rawPayload":{"kind":"external-reference","reference":"github://deliveries/delivery-defaults"}}`;

    const result = runRainrailCli(['dispatch', '--envelope-json', envelopeInputJson], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted defaults envelope\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toEqual([
      expect.objectContaining({
        mode: 'envelope-json',
        input: `{"id":"github-webhook:delivery-defaults:github.issue","schemaVersion":"rainrail.event.v1",${envelopeInputJson.slice(1)}`,
      }),
    ]);
    expect(JSON.stringify(dispatched)).toContain('9007199254740993');
  });

  it('accepts repository-shaped event ids and unsafe optional source metadata', () => {
    const dispatched: unknown[] = [];
    const envelope = {
      id: 'reirei-lab/rainrail',
      schemaVersion: 'rainrail.event.v1',
      source: {
        type: 'github',
        name: 'github-webhook',
        account: 'renovate[bot]',
        environment: 'github-actions[bot]',
      },
      name: 'github.issue',
      delivery: { id: 'delivery-repository-id', receivedAt: '2026-07-09T00:00:00.000Z' },
      occurredAt: '2026-07-09T00:00:00.000Z',
      subject: { type: 'issue', id: '262', url: 'https://github.com/reirei-lab/rainrail/issues/262' },
      payload: { provider: 'github', action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-repository-id' },
    };

    const result = runRainrailCli(['dispatch', '--envelope-json', JSON.stringify(envelope)], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted repository id envelope\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toEqual([
      expect.objectContaining({
        mode: 'envelope-json',
        input: JSON.stringify(envelope),
      }),
    ]);
  });

  it('accepts GitHub pull request review URL fragments in dispatch envelope URLs', () => {
    const dispatched: unknown[] = [];
    const envelope = {
      id: 'github-webhook:delivery-review:github.pull_request_review',
      schemaVersion: 'rainrail.event.v1',
      source: {
        type: 'github',
        name: 'github-webhook',
        repository: 'reirei-lab/rainrail',
      },
      name: 'github.pull_request_review',
      delivery: { id: 'delivery-review', receivedAt: '2026-07-09T00:00:00.000Z' },
      occurredAt: '2026-07-09T00:00:00.000Z',
      subject: {
        type: 'review',
        id: '123',
        url: 'https://github.com/reirei-lab/rainrail/pull/39#pullrequestreview-123',
      },
      payload: { provider: 'github', action: 'submitted' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-review' },
    };

    const result = runRainrailCli(['dispatch', '--envelope-json', JSON.stringify(envelope)], {
      dispatchRunner: (request) => {
        dispatched.push(request);
        return {
          exitCode: 0,
          stdout: 'accepted review envelope\n',
          stderr: '',
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(dispatched).toEqual([
      expect.objectContaining({
        mode: 'envelope-json',
        input: JSON.stringify(envelope),
      }),
    ]);
  });

  it.each([
    [
      'schemaVersion null',
      {
        id: 'manual-source:delivery-null-schema:rainrail.manual.message',
        schemaVersion: null,
      },
      'Invalid Rainrail event envelope: schemaVersion must be "rainrail.event.v1".\n',
    ],
    [
      'id null',
      {
        id: null,
        schemaVersion: 'rainrail.event.v1',
      },
      'Invalid Rainrail event envelope: id must be a string.\n',
    ],
    [
      'manual source with chat event name',
      {
        id: 'manual-source:delivery-manual-chat:rainrail.chat.message',
        schemaVersion: 'rainrail.event.v1',
        name: 'rainrail.chat.message',
      },
      'Invalid Rainrail event envelope: manual/chat event name must match source.type.\n',
    ],
    [
      'manual payload missing required fields',
      {
        id: 'manual-source:delivery-manual-payload:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        payload: { text: 'hello' },
      },
      'Invalid Rainrail event envelope: manual/chat payload is missing required fields.\n',
    ],
    [
      'manual raw payload external reference',
      {
        id: 'manual-source:delivery-manual-external:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        rawPayload: { kind: 'external-reference', reference: 'manual://deliveries/delivery-manual-external' },
      },
      'Invalid Rainrail event envelope: manual/chat raw payload kind must be inline-redacted.\n',
    ],
    [
      'manual raw payload chat reference',
      {
        id: 'manual-source:delivery-manual-chat-ref:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        rawPayload: { kind: 'inline-redacted', reference: 'chat://deliveries/delivery-manual-chat-ref' },
      },
      'Invalid Rainrail event envelope: manual/chat raw payload reference must match source.type.\n',
    ],
    [
      'delivery reference port',
      {
        id: 'manual-source:delivery-manual-port:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries:123/delivery-manual-port' },
      },
      'Invalid Rainrail event envelope: rawPayload.reference must be an allowed Rainrail event URL.\n',
    ],
  ])('rejects invalid dispatch envelope contract extension %s', async (_case, override, expectedError) => {
    await withTempDirectory(async (directory) => {
      const eventPath = join(directory, 'event.json');
      const baseEnvelope = {
        id: 'manual-source:delivery-extension:rainrail.manual.message',
        schemaVersion: 'rainrail.event.v1',
        source: { type: 'manual', name: 'manual-source' },
        name: 'rainrail.manual.message',
        delivery: { id: 'delivery-extension', receivedAt: '2026-07-09T00:00:00.000Z' },
        occurredAt: '2026-07-09T00:00:00.000Z',
        subject: { type: 'conversation', id: 'thread-extension' },
        payload: manualDispatchPayload('thread-extension', 'hello extension'),
        rawPayload: { kind: 'inline-redacted', reference: 'manual://deliveries/delivery-extension' },
      };
      const envelope = { ...baseEnvelope, ...override };
      await writeFile(eventPath, JSON.stringify(envelope), 'utf8');

      expect(runRainrailCli(['dispatch', '--json', eventPath], {
        dispatchRunner: () => ({ exitCode: 0, stdout: 'unexpected\n', stderr: '' }),
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: expectedError,
      });
    });
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
      expect(result.stdout).toContain('Dashboard: http://127.0.0.1:8787/dashboard');
      expect(result.stdout).toContain('Event Stream: http://127.0.0.1:8787/events');
      expect(result.stdout).toContain('Dashboard API: http://127.0.0.1:8787/api/v1/overview');
      expect(result.stdout).toContain('Dashboard Auth: not configured');
      expect(result.stdout).toContain('Run `rainrail --config');
      expect(result.stdout).toContain('setup --dashboard-auth-only --yes` to generate local dashboardAuth tokens.');
      expect(result.stdout).toContain(`Or set dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, or dashboardAuth.adminToken in ${join(projectRoot, 'rainrail.config.json')}.`);
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

  it('passes rainrail.config.json operationalStore into rainrail start options', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'configured-operational-store');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        operationalStore: {
          kind: 'sqlite',
          databasePath: '${RAINRAIL_OPERATIONAL_DB}',
          eventLimit: 123,
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
          RAINRAIL_OPERATIONAL_DB: 'var/rainrail-operational.sqlite',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions?.operationalStoreConfig).toEqual({
        kind: 'sqlite',
        databasePath: join(projectRoot, 'var', 'rainrail-operational.sqlite'),
        eventLimit: 123,
      });
    });
  });

  it('lets rainrail start operational store env override config', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'env-operational-store');
      let startOptions: RainrailStartOptions | undefined;

      const result = runRainrailCli(['start'], {
        cwd: projectRoot,
        env: {
          RAINRAIL_OPERATIONAL_STORE: 'json',
          RAINRAIL_OPERATIONAL_DB: 'var/rainrail-operational.json',
          RAINRAIL_OPERATIONAL_EVENT_LIMIT: '17',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions?.operationalStoreConfig).toEqual({
        kind: 'json',
        databasePath: join(projectRoot, 'var', 'rainrail-operational.json'),
        eventLimit: 17,
      });
    });
  });

  it('does not validate config operationalStore before env override', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'env-operational-store-precedence');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        operationalStore: {
          kind: 'sqlite',
          databasePath: '${RAINRAIL_OPERATIONAL_DB}',
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
          RAINRAIL_OPERATIONAL_STORE: 'memory',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions?.operationalStoreConfig).toEqual({
        kind: 'memory',
        eventLimit: 250,
      });
    });
  });

  it('falls back to config operationalStore when env override is empty', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'empty-env-operational-store');
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        operationalStore: {
          kind: 'sqlite',
          databasePath: 'var/rainrail-operational.sqlite',
          eventLimit: 19,
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
          RAINRAIL_OPERATIONAL_STORE: '',
        },
        serverStarter: (options) => {
          startOptions = options;
          return { stop: () => undefined };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(startOptions?.operationalStoreConfig).toEqual({
        kind: 'sqlite',
        databasePath: join(projectRoot, 'var', 'rainrail-operational.sqlite'),
        eventLimit: 19,
      });
    });
  });

  it('prints custom config setup guidance when dashboard auth is not configured', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'custom-start-auth-guide');
      const customConfigPath = join(projectRoot, 'custom.rainrail.json');
      await writeFile(customConfigPath, `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 9002,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['--config', customConfigPath, 'start'], {
        cwd: projectRoot,
        serverStarter: () => ({ stop: () => undefined }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Config: ${customConfigPath}`);
      expect(result.stdout).toContain(`Run \`rainrail --config ${customConfigPath} setup --dashboard-auth-only --yes\` to generate local dashboardAuth tokens.`);
      expect(result.stdout).toContain(`Or set dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, or dashboardAuth.adminToken in ${customConfigPath}.`);
      expect(result.stdout).not.toContain('rainrail.config.json');
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
      expect(result.stdout).toContain('Dashboard Auth: configured scopes: read-only, operator, admin');
      expect(result.stdout).not.toContain('read-token');
      expect(result.stdout).not.toContain('operator-token');
      expect(result.stdout).not.toContain('admin-token');
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

  it('gates local rainrail start agent task command routes with operator scope', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'local-operator-commands');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
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

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const readOnlyResponse = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/task-1/actions/resume`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer read-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        expect(readOnlyResponse.status).toBe(403);
        await expect(readOnlyResponse.json()).resolves.toEqual({
          error: 'insufficient_scope',
          requiredScope: 'operator',
        });

        for (const token of ['operator-token', 'admin-token']) {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/task-1/actions/resume`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-Request-ID': `request-${token}`,
            },
            body: JSON.stringify({}),
          });
          expect(response.status, token).toBe(503);
          expect(response.headers.get('x-request-id')).toBe(`request-${token}`);
          await expect(response.json(), token).resolves.toEqual({ error: 'command_handler_not_configured' });
        }
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('requires confirmation for local rainrail start destructive agent task commands before reporting unavailable dispatch', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'local-operator-confirmation');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        dashboardAuth: {
          operatorToken: 'operator-token',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const preview = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/actions/terminate-all`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer operator-token',
            'Content-Type': 'application/json',
            'X-Request-ID': 'request-terminate-all-preview',
          },
          body: JSON.stringify({}),
        });
        expect(preview.status).toBe(409);
        expect(preview.headers.get('x-request-id')).toBe('request-terminate-all-preview');
        await expect(preview.json()).resolves.toEqual({
          error: 'action_confirmation_required',
          data: {
            action: 'agent_task_terminate_all',
            targetType: 'agent_tasks',
            targetId: 'all',
            confirmationRequired: true,
            confirmationToken: 'confirm:agent_task_terminate_all:agent_tasks:all',
          },
        });

        const confirmed = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/actions/terminate-all`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer operator-token',
            'Content-Type': 'application/json',
            'X-Request-ID': 'request-terminate-all-confirmed',
          },
          body: JSON.stringify({
            confirmationToken: 'confirm:agent_task_terminate_all:agent_tasks:all',
          }),
        });
        expect(confirmed.status).toBe(503);
        expect(confirmed.headers.get('x-request-id')).toBe('request-terminate-all-confirmed');
        await expect(confirmed.json()).resolves.toEqual({ error: 'command_handler_not_configured' });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('returns local rainrail start command dry-run previews without confirmation or handler dispatch', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'local-operator-dry-run');
      const port = await getFreePort();
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        dashboardAuth: {
          operatorToken: 'operator-token',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const resumePreview = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/task-1/actions/resume`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer operator-token',
            'Content-Type': 'application/json',
            'X-Request-ID': 'request-resume-dry-run',
          },
          body: JSON.stringify({ dryRun: true }),
        });
        expect(resumePreview.status).toBe(200);
        expect(resumePreview.headers.get('x-request-id')).toBe('request-resume-dry-run');
        await expect(resumePreview.json()).resolves.toEqual({
          data: {
            action: 'agent_task_resume',
            targetType: 'agent_task',
            targetId: 'task-1',
            status: 'preview',
            dryRun: true,
            confirmationRequired: false,
          },
        });

        const terminateAllPreview = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/actions/terminate-all`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer operator-token',
            'Content-Type': 'application/json',
            'X-Request-ID': 'request-terminate-all-dry-run',
          },
          body: JSON.stringify({ dryRun: true }),
        });
        expect(terminateAllPreview.status).toBe(200);
        expect(terminateAllPreview.headers.get('x-request-id')).toBe('request-terminate-all-dry-run');
        await expect(terminateAllPreview.json()).resolves.toEqual({
          data: {
            action: 'agent_task_terminate_all',
            targetType: 'agent_tasks',
            targetId: 'all',
            status: 'preview',
            dryRun: true,
            confirmationRequired: true,
            confirmationToken: 'confirm:agent_task_terminate_all:agent_tasks:all',
          },
        });
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
      const dashboardAssetRoot = join(directory, 'dashboard-dist');
      await mkdir(join(dashboardAssetRoot, 'dashboard'), { recursive: true });
      await mkdir(join(dashboardAssetRoot, 'ja', 'dashboard'), { recursive: true });
      await mkdir(join(dashboardAssetRoot, 'en', 'dashboard'), { recursive: true });
      await mkdir(join(dashboardAssetRoot, '_astro'), { recursive: true });
      await writeFile(join(dashboardAssetRoot, 'rainrail.config.json'), 'should-not-leak');
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
      await writeFile(join(dashboardAssetRoot, 'dashboard', 'index.html'), [
        '<!doctype html>',
        '<html><head><script type="module" src="/_astro/dashboard-app.js"></script></head>',
        '<body><section data-dashboard-app data-api-base-url="https://ops.example.test" data-auth-required="true"></section></body></html>',
      ].join(''));
      await writeFile(join(dashboardAssetRoot, 'ja', 'dashboard', 'index.html'), [
        '<!doctype html>',
        '<html><head><script type="module" src="/_astro/dashboard-app.js"></script></head>',
        '<body><a href="/en/dashboard">English</a><section data-dashboard-app data-api-base-url="https://ops.example.test" data-auth-required="true"></section></body></html>',
      ].join(''));
      await writeFile(join(dashboardAssetRoot, 'en', 'dashboard', 'index.html'), [
        '<!doctype html>',
        '<html><head><script type="module" src="/_astro/dashboard-app.js"></script></head>',
        '<body><a href="/ja/dashboard">日本語</a><section data-dashboard-app data-api-base-url="https://ops.example.test" data-auth-required="true"></section></body></html>',
      ].join(''));
      await writeFile(join(dashboardAssetRoot, '_astro', 'dashboard-app.js'), 'console.log("dashboard");\n');

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { RAINRAIL_DASHBOARD_DIST_DIR: dashboardAssetRoot },
      });
      try {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Dashboard: http://127.0.0.1:${port}/dashboard`);

        const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
        expect(dashboard.status).toBe(200);
        expect(dashboard.headers.get('content-type')).toContain('text/html');
        expect(dashboard.headers.get('cache-control')).toBe('no-cache');
        const dashboardHtml = await dashboard.text();
        expect(dashboardHtml).toContain('data-dashboard-app');
        expect(dashboardHtml).toContain('data-api-base-url=""');
        expect(dashboardHtml).not.toContain('https://ops.example.test');
        expect(dashboardHtml).toContain('data-auth-required="false"');
        expect(dashboardHtml).toContain('src="/_astro/dashboard-app.js"');
        expect(dashboardHtml).toContain('href="/ja/dashboard"');
        expect(dashboardHtml).toContain('日本語');

        for (const locale of ['ja', 'en']) {
          const localizedDashboard = await fetch(`http://127.0.0.1:${port}/${locale}/dashboard`);
          expect(localizedDashboard.status, locale).toBe(200);
          const localizedHtml = await localizedDashboard.text();
          expect(localizedHtml, locale).toContain('data-dashboard-app');
          expect(localizedHtml, locale).toContain('data-api-base-url=""');
          expect(localizedHtml, locale).toContain('data-auth-required="false"');
        }

        const dashboardAsset = await fetch(`http://127.0.0.1:${port}/_astro/dashboard-app.js`);
        expect(dashboardAsset.status).toBe(200);
        expect(dashboardAsset.headers.get('content-type')).toContain('text/javascript');
        expect(dashboardAsset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

        const missingAsset = await fetch(`http://127.0.0.1:${port}/_astro/missing-dashboard-app.js`);
        expect(missingAsset.status).toBe(404);
        await expect(missingAsset.json()).resolves.toEqual({ error: 'not_found' });

        const traversalAsset = await fetch(`http://127.0.0.1:${port}/_astro/..%2frainrail.config.json`);
        expect(traversalAsset.status).toBe(404);

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

        const apiRoutePrecedence = await fetch(`http://127.0.0.1:${port}/api/v1/events/local-event-000001`);
        expect(apiRoutePrecedence.status).toBe(200);
        expect(apiRoutePrecedence.headers.get('content-type')).toContain('application/json');
        await expect(apiRoutePrecedence.json()).resolves.toMatchObject({
          data: {
            id: 'local-event-000001',
            compact: { id: 'local-event-000001', name: 'github.issue' },
          },
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('persists local dashboard events through configured SQLite operational store', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sqlite-operational-start');
      const port = await getFreePort();
      const restartPort = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.sqlite');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const startConfig = (serverPort: number): string => `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: serverPort,
        },
        operationalStore: {
          kind: 'sqlite',
          databasePath,
          eventLimit: 3,
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
      }, null, 2)}\n`;
      await writeFile(configPath, startConfig(port));

      const first = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(first.exitCode).toBe(0);
        for (const delivery of ['delivery-sqlite-start-1', 'delivery-sqlite-start-2', 'delivery-sqlite-start-3']) {
          const body = JSON.stringify({ action: 'opened' });
          const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
            method: 'POST',
            headers: githubWebhookHeaders('secret', body, { delivery, event: 'issues' }),
            body,
          });
          expect(accepted.status).toBe(202);
        }
        await expectSqliteOperationalFilesProtected(databasePath);

        const overview = await fetch(`http://127.0.0.1:${port}/api/v1/overview`);
        await expect(overview.json()).resolves.toMatchObject({ data: { counts: { events: 3 } } });
      } finally {
        await closeTestServer(first);
      }

      const limitedConfig = JSON.parse(startConfig(restartPort)) as Record<string, unknown>;
      if (
        typeof limitedConfig.operationalStore === 'object'
        && limitedConfig.operationalStore !== null
        && !Array.isArray(limitedConfig.operationalStore)
      ) {
        Object.assign(limitedConfig.operationalStore, { eventLimit: 1 });
      }
      await writeFile(configPath, `${JSON.stringify(limitedConfig, null, 2)}\n`);
      const second = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(second.exitCode).toBe(0);
        const overview = await fetch(`http://127.0.0.1:${restartPort}/api/v1/overview`);
        await expect(overview.json()).resolves.toMatchObject({ data: { counts: { events: 3 } } });

        const events = await fetch(`http://127.0.0.1:${restartPort}/api/v1/events`);
        await expect(events.json()).resolves.toMatchObject({
          data: [{
            id: 'local-event-000003',
            deliveryId: 'delivery-sqlite-start-3',
          }],
        });
      } finally {
        await closeTestServer(second);
      }
    });
  });

  it('reads shared SQLite operational rows without overwriting existing event metadata', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sqlite-operational-shared-start');
      const setupPort = await getFreePort();
      const port = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.sqlite');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const startConfig = (serverPort: number): string => `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: serverPort,
        },
        operationalStore: {
          kind: 'sqlite',
          databasePath,
          eventLimit: 10,
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
      }, null, 2)}\n`;
      await writeFile(configPath, startConfig(setupPort));

      const setup = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      await closeTestServer(setup);

      withSqliteDatabase(databasePath, (database) => {
        database.prepare(`
          INSERT INTO operational_events (
            id, name, source_json, delivery_json, subject_json, occurred_at, received_at,
            payload_json, raw_payload_reference_json, links_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'github-webhook:delivery-existing:github.issue',
          'github.issue',
          JSON.stringify({ type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' }),
          JSON.stringify({ id: 'delivery-existing', receivedAt: '2026-07-09T00:00:00.000Z' }),
          JSON.stringify({ type: 'issue', id: '271', url: 'https://github.com/reirei-lab/rainrail/issues/271' }),
          '2026-07-09T00:00:00.000Z',
          '2026-07-09T00:00:00.000Z',
          JSON.stringify({ action: 'opened', preserved: true }),
          JSON.stringify({ kind: 'external-reference', reference: 'github://deliveries/delivery-existing' }),
          JSON.stringify({ html: 'https://github.com/reirei-lab/rainrail/issues/271' }),
        );
        database.prepare(`
          INSERT INTO agent_tasks (
            id, title, branch_name, status, claim_json, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          'agent_task_shared_sqlite',
          'shared sqlite task',
          'agent/reirei-lab-rainrail-271-dashboard-api-node-sqlite-operational-store',
          'failed',
          JSON.stringify({ provider: 'github-project', itemId: 'PVTI_shared' }),
          '2026-07-09T00:01:00.000Z',
          '2026-07-09T00:01:00.000Z',
        );
        database.prepare(`
          INSERT INTO activity_events (
            id, source_event_id, source_event_name, category, target_type, target_id,
            action_type, outcome, summary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'act_shared_sqlite',
          'github-webhook:delivery-existing:github.issue',
          'github.issue',
          'workflow',
          'event',
          'github-webhook:delivery-existing:github.issue',
          'workflow_dispatched',
          'success',
          'shared workflow dispatched',
          '2026-07-09T00:02:00.000Z',
        );
      });

      await writeFile(configPath, startConfig(port));
      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);

        const overview = await fetch(`http://127.0.0.1:${port}/api/v1/overview`);
        await expect(overview.json()).resolves.toMatchObject({
          data: {
            counts: { events: 1, agentTasks: 1, activityEvents: 1 },
            warnings: { staleProjectClaims: [{ taskId: 'agent_task_shared_sqlite' }] },
          },
        });

        const tasks = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks`);
        const taskPayload = await tasks.json();
        expect(taskPayload).toMatchObject({
          data: [{
            id: 'agent_task_shared_sqlite',
            title: 'shared sqlite task',
            warnings: { staleProjectClaim: true },
          }],
        });
        expect(JSON.stringify(taskPayload)).not.toContain('/api/v1/agent-tasks/agent_task_shared_sqlite');

        const taskDetail = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks/agent_task_shared_sqlite`);
        expect(taskDetail.status).toBe(200);
        await expect(taskDetail.json()).resolves.toMatchObject({
          data: {
            id: 'agent_task_shared_sqlite',
            type: 'agent-task',
            compact: {
              id: 'agent_task_shared_sqlite',
              warnings: { staleProjectClaim: true },
            },
            record: {
              id: 'agent_task_shared_sqlite',
              status: 'failed',
            },
          },
        });

        const invalidTasks = await fetch(`http://127.0.0.1:${port}/api/v1/agent-tasks?filter[unknown]=x`);
        expect(invalidTasks.status).toBe(400);
        await expect(invalidTasks.json()).resolves.toEqual({ error: 'unsupported_filter', filter: 'filter[unknown]' });

        const invalidWorkflowSort = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs?sort=newest`);
        expect(invalidWorkflowSort.status).toBe(400);
        await expect(invalidWorkflowSort.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'newest' });

        const workflows = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs`);
        const workflowPayload = await workflows.json();
        expect(workflowPayload).toMatchObject({
          data: [{ id: 'act_shared_sqlite', summary: 'shared workflow dispatched' }],
        });
        expect(JSON.stringify(workflowPayload)).not.toContain('/api/v1/workflow-runs/act_shared_sqlite');

        const workflowDetail = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs/act_shared_sqlite`);
        expect(workflowDetail.status).toBe(200);
        await expect(workflowDetail.json()).resolves.toMatchObject({
          data: {
            id: 'act_shared_sqlite',
            type: 'workflow-run',
            compact: {
              id: 'act_shared_sqlite',
              summary: 'shared workflow dispatched',
            },
            record: {
              id: 'act_shared_sqlite',
              outcome: 'success',
            },
          },
        });

        const missingWorkflowDetail = await fetch(`http://127.0.0.1:${port}/api/v1/workflow-runs/missing`);
        expect(missingWorkflowDetail.status).toBe(404);
        await expect(missingWorkflowDetail.json()).resolves.toEqual({ error: 'workflow_run_not_found' });

        const settings = await fetch(`http://127.0.0.1:${port}/api/v1/settings`);
        const settingsPayload = await settings.json() as { data: Array<{ id: string; value: string }> };
        expect(settingsPayload.data.find((row) => row.id === 'operational-snapshot-limit')).toMatchObject({
          value: '10 events',
        });

        const detail = await fetch(`http://127.0.0.1:${port}/api/v1/events/github-webhook%3Adelivery-existing%3Agithub.issue`);
        await expect(detail.json()).resolves.toMatchObject({
          data: {
            id: 'github-webhook:delivery-existing:github.issue',
            record: {
              subject: {
                id: '271',
                url: 'https://github.com/reirei-lab/rainrail/issues/271',
              },
            },
          },
        });

        const body = JSON.stringify({ action: 'opened' });
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body, { delivery: 'delivery-new', event: 'issues' }),
          body,
        });
        expect(accepted.status).toBe(202);
      } finally {
        await closeTestServer(result);
      }

      withSqliteDatabase(databasePath, (database) => {
        const row = database.prepare('SELECT payload_json FROM operational_events WHERE id = ?')
          .get('github-webhook:delivery-existing:github.issue') as { payload_json: string };
        expect(JSON.parse(row.payload_json)).toEqual({ action: 'opened', preserved: true });
      });
    });
  });

  it('migrates older SQLite operational event tables in local start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sqlite-operational-start-migration');
      const port = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.sqlite');
      await mkdir(join(projectRoot, 'var'), { recursive: true });
      withSqliteDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TABLE operational_events (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_json TEXT NOT NULL,
            delivery_json TEXT NOT NULL,
            subject_json TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            links_json TEXT
          );
        `);
        database.prepare(`
          INSERT INTO operational_events (
            id, name, source_json, delivery_json, subject_json, occurred_at, received_at,
            payload_json, links_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'github-webhook:delivery-old-schema:github.issue',
          'github.issue',
          JSON.stringify({ type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' }),
          JSON.stringify({ id: 'delivery-old-schema', receivedAt: '2026-07-09T00:00:00.000Z' }),
          JSON.stringify({ type: 'issue', id: '271' }),
          '2026-07-09T00:00:00.000Z',
          '2026-07-09T00:00:00.000Z',
          JSON.stringify({ action: 'opened' }),
          null,
        );
      });
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port,
        },
        operationalStore: {
          kind: 'sqlite',
          databasePath,
          eventLimit: 10,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        expect(result.exitCode).toBe(0);
        const detail = await fetch(`http://127.0.0.1:${port}/api/v1/events/github-webhook%3Adelivery-old-schema%3Agithub.issue`);
        await expect(detail.json()).resolves.toMatchObject({
          data: {
            id: 'github-webhook:delivery-old-schema:github.issue',
            record: {
              envelope: {
                rawPayload: {
                  kind: 'inline-redacted',
                  reference: 'rainrail://redacted/raw-payload',
                },
              },
            },
          },
        });
      } finally {
        await closeTestServer(result);
      }
    });
  });

  it('reserves local event ids across shared SQLite start processes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sqlite-operational-shared-id');
      const firstPort = await getFreePort();
      const secondPort = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.sqlite');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const startConfig = (serverPort: number): string => `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: serverPort,
        },
        operationalStore: {
          kind: 'sqlite',
          databasePath,
          eventLimit: 10,
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
      }, null, 2)}\n`;
      await writeFile(configPath, startConfig(firstPort));
      const first = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      await writeFile(configPath, startConfig(secondPort));
      const second = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        const body = JSON.stringify({ action: 'opened' });
        const firstAccepted = await fetch(`http://127.0.0.1:${firstPort}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body, { delivery: 'delivery-shared-first', event: 'issues' }),
          body,
        });
        const secondAccepted = await fetch(`http://127.0.0.1:${secondPort}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body, { delivery: 'delivery-shared-second', event: 'issues' }),
          body,
        });

        expect(firstAccepted.status).toBe(202);
        expect(secondAccepted.status).toBe(202);
        await expect(firstAccepted.json()).resolves.toMatchObject({ data: { id: 'local-event-000001' } });
        await expect(secondAccepted.json()).resolves.toMatchObject({ data: { id: 'local-event-000002' } });
      } finally {
        await closeTestServer(first);
        await closeTestServer(second);
      }

      withSqliteDatabase(databasePath, (database) => {
        expect(database.prepare('SELECT count(*) as count FROM operational_events WHERE id LIKE ?').get('local-event-%'))
          .toEqual({ count: 2 });
      });
    });
  });

  it('allocates local event ids from all persisted SQLite events', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'sqlite-operational-local-id');
      const setupPort = await getFreePort();
      const port = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.sqlite');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const startConfig = (serverPort: number): string => `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: serverPort,
        },
        operationalStore: {
          kind: 'sqlite',
          databasePath,
          eventLimit: 1,
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
      }, null, 2)}\n`;
      await writeFile(configPath, startConfig(setupPort));
      const setup = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      await closeTestServer(setup);

      withSqliteDatabase(databasePath, (database) => {
        const insertEvent = database.prepare(`
          INSERT INTO operational_events (
            id, name, source_json, delivery_json, subject_json, occurred_at, received_at,
            payload_json, raw_payload_reference_json, links_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertEvent.run(
          'local-event-000009',
          'github.issue',
          JSON.stringify({ type: 'github', name: 'github-local' }),
          JSON.stringify({ id: 'delivery-old-local', receivedAt: '2026-07-09T00:00:00.000Z' }),
          JSON.stringify({ type: 'issue', id: 'local-event-000009' }),
          '2026-07-09T00:00:00.000Z',
          '2026-07-09T00:00:00.000Z',
          JSON.stringify({ localEvent: { status: 'received', summary: 'old local' } }),
          JSON.stringify({ kind: 'external-reference', reference: 'local://events/local-event-000009' }),
          JSON.stringify({ self: '/api/v1/events/local-event-000009' }),
        );
        insertEvent.run(
          'github-webhook:delivery-latest:github.issue',
          'github.issue',
          JSON.stringify({ type: 'github', name: 'github-webhook' }),
          JSON.stringify({ id: 'delivery-latest', receivedAt: '2026-07-09T00:10:00.000Z' }),
          JSON.stringify({ type: 'issue', id: 'latest' }),
          '2026-07-09T00:10:00.000Z',
          '2026-07-09T00:10:00.000Z',
          JSON.stringify({ action: 'opened' }),
          JSON.stringify({ kind: 'external-reference', reference: 'github://deliveries/delivery-latest' }),
          null,
        );
      });

      await writeFile(configPath, startConfig(port));
      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });
      try {
        const body = JSON.stringify({ action: 'opened' });
        const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: 'POST',
          headers: githubWebhookHeaders('secret', body, { delivery: 'delivery-new-local-id', event: 'issues' }),
          body,
        });
        expect(accepted.status).toBe(202);
        await expect(accepted.json()).resolves.toMatchObject({ data: { id: 'local-event-000010' } });
      } finally {
        await closeTestServer(result);
      }

      withSqliteDatabase(databasePath, (database) => {
        expect(database.prepare('SELECT id FROM operational_events WHERE id = ?').get('local-event-000010'))
          .toEqual({ id: 'local-event-000010' });
      });
    });
  });

  it('rejects incompatible JSON operational store files in local start', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'json-operational-start');
      const port = await getFreePort();
      const databasePath = join(projectRoot, 'var', 'rainrail-operational.json');
      await mkdir(join(projectRoot, 'var'), { recursive: true });
      await writeFile(databasePath, `${JSON.stringify({
        events: {
          existing: {
            id: 'existing',
          },
        },
        activityEvents: {},
      }, null, 2)}\n`);
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: {
          host: '127.0.0.1',
          port,
        },
        operationalStore: {
          kind: 'json',
          databasePath,
          eventLimit: 10,
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('JSON operational store is not compatible with rainrail start local event storage');
      await expect(readFile(databasePath, 'utf8')).resolves.toContain('"activityEvents"');
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

  it('keeps dashboard auth required when dashboardAuth tokens protect local APIs', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-html-contract');
      const dashboardAssetRoot = join(directory, 'dashboard-auth-dist');
      const port = await getFreePort();
      await mkdir(join(dashboardAssetRoot, 'en', 'dashboard'), { recursive: true });
      await writeFile(join(dashboardAssetRoot, 'en', 'dashboard', 'index.html'), [
        '<!doctype html>',
        '<html><body><section data-dashboard-app data-api-base-url="https://ops.example.test" data-auth-required="true"></section></body></html>',
      ].join(''));
      await writeFile(join(projectRoot, 'rainrail.config.json'), `${JSON.stringify({
        server: { host: '127.0.0.1', port },
        dashboardAuth: { readOnlyToken: 'read-token' },
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = await runRainrailCliAsync(['start'], {
        cwd: projectRoot,
        env: { RAINRAIL_DASHBOARD_DIST_DIR: dashboardAssetRoot },
      });
      try {
        expect(result.exitCode).toBe(0);

        const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
        expect(dashboard.status).toBe(200);
        const dashboardHtml = await dashboard.text();
        expect(dashboardHtml).toContain('data-api-base-url=""');
        expect(dashboardHtml).toContain('data-auth-required="true"');
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

      for (const endpoint of ['/dashboard', '/ja/dashboard', '/ja/dashboard/', '/en/dashboard', '/en/dashboard/', '/_astro/dashboard-app.js']) {
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
              endpoint,
            }],
          }],
          sources: [],
          taskProviders: {},
          runtimeProviders: {},
        }, null, 2)}\n`);

        const dashboardEndpoint = runRainrailCli(['start'], {
          cwd: projectRoot,
          serverStarter: () => ({ stop: () => undefined }),
        });
        expect(dashboardEndpoint.exitCode).toBe(1);
        expect(dashboardEndpoint.stderr, endpoint).toContain('config endpoint must not use a Rainrail core route');
      }

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

  it('generates only dashboard auth tokens with setup --dashboard-auth-only --yes', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-only-setup');
      const configPath = join(projectRoot, 'rainrail.config.json');
      const calls: unknown[] = [];

      const result = runRainrailCli(['setup', '--dashboard-auth-only', '--yes'], {
        cwd: projectRoot,
        commandRunner: (...call) => {
          calls.push(call);
          return { status: 0, stdout: 'unexpected plugin setup\n', stderr: '' };
        },
      });
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };
      const lockfile = await readFile(join(projectRoot, 'rainrail.lock'), 'utf8');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken in rainrail.config.json.\n');
      expect(config.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      expect(lockfile).toContain('"plugins": []');
      expect(calls).toEqual([]);
    });
  });

  it('generates dashboard auth only for config-only workspaces', async () => {
    await withTempDirectory(async (directory) => {
      const configPath = join(directory, 'custom.rainrail.json');
      await writeFile(configPath, `${JSON.stringify({
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['--config', configPath, 'setup', '--dashboard-auth-only', '--yes'], {
        cwd: directory,
      });
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('Generated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken in custom.rainrail.json.\n');
      expect(config.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      await expect(stat(join(directory, 'rainrail.lock'))).rejects.toThrow();
      await expect(stat(join(directory, '.rainrail', 'plugins'))).rejects.toThrow();
    });
  });

  it('rotates local dashboard auth tokens without printing old or new values', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-rotate');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, `${JSON.stringify({
        project: { name: 'dashboard-auth-rotate' },
        dashboardAuth: {
          readOnlyToken: 'old-read-token',
          operatorToken: 'old-operator-token',
          adminToken: 'old-admin-token',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['setup', '--dashboard-auth-only', '--rotate', '--yes'], {
        cwd: projectRoot,
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const config = JSON.parse(rawConfig) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string; adminToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        'Rotated dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, and dashboardAuth.adminToken in rainrail.config.json.\n',
      );
      expect(config.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.adminToken).toMatch(/^rr_local_admin_[A-Za-z0-9_-]+$/u);
      for (const secret of ['old-read-token', 'old-operator-token', 'old-admin-token']) {
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
        expect(rawConfig).not.toContain(secret);
      }
    });
  });

  it('keeps dashboard auth environment references when rotating concrete local tokens', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-rotate-env');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, `${JSON.stringify({
        project: { name: 'dashboard-auth-rotate-env' },
        dashboardAuth: {
          readOnlyToken: '${DASHBOARD_READ_TOKEN}',
          operatorToken: 'old-operator-token',
          adminToken: '${DASHBOARD_ADMIN_TOKEN}',
        },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);

      const result = runRainrailCli(['setup', '--dashboard-auth-only', '--rotate', '--yes'], {
        cwd: projectRoot,
        env: {
          DASHBOARD_READ_TOKEN: 'expanded-read-secret',
          DASHBOARD_ADMIN_TOKEN: 'expanded-admin-secret',
        },
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const config = JSON.parse(rawConfig) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string; adminToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        'Rotated dashboardAuth.operatorToken in rainrail.config.json.\n',
      );
      expect(config.dashboardAuth?.readOnlyToken).toBe('${DASHBOARD_READ_TOKEN}');
      expect(config.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      expect(config.dashboardAuth?.adminToken).toBe('${DASHBOARD_ADMIN_TOKEN}');
      expect(result.stdout).not.toContain('old-operator-token');
      expect(result.stdout).not.toContain('expanded-read-secret');
      expect(result.stdout).not.toContain('expanded-admin-secret');
      expect(rawConfig).not.toContain('old-operator-token');
      expect(rawConfig).not.toContain('expanded-read-secret');
      expect(rawConfig).not.toContain('expanded-admin-secret');
    });
  });

  it('replaces existing dashboard auth keys when rotating config files with top-level env fragments', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-rotate-fragmented-config');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-rotate-fragmented-config" },',
        '  "dashboardAuth": {',
        '    "readOnlyToken": "old-read-token",',
        '    "operatorToken": "old-operator-token"',
        '  },',
        '  "sourceBundles": [],',
        '  "sources": ${RAINRAIL_SOURCES},',
        '  "taskProviders": {},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', '--dashboard-auth-only', '--rotate', '--yes'], {
        cwd: projectRoot,
        env: { RAINRAIL_SOURCES: '[]' },
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const parseableConfig = JSON.parse(rawConfig.replace('${RAINRAIL_SOURCES}', '[]')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        'Rotated dashboardAuth.readOnlyToken and dashboardAuth.operatorToken in rainrail.config.json.\n',
      );
      expect(rawConfig).toContain('"sources": ${RAINRAIL_SOURCES}');
      expect(rawConfig.match(/"readOnlyToken"/gu)).toHaveLength(1);
      expect(rawConfig.match(/"operatorToken"/gu)).toHaveLength(1);
      expect(rawConfig).not.toContain('old-read-token');
      expect(rawConfig).not.toContain('old-operator-token');
      expect(parseableConfig.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(parseableConfig.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
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

  it('generates dashboard auth for complete setup projects using a custom config path', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-custom-config');
      const defaultConfigPath = join(projectRoot, 'rainrail.config.json');
      const customConfigPath = join(projectRoot, 'custom.rainrail.json');
      await writeFile(customConfigPath, `${JSON.stringify({
        project: { name: 'dashboard-auth-custom-config' },
        sourceBundles: [],
        sources: [],
        taskProviders: {},
        runtimeProviders: {},
      }, null, 2)}\n`);
      await rm(defaultConfigPath);

      const result = runRainrailCli(['--config', customConfigPath, 'setup', 'github', '--yes'], { cwd: projectRoot });
      const customConfig = JSON.parse(await readFile(customConfigPath, 'utf8')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(customConfig.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(customConfig.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      await expect(stat(defaultConfigPath)).rejects.toThrow();
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

  it('does not require unrelated runtime env fragments when generating dashboard auth tokens during setup', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-unset-runtime-fragment');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-unset-runtime-fragment" },',
        '  "sourceBundles": [],',
        '  "sources": ${RAINRAIL_SOURCES},',
        '  "taskProviders": ${TASK_PROVIDERS},',
        '  "runtimeProviders": {}',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', 'github', '--yes'], { cwd: projectRoot });
      const rawConfig = await readFile(configPath, 'utf8');
      const config = JSON.parse(
        rawConfig
          .replace('${RAINRAIL_SOURCES}', '[]')
          .replace('${TASK_PROVIDERS}', '{}'),
      ) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
      };

      expect(result.exitCode).toBe(0);
      expect(rawConfig).toContain('"sources": ${RAINRAIL_SOURCES}');
      expect(rawConfig).toContain('"taskProviders": ${TASK_PROVIDERS}');
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

  it('inserts generated dashboard auth at the top level when nested objects use the same key', async () => {
    await withTempDirectory(async (directory) => {
      const projectRoot = await initRainrailProject(directory, 'dashboard-auth-top-level-only');
      const configPath = join(projectRoot, 'rainrail.config.json');
      await writeFile(configPath, [
        '{',
        '  "project": { "name": "dashboard-auth-top-level-only" },',
        '  "sourceBundles": [],',
        '  "sources": [],',
        '  "taskProviders": ${TASK_PROVIDERS},',
        '  "runtimeProviders": {',
        '    "openclaw": {',
        '      "dashboardAuth": {}',
        '    }',
        '  }',
        '}',
      ].join('\n'));

      const result = runRainrailCli(['setup', 'github', '--yes'], {
        cwd: projectRoot,
        env: { TASK_PROVIDERS: '{}' },
      });
      const rawConfig = await readFile(configPath, 'utf8');
      const parseableConfig = JSON.parse(rawConfig.replace('${TASK_PROVIDERS}', '{}')) as {
        dashboardAuth?: { readOnlyToken?: string; operatorToken?: string };
        runtimeProviders?: { openclaw?: { dashboardAuth?: unknown } };
      };

      expect(result.exitCode).toBe(0);
      expect(parseableConfig.dashboardAuth?.readOnlyToken).toMatch(/^rr_local_read-only_[A-Za-z0-9_-]+$/u);
      expect(parseableConfig.dashboardAuth?.operatorToken).toMatch(/^rr_local_operator_[A-Za-z0-9_-]+$/u);
      expect(parseableConfig.runtimeProviders?.openclaw?.dashboardAuth).toEqual({});
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
