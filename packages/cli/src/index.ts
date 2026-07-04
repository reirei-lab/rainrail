import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

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

export type RainrailCliEnvironment = {
  readonly cwd?: string;
};

export type RainrailProject = {
  readonly root: string;
  readonly configPath: string;
  readonly lockPath: string;
  readonly pluginDirectory: string;
};

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
    summary: 'Update Rainrail CLI or project metadata.',
    implemented: false,
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

  return [
    'Usage: rainrail <command> [options]',
    '',
    'Built-in commands:',
    commandRows,
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

export function runRainrailCli(argv: readonly string[], environment: RainrailCliEnvironment = {}): RainrailCliResult {
  const parsed = parseRainrailArguments(argv);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.join('\n')}\n`,
    };
  }

  const command = getBuiltInCommand(parsed.commandName);

  if (command === undefined) {
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
