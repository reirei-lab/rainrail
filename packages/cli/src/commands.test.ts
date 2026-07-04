import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  OFFICIAL_PLUGIN_CATALOG,
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

  it('resolves official plugin aliases before project-local plugin execution', () => {
    const result = runRainrailCli(['gh', 'doctor']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rainrail github doctor requires plugin execution');
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
