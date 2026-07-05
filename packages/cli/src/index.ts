import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
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
  | 'init'
  | 'setup'
  | 'start'
  | 'doctor'
  | 'plugins'
  | 'plugin'
  | 'update'
  | 'version'
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
  readonly server?: RainrailStartedServer;
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

export type ReleaseFetchResult = {
  readonly status: number;
  readonly body: string;
};

export type ReleaseFetcher = (url: string) => ReleaseFetchResult;
export type AsyncReleaseFetcherOptions = {
  readonly signal: AbortSignal;
};
export type AsyncReleaseFetcher = (
  url: string,
  options: AsyncReleaseFetcherOptions,
) => Promise<ReleaseFetchResult>;

export type RainrailCliFileSystem = {
  readonly existsSync: typeof existsSync;
  readonly lstatSync: typeof lstatSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly readdirSync: typeof readdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly rmSync: typeof rmSync;
  readonly statSync: typeof statSync;
  readonly writeFileSync: typeof writeFileSync;
};

export type PluginAliasResolver = (alias: string) => OfficialPluginMetadata | undefined;

export type RainrailStartOptions = {
  readonly host: string;
  readonly port: number;
  readonly root: string;
  readonly configPath: string;
  readonly dashboardToken?: string;
  readonly sources: readonly RainrailLocalSource[];
};

export type RainrailStartedServer = {
  readonly stop: () => void | Promise<void>;
};

export type RainrailServerStarter = (
  options: RainrailStartOptions,
) => RainrailStartedServer | Promise<RainrailStartedServer>;

export type RainrailLocalSource = {
  readonly name: string;
  readonly sourceType: string;
  readonly endpoint: string;
  readonly transport: 'http';
  readonly authConfigured: boolean;
  readonly webhookSecret?: string;
  readonly maxBodyBytes?: number;
};

export type RainrailCliEnvironment = {
  readonly cacheDirectory?: string;
  readonly cwd?: string;
  readonly commandRunner?: CommandRunner;
  readonly currentVersion?: string;
  readonly currentBinPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fileSystem?: Partial<RainrailCliFileSystem>;
  readonly now?: () => Date;
  readonly pluginAliasResolver?: PluginAliasResolver;
  readonly releaseFetcher?: ReleaseFetcher;
  readonly serverStarter?: RainrailServerStarter;
  readonly asyncReleaseFetcher?: AsyncReleaseFetcher;
  readonly stdin?: string;
  readonly stdinReader?: () => string;
  readonly stderrWriter?: (message: string) => void;
};

export type RainrailCliEntrypointIO = {
  readonly stdout: { readonly write: (value: string) => void };
  readonly stderr: { readonly write: (value: string) => void };
};

export type RainrailCliEntrypointEnvironment = RainrailCliEnvironment & {
  readonly runCli?: (
    argv: readonly string[],
    environment?: RainrailCliEnvironment,
  ) => RainrailCliResult | Promise<RainrailCliResult>;
  readonly updateNoticeCheck?: (signal: AbortSignal) => Promise<string | undefined>;
  readonly updateNoticeTimeoutMs?: number;
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
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/reirei-lab/rainrail/releases/latest';
const updateCheckCacheFileName = 'update-check.json';
const updateCheckCacheTtlMs = 24 * 60 * 60 * 1000;
const updateNoticeTimeoutMs = 150;
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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
};

export const BUILT_IN_COMMANDS: readonly BuiltInCommand[] = [
  {
    name: 'init',
    kind: 'built-in',
    summary: 'Initialize the current directory as a Rainrail workspace.',
    implemented: true,
  },
  {
    name: 'setup',
    kind: 'built-in',
    summary: 'Prepare local Rainrail configuration.',
    implemented: true,
  },
  {
    name: 'start',
    kind: 'built-in',
    summary: 'Start the local Rainrail server in the foreground.',
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
    name: 'version',
    kind: 'built-in',
    summary: 'Print the Rainrail CLI version.',
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
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  if (args[0] === 'check') {
    return runUpdateCheckCommand(args.slice(1), options, commandRunner, environment);
  }

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
    const inferredPrefix = inferRainrailInstallPrefix(environment.currentBinPath);
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

type UpdateCheckCache = {
  readonly checkedAt: string;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly updateCommand: string | null;
};

type UpdateCheckResult = UpdateCheckCache & {
  readonly command: 'update check';
  readonly cached: boolean;
};

type LatestReleaseCheck = {
  readonly cacheable: boolean;
  readonly result: UpdateCheckCache;
};

function runUpdateCheckCommand(
  args: readonly string[],
  options: SharedOptions,
  commandRunner: CommandRunner,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  if (args.length !== 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail update check\n',
    };
  }

  const now = environment.now?.() ?? new Date();
  const currentVersion = environment.currentVersion ?? getRainrailCliPackageVersion();
  const cachePath = getUpdateCheckCachePath(environment);
  const cachedResult = readFreshUpdateCheckCache(cachePath, currentVersion, now, environment);
  if (cachedResult !== undefined) {
    return formatUpdateCheckResult({ ...cachedResult, command: 'update check', cached: true }, options);
  }

  const checkedAt = now.toISOString();
  const result = checkLatestRelease(
    currentVersion,
    checkedAt,
    commandRunner,
    environment.releaseFetcher,
  );
  if (result.cacheable) {
    writeUpdateCheckCache(cachePath, result.result, environment);
  }
  return formatUpdateCheckResult({ ...result.result, command: 'update check', cached: false }, options);
}

function checkLatestRelease(
  currentVersion: string,
  checkedAt: string,
  commandRunner: CommandRunner,
  releaseFetcher: ReleaseFetcher | undefined,
): LatestReleaseCheck {
  try {
    const response = releaseFetcher === undefined
      ? defaultReleaseFetcher(GITHUB_LATEST_RELEASE_URL, commandRunner)
      : releaseFetcher(GITHUB_LATEST_RELEASE_URL);
    return evaluateLatestReleaseResponse(response, currentVersion, checkedAt);
  } catch {
    return { cacheable: false, result: createNoopUpdateCheck(currentVersion, checkedAt) };
  }
}

function evaluateLatestReleaseResponse(
  response: ReleaseFetchResult,
  currentVersion: string,
  checkedAt: string,
): LatestReleaseCheck {
  if (response.status < 200 || response.status >= 300) {
    return { cacheable: false, result: createNoopUpdateCheck(currentVersion, checkedAt) };
  }

  const release = JSON.parse(response.body) as {
    assets?: unknown;
    tag_name?: unknown;
    prerelease?: unknown;
  };
  if (release.prerelease === true || typeof release.tag_name !== 'string') {
    return { cacheable: false, result: createNoopUpdateCheck(currentVersion, checkedAt) };
  }

  const latestVersion = normalizeReleaseTag(release.tag_name);
  if (
    latestVersion === undefined ||
    isPrereleaseVersion(latestVersion)
  ) {
    return { cacheable: false, result: createNoopUpdateCheck(currentVersion, checkedAt) };
  }

  if (!hasRainrailCliReleaseAsset(release.assets, latestVersion)) {
    return { cacheable: false, result: createNoopUpdateCheck(currentVersion, checkedAt) };
  }

  if (compareSemver(latestVersion, currentVersion) <= 0) {
    return {
      cacheable: true,
      result: createKnownNoUpdateCheck(currentVersion, checkedAt, latestVersion),
    };
  }

  const updateVersion = formatReleaseTagForUpdateCommand(release.tag_name, latestVersion);

  return {
    cacheable: true,
    result: {
      checkedAt,
      currentVersion,
      latestVersion,
      updateAvailable: true,
      updateCommand: `rainrail update --version ${shellQuoteArgument(updateVersion)}`,
    },
  };
}

function createNoopUpdateCheck(currentVersion: string, checkedAt: string): UpdateCheckCache {
  return {
    checkedAt,
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    updateCommand: null,
  };
}

function hasRainrailCliReleaseAsset(assets: unknown, version: string): boolean {
  if (!Array.isArray(assets)) {
    return false;
  }

  const expectedAssetName = `rainrail-cli-v${version}.tgz`;
  return assets.some((asset) => isUploadedReleaseAsset(asset, expectedAssetName));
}

function isUploadedReleaseAsset(asset: unknown, expectedAssetName: string): boolean {
  if (typeof asset !== 'object' || asset === null) {
    return false;
  }

  const candidate = asset as { name?: unknown; size?: unknown; state?: unknown };
  return candidate.name === expectedAssetName &&
    candidate.state === 'uploaded' &&
    typeof candidate.size === 'number' &&
    candidate.size > 0;
}

function formatReleaseTagForUpdateCommand(tag: string, normalizedVersion: string): string {
  if (tag.startsWith('release/') || tag.startsWith('v')) {
    return tag;
  }
  return normalizedVersion;
}

function createKnownNoUpdateCheck(
  currentVersion: string,
  checkedAt: string,
  latestVersion: string,
): UpdateCheckCache {
  return {
    checkedAt,
    currentVersion,
    latestVersion,
    updateAvailable: false,
    updateCommand: null,
  };
}

function formatUpdateCheckResult(result: UpdateCheckResult, options: SharedOptions): RainrailCliResult {
  if (options.json) {
    return {
      exitCode: 0,
      stdout: formatJson(result),
      stderr: '',
    };
  }

  return {
    exitCode: 0,
    stdout: result.updateAvailable && result.latestVersion !== null
      ? `Rainrail ${result.latestVersion} is available. Run \`${result.updateCommand}\` to update.\n`
      : formatNoUpdateText(result),
    stderr: '',
  };
}

function formatNoUpdateText(result: UpdateCheckResult): string {
  if (result.latestVersion === null) {
    return 'Unable to check Rainrail updates. Try again later.\n';
  }

  return `Rainrail is up to date (${result.currentVersion}).\n`;
}

export async function runRainrailCliEntrypoint(
  argv: readonly string[],
  io: RainrailCliEntrypointIO = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  environment: RainrailCliEntrypointEnvironment = {},
): Promise<RainrailCliResult> {
  const updateNoticeTask = shouldStartUpdateNoticeCheck(argv, environment)
    ? startUpdateNoticeCheck(environment)
    : undefined;
  const {
    runCli: injectedRunCli,
    updateNoticeCheck: _updateNoticeCheck,
    updateNoticeTimeoutMs: _updateNoticeTimeoutMs,
    asyncReleaseFetcher: _asyncReleaseFetcher,
    ...cliEnvironment
  } = environment;
  const runCli = injectedRunCli ?? runRainrailCliAsync;
  const result = await runCli(argv, cliEnvironment);

  if (result.stdout.length > 0) {
    io.stdout.write(result.stdout);
  }

  if (result.stderr.length > 0) {
    io.stderr.write(result.stderr);
  }

  if (result.exitCode !== 0) {
    updateNoticeTask?.abort();
  }

  if (result.exitCode === 0 && updateNoticeTask !== undefined) {
    const notice = await waitForUpdateNotice(
      updateNoticeTask,
      environment.updateNoticeTimeoutMs ?? updateNoticeTimeoutMs,
    );
    if (notice !== undefined && notice.length > 0) {
      io.stderr.write(notice);
    }
  }

  return result;
}

function shouldStartUpdateNoticeCheck(
  argv: readonly string[],
  environment: RainrailCliEntrypointEnvironment,
): boolean {
  const parsed = parseRainrailArguments(argv);
  if (parsed.errors.length > 0) {
    return false;
  }

  if (['help', 'version', 'update'].includes(parsed.commandName)) {
    return false;
  }

  const pluginAliasResolver = environment.pluginAliasResolver ?? defaultPluginAliasResolver;
  if (parsed.commandName === 'plugin') {
    const pluginName = parsed.commandArgs[0];
    const plugin = pluginName === undefined ? undefined : pluginAliasResolver(pluginName);
    return plugin === undefined ||
      !isPluginHelpRequestForNotice(plugin, parsed.commandArgs.slice(1));
  }

  const plugin = pluginAliasResolver(parsed.commandName);
  return plugin === undefined || !isPluginHelpRequestForNotice(plugin, parsed.commandArgs);
}

function isPluginHelpRequestForNotice(
  plugin: OfficialPluginMetadata,
  args: readonly string[],
): boolean {
  if (isOfficialPluginHelpRequest(args)) {
    return true;
  }

  const pluginCommand = getOfficialPluginCommand(plugin, args);
  return pluginCommand !== undefined && isOfficialPluginCommandHelpRequest(pluginCommand, args);
}

type UpdateNoticeTask = {
  readonly promise: Promise<string | undefined>;
  readonly abort: () => void;
}

function startUpdateNoticeCheck(
  environment: RainrailCliEntrypointEnvironment,
): UpdateNoticeTask {
  const abortController = new AbortController();
  const promise = (environment.updateNoticeCheck ??
    ((signal) => checkRainrailUpdateNotice(environment, signal)))(abortController.signal)
    .catch(() => undefined);

  return {
    promise,
    abort: () => abortController.abort(),
  };
}

async function waitForUpdateNotice(
  updateNoticeTask: UpdateNoticeTask,
  timeoutMs: number,
): Promise<string | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      updateNoticeTask.promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          updateNoticeTask.abort();
          resolve(undefined);
        }, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function checkRainrailUpdateNotice(
  environment: RainrailCliEnvironment,
  signal: AbortSignal,
): Promise<string | undefined> {
  const now = environment.now?.() ?? new Date();
  const currentVersion = environment.currentVersion ?? getRainrailCliPackageVersion();
  const cachePath = getUpdateCheckCachePath(environment);
  const cachedResult = readFreshUpdateCheckCache(cachePath, currentVersion, now, environment);
  if (cachedResult !== undefined) {
    return formatUpdateNotice(cachedResult);
  }

  try {
    const checkedAt = now.toISOString();
    const response = environment.asyncReleaseFetcher === undefined
      ? await defaultAsyncReleaseFetcher(GITHUB_LATEST_RELEASE_URL, { signal })
      : await environment.asyncReleaseFetcher(GITHUB_LATEST_RELEASE_URL, { signal });
    const result = evaluateLatestReleaseResponse(response, currentVersion, checkedAt);
    if (result.cacheable) {
      writeUpdateCheckCache(cachePath, result.result, environment);
    }
    return formatUpdateNotice(result.result);
  } catch {
    return undefined;
  }
}

function formatUpdateNotice(result: UpdateCheckCache): string | undefined {
  if (!result.updateAvailable || result.latestVersion === null || result.updateCommand === null) {
    return undefined;
  }

  return `Rainrail ${result.latestVersion} is available. Run \`${result.updateCommand}\` to update.\n`;
}

async function defaultAsyncReleaseFetcher(
  url: string,
  options: AsyncReleaseFetcherOptions,
): Promise<ReleaseFetchResult> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rainrail-cli',
    },
    signal: options.signal,
  });

  return {
    status: response.status,
    body: await response.text(),
  };
}

function defaultReleaseFetcher(url: string, commandRunner: CommandRunner): ReleaseFetchResult {
  const result = commandRunner('curl', [
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
    url,
  ], { stdio: 'pipe' });
  const output = toOutput(result.stdout);
  const separatorIndex = output.lastIndexOf('\n');
  const body = separatorIndex >= 0 ? output.slice(0, separatorIndex) : output;
  const httpCodeText = separatorIndex >= 0 ? output.slice(separatorIndex + 1).trim() : '';
  const httpCode = Number(httpCodeText);

  return {
    status: Number.isInteger(httpCode) ? httpCode : 0,
    body,
  };
}

function getUpdateCheckCachePath(environment: RainrailCliEnvironment): string | undefined {
  const cacheDirectory = environment.cacheDirectory ?? getDefaultCacheDirectory();
  if (cacheDirectory === undefined) {
    return undefined;
  }
  return join(cacheDirectory, updateCheckCacheFileName);
}

function getDefaultCacheDirectory(): string | undefined {
  if (process.env.XDG_CACHE_HOME !== undefined && process.env.XDG_CACHE_HOME.length > 0) {
    return join(process.env.XDG_CACHE_HOME, 'rainrail');
  }

  const homeDirectory = homedir();
  return homeDirectory.length > 0 ? join(homeDirectory, '.cache', 'rainrail') : undefined;
}

function readFreshUpdateCheckCache(
  path: string | undefined,
  currentVersion: string,
  now: Date,
  environment: RainrailCliEnvironment,
): UpdateCheckCache | undefined {
  if (path === undefined) {
    return undefined;
  }

  const fileSystem = getRainrailCliFileSystem(environment);
  try {
    if (!fileSystem.existsSync(path)) {
      return undefined;
    }
    const parsed = JSON.parse(fileSystem.readFileSync(path, 'utf8')) as Partial<UpdateCheckCache>;
    if (!isUpdateCheckCache(parsed) || parsed.currentVersion !== currentVersion) {
      return undefined;
    }
    const checkedAtMs = Date.parse(parsed.checkedAt);
    if (
      !Number.isFinite(checkedAtMs) ||
      checkedAtMs > now.getTime() ||
      now.getTime() - checkedAtMs >= updateCheckCacheTtlMs
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeUpdateCheckCache(
  path: string | undefined,
  result: UpdateCheckCache,
  environment: RainrailCliEnvironment,
): void {
  if (path === undefined) {
    return;
  }

  const fileSystem = getRainrailCliFileSystem(environment);
  try {
    fileSystem.mkdirSync(dirname(path), { recursive: true });
    fileSystem.writeFileSync(path, formatJson(result), { flag: 'w' });
  } catch {
    // Update checks must never fail the CLI because cache storage is unavailable.
  }
}

function isUpdateCheckCache(value: Partial<UpdateCheckCache>): value is UpdateCheckCache {
  return typeof value.checkedAt === 'string' &&
    typeof value.currentVersion === 'string' &&
    (typeof value.latestVersion === 'string' || value.latestVersion === null) &&
    typeof value.updateAvailable === 'boolean' &&
    (typeof value.updateCommand === 'string' || value.updateCommand === null);
}

function normalizeReleaseTag(tag: string): string | undefined {
  const normalized = tag.startsWith('release/') ? tag.slice('release/'.length) : tag;
  const withoutPrefix = normalized.startsWith('v') ? normalized.slice(1) : normalized;
  return semverVersionPattern.test(withoutPrefix) ? withoutPrefix : undefined;
}

function isPrereleaseVersion(version: string): boolean {
  const match = semverVersionPattern.exec(version);
  return match?.[4] !== undefined;
}

type ParsedSemver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
};

function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (leftParts === undefined || rightParts === undefined) {
    return 0;
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = leftParts[key] - rightParts[key];
    if (difference !== 0) {
      return difference;
    }
  }

  return comparePrerelease(leftParts.prerelease, rightParts.prerelease);
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length > 0) {
    return 1;
  }
  if (left.length > 0 && right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const difference = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumber = parseNumericPrereleaseIdentifier(left);
  const rightNumber = parseNumericPrereleaseIdentifier(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== undefined) {
    return -1;
  }
  if (rightNumber !== undefined) {
    return 1;
  }
  return left.localeCompare(right);
}

function parseNumericPrereleaseIdentifier(identifier: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/u.test(identifier)) {
    return undefined;
  }
  return Number(identifier);
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match = semverVersionPattern.exec(version);
  if (match === null) {
    return undefined;
  }
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
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
    const commandLength = pluginCommand.name.split(' ').length;
    if (args.length !== commandLength) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Unknown rainrail ${invocation.join(' ')} command: ${args.join(' ')}\n\n${formatOfficialPluginHelp(plugin, invocation)}`,
      };
    }

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
    const updateEnvironment: RainrailCliEnvironment = environment.currentBinPath === undefined
      ? environment
      : {
          ...environment,
          currentBinPath: environment.currentBinPath,
        };
    return runUpdateCommand(
      parsed.commandArgs,
      parsed.options,
      environment.commandRunner ??
        ((commandName, args, commandOptions) =>
          spawnSync(commandName, args, {
            encoding: 'utf8',
            stdio: commandOptions.stdio,
          })),
      environment.currentBinPath === undefined && process.argv[1] !== undefined
        ? { ...updateEnvironment, currentBinPath: process.argv[1] }
        : updateEnvironment,
    );
  }

  if (command.name === 'version') {
    return runVersionCommand(parsed.commandArgs);
  }

  if (command.name === 'init') {
    return runInitCommand(parsed.commandArgs, parsed.options, environment);
  }

  if (command.name === 'setup') {
    return runSetupCommand(parsed.commandArgs, parsed.options, environment);
  }

  if (command.name === 'start') {
    return runStartCommand(parsed.commandArgs, parsed.options, environment);
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

export async function runRainrailCliAsync(
  argv: readonly string[],
  environment: RainrailCliEnvironment = {},
): Promise<RainrailCliResult> {
  const parsed = parseRainrailArguments(argv);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.join('\n')}\n`,
    };
  }

  const command = getBuiltInCommand(parsed.commandName);
  if (command?.name !== 'start') {
    return runRainrailCli(argv, environment);
  }

  const pluginCollisionHint = getPluginCollisionHint(
    command.name,
    parsed.commandArgs,
    parsed.options,
    environment.pluginAliasResolver ?? defaultPluginAliasResolver,
  );
  if (pluginCollisionHint !== undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `rainrail ${command.name} is a built-in command.\n${pluginCollisionHint}`,
    };
  }

  return runStartCommandAsync(parsed.commandArgs, parsed.options, environment);
}

type StartArguments = {
  readonly host?: string;
  readonly port?: number;
  readonly errors: readonly string[];
};

type StartConfig = {
  readonly server?: {
    readonly host?: string;
    readonly port?: number;
  };
  readonly sources: readonly RainrailLocalSource[];
};

function runStartCommand(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  if (environment.serverStarter === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'rainrail start requires the async CLI runner.\n',
    };
  }

  const resolved = resolveStartCommandOptions(args, options, environment);
  if ('result' in resolved) {
    return resolved.result;
  }

  try {
    const server = environment.serverStarter(resolved.options);
    if (server instanceof Promise) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'rainrail start requires the async CLI runner.\n',
      };
    }
    return {
      exitCode: 0,
      stdout: formatStartOutput(resolved.options),
      stderr: '',
      server,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

async function runStartCommandAsync(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): Promise<RainrailCliResult> {
  const resolved = resolveStartCommandOptions(args, options, environment);
  if ('result' in resolved) {
    return resolved.result;
  }

  try {
    const server = await (environment.serverStarter ?? startLocalRainrailServer)(resolved.options);
    return {
      exitCode: 0,
      stdout: formatStartOutput(resolved.options),
      stderr: '',
      server,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unable to bind Rainrail local server: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

function resolveStartCommandOptions(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): { readonly options: RainrailStartOptions } | { readonly result: RainrailCliResult } {
  const parsedStart = parseStartArguments(args);
  if (parsedStart.errors.length > 0) {
    return {
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `${parsedStart.errors.join('\n')}\n`,
      },
    };
  }

  const cwd = environment.cwd === undefined ? process.cwd() : environment.cwd;
  const fileSystem = getRainrailCliFileSystem(environment);
  let project: RainrailProject | undefined;
  try {
    project = resolveRainrailProject(cwd, options, fileSystem);
  } catch (error) {
    return {
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }
  if (project === undefined) {
    return {
      result: {
        exitCode: 1,
        stdout: '',
        stderr:
          'rainrail start requires a Rainrail project. Run it inside a directory with rainrail.config.json.\n',
      },
    };
  }

  let config: StartConfig;
  try {
    config = readStartConfig(project.configPath, fileSystem, environment.env ?? process.env);
  } catch (error) {
    return {
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }

  const resolved = resolveStartOptions(
    project,
    config,
    environment.env ?? process.env,
    parsedStart,
  );
  if (resolved.error !== undefined) {
    return {
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `${resolved.error}\n`,
      },
    };
  }

  return {
    options: resolved.options,
  };
}

function parseStartArguments(args: readonly string[]): StartArguments {
  const errors: string[] = [];
  let host: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === '--host' || arg === '--port') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`Missing value for rainrail start ${arg}.`);
        continue;
      }
      if (arg === '--host') {
        const parsedHost = parseStartHost(value, 'rainrail start --host');
        if (typeof parsedHost === 'string') host = parsedHost;
        else errors.push(parsedHost.message);
      } else {
        const parsedPort = parseStartPort(value, 'rainrail start --port');
        if (typeof parsedPort === 'number') port = parsedPort;
        else errors.push(parsedPort.message);
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--host=')) {
      const parsedHost = parseStartHost(arg.slice('--host='.length), 'rainrail start --host');
      if (typeof parsedHost === 'string') host = parsedHost;
      else errors.push(parsedHost.message);
      continue;
    }

    if (arg.startsWith('--port=')) {
      const parsedPort = parseStartPort(arg.slice('--port='.length), 'rainrail start --port');
      if (typeof parsedPort === 'number') port = parsedPort;
      else errors.push(parsedPort.message);
      continue;
    }

    errors.push(`Unknown rainrail start option: ${arg}.`);
  }

  const result: { host?: string; port?: number; errors: readonly string[] } = { errors };
  if (host !== undefined) result.host = host;
  if (port !== undefined) result.port = port;
  return result;
}

function readStartConfig(
  configPath: string,
  fileSystem: RainrailCliFileSystem,
  env: Record<string, string | undefined>,
): StartConfig {
  const raw = fileSystem.readFileSync(configPath, 'utf8');
  const value = JSON.parse(expandConfigEnv(raw, env)) as unknown;
  if (!isRecord(value)) {
    throw new Error('config must be an object');
  }

  const server = parseStartConfigServer(value.server);
  const sources = parseStartConfigSources(value);
  return server === undefined ? { sources } : { server, sources };
}

function parseStartConfigServer(value: unknown): StartConfig['server'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('config.server must be an object');
  }

  const server: { host?: string; port?: number } = {};
  if (value.host !== undefined) {
    const host = parseStartHost(value.host, 'config.server.host');
    if (typeof host !== 'string') throw new Error(host.message);
    server.host = host;
  }
  if (value.port !== undefined) {
    const port = parseStartPort(value.port, 'config.server.port');
    if (typeof port !== 'number') throw new Error(port.message);
    server.port = port;
  }
  return server;
}

function parseStartConfigSources(value: Record<string, unknown>): RainrailLocalSource[] {
  const sources: RainrailLocalSource[] = [];
  appendSourceBundleSources(sources, value.sourceBundles);
  appendConfiguredSources(sources, value.sources);
  return dedupeLocalSources(sources);
}

function appendSourceBundleSources(
  sources: RainrailLocalSource[],
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('config.sourceBundles must be an array');
  }
  for (const bundle of value) {
    if (!isRecord(bundle)) {
      throw new Error('config.sourceBundles[] must be an object');
    }
    if (!Array.isArray(bundle.sources)) {
      throw new Error('config.sourceBundles[].sources must be an array');
    }
    for (const source of bundle.sources) {
      if (!isRecord(source)) {
        throw new Error('config.sourceBundles[].sources[] must be an object');
      }
      const localSource = parseLocalSource(source);
      if (localSource !== undefined) {
        sources.push(localSource);
      }
    }
  }
}

function appendConfiguredSources(
  sources: RainrailLocalSource[],
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('config.sources must be an array');
  }
  for (const source of value) {
    if (!isRecord(source)) {
      throw new Error('config.sources[] must be an object');
    }
    const localSource = parseLocalSource(source);
    if (localSource !== undefined) {
      sources.push(localSource);
    }
  }
}

function parseLocalSource(source: Record<string, unknown>): RainrailLocalSource | undefined {
  const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : undefined;
  const sourceType = typeof source.sourceType === 'string' && source.sourceType.length > 0
    ? source.sourceType
    : typeof source.type === 'string' && source.type === 'github'
      ? 'github'
      : undefined;
  const endpoint = typeof source.endpoint === 'string' && source.endpoint.startsWith('/')
    ? parseLocalSourceEndpoint(source.endpoint)
    : source.type === 'github-webhook'
      ? '/webhooks/github'
      : undefined;
  if (name === undefined || sourceType === undefined || endpoint === undefined) {
    return undefined;
  }
  const maxBodyBytes = source.maxBodyBytes === undefined ? undefined : parseLocalSourceMaxBodyBytes(source.maxBodyBytes);

  const webhookSecret = typeof source.webhookSecret === 'string' && source.webhookSecret.length > 0
    ? source.webhookSecret
    : undefined;
  const localSource: {
    name: string;
    sourceType: string;
    endpoint: string;
    transport: 'http';
    authConfigured: boolean;
    webhookSecret?: string;
    maxBodyBytes?: number;
  } = {
    name,
    sourceType,
    endpoint,
    transport: 'http',
    authConfigured: webhookSecret !== undefined,
  };
  if (webhookSecret !== undefined) {
    localSource.webhookSecret = webhookSecret;
  }
  if (maxBodyBytes !== undefined) {
    localSource.maxBodyBytes = maxBodyBytes;
  }
  return localSource;
}

function parseLocalSourceEndpoint(endpoint: string): string {
  if (endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error('config endpoint must be a path without query or fragment');
  }
  return endpoint;
}

function parseLocalSourceMaxBodyBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('config source maxBodyBytes must be a finite non-negative number');
  }
  return value;
}

function dedupeLocalSources(sources: readonly RainrailLocalSource[]): RainrailLocalSource[] {
  const seen = new Set<string>();
  const deduped: RainrailLocalSource[] = [];
  for (const source of sources) {
    if (seen.has(source.endpoint)) {
      throw new Error(`config endpoints must be unique: ${source.endpoint}`);
    }
    seen.add(source.endpoint);
    deduped.push(source);
  }
  return deduped;
}

function resolveStartOptions(
  project: RainrailProject,
  config: StartConfig,
  env: Record<string, string | undefined>,
  args: StartArguments,
): { readonly options: RainrailStartOptions; readonly error?: undefined } | {
  readonly options?: undefined;
  readonly error: string;
} {
  const envHost = env.RAINRAIL_HOST === undefined
    ? undefined
    : parseStartHost(env.RAINRAIL_HOST, 'RAINRAIL_HOST');
  if (envHost !== undefined && typeof envHost !== 'string') {
    return { error: envHost.message };
  }

  const envPort = env.RAINRAIL_PORT === undefined
    ? undefined
    : parseStartPort(env.RAINRAIL_PORT, 'RAINRAIL_PORT');
  if (envPort !== undefined && typeof envPort !== 'number') {
    return { error: envPort.message };
  }

  const host = args.host ?? envHost ?? config.server?.host ?? '127.0.0.1';
  const dashboardToken = env.SSE_BEARER_TOKEN === undefined || env.SSE_BEARER_TOKEN.length === 0
    ? undefined
    : env.SSE_BEARER_TOKEN;
  if (!isLocalBindHost(host) && (dashboardToken === undefined || dashboardToken.length === 0)) {
    return { error: 'SSE_BEARER_TOKEN is required when rainrail start binds outside localhost' };
  }

  return {
    options: {
      host,
      port: args.port ?? envPort ?? config.server?.port ?? 8787,
      root: project.root,
      configPath: project.configPath,
      sources: config.sources,
      ...(dashboardToken === undefined ? {} : { dashboardToken }),
    },
  };
}

function isLocalBindHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function parseStartHost(value: unknown, label: string): string | { readonly message: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `${label} must be a non-empty string` };
  }
  return value;
}

function parseStartPort(value: unknown, label: string): number | { readonly message: string } {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { message: `${label} must be an integer from 1 to 65535` };
  }
  return port;
}

function formatStartOutput(options: RainrailStartOptions): string {
  const baseUrl = `http://${formatUrlHost(options.host)}:${options.port}`;
  return [
    'Rainrail local server starting',
    `Workspace: ${options.root}`,
    `Config: ${options.configPath}`,
    `Host: ${options.host}`,
    `Port: ${options.port}`,
    `Health: ${baseUrl}/healthz`,
    `Events: ${baseUrl}/events`,
    `Dashboard API: ${baseUrl}/api/v1/overview`,
    'Press Ctrl+C to stop.',
    '',
  ].join('\n');
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function runVersionCommand(args: readonly string[]): RainrailCliResult {
  if (args.length !== 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail version\n',
    };
  }

  return {
    exitCode: 0,
    stdout: `rainrail ${getRainrailCliPackageVersion()}\n`,
    stderr: '',
  };
}

function getRainrailCliPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };

  if (typeof packageJson.version !== 'string') {
    throw new Error('Rainrail CLI package.json is missing a string version.');
  }

  return packageJson.version;
}

function runInitCommand(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  if (args.length !== 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: rainrail init\n',
    };
  }

  const cwd = environment.cwd === undefined ? process.cwd() : environment.cwd;
  const fileSystem = getRainrailCliFileSystem(environment);
  const projectRoot = resolve(cwd);
  const projectName = parse(projectRoot).base;

  if (!safeProjectNamePattern.test(projectName)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Current directory name must be a safe Rainrail project name.\n',
    };
  }

  let alreadyInitialized = false;
  try {
    alreadyInitialized = isRainrailWorkspaceRoot(projectRoot, fileSystem);
    if (alreadyInitialized) {
      return {
        exitCode: 0,
        stdout: `Rainrail workspace already initialized at ${projectRoot}\n`,
        stderr: '',
      };
    }

    if (!options.yes && isDirectoryNonEmpty(projectRoot, fileSystem)) {
      const prompt = 'Current directory is not empty. Initialize Rainrail workspace here? [y/N]\n';
      const confirmation = readInitConfirmation(environment, prompt);
      const confirmed = confirmation.input.trim().toLowerCase();
      if (!(confirmed === 'y' || confirmed === 'yes')) {
        return {
          exitCode: 0,
          stdout: '',
          stderr: confirmation.promptWritten ? '' : prompt,
        };
      }
    }

    initializeRainrailWorkspace(projectRoot, projectName, fileSystem);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `Initialized Rainrail workspace at ${projectRoot}\n`,
    stderr: '',
  };
}

function isRainrailWorkspaceRoot(
  projectRoot: string,
  fileSystem: RainrailCliFileSystem,
): boolean {
  const configPath = join(projectRoot, rainrailConfigFileName);
  const lockPath = join(projectRoot, rainrailLockFileName);
  const pluginDirectory = join(projectRoot, rainrailDirectoryName, rainrailPluginDirectoryName);
  if (
    !fileSystem.existsSync(configPath) ||
    !isRegularFile(configPath, fileSystem) ||
    !fileSystem.existsSync(lockPath) ||
    !fileSystem.existsSync(pluginDirectory) ||
    lstatPath(pluginDirectory, fileSystem)?.isDirectory() !== true
  ) {
    return false;
  }

  readRainrailLockfile(lockPath, fileSystem);
  return true;
}

function isDirectoryNonEmpty(
  path: string,
  fileSystem: RainrailCliFileSystem,
): boolean {
  if (!fileSystem.existsSync(path)) {
    return false;
  }

  return fileSystem.readdirSync(path).length > 0;
}

function readInitConfirmation(
  environment: RainrailCliEnvironment,
  prompt: string,
): { input: string; promptWritten: boolean } {
  if (environment.stdin !== undefined) {
    return { input: environment.stdin, promptWritten: false };
  }

  if (environment.stderrWriter !== undefined) {
    environment.stderrWriter(prompt);
    return {
      input: environment.stdinReader === undefined
        ? readStdinLineSync()
        : environment.stdinReader(),
      promptWritten: true,
    };
  }

  if (environment.stdinReader !== undefined) {
    return { input: environment.stdinReader(), promptWritten: false };
  }

  return { input: '', promptWritten: false };
}

function readStdinLineSync(): string {
  const input: string[] = [];
  const buffer = Buffer.alloc(1);

  while (true) {
    const bytesRead = readSync(0, buffer, 0, 1, null);
    if (bytesRead === 0) {
      break;
    }

    const character = buffer.toString('utf8', 0, bytesRead);
    if (character === '\n' || character === '\r') {
      break;
    }

    input.push(character);
  }

  return input.join('');
}

function initializeRainrailWorkspace(
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
      return formatSetupPreview(plugins, args.length > 0, setupOptions);
    }

    return {
      exitCode: 0,
      stdout: formatSetupChoices(plugins, args.length > 0, setupOptions),
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
      ? runPluginCommand(plugin, ['setup'], [
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

function formatSetupChoices(
  plugins: readonly OfficialPluginMetadata[],
  includePluginArguments: boolean,
  options: Pick<SharedOptions, 'config' | 'profile'>,
): string {
  const pluginRows = plugins.map((plugin) => {
    const aliasText = plugin.aliases.length > 1 ? ` (${plugin.aliases.slice(1).join(', ')})` : '';
    return `  ${plugin.alias.padEnd(11, ' ')} ${plugin.summary}${aliasText}`;
  }).join('\n');
  const heading = includePluginArguments
    ? 'Official plugins selected for setup:'
    : 'Official plugins available for setup:';

  return [
    heading,
    pluginRows,
    '',
    includePluginArguments
      ? `Run \`${formatSetupNextAction(plugins, true, options)}\` to install and set up selected official plugins.`
      : `Run \`${formatSetupNextAction(plugins, false, options)}\` to install and set up all official plugins.`,
    includePluginArguments
      ? ''
      : 'Run `rainrail setup <plugin...> --yes` to install and set up selected official plugins.',
    '',
  ].join('\n');
}

function formatSetupPreview(
  plugins: readonly OfficialPluginMetadata[],
  includePluginArguments: boolean,
  options: SharedOptions,
): RainrailCliResult {
  return {
    exitCode: 0,
    stdout: formatJson({
      command: 'setup',
      completed: false,
      plugins: plugins.map((plugin) => plugin.alias),
      steps: [],
      nextAction: formatSetupNextAction(plugins, includePluginArguments, options),
    }),
    stderr: '',
  };
}

function formatSetupNextAction(
  plugins: readonly OfficialPluginMetadata[],
  includePluginArguments: boolean,
  options: Pick<SharedOptions, 'config' | 'profile'>,
): string {
  return [
    'rainrail',
    ...formatForwardedTargetOptions(options),
    'setup',
    ...(includePluginArguments ? plugins.map((plugin) => plugin.alias) : []),
    '--yes',
  ].map(shellQuoteArgument).join(' ');
}

function shellQuoteArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument)) {
    return argument;
  }

  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function formatForwardedSetupOptions(options: SharedOptions): readonly string[] {
  return [
    ...formatForwardedTargetOptions(options),
    ...formatForwardedExecutionOptions(options),
  ];
}

function formatForwardedTargetOptions(
  options: Pick<SharedOptions, 'config' | 'profile'>,
): readonly string[] {
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
    server: {
      host: '127.0.0.1',
      port: 8787,
    },
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

type LocalRainrailEvent = {
  readonly id: string;
  readonly type: 'event';
  readonly name: string;
  readonly status: string;
  readonly summary: string;
  readonly receivedAt: string;
  readonly source: {
    readonly type: string;
    readonly name: string;
  };
  readonly links: {
    readonly self: string;
  };
};

type LocalRainrailServerState = {
  nextEventId: number;
  events: LocalRainrailEvent[];
  sseClients: Set<ServerResponse>;
};

async function startLocalRainrailServer(options: RainrailStartOptions): Promise<RainrailStartedServer> {
  const state: LocalRainrailServerState = {
    nextEventId: 1,
    events: [],
    sseClients: new Set(),
  };
  const server = http.createServer((request, response) => {
    handleLocalRainrailRequest(request, response, options, state).catch(() => {
      if (!response.headersSent) {
        writeJsonResponse(response, 500, { error: 'internal_server_error' });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  const stop = async (): Promise<void> => {
    await closeHttpServer(server);
  };
  const onSigint = (): void => {
    stop().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', onSigint);

  return {
    async stop() {
      process.off('SIGINT', onSigint);
      await stop();
    },
  };
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function handleLocalRainrailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RainrailStartOptions,
  state: LocalRainrailServerState,
): Promise<void> {
  const url = parseLocalRequestUrl(request, options);
  if (url === undefined) {
    writeJsonResponse(response, 400, { error: 'invalid_host_header' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJsonResponse(response, 200, isLocalBindHost(options.host) ? {
      ok: true,
      runtime: 'node',
      workspace: options.root,
    } : { ok: true, runtime: 'node' });
    return;
  }

  if (requiresLocalServerAuth(url.pathname, options) && !isAuthorizedLocalRequest(request, options)) {
    writeJsonResponse(response, 401, { error: 'events_auth_invalid' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    state.sseClients.add(response);
    response.once('close', () => {
      state.sseClients.delete(response);
    });
    response.write(': rainrail local server connected\n\n');
    return;
  }

  const intakeSource = options.sources.find((source) => source.endpoint === url.pathname);
  if (request.method === 'POST' && intakeSource !== undefined) {
    let body: Buffer;
    try {
      body = await readRequestBodyForLocalServer(request, intakeSource.maxBodyBytes ?? 1024 * 1024);
    } catch (error) {
      if (error instanceof LocalRequestBodyTooLargeError) {
        writeJsonResponse(response, 413, { error: 'request_body_too_large' });
        return;
      }
      throw error;
    }
    if (!isAuthorizedLocalIntakeRequest(request, options, intakeSource, body)) {
      writeJsonResponse(response, 401, { error: 'intake_auth_invalid' });
      return;
    }
    const id = `local-event-${String(state.nextEventId).padStart(6, '0')}`;
    state.nextEventId += 1;
    const event: LocalRainrailEvent = {
      id,
      type: 'event',
      name: `${intakeSource.sourceType}.event`,
      status: 'received',
      summary: `${intakeSource.name} event received`,
      receivedAt: new Date().toISOString(),
      source: {
        type: intakeSource.sourceType,
        name: intakeSource.name,
      },
      links: {
        self: `/api/v1/events/${encodeURIComponent(id)}`,
      },
    };
    state.events.push(event);
    broadcastLocalEvent(state, event);
    writeJsonResponse(response, 202, { data: event });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    writeJsonResponse(response, 200, {
      counts: { events: state.events.length, activityEvents: 0 },
      events: state.events,
      workspace: options.root,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/overview') {
    writeJsonResponse(response, 200, {
      data: {
        runtime: 'node',
        workspace: options.root,
        counts: { events: state.events.length, activityEvents: 0, agentTasks: 0, eventHandlerRetries: 0 },
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
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    writeJsonResponse(response, 200, paginatedCollectionResponse(state.events, url));
    return;
  }

  const eventDetailMatch = /^\/api\/v1\/events\/([^/]+)$/u.exec(url.pathname);
  if (request.method === 'GET' && eventDetailMatch !== null) {
    const eventId = safeDecodeURIComponent(eventDetailMatch[1] ?? '');
    const event = eventId === undefined ? undefined : state.events.find((item) => item.id === eventId);
    if (event === undefined) {
      writeJsonResponse(response, 404, { error: 'event_not_found' });
      return;
    }
    writeJsonResponse(response, 200, {
      data: {
        id: event.id,
        type: 'event',
        record: event,
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/workflow-runs') {
    writeJsonResponse(response, 200, collectionResponse([]));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/agent-tasks') {
    writeJsonResponse(response, 200, collectionResponse([]));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/sources') {
    writeJsonResponse(response, 200, collectionResponse(options.sources.map((source) => ({
      id: source.name,
      type: 'source',
      status: 'configured',
      sourceType: source.sourceType,
      name: source.name,
      endpoint: source.endpoint,
      transport: source.transport,
      auth: { status: source.authConfigured ? 'configured' : 'not configured' },
      links: { self: `/api/v1/sources/${encodeURIComponent(source.name)}` },
    }))));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/queue') {
    writeJsonResponse(response, 200, {
      ...collectionResponse([]),
      summary: {
        upcomingIssues: 0,
        blockedReasons: [],
        inProgressCount: 0,
        claimedCount: 0,
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/settings') {
    writeJsonResponse(response, 200, collectionResponse([
      { id: 'dashboard-auth', type: 'setting', status: 'read-only', label: 'Dashboard auth', value: options.dashboardToken === undefined ? 'not configured' : 'bearer token configured' },
      { id: 'runtime', type: 'setting', status: 'read-only', label: 'Runtime', value: 'node' },
    ]));
    return;
  }

  writeJsonResponse(response, 404, { error: 'not_found' });
}

function parseLocalRequestUrl(request: IncomingMessage, options: RainrailStartOptions): URL | undefined {
  const host = request.headers.host ?? `${options.host}:${options.port}`;
  if (!isSafeHostHeader(host, options)) {
    return undefined;
  }
  try {
    return new URL(request.url ?? '/', `http://${host}`);
  } catch {
    return undefined;
  }
}

function isSafeHostHeader(host: string, options?: RainrailStartOptions): boolean {
  const hostName = hostHeaderName(host);
  if (hostName === undefined) {
    return false;
  }
  if (options === undefined) {
    return true;
  }
  const allowed = new Set([
    normalizeHostName(options.host),
    'localhost',
    '127.0.0.1',
    '::1',
  ]);
  return allowed.has(hostName);
}

function hostHeaderName(host: string): string | undefined {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::[0-9]{1,5})?$/u.exec(host);
  if (bracketed?.[1] !== undefined) {
    return bracketed[1].toLowerCase();
  }
  const named = /^([A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/u.exec(host);
  return named?.[1]?.toLowerCase();
}

function normalizeHostName(host: string): string {
  return host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase();
}

function requiresLocalServerAuth(pathname: string, options: RainrailStartOptions): boolean {
  return options.dashboardToken !== undefined &&
    (pathname === '/events' || pathname.startsWith('/api/'));
}

function isAuthorizedLocalRequest(request: IncomingMessage, options: RainrailStartOptions): boolean {
  return options.dashboardToken !== undefined &&
    request.headers.authorization === `Bearer ${options.dashboardToken}`;
}

function isAuthorizedLocalIntakeRequest(
  request: IncomingMessage,
  options: RainrailStartOptions,
  source: RainrailLocalSource,
  body: Buffer,
): boolean {
  if (isLocalBindHost(options.host)) {
    return true;
  }
  if (source.webhookSecret === undefined) {
    return false;
  }
  const signature = request.headers['x-hub-signature-256'];
  if (typeof signature !== 'string') {
    return false;
  }
  const expected = createHmac('sha256', source.webhookSecret).update(body).digest('hex');
  return timingSafeStringEqual(signature, `sha256=${expected}`);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

class LocalRequestBodyTooLargeError extends Error {}

async function readRequestBodyForLocalServer(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const _chunk of request) {
    const chunk = typeof _chunk === 'string' ? Buffer.from(_chunk) : _chunk as Buffer;
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw new LocalRequestBodyTooLargeError('request body too large');
    }
    chunks.push(chunk);
    // Drain the request so clients can reuse the connection.
  }
  return Buffer.concat(chunks);
}

function broadcastLocalEvent(state: LocalRainrailServerState, event: LocalRainrailEvent): void {
  const payload = `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of state.sseClients) {
    client.write(payload);
  }
}

function collectionResponse(data: readonly unknown[]): {
  readonly data: readonly unknown[];
  readonly page: {
    readonly limit: 50;
    readonly nextCursor: null;
  };
} {
  return {
    data,
    page: { limit: 50, nextCursor: null },
  };
}

function paginatedCollectionResponse(data: readonly unknown[], url: URL): {
  readonly data: readonly unknown[];
  readonly page: {
    readonly limit: number;
    readonly nextCursor: string | null;
  };
} {
  const limit = parsePositiveInteger(url.searchParams.get('limit')) ?? 50;
  const cursor = parseNonNegativeInteger(url.searchParams.get('cursor')) ?? 0;
  const pageData = data.slice(cursor, cursor + limit);
  const nextOffset = cursor + pageData.length;
  return {
    data: pageData,
    page: {
      limit,
      nextCursor: nextOffset < data.length ? String(nextOffset) : null,
    },
  };
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function expandConfigEnv(raw: string, env: Record<string, string | undefined>): string {
  return raw.replace(
    /\$\{([A-Z0-9_]+)\}/gu,
    (_match, name: string) => JSON.stringify(env[name] ?? '').slice(1, -1),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
