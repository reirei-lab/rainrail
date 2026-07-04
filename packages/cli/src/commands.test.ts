import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  getBuiltInCommand,
  parseRainrailArguments,
  runRainrailCli,
} from './index.js';

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
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const result = runRainrailCli(
      ['--yes', 'update', '--version', '1.2.3', '--installer', '/tmp/install.sh'],
      {
        commandRunner: (command, args) => {
          calls.push({ command, args });
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
        args: ['/tmp/install.sh', '--version', '1.2.3', '--yes'],
      },
    ]);
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
