import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, parse, resolve, sep } from 'node:path';
import {
  OFFICIAL_PLUGIN_CATALOG,
  formatOfficialPluginCommandHelp,
  formatOfficialPluginHelp,
  getOfficialPluginByAlias,
  getOfficialPluginCommand,
  isOfficialPluginCommandHelpRequest,
  isOfficialPluginHelpRequest,
} from './official-plugin-catalog.js';

export {
  OFFICIAL_PLUGIN_CATALOG,
  formatOfficialPluginCommandHelp,
  formatOfficialPluginHelp,
  getOfficialPluginByAlias,
  getOfficialPluginCommand,
  isOfficialPluginCommandHelpRequest,
  isOfficialPluginHelpRequest,
  type OfficialPluginCommandMetadata,
  type OfficialPluginMetadata,
} from './official-plugin-catalog.js';

export type BuiltInCommandName =
  | 'new'
  | 'setup'
  | 'doctor'
  | 'plugins'
  | 'plugin'
  | 'update'
  | 'help';

export type BuiltInCommand = {
  readonly name: BuiltInCommandName;
  readonly kind: 'built-in';
  readonly summary: string;
  readonly implemented: boolean;
};

export type SharedOptions = {
  readonly config?: string;
  readonly profile?: string;
  readonly json: boolean;
  readonly yes: boolean;
};

export type ParsedRainrailArguments = {
  readonly commandName: string;
  readonly commandArgs: readonly string[];
  readonly options: SharedOptions;
  readonly errors: readonly string[];
};

export type RainrailCliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunnerResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
};

export type CommandRunnerOptions = {
  readonly stdio: 'inherit' | 'pipe';
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandRunnerOptions,
) => CommandRunnerResult;

export type RainrailCliEnvironment = {
  readonly cwd?: string;
  readonly commandRunner?: CommandRunner;
  readonly currentBinPath?: string;
};

export type RainrailProject = {
  readonly root: string;
  readonly configPath: string;
  readonly lockPath: string;
  readonly pluginDirectory: string;
};

const DEFAULT_INSTALLER_URL =
  'https://raw.githubusercontent.com/reirei-lab/rainrail/main/install.sh';
const rainrailConfigFileName = 'rainrail.config.json';
const rainrailLockFileName = 'rainrail.lock';
const rainrailDirectoryName = '.rainrail';
const rainrailPluginDirectoryName = 'plugins';
const safeProjectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const BUILT_IN_COMMANDS: readonly BuiltInCommand[] = [
  {
    name: 'new',
    kind: 'built-in',
    summary: 'Create a new Rainrail project or workspace scaffold.',
    implemented: true,
  },
  {
    name: 'setup',
    kind: 'built-in',
    summary: 'Prepare local Rainrail configuration.',
    implemented: false,
  },
  {
    name: 'doctor',
    kind: 'built-in',
    summary: 'Check local Rainrail configuration and environment health.',
    implemented: false,
  },
  {
    name: 'plugins',
    kind: 'built-in',
    summary: 'List and inspect installed Rainrail plugins.',
    implemented: false,
  },
  {
    name: 'plugin',
    kind: 'built-in',
    summary: 'Manage one Rainrail plugin.',
    implemented: false,
  },
  {
    name: 'update',
    kind: 'built-in',
    summary: 'Update the Rainrail CLI from GitHub Releases.',
    implemented: true,
  },
  {
    name: 'help',
    kind: 'built-in',
    summary: 'Show Rainrail CLI help.',
    implemented: true,
  },
];

export function getBuiltInCommand(name: string): BuiltInCommand | undefined {
  return BUILT_IN_COMMANDS.find((command) => command.name === name);
}

export function parseRainrailArguments(argv: readonly string[]): ParsedRainrailArguments {
  const commandArgs: string[] = [];
  const errors: string[] = [];
  const parsedOptions: { config?: string; profile?: string; json: boolean; yes: boolean } = {
    json: false,
    yes: false,
  };
  let commandName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      commandArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg === '--json') {
      parsedOptions.json = true;
      continue;
    }

    if (arg === '--yes') {
      parsedOptions.yes = true;
      continue;
    }

    if (arg === '--help' && commandName === undefined) {
      commandName = 'help';
      continue;
    }

    if (arg === '--config' || arg === '--profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`Missing value for ${arg}.`);
        continue;
      }

      if (arg === '--config') {
        parsedOptions.config = value;
      } else {
        parsedOptions.profile = value;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value.length === 0) {
        errors.push('Missing value for --config.');
        continue;
      }

      parsedOptions.config = value;
      continue;
    }

    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value.length === 0) {
        errors.push('Missing value for --profile.');
        continue;
      }

      parsedOptions.profile = value;
      continue;
    }

    if (commandName === undefined) {
      commandName = arg;
      continue;
    }

    commandArgs.push(arg);
  }

  return {
    commandName: commandName ?? 'help',
    commandArgs,
    options: parsedOptions,
    errors,
  };
}

export function formatHelp(): string {
  const commandRows = BUILT_IN_COMMANDS.map((command) => {
    const paddedName = command.name.padEnd(8, ' ');
    return `  ${paddedName} ${command.summary}`;
  }).join('\n');
  const pluginRows = OFFICIAL_PLUGIN_CATALOG.map((plugin) => {
    const paddedAlias = plugin.alias.padEnd(11, ' ');
    const aliasText = plugin.aliases.length > 1 ? ` (${plugin.aliases.slice(1).join(', ')})` : '';
    return `  ${paddedAlias} ${plugin.summary}${aliasText}`;
  }).join('\n');

  return [
    'Usage: rainrail <command> [options]',
    '',
    'Built-in commands:',
    commandRows,
    '',
    'Official plugin aliases:',
    pluginRows,
    '',
    'Common options:',
    '  --config <path>    Use a Rainrail config file.',
    '  --profile <name>   Use a named Rainrail profile.',
    '  --json             Reserve JSON output mode for commands that support it.',
    '  --yes              Confirm non-interactive prompts.',
    '',
  ].join('\n');
}

export function discoverRainrailProject(startPath: string): RainrailProject | undefined {
  let current = resolve(startPath);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }

  while (true) {
    const configPath = join(current, rainrailConfigFileName);
    if (existsSync(configPath)) {
      return {
        root: current,
        configPath,
        lockPath: join(current, rainrailLockFileName),
        pluginDirectory: join(current, rainrailDirectoryName, rainrailPluginDirectoryName),
      };
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function parseUpdateArguments(args: readonly string[]): {
  readonly installer: string;
  readonly installerArgs: readonly string[];
  readonly hasExplicitPrefix: boolean;
  readonly errors: readonly string[];
} {
  const installerArgs: string[] = [];
  const errors: string[] = [];
  let installer = DEFAULT_INSTALLER_URL;
  let hasExplicitPrefix = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--version' || arg === '--installer') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`Missing value for ${arg}.`);
        continue;
      }

      if (arg === '--installer') {
        installer = value;
      } else {
        installerArgs.push(arg, value);
      }
      index += 1;
      continue;
    }

    if (arg === '--prefix') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push('Missing value for --prefix.');
        continue;
      }

      installerArgs.push(arg, value);
      hasExplicitPrefix = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--version=')) {
      const value = arg.slice('--version='.length);
      if (value.length === 0) {
        errors.push('Missing value for --version.');
        continue;
      }
      installerArgs.push('--version', value);
      continue;
    }

    if (arg.startsWith('--installer=')) {
      const value = arg.slice('--installer='.length);
      if (value.length === 0) {
        errors.push('Missing value for --installer.');
        continue;
      }
      installer = value;
      continue;
    }

    if (arg.startsWith('--prefix=')) {
      const value = arg.slice('--prefix='.length);
      if (value.length === 0) {
        errors.push('Missing value for --prefix.');
        continue;
      }
      installerArgs.push('--prefix', value);
      hasExplicitPrefix = true;
      continue;
    }

    installerArgs.push(arg);
  }

  return { installer, installerArgs, hasExplicitPrefix, errors };
}

function toOutput(value: string | Buffer | null | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : value.toString('utf8');
}

function runUpdateCommand(
  args: readonly string[],
  options: SharedOptions,
  commandRunner: CommandRunner,
  currentBinPath: string | undefined,
): RainrailCliResult {
  const parsed = parseUpdateArguments(args);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.join('\n')}\n`,
    };
  }

  const installerArgs = [...parsed.installerArgs];
  if (!parsed.hasExplicitPrefix) {
    const inferredPrefix = inferRainrailInstallPrefix(currentBinPath);
    if (inferredPrefix === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          'Unable to infer the current Rainrail install prefix. Re-run rainrail update with --prefix <path>.\n',
      };
    }
    installerArgs.push('--prefix', inferredPrefix);
  }

  if (options.yes) {
    installerArgs.push('--yes');
  }
  const stdio = installerArgs.includes('--add-to-shell') &&
    !installerArgs.includes('--yes')
    ? 'inherit'
    : 'pipe';

  const result = parsed.installer.startsWith('http://') ||
    parsed.installer.startsWith('https://')
    ? commandRunner('bash', [
        '-c',
        'set -euo pipefail; tmp="$(mktemp)"; trap \'rm -f "$tmp"\' EXIT; curl -fsSL "$1" -o "$tmp"; bash "$tmp" "${@:2}"',
        'rainrail-update',
        parsed.installer,
        ...installerArgs,
      ], { stdio })
    : commandRunner('bash', [parsed.installer, ...installerArgs], { stdio });

  return {
    exitCode: result.status ?? 1,
    stdout: toOutput(result.stdout),
    stderr: toOutput(result.stderr),
  };
}

function inferRainrailInstallPrefix(currentBinPath: string | undefined): string | undefined {
  if (currentBinPath === undefined || currentBinPath.length === 0) {
    return undefined;
  }

  const normalized = normalize(currentBinPath);
  if (normalized.endsWith(`${sep}bin${sep}rainrail`)) {
    return dirname(dirname(normalized));
  }

  const packageBinSuffix = `${sep}dist${sep}bin${sep}rainrail.js`;
  const packageMarker = `${sep}lib${sep}rainrail${sep}`;
  const packageMarkerIndex = normalized.lastIndexOf(packageMarker);
  if (packageMarkerIndex > 0 && normalized.endsWith(packageBinSuffix)) {
    return normalized.slice(0, packageMarkerIndex);
  }

  return undefined;
}

export function runRainrailCli(
  argv: readonly string[],
  environment: RainrailCliEnvironment = {},
): RainrailCliResult {
  const parsed = parseRainrailArguments(argv);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.join('\n')}\n`,
    };
  }

  const command = getBuiltInCommand(parsed.commandName);
  const officialPlugin = getOfficialPluginByAlias(parsed.commandName);

  if (command === undefined) {
    if (officialPlugin !== undefined) {
      if (isOfficialPluginHelpRequest(parsed.commandArgs)) {
        return {
          exitCode: 0,
          stdout: formatOfficialPluginHelp(officialPlugin),
          stderr: '',
        };
      }

      const pluginCommand = getOfficialPluginCommand(officialPlugin, parsed.commandArgs);
      if (pluginCommand === undefined) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Unknown rainrail ${officialPlugin.alias} command: ${parsed.commandArgs.join(' ')}\n\n${formatOfficialPluginHelp(officialPlugin)}`,
        };
      }

      if (isOfficialPluginCommandHelpRequest(pluginCommand, parsed.commandArgs)) {
        return {
          exitCode: 0,
          stdout: formatOfficialPluginCommandHelp(officialPlugin, pluginCommand),
          stderr: '',
        };
      }

      return {
        exitCode: 2,
        stdout: '',
        stderr: `rainrail ${officialPlugin.alias} ${pluginCommand.name} requires plugin execution, which is not implemented yet.\n`,
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unknown rainrail command: ${parsed.commandName}\n\n${formatHelp()}`,
    };
  }

  if (command.name === 'help') {
    return {
      exitCode: 0,
      stdout: formatHelp(),
      stderr: '',
    };
  }

  if (command.name === 'update') {
    return runUpdateCommand(
      parsed.commandArgs,
      parsed.options,
      environment.commandRunner ??
        ((commandName, args, commandOptions) =>
          spawnSync(commandName, args, {
            encoding: 'utf8',
            stdio: commandOptions.stdio,
          })),
      environment.currentBinPath ?? process.argv[1],
    );
  }

  if (command.name === 'new') {
    return runNewCommand(parsed.commandArgs, environment);
  }

  return {
    exitCode: 2,
    stdout: '',
    stderr: `rainrail ${command.name} is not implemented yet.\n`,
  };
}

function runNewCommand(args: readonly string[], environment: RainrailCliEnvironment): RainrailCliResult {
  const projectName = args[0];
  if (projectName === undefined || args.length !== 1) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail new <projectName>\n',
    };
  }

  if (!safeProjectNamePattern.test(projectName) || parse(projectName).base !== projectName) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Project name must be a safe directory name.\n',
    };
  }

  const cwd = environment.cwd === undefined ? process.cwd() : environment.cwd;
  const projectRoot = resolve(cwd, projectName);
  const alreadyExisted = existsSync(projectRoot);

  try {
    createRainrailProject(projectRoot, projectName);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: alreadyExisted
      ? `Rainrail project already exists at ${projectRoot}\n`
      : `Created Rainrail project at ${projectRoot}\n`,
    stderr: '',
  };
}

function createRainrailProject(projectRoot: string, projectName: string): void {
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, rainrailDirectoryName, rainrailPluginDirectoryName), { recursive: true });

  writeGeneratedFile(
    join(projectRoot, rainrailConfigFileName),
    formatRainrailConfig(projectName),
  );
  writeGeneratedFile(
    join(projectRoot, rainrailLockFileName),
    formatRainrailLock(projectName),
  );
  writeGeneratedFile(
    join(projectRoot, rainrailDirectoryName, rainrailPluginDirectoryName, '.gitkeep'),
    '',
  );
}

function writeGeneratedFile(path: string, content: string): void {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (existing !== content) {
      throw new Error(`Refusing to overwrite existing file with different content: ${path}`);
    }
    return;
  }

  writeFileSync(path, content, { flag: 'wx' });
}

function formatRainrailConfig(projectName: string): string {
  return `${JSON.stringify({
    project: { name: projectName },
    sourceBundles: [],
    sources: [],
    taskProviders: {},
    runtimeProviders: {},
  }, null, 2)}\n`;
}

function formatRainrailLock(projectName: string): string {
  return `${JSON.stringify({
    lockfileVersion: 1,
    project: { name: projectName },
    plugins: [],
  }, null, 2)}\n`;
}
