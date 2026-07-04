import { writeFileSync as realWriteFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  OFFICIAL_PLUGIN_CATALOG,
  type RainrailCliFileSystem,
  discoverRainrailProject,
  getBuiltInCommand,
  getOfficialPluginByAlias,
  parseRainrailArguments,
  runRainrailCli,
} from './index.js';

async function withTempDirectory(test: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'rainrail-cli-'));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Rainrail CLI built-in commands', () => {
  it('defines the command table without provider or runtime specific handlers', () => {
    expect(BUILT_IN_COMMANDS.map((command) => command.name)).toEqual([
      'new',
      'setup',
      'doctor',
      'plugins',
      'plugin',
      'update',
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
    expect(result.stdout).toContain('Official plugin aliases:');
    expect(result.stdout).toContain('  github');
    expect(result.stdout).toContain('  cloudflare');
    expect(result.stdout).toContain('  openclaw');
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

  it('routes canonical plugin commands through the plugin resolver', () => {
    const result = runRainrailCli(['plugin', 'github', 'setup']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail plugin github setup requires plugin execution');
  });

  it('routes official plugin aliases after built-in command lookup', () => {
    const result = runRainrailCli(['github', 'setup']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail github setup requires plugin execution');
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

  it('prints collision guidance before running implemented built-ins in verbose mode', async () => {
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
      expect(result.stderr).toContain('rainrail new is a built-in command.');
      expect(result.stderr).toContain('Use `rainrail plugin new run` to call the plugin.');
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

  it('scaffolds a project-local config, lockfile, and plugin directory', async () => {
    await withTempDirectory(async (directory) => {
      const result = runRainrailCli(['new', 'my-agent-ops'], { cwd: directory });
      const projectRoot = join(directory, 'my-agent-ops');

      expect(result).toEqual({
        exitCode: 0,
        stdout: `Created Rainrail project at ${projectRoot}\n`,
        stderr: '',
      });
      const config = await readFile(join(projectRoot, 'rainrail.config.json'), 'utf8');
      expect(JSON.parse(config) as unknown).toEqual({
        project: { name: 'my-agent-ops' },
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
    });
  });

  it('treats repeated scaffolding as safe when generated files are unchanged', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory })).toEqual({
        exitCode: 0,
        stdout: `Rainrail project already exists at ${join(directory, 'my-agent-ops')}\n`,
        stderr: '',
      });
    });
  });

  it('refuses to overwrite changed project-local files during scaffolding', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      await writeFile(join(directory, 'my-agent-ops', 'rainrail.lock'), '{"plugins":["custom"]}\n');

      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `Refusing to overwrite existing file with different content: ${join(directory, 'my-agent-ops', 'rainrail.lock')}\n`,
      });
    });
  });

  it('discovers the Rainrail project root from a nested directory', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
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

  it('adds, lists, and removes official plugins from project-local state', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');

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
      expect(runRainrailCli(['new', 'current-project'], { cwd: directory }).exitCode).toBe(0);
      expect(runRainrailCli(['new', 'target-project'], { cwd: directory }).exitCode).toBe(0);
      const currentProject = join(directory, 'current-project');
      const targetProject = join(directory, 'target-project');

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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');

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

      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      expect(runRainrailCli(['plugins', 'add', 'https://example.com/plugin.git'], {
        cwd: join(directory, 'my-agent-ops'),
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);

      expect(runRainrailCli(['plugins', 'list', 'github'], {
        cwd: join(directory, 'my-agent-ops'),
      })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'Usage: rainrail plugins list\n',
      });
    });
  });

  it('returns plugin filesystem failures as CLI results', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
      await rm(join(projectRoot, '.rainrail', 'plugins'), { recursive: true });
      await writeFile(join(projectRoot, '.rainrail', 'plugins'), 'not a directory\n');

      const result = runRainrailCli(['plugins', 'add', 'github'], { cwd: projectRoot });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('ENOTDIR');
      expect(result.stderr).not.toContain('Error:');
    });
  });

  it('keeps the plugin manifest when remove cannot update the lockfile', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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

  it('restores the lockfile when remove cannot delete the plugin manifest directory', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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

  it('rejects duplicate lockfile plugin names', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new', 'my-agent-ops'], { cwd: directory }).exitCode).toBe(0);
      const projectRoot = join(directory, 'my-agent-ops');
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

  it('validates the project name for rainrail new', async () => {
    await withTempDirectory(async (directory) => {
      expect(runRainrailCli(['new'], { cwd: directory }).stderr).toBe(
        'Usage: rainrail new <projectName>\n',
      );
      expect(runRainrailCli(['new', '../ops'], { cwd: directory }).stderr).toBe(
        'Project name must be a safe directory name.\n',
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
