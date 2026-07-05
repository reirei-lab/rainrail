import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, parse, resolve, sep } from 'node:path';
import {
  OFFICIAL_PLUGIN_CATALOG,
  formatOfficialPluginCommandHelp,
  formatOfficialPluginHelp,
  getOfficialPluginByAlias,
  getOfficialPluginCommand,
  isOfficialPluginCommandHelpRequest,
  isOfficialPluginHelpRequest,
  type OfficialPluginMetadata,
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
  readonly verbose?: boolean;
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
  readonly cwd?: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandRunnerOptions,
) => CommandRunnerResult;

export type RainrailCliFileSystem = {
  readonly existsSync: typeof existsSync;
  readonly lstatSync: typeof lstatSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly rmSync: typeof rmSync;
  readonly statSync: typeof statSync;
  readonly writeFileSync: typeof writeFileSync;
};

export type PluginAliasResolver = (alias: string) => OfficialPluginMetadata | undefined;

export type RainrailCliEnvironment = {
  readonly cwd?: string;
  readonly commandRunner?: CommandRunner;
  readonly currentBinPath?: string;
  readonly fileSystem?: Partial<RainrailCliFileSystem>;
  readonly pluginAliasResolver?: PluginAliasResolver;
};

export type RainrailProject = {
  readonly root: string;
  readonly configPath: string;
  readonly lockPath: string;
  readonly pluginDirectory: string;
};

export type RainrailLockPlugin = {
  readonly name: string;
  readonly version: string;
  readonly resolvedSource: string;
};

export type RainrailLockfile = {
  readonly lockfileVersion: 1;
  readonly project: {
    readonly name: string;
  };
  readonly plugins: readonly RainrailLockPlugin[];
};

type PluginManifestRollback = {
  readonly pluginDirectoryPath: string;
  readonly manifestPath: string;
  readonly createdPluginDirectory: boolean;
  readonly hadManifest: boolean;
  readonly previousManifestContent?: string;
};

const DEFAULT_INSTALLER_URL =
  'https://raw.githubusercontent.com/reirei-lab/rainrail/main/install.sh';
const rainrailConfigFileName = 'rainrail.config.json';
const rainrailLockFileName = 'rainrail.lock';
const rainrailDirectoryName = '.rainrail';
const rainrailPluginDirectoryName = 'plugins';
const safeProjectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const semverVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const defaultRainrailCliFileSystem: RainrailCliFileSystem = {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
};

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
    implemented: true,
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
    implemented: true,
  },
  {
    name: 'plugin',
    kind: 'built-in',
    summary: 'Manage one Rainrail plugin.',
    implemented: true,
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
  const parsedOptions: {
    config?: string;
    profile?: string;
    json: boolean;
    yes: boolean;
    verbose?: boolean;
  } = {
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

    if (arg === '--verbose') {
      parsedOptions.verbose = true;
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

export function discoverRainrailProject(
  startPath: string,
  fileSystem: RainrailCliFileSystem = defaultRainrailCliFileSystem,
): RainrailProject | undefined {
  let current = resolve(startPath);
  if (fileSystem.existsSync(current) && !fileSystem.statSync(current).isDirectory()) {
    current = dirname(current);
  }

  while (true) {
    const configPath = join(current, rainrailConfigFileName);
    if (fileSystem.existsSync(configPath) && isRegularFile(configPath, fileSystem)) {
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

function defaultPluginAliasResolver(alias: string): OfficialPluginMetadata | undefined {
  return getOfficialPluginByAlias(alias);
}

function runPluginCommand(
  plugin: OfficialPluginMetadata,
  args: readonly string[],
  invocation: readonly string[],
): RainrailCliResult {
  if (isOfficialPluginHelpRequest(args)) {
    return {
      exitCode: 0,
      stdout: formatOfficialPluginHelp(plugin, invocation),
      stderr: '',
    };
  }

  const pluginCommand = getOfficialPluginCommand(plugin, args);
  if (pluginCommand === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unknown rainrail ${invocation.join(' ')} command: ${args.join(' ')}\n\n${formatOfficialPluginHelp(plugin, invocation)}`,
    };
  }

  if (isOfficialPluginCommandHelpRequest(pluginCommand, args)) {
    return {
      exitCode: 0,
      stdout: formatOfficialPluginCommandHelp(plugin, pluginCommand, invocation),
      stderr: '',
    };
  }

  if (pluginCommand.name === 'setup' && isOfficialBundledPlugin(plugin)) {
    return {
      exitCode: 0,
      stdout:
        `Official plugin ${plugin.alias} setup completed. No bundled setup actions are registered yet.\n`,
      stderr: '',
    };
  }

  return {
    exitCode: 2,
    stdout: '',
    stderr: `rainrail ${[...invocation, pluginCommand.name].join(' ')} requires plugin execution, which is not implemented yet.\n`,
  };
}

function isOfficialBundledPlugin(plugin: OfficialPluginMetadata): boolean {
  return getOfficialPluginByAlias(plugin.alias)?.alias === plugin.alias;
}

function formatPluginCollisionHint(commandName: string, commandArgs: readonly string[]): string {
  const canonicalCommand = ['rainrail', 'plugin', commandName, ...commandArgs].join(' ');
  return `A plugin named "${commandName}" also exists. Use \`${canonicalCommand}\` to call the plugin.\n`;
}

function getPluginCollisionHint(
  commandName: string,
  commandArgs: readonly string[],
  options: SharedOptions,
  pluginAliasResolver: PluginAliasResolver,
): string | undefined {
  if (!options.verbose || pluginAliasResolver(commandName) === undefined) {
    return undefined;
  }

  return formatPluginCollisionHint(commandName, commandArgs);
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
  const pluginAliasResolver = environment.pluginAliasResolver ?? defaultPluginAliasResolver;

  if (command === undefined) {
    const officialPlugin = pluginAliasResolver(parsed.commandName);
    if (officialPlugin !== undefined) {
      return runPluginCommand(officialPlugin, parsed.commandArgs, [officialPlugin.alias]);
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unknown rainrail command: ${parsed.commandName}\n\n${formatHelp()}`,
    };
  }

  if (command.name === 'plugin') {
    const pluginName = parsed.commandArgs[0];
    if (pluginName === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Usage: rainrail plugin <pluginName> <command>\n',
      };
    }

    const plugin = pluginAliasResolver(pluginName);
    if (plugin === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Unknown rainrail plugin: ${pluginName}\n`,
      };
    }

    return runPluginCommand(plugin, parsed.commandArgs.slice(1), ['plugin', pluginName]);
  }

  const pluginCollisionHint = getPluginCollisionHint(
    command.name,
    parsed.commandArgs,
    parsed.options,
    pluginAliasResolver,
  );
  if (command.implemented && pluginCollisionHint !== undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `rainrail ${command.name} is a built-in command.\n${pluginCollisionHint}`,
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

  if (command.name === 'setup') {
    return runSetupCommand(parsed.commandArgs, parsed.options, environment);
  }

  if (command.name === 'plugins') {
    return runPluginsCommand(parsed.commandArgs, parsed.options, environment);
  }

  return {
    exitCode: 2,
    stdout: '',
    stderr: [
      `rainrail ${command.name} is not implemented yet.\n`,
      pluginCollisionHint ?? '',
    ].join(''),
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
  const fileSystem = getRainrailCliFileSystem(environment);
  const projectRoot = resolve(cwd, projectName);
  const alreadyExisted = fileSystem.existsSync(projectRoot);

  try {
    createRainrailProject(projectRoot, projectName, fileSystem);
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

function createRainrailProject(
  projectRoot: string,
  projectName: string,
  fileSystem: RainrailCliFileSystem,
): void {
  fileSystem.mkdirSync(projectRoot, { recursive: true });
  const stateDirectory = ensureRainrailStateDirectory(projectRoot, fileSystem);
  const pluginDirectory = join(stateDirectory, rainrailPluginDirectoryName);
  if (!fileSystem.existsSync(pluginDirectory)) {
    fileSystem.mkdirSync(pluginDirectory, { recursive: true });
  }
  ensureRegularDirectory(pluginDirectory, `Plugin root is not a regular directory: ${pluginDirectory}`, fileSystem);

  writeGeneratedFile(
    join(projectRoot, rainrailConfigFileName),
    formatRainrailConfig(projectName),
    fileSystem,
  );
  writeGeneratedFile(
    join(projectRoot, rainrailLockFileName),
    formatRainrailLock(projectName),
    fileSystem,
  );
  writeGeneratedFile(
    join(pluginDirectory, '.gitkeep'),
    '',
    fileSystem,
  );
}

type SetupStepAction = 'install' | 'setup';
type SetupStepStatus = 'completed' | 'failed';

type SetupStepResult = {
  readonly plugin: string;
  readonly action: SetupStepAction;
  readonly command: readonly string[];
  readonly status: SetupStepStatus;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type SetupJsonResult = {
  readonly command: 'setup';
  readonly completed: boolean;
  readonly plugins: readonly string[];
  readonly steps: readonly SetupStepResult[];
  readonly nextAction?: string;
  readonly error?: string;
};

function runSetupCommand(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  const cwd = environment.cwd === undefined ? process.cwd() : environment.cwd;
  const fileSystem = getRainrailCliFileSystem(environment);
  let project: RainrailProject | undefined;
  try {
    project = resolveRainrailProject(cwd, options, fileSystem);
  } catch (error) {
    return formatSetupError(options, error);
  }
  if (project === undefined) {
    return formatSetupError(
      options,
      'rainrail setup requires a Rainrail project. Run it inside a directory with rainrail.config.json.',
    );
  }
  const setupOptions = normalizeSetupOptions(cwd, options);

  const selectedPlugins = resolveSetupPlugins(args);
  if (selectedPlugins.error !== undefined) {
    return formatSetupError(options, selectedPlugins.error);
  }
  const plugins = selectedPlugins.plugins;

  if (!options.yes) {
    if (options.json) {
      return formatSetupPreview(plugins, args.length > 0);
    }

    return {
      exitCode: 0,
      stdout: formatSetupChoices(),
      stderr: '',
    };
  }

  const invocation = createRainrailCommandInvocation(environment.currentBinPath ?? process.argv[1]);
  const steps: SetupStepResult[] = [];

  for (const plugin of plugins) {
    const installResult = runPluginsCommand(['add', plugin.alias], setupOptions, {
      ...environment,
      cwd: project.root,
    });
    const installStep = createSetupStep(
      plugin.alias,
      'install',
      ['rainrail', ...formatForwardedTargetOptions(setupOptions), 'plugins', 'add', plugin.alias],
      installResult,
    );
    steps.push(installStep);
    if (installResult.exitCode !== 0) {
      return formatSetupResult(false, plugins, steps, options, installStep);
    }

    const setupArgs = [
      ...invocation.args,
      'plugin',
      plugin.alias,
      'setup',
      ...formatForwardedSetupOptions(setupOptions),
    ];
    const pluginSetupResult = environment.commandRunner === undefined
      ? runPluginCommand(plugin, ['setup', ...formatForwardedSetupOptions(setupOptions)], [
          'plugin',
          plugin.alias,
        ])
      : toCliResult(environment.commandRunner(invocation.command, setupArgs, {
          stdio: 'pipe',
          cwd: project.root,
        }));
    const setupStep = createSetupStep(
      plugin.alias,
      'setup',
      [
        'rainrail',
        ...formatForwardedTargetOptions(setupOptions),
        'plugin',
        plugin.alias,
        'setup',
        ...formatForwardedExecutionOptions(setupOptions),
      ],
      pluginSetupResult,
    );
    steps.push(setupStep);
    if (pluginSetupResult.exitCode !== 0) {
      return formatSetupResult(false, plugins, steps, options, setupStep);
    }
  }

  return formatSetupResult(true, plugins, steps, options);
}

function formatSetupError(options: SharedOptions, error: unknown): RainrailCliResult {
  const message = stripTrailingNewline(error instanceof Error ? error.message : String(error));
  if (!options.json) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${message}\n`,
    };
  }

  return {
    exitCode: 1,
    stdout: formatJson({
      command: 'setup',
      completed: false,
      plugins: [],
      steps: [],
      error: message,
    }),
    stderr: '',
  };
}

function toCliResult(result: CommandRunnerResult): RainrailCliResult {
  return {
    exitCode: result.status ?? 1,
    stdout: toOutput(result.stdout),
    stderr: toOutput(result.stderr),
  };
}

function normalizeSetupOptions(cwd: string, options: SharedOptions): SharedOptions {
  if (options.config === undefined) {
    return options;
  }

  return {
    ...options,
    config: resolve(cwd, options.config),
  };
}

function resolveSetupPlugins(args: readonly string[]): {
  readonly plugins: readonly OfficialPluginMetadata[];
  readonly error?: string;
} {
  if (args.length === 0) {
    return { plugins: OFFICIAL_PLUGIN_CATALOG };
  }

  const plugins: OfficialPluginMetadata[] = [];
  const seenAliases = new Set<string>();
  for (const arg of args) {
    const plugin = getOfficialPluginByAlias(arg);
    if (plugin === undefined) {
      return {
        plugins: [],
        error: `Unknown official plugin: ${arg}. Third-party and Git URL plugins are not supported by rainrail setup.`,
      };
    }
    if (!seenAliases.has(plugin.alias)) {
      plugins.push(plugin);
      seenAliases.add(plugin.alias);
    }
  }

  return { plugins };
}

function formatSetupChoices(): string {
  const pluginRows = OFFICIAL_PLUGIN_CATALOG.map((plugin) => {
    const aliasText = plugin.aliases.length > 1 ? ` (${plugin.aliases.slice(1).join(', ')})` : '';
    return `  ${plugin.alias.padEnd(11, ' ')} ${plugin.summary}${aliasText}`;
  }).join('\n');

  return [
    'Official plugins available for setup:',
    pluginRows,
    '',
    'Run `rainrail setup --yes` to install and set up all official plugins.',
    'Run `rainrail setup <plugin...> --yes` to install and set up selected official plugins.',
    '',
  ].join('\n');
}

function formatSetupPreview(
  plugins: readonly OfficialPluginMetadata[],
  includePluginArguments: boolean,
): RainrailCliResult {
  return {
    exitCode: 0,
    stdout: formatJson({
      command: 'setup',
      completed: false,
      plugins: plugins.map((plugin) => plugin.alias),
      steps: [],
      nextAction: formatSetupNextAction(plugins, includePluginArguments),
    }),
    stderr: '',
  };
}

function formatSetupNextAction(
  plugins: readonly OfficialPluginMetadata[],
  includePluginArguments: boolean,
): string {
  return [
    'rainrail',
    'setup',
    ...(includePluginArguments ? plugins.map((plugin) => plugin.alias) : []),
    '--yes',
  ].join(' ');
}

function formatForwardedSetupOptions(options: SharedOptions): readonly string[] {
  return [
    ...formatForwardedTargetOptions(options),
    ...formatForwardedExecutionOptions(options),
  ];
}

function formatForwardedTargetOptions(options: SharedOptions): readonly string[] {
  const forwardedOptions: string[] = [];
  if (options.config !== undefined) {
    forwardedOptions.push('--config', options.config);
  }
  if (options.profile !== undefined) {
    forwardedOptions.push('--profile', options.profile);
  }
  return forwardedOptions;
}

function formatForwardedExecutionOptions(options: SharedOptions): readonly string[] {
  const forwardedOptions: string[] = [];
  if (options.yes) {
    forwardedOptions.push('--yes');
  }
  if (options.json) {
    forwardedOptions.push('--json');
  }
  return forwardedOptions;
}

function createRainrailCommandInvocation(currentBinPath: string | undefined): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (currentBinPath !== undefined && currentBinPath.length > 0) {
    const normalizedBinPath = normalize(currentBinPath);
    if (normalizedBinPath.endsWith(`${sep}rainrail.js`)) {
      return {
        command: process.execPath,
        args: [currentBinPath],
      };
    }

    if (parse(normalizedBinPath).base === 'rainrail') {
      return {
        command: currentBinPath,
        args: [],
      };
    }
  }

  return {
    command: 'rainrail',
    args: [],
  };
}

function createSetupStep(
  plugin: string,
  action: SetupStepAction,
  command: readonly string[],
  result: RainrailCliResult,
): SetupStepResult {
  return {
    plugin,
    action,
    command,
    exitCode: result.exitCode,
    status: result.exitCode === 0 ? 'completed' : 'failed',
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function formatSetupResult(
  completed: boolean,
  plugins: readonly OfficialPluginMetadata[],
  steps: readonly SetupStepResult[],
  options: SharedOptions,
  failedStep?: SetupStepResult,
): RainrailCliResult {
  if (options.json) {
    const jsonResult: SetupJsonResult = {
      command: 'setup',
      completed,
      plugins: plugins.map((plugin) => plugin.alias),
      steps,
    };
    return {
      exitCode: failedStep?.exitCode ?? 0,
      stdout: formatJson(jsonResult),
      stderr: '',
    };
  }

  const stdout = steps.map((step) => step.stdout).join('');
  const stderr = steps.map((step) => step.stderr).join('');
  if (failedStep !== undefined) {
    return {
      exitCode: failedStep.exitCode,
      stdout,
      stderr: `${failedStep.command.join(' ')} failed with exit code ${failedStep.exitCode}.\n${stderr}`,
    };
  }

  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

function runPluginsCommand(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  const subcommand = args[0];
  if (subcommand === undefined || !['list', 'add', 'remove'].includes(subcommand)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail plugins <list|add|remove> [officialPluginName]\n',
    };
  }

  if (subcommand === 'list' && args.length !== 1) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail plugins list\n',
    };
  }

  if ((subcommand === 'add' || subcommand === 'remove') && args.length !== 2) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Usage: rainrail plugins ${subcommand} <officialPluginName>\n`,
    };
  }

  const cwd = environment.cwd === undefined ? process.cwd() : environment.cwd;
  const fileSystem = getRainrailCliFileSystem(environment);
  let project: RainrailProject | undefined;
  try {
    project = resolveRainrailProject(cwd, options, fileSystem);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  if (project === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        'rainrail plugins requires a Rainrail project. Run it inside a directory with rainrail.config.json.\n',
    };
  }

  try {
    const lockfile = readRainrailLockfile(project.lockPath, fileSystem);
    if (subcommand === 'list') {
      return listProjectPlugins(project, lockfile, fileSystem);
    }

    const pluginName = args[1];
    if (pluginName === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Usage: rainrail plugins ${subcommand} <officialPluginName>\n`,
      };
    }

    const plugin = getOfficialPluginByAlias(pluginName);
    if (plugin === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `Unknown official plugin: ${pluginName}. Third-party and Git URL plugins are not supported yet.\n`,
      };
    }

    if (subcommand === 'add') {
      return addProjectPlugin(project, lockfile, plugin.alias, plugin.version, fileSystem);
    }

    return removeProjectPlugin(project, lockfile, plugin.alias, fileSystem);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

function getRainrailCliFileSystem(environment: RainrailCliEnvironment): RainrailCliFileSystem {
  return {
    ...defaultRainrailCliFileSystem,
    ...environment.fileSystem,
  };
}

function resolveRainrailProject(
  cwd: string,
  options: SharedOptions,
  fileSystem: RainrailCliFileSystem,
): RainrailProject | undefined {
  if (options.config === undefined) {
    return discoverRainrailProject(cwd, fileSystem);
  }

  const configPath = resolve(cwd, options.config);
  if (!fileSystem.existsSync(configPath)) {
    throw new Error(`Rainrail config file not found: ${configPath}`);
  }
  if (!isRegularFile(configPath, fileSystem)) {
    throw new Error(`Rainrail config path is not a file: ${configPath}`);
  }

  const root = dirname(configPath);
  return {
    root,
    configPath,
    lockPath: join(root, rainrailLockFileName),
    pluginDirectory: join(root, rainrailDirectoryName, rainrailPluginDirectoryName),
  };
}

function listProjectPlugins(
  project: RainrailProject,
  lockfile: RainrailLockfile,
  fileSystem: RainrailCliFileSystem,
): RainrailCliResult {
  ensureProjectPluginRoot(project, fileSystem);
  for (const plugin of lockfile.plugins) {
    const pluginDirectoryPath = join(project.pluginDirectory, plugin.name);
    const manifestPath = join(pluginDirectoryPath, 'plugin.json');
    const pluginDirectoryStat = lstatPath(pluginDirectoryPath, fileSystem);
    if (pluginDirectoryStat === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `Plugin lockfile entry ${plugin.name} is missing ${manifestPath}. Re-run rainrail plugins add ${plugin.name}.\n`,
      };
    }
    if (!pluginDirectoryStat.isDirectory() || pluginDirectoryStat.isSymbolicLink()) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Plugin manifest directory is not a regular directory: ${pluginDirectoryPath}\n`,
      };
    }
    const manifestStat = lstatPath(manifestPath, fileSystem);
    if (manifestStat === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `Plugin lockfile entry ${plugin.name} is missing ${manifestPath}. Re-run rainrail plugins add ${plugin.name}.\n`,
      };
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Plugin manifest path is not a regular file: ${manifestPath}\n`,
      };
    }
    const expectedManifest = formatJson(plugin);
    if (fileSystem.readFileSync(manifestPath, 'utf8') !== expectedManifest) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `Plugin manifest ${manifestPath} does not match rainrail.lock. Re-run rainrail plugins add ${plugin.name}.\n`,
      };
    }
  }

  return {
    exitCode: 0,
    stdout: lockfile.plugins.map((plugin) =>
      `${plugin.name}@${plugin.version} ${plugin.resolvedSource}`
    ).join('\n') + (lockfile.plugins.length === 0 ? '' : '\n'),
    stderr: '',
  };
}

function addProjectPlugin(
  project: RainrailProject,
  lockfile: RainrailLockfile,
  name: string,
  version: string,
  fileSystem: RainrailCliFileSystem,
): RainrailCliResult {
  ensureProjectPluginRoot(project, fileSystem);
  const installedPlugin = lockfile.plugins.find((plugin) => plugin.name === name);
  if (installedPlugin !== undefined) {
    writeProjectPluginManifest(project, installedPlugin, fileSystem);
    return {
      exitCode: 0,
      stdout: `Official plugin ${name} is already installed.\n`,
      stderr: '',
    };
  }

  const pluginEntry = createLockPlugin(name, version);
  const nextLockfile = {
    ...lockfile,
    plugins: sortLockPlugins([...lockfile.plugins, pluginEntry]),
  };
  const manifestRollback = writeProjectPluginManifest(project, pluginEntry, fileSystem);
  try {
    fileSystem.writeFileSync(project.lockPath, formatJson(nextLockfile), { flag: 'w' });
  } catch (error) {
    rollbackProjectPluginManifest(manifestRollback, fileSystem);
    throw error;
  }

  return {
    exitCode: 0,
    stdout: `Added official plugin ${name}@${version}\n`,
    stderr: '',
  };
}

function writeProjectPluginManifest(
  project: RainrailProject,
  plugin: RainrailLockPlugin,
  fileSystem: RainrailCliFileSystem,
): PluginManifestRollback {
  const pluginDirectoryPath = join(project.pluginDirectory, plugin.name);
  const manifestPath = join(pluginDirectoryPath, 'plugin.json');
  const pluginDirectoryStat = lstatPath(pluginDirectoryPath, fileSystem);
  const createdPluginDirectory = pluginDirectoryStat === undefined;
  if (pluginDirectoryStat !== undefined) {
    if (!pluginDirectoryStat.isDirectory() || pluginDirectoryStat.isSymbolicLink()) {
      throw new Error(`Plugin manifest directory is not a regular directory: ${pluginDirectoryPath}`);
    }
  }

  fileSystem.mkdirSync(pluginDirectoryPath, { recursive: true });
  const createdDirectoryStat = fileSystem.lstatSync(pluginDirectoryPath);
  if (!createdDirectoryStat.isDirectory() || createdDirectoryStat.isSymbolicLink()) {
    throw new Error(`Plugin manifest directory is not a regular directory: ${pluginDirectoryPath}`);
  }

  const manifestStat = lstatPath(manifestPath, fileSystem);
  const hadManifest = manifestStat !== undefined;
  if (manifestStat !== undefined) {
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error(`Plugin manifest path is not a regular file: ${manifestPath}`);
    }
  }
  const previousManifestContent = hadManifest ? fileSystem.readFileSync(manifestPath, 'utf8') : undefined;

  fileSystem.writeFileSync(manifestPath, formatJson(plugin), {
    flag: 'w',
  });
  const rollback: PluginManifestRollback = {
    pluginDirectoryPath,
    manifestPath,
    createdPluginDirectory,
    hadManifest,
  };
  if (previousManifestContent !== undefined) {
    return {
      ...rollback,
      previousManifestContent,
    };
  }
  return rollback;
}

function rollbackProjectPluginManifest(
  rollback: PluginManifestRollback,
  fileSystem: RainrailCliFileSystem,
): void {
  if (rollback.hadManifest) {
    fileSystem.writeFileSync(rollback.manifestPath, rollback.previousManifestContent ?? '', { flag: 'w' });
    return;
  }

  fileSystem.rmSync(rollback.manifestPath, { force: true });
  if (rollback.createdPluginDirectory) {
    fileSystem.rmSync(rollback.pluginDirectoryPath, { recursive: true, force: true });
  }
}

function removeProjectPlugin(
  project: RainrailProject,
  lockfile: RainrailLockfile,
  name: string,
  fileSystem: RainrailCliFileSystem,
): RainrailCliResult {
  ensureProjectPluginRoot(project, fileSystem);
  if (!lockfile.plugins.some((plugin) => plugin.name === name)) {
    return {
      exitCode: 0,
      stdout: `Official plugin ${name} is not installed.\n`,
      stderr: '',
    };
  }

  const nextLockfile = {
    ...lockfile,
    plugins: lockfile.plugins.filter((plugin) => plugin.name !== name),
  };
  fileSystem.writeFileSync(project.lockPath, formatJson(nextLockfile), { flag: 'w' });
  try {
    fileSystem.rmSync(join(project.pluginDirectory, name), { recursive: true, force: true });
  } catch (error) {
    fileSystem.writeFileSync(project.lockPath, formatJson(lockfile), { flag: 'w' });
    throw error;
  }

  return {
    exitCode: 0,
    stdout: `Removed official plugin ${name}\n`,
    stderr: '',
  };
}

function ensureProjectPluginRoot(project: RainrailProject, fileSystem: RainrailCliFileSystem): void {
  ensureRainrailStateDirectory(project.root, fileSystem);
  if (!fileSystem.existsSync(project.pluginDirectory)) {
    fileSystem.mkdirSync(project.pluginDirectory, { recursive: true });
  }

  ensureRegularDirectory(
    project.pluginDirectory,
    `Plugin root is not a regular directory: ${project.pluginDirectory}`,
    fileSystem,
  );
}

function ensureRainrailStateDirectory(
  projectRoot: string,
  fileSystem: RainrailCliFileSystem,
): string {
  const stateDirectory = join(projectRoot, rainrailDirectoryName);
  if (!fileSystem.existsSync(stateDirectory)) {
    fileSystem.mkdirSync(stateDirectory, { recursive: true });
  }

  ensureRegularDirectory(
    stateDirectory,
    `Rainrail state directory is not a regular directory: ${stateDirectory}`,
    fileSystem,
  );
  return stateDirectory;
}

function ensureRegularDirectory(
  path: string,
  message: string,
  fileSystem: RainrailCliFileSystem,
): void {
  const pathStat = lstatPath(path, fileSystem);
  if (pathStat === undefined || !pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(message);
  }
}

function isRegularFile(path: string, fileSystem: RainrailCliFileSystem): boolean {
  const pathStat = lstatPath(path, fileSystem);
  return pathStat !== undefined && pathStat.isFile() && !pathStat.isSymbolicLink();
}

function lstatPath(
  path: string,
  fileSystem: RainrailCliFileSystem,
): ReturnType<typeof lstatSync> | undefined {
  try {
    const pathStat = fileSystem.lstatSync(path);
    if (
      !pathStat.isFile() &&
      !pathStat.isDirectory() &&
      !pathStat.isSymbolicLink() &&
      !fileSystem.existsSync(path)
    ) {
      return undefined;
    }
    return pathStat;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  }
}

function createLockPlugin(name: string, version: string): RainrailLockPlugin {
  return {
    name,
    version,
    resolvedSource: `official:${name}@${version}`,
  };
}

function readRainrailLockfile(path: string, fileSystem: RainrailCliFileSystem): RainrailLockfile {
  const lockfileStat = lstatPath(path, fileSystem);
  if (lockfileStat === undefined) {
    throw new Error(`Rainrail lockfile not found: ${path}`);
  }
  if (!lockfileStat.isFile() || lockfileStat.isSymbolicLink()) {
    throw new Error(`Rainrail lockfile is not a regular file: ${path}`);
  }

  const parsed = JSON.parse(fileSystem.readFileSync(path, 'utf8')) as Partial<RainrailLockfile>;
  if (
    parsed.lockfileVersion !== 1 ||
    typeof parsed.project?.name !== 'string' ||
    parsed.project.name.length === 0 ||
    !Array.isArray(parsed.plugins)
  ) {
    throw new Error(`Unsupported Rainrail lockfile format: ${path}`);
  }

  const plugins = parsed.plugins.map((plugin) => {
    if (!isLockPlugin(plugin)) {
      throw new Error(`Unsupported Rainrail lockfile plugin entry in ${path}`);
    }
    return {
      name: plugin.name,
      version: plugin.version,
      resolvedSource: plugin.resolvedSource,
    };
  });
  const pluginNames = new Set<string>();
  for (const plugin of plugins) {
    if (pluginNames.has(plugin.name)) {
      throw new Error(`Duplicate Rainrail lockfile plugin entry in ${path}: ${plugin.name}`);
    }
    pluginNames.add(plugin.name);
  }

  return {
    lockfileVersion: 1,
    project: {
      name: parsed.project.name,
    },
    plugins: sortLockPlugins(plugins),
  };
}

function isLockPlugin(value: unknown): value is RainrailLockPlugin {
  if (
    !(typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { version?: unknown }).version === 'string' &&
    typeof (value as { resolvedSource?: unknown }).resolvedSource === 'string')
  ) {
    return false;
  }

  const plugin = value as RainrailLockPlugin;
  const officialPlugin = getOfficialPluginByAlias(plugin.name);
  return officialPlugin?.alias === plugin.name &&
    semverVersionPattern.test(plugin.version) &&
    plugin.resolvedSource === `official:${plugin.name}@${plugin.version}`;
}

function sortLockPlugins(plugins: readonly RainrailLockPlugin[]): readonly RainrailLockPlugin[] {
  return [...plugins].sort((left, right) => left.name.localeCompare(right.name));
}

function writeGeneratedFile(
  path: string,
  content: string,
  fileSystem: RainrailCliFileSystem,
): void {
  const pathStat = lstatPath(path, fileSystem);
  if (pathStat !== undefined) {
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`Generated file path is not a regular file: ${path}`);
    }
    const existing = fileSystem.readFileSync(path, 'utf8');
    if (existing !== content) {
      throw new Error(`Refusing to overwrite existing file with different content: ${path}`);
    }
    return;
  }

  fileSystem.writeFileSync(path, content, { flag: 'wx' });
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
  return formatJson({
    lockfileVersion: 1,
    project: { name: projectName },
    plugins: [],
  });
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}
