import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
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
import { basename, dirname, extname, join, normalize, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  | 'dispatch'
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

export type RainrailDispatchMode = 'message' | 'envelope-json';

export type RainrailDispatchManualMessagePayload = {
  readonly provider: 'rainrail';
  readonly channel: 'manual';
  readonly action: 'message';
  readonly conversation: {
    readonly id: string;
  };
  readonly message: {
    readonly text: string;
  };
  readonly actor: {
    readonly id: string;
    readonly displayName: string;
    readonly type: 'cli';
  };
};

export type RainrailDispatchEventEnvelope = {
  readonly id: string;
  readonly schemaVersion: 'rainrail.event.v1';
  readonly source: {
    readonly type: 'manual';
    readonly name: 'cli';
  };
  readonly name: 'rainrail.manual.message';
  readonly delivery: {
    readonly id: string;
    readonly receivedAt: string;
  };
  readonly occurredAt: string;
  readonly subject: {
    readonly type: 'conversation';
    readonly id: string;
  };
  readonly payload: RainrailDispatchManualMessagePayload;
  readonly rawPayload: {
    readonly kind: 'inline-redacted';
    readonly reference: string;
    readonly contentType: 'text/plain';
    readonly sha256: string;
  };
};

export type RainrailDispatchRequest =
  | {
      readonly mode: 'message';
      readonly input: string;
      readonly event: RainrailDispatchEventEnvelope;
      readonly options: {
        readonly config?: string | undefined;
        readonly profile?: string | undefined;
        readonly json: boolean;
      };
    }
  | {
      readonly mode: 'envelope-json';
      readonly input: string;
      readonly options: {
        readonly config?: string | undefined;
        readonly profile?: string | undefined;
        readonly json: boolean;
      };
    };

export type RainrailDispatchRunnerResult = RainrailCliResult;

export type RainrailDispatchRunner = {
  (request: RainrailDispatchRequest): RainrailDispatchRunnerResult;
};

export type RainrailAsyncDispatchRunner = {
  (request: RainrailDispatchRequest): Promise<RainrailCliResult>;
  readonly preflight?: () => RainrailCliResult | undefined;
};

export type RainrailStandaloneDispatchFetchResult = {
  readonly status: number;
  readonly body: string;
};

export type RainrailStandaloneDispatchFetcher = (
  url: string,
  options: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<RainrailStandaloneDispatchFetchResult>;

export type RainrailStandaloneDispatchRunnerOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly fetcher?: RainrailStandaloneDispatchFetcher;
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
  readonly allowedHosts: readonly string[];
  readonly dashboardToken?: string;
  readonly dashboardAssetRoot?: string;
  readonly dashboardAuth: RainrailDashboardAuth;
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
  readonly configuredType?: string;
  readonly endpoint: string;
  readonly transport: 'http';
  readonly authConfigured: boolean;
  readonly webhookSecret?: string;
  readonly maxBodyBytes?: number;
};

export type RainrailDashboardAuth = {
  readonly readOnlyToken?: string;
  readonly operatorToken?: string;
  readonly adminToken?: string;
};

export type RainrailCliEnvironment = {
  readonly cacheDirectory?: string;
  readonly cwd?: string;
  readonly commandRunner?: CommandRunner;
  readonly currentVersion?: string;
  readonly dispatchRunner?: RainrailDispatchRunner;
  readonly asyncDispatchRunner?: RainrailAsyncDispatchRunner;
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
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const bundledDashboardAssetRoot = join(moduleDirectory, 'dashboard');
const workspaceDashboardAssetRoot = resolve(moduleDirectory, '..', '..', '..', 'apps', 'www', 'dist');

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
    summary: 'Start the local Rainrail harness server in the foreground.',
    implemented: true,
  },
  {
    name: 'dispatch',
    kind: 'built-in',
    summary: 'Dispatch an event into a Rainrail workflow.',
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

    if (commandName === 'dispatch' && isDispatchInputModeOption(arg, commandArgs)) {
      commandArgs.push(arg);
      const value = argv[index + 1];
      if (value !== undefined) {
        commandArgs.push(value);
        index += 1;
      }
      continue;
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

function isDispatchInputModeOption(arg: string, commandArgs: readonly string[]): boolean {
  if (arg === '--message' || arg === '--envelope-json') {
    return true;
  }
  if (arg !== '--json') {
    return false;
  }
  return !hasDispatchInputMode(commandArgs);
}

function hasDispatchInputMode(commandArgs: readonly string[]): boolean {
  return commandArgs.some((arg, index) => {
    if (
      arg === '--message'
      || arg === '--envelope-json'
      || arg === '--stdin'
      || arg.startsWith('--message=')
      || arg.startsWith('--json=')
      || arg.startsWith('--envelope-json=')
    ) {
      return true;
    }
    if (arg === '--json') {
      return true;
    }
    return index === 0 && !arg.startsWith('--');
  });
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

  if (parsed.commandName === 'dispatch' && isDispatchHelpRequestForNotice(parsed.commandArgs)) {
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

function isDispatchHelpRequestForNotice(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === 'help' || args[0] === '--help');
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

  if (command.name === 'dispatch') {
    return runDispatchCommand(parsed.commandArgs, parsed.options, environment);
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
  if (command?.name !== 'start' && command?.name !== 'dispatch') {
    return runRainrailCli(argv, environment);
  }

  if (command === undefined) {
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

  if (command.name === 'dispatch') {
    return runDispatchCommandAsync(parsed.commandArgs, parsed.options, environment);
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
    readonly allowedHosts?: readonly string[];
  };
  readonly dashboardAuth: RainrailDashboardAuth;
  readonly sources: readonly RainrailLocalSource[];
};

const localDefaultMaxRequestBodyBytes = 25 * 1024 * 1024;
const localGitHubWebhookSourceNameMaxLength = 53;
const localEventHistoryLimit = 50;
const localEmptyCollectionRows: readonly { readonly id: string }[] = [];

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
  if (isAsyncFunction(environment.serverStarter)) {
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
      void server.then((started) => {
        started.stop();
      }, () => undefined);
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

function isAsyncFunction(value: unknown): boolean {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
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
  const expanded = expandConfigEnv(raw, env);
  const value = JSON.parse(expanded) as unknown;
  const markerValue = JSON.parse(markWebhookSecretEnvExpansions(raw, env)) as unknown;
  if (!isRecord(value)) {
    throw new Error('config must be an object');
  }
  if (!isRecord(markerValue)) {
    throw new Error('config must be an object');
  }

  const server = parseStartConfigServer(value.server);
  const dashboardAuth = parseStartDashboardAuth(value.dashboardAuth);
  const sources = parseStartConfigSources(value, markerValue, env);
  return server === undefined ? { dashboardAuth, sources } : { server, dashboardAuth, sources };
}

function parseStartDashboardAuth(value: unknown): RainrailDashboardAuth {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('config.dashboardAuth must be an object');
  }
  const auth: { readOnlyToken?: string; operatorToken?: string; adminToken?: string } = {};
  const readOnlyToken = parseOptionalLocalToken(value.readOnlyToken, 'config.dashboardAuth.readOnlyToken');
  const operatorToken = parseOptionalLocalToken(value.operatorToken, 'config.dashboardAuth.operatorToken');
  const adminToken = parseOptionalLocalToken(value.adminToken, 'config.dashboardAuth.adminToken');
  if (readOnlyToken !== undefined) auth.readOnlyToken = readOnlyToken;
  if (operatorToken !== undefined) auth.operatorToken = operatorToken;
  if (adminToken !== undefined) auth.adminToken = adminToken;
  assertUniqueLocalDashboardAuthTokens(auth);
  return auth;
}

function parseOptionalLocalToken(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseLocalNonEmptyString(value, path);
}

function assertUniqueLocalDashboardAuthTokens(auth: RainrailDashboardAuth): void {
  const seen = new Map<string, string>();
  for (const [key, token] of Object.entries(auth)) {
    if (token === undefined || token.length === 0) continue;
    const previous = seen.get(token);
    if (previous !== undefined) {
      throw new Error(`config.dashboardAuth.${key} must not duplicate config.dashboardAuth.${previous}`);
    }
    seen.set(token, key);
  }
}

function parseStartConfigServer(value: unknown): StartConfig['server'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('config.server must be an object');
  }

  const server: { host?: string; port?: number; allowedHosts?: readonly string[] } = {};
  if (value.host !== undefined) {
    const host = parseStartHost(value.host, 'config.server.host');
    if (typeof host !== 'string') throw new Error(host.message);
    server.host = host;
  }
  if (value.port !== undefined) {
    const port = parseStartConfigPort(value.port, 'config.server.port');
    if (typeof port !== 'number') throw new Error(port.message);
    server.port = port;
  }
  if (value.allowedHosts !== undefined) {
    server.allowedHosts = parseStartAllowedHosts(value.allowedHosts, 'config.server.allowedHosts');
  }
  return server;
}

function parseStartConfigSources(
  value: Record<string, unknown>,
  rawValue: Record<string, unknown>,
  env: Record<string, string | undefined>,
): RainrailLocalSource[] {
  const sources: RainrailLocalSource[] = [];
  appendSourceBundleSources(sources, value.sourceBundles, rawValue.sourceBundles, env);
  appendConfiguredSources(sources, value.sources, rawValue.sources, env);
  return dedupeLocalSources(sources);
}

function appendSourceBundleSources(
  sources: RainrailLocalSource[],
  value: unknown,
  rawValue: unknown,
  env: Record<string, string | undefined>,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('config.sourceBundles must be an array');
  }
  if (!Array.isArray(rawValue)) {
    throw new Error('config.sourceBundles must be an array');
  }
  for (const [index, bundle] of value.entries()) {
    const rawBundle = rawValue[index];
    if (!isRecord(bundle)) {
      throw new Error('config.sourceBundles[] must be an object');
    }
    if (!isRecord(rawBundle)) {
      throw new Error('config.sourceBundles[] must be an object');
    }
    validateLocalSourceBundleContract(bundle, `config.sourceBundles[${index}]`);
    if (!Array.isArray(bundle.sources)) {
      throw new Error('config.sourceBundles[].sources must be an array');
    }
    if (!Array.isArray(rawBundle.sources)) {
      throw new Error('config.sourceBundles[].sources must be an array');
    }
    for (const [sourceIndex, source] of bundle.sources.entries()) {
      const rawSource = rawBundle.sources[sourceIndex];
      if (!isRecord(source)) {
        throw new Error('config.sourceBundles[].sources[] must be an object');
      }
      if (!isRecord(rawSource)) {
        throw new Error('config.sourceBundles[].sources[] must be an object');
      }
      validateLocalSourceBundleSourceContract(source, `config.sourceBundles[${index}].sources[${sourceIndex}]`);
      const localSource = parseLocalSource(source, rawSource, env, `config.sourceBundles[${index}].sources[${sourceIndex}]`, {
        topLevel: false,
      });
      if (localSource !== undefined) {
        sources.push(localSource);
      }
    }
  }
}

function appendConfiguredSources(
  sources: RainrailLocalSource[],
  value: unknown,
  rawValue: unknown,
  env: Record<string, string | undefined>,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('config.sources must be an array');
  }
  if (!Array.isArray(rawValue)) {
    throw new Error('config.sources must be an array');
  }
  for (const [index, source] of value.entries()) {
    const rawSource = rawValue[index];
    if (!isRecord(source)) {
      throw new Error('config.sources[] must be an object');
    }
    if (!isRecord(rawSource)) {
      throw new Error('config.sources[] must be an object');
    }
    const localSource = parseLocalSource(source, rawSource, env, `config.sources[${index}]`, {
      topLevel: true,
    });
    if (localSource !== undefined) {
      sources.push(localSource);
    }
  }
}

function parseLocalSource(
  source: Record<string, unknown>,
  rawSource: Record<string, unknown>,
  env: Record<string, string | undefined>,
  path: string,
  options: { readonly topLevel: boolean },
): RainrailLocalSource | undefined {
  const type = parseLocalNonEmptyString(source.type, `${path}.type`);
  const name = parseLocalNonEmptyString(source.name, `${path}.name`);
  const sourceType = typeof source.sourceType === 'string' && source.sourceType.length > 0
    ? source.sourceType
    : options.topLevel
      ? type
      : type === 'github'
        ? 'github'
      : undefined;
  const endpoint = source.endpoint === undefined
    ? source.type === 'github-webhook' || source.type === 'github'
    ? '/webhooks/github'
      : undefined
    : parseLocalSourceEndpoint(source.endpoint);
  if (sourceType === undefined) {
    throw new Error(`${path}.sourceType must be a non-empty string`);
  }
  if (endpoint === undefined) {
    if (!options.topLevel) {
      return undefined;
    }
    throw new Error(`${path}.endpoint must be a string`);
  }
  validateLocalSourceContract(source, sourceType);
  const maxBodyBytes = source.maxBodyBytes === undefined ? undefined : parseLocalSourceMaxBodyBytes(source.maxBodyBytes);

  const webhookSecret = typeof source.webhookSecret === 'string' && source.webhookSecret.length > 0
    ? resolveLocalWebhookSecret(source.webhookSecret, rawSource.webhookSecret, env)
    : undefined;
  if ((source.type === 'github-webhook' || source.type === 'github') && webhookSecret === undefined) {
    throw new Error(`${path}.webhookSecret must resolve to a non-empty string for GitHub webhook sources`);
  }
  const localSource: {
    name: string;
    sourceType: string;
    configuredType?: string;
    endpoint: string;
    transport: 'http';
    authConfigured: boolean;
    webhookSecret?: string;
    maxBodyBytes?: number;
  } = {
    name,
    sourceType,
    ...(typeof source.type === 'string' ? { configuredType: source.type } : {}),
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

function validateLocalSourceBundleContract(bundle: Record<string, unknown>, path: string): void {
  const type = parseLocalNonEmptyString(bundle.type, `${path}.type`);
  if (type !== 'eep-bridge') {
    throw new Error(`${path}.type must be one of: eep-bridge`);
  }
  parseLocalNonEmptyString(bundle.name, `${path}.name`);
}

function validateLocalSourceBundleSourceContract(source: Record<string, unknown>, path: string): void {
  const type = parseLocalConfiguredSourceType(source.type, `${path}.type`);
  const name = parseLocalNonEmptyString(source.name, `${path}.name`);
  const sourceType = parseLocalSourceEventType(source.sourceType, `${path}.sourceType`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(name)) {
    throw new Error(`${path}.name must be a safe identifier`);
  }
  if (type === 'github-webhook' && name.length > localGitHubWebhookSourceNameMaxLength) {
    throw new Error(`${path}.name must be ${localGitHubWebhookSourceNameMaxLength} characters or fewer for github-webhook sources`);
  }
  if (type === 'github-webhook' && source.provider !== 'github') {
    throw new Error(`${path}.provider must be "github" for github-webhook sources`);
  }
  if (type === 'github-webhook' && sourceType !== 'github') {
    throw new Error(`${path}.sourceType must be "github" for github-webhook sources`);
  }
  if (type === 'github-webhook' && (typeof source.webhookSecret !== 'string' || source.webhookSecret.length === 0)) {
    throw new Error(`${path}.webhookSecret must be a non-empty string for github-webhook sources`);
  }
  if (type === 'cloudflare-tail' && sourceType !== 'cloudflare') {
    throw new Error(`${path}.sourceType must be "cloudflare" for cloudflare-tail sources`);
  }
  if (type === 'manual-chat' && sourceType !== 'manual' && sourceType !== 'chat') {
    throw new Error(`${path}.sourceType must be "manual" or "chat" for manual-chat sources`);
  }
}

function parseLocalConfiguredSourceType(value: unknown, path: string): string {
  const type = parseLocalNonEmptyString(value, path);
  if (type !== 'github-webhook' && type !== 'cloudflare-tail' && type !== 'manual-chat') {
    throw new Error(`${path} must be one of: github-webhook, cloudflare-tail, manual-chat`);
  }
  return type;
}

function parseLocalSourceEventType(value: unknown, path: string): string {
  const type = parseLocalNonEmptyString(value, path);
  if (type !== 'github' && type !== 'cloudflare' && type !== 'manual' && type !== 'chat' && type !== 'system') {
    throw new Error(`${path} must be one of: github, cloudflare, manual, chat, system`);
  }
  return type;
}

function parseLocalNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function validateLocalSourceContract(source: Record<string, unknown>, sourceType: string): void {
  if (source.type === 'github-webhook') {
    if (source.provider !== 'github') {
      throw new Error('config provider must be "github" for github-webhook sources');
    }
    if (sourceType !== 'github') {
      throw new Error('config sourceType must be "github" for github-webhook sources');
    }
    if (typeof source.webhookSecret !== 'string' || source.webhookSecret.length === 0) {
      throw new Error('config source webhookSecret must be a non-empty string for github-webhook sources');
    }
  }
  if (source.type === 'cloudflare-tail' && sourceType !== 'cloudflare') {
    throw new Error('config sourceType must be "cloudflare" for cloudflare-tail sources');
  }
  if (source.type === 'manual-chat' && sourceType !== 'manual' && sourceType !== 'chat') {
    throw new Error('config sourceType must be "manual" or "chat" for manual-chat sources');
  }
}

function parseLocalSourceEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string') {
    throw new Error('config endpoint must be a string');
  }
  if (!endpoint.startsWith('/')) {
    throw new Error('config endpoint must start with "/"');
  }
  if (endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error('config endpoint must be a path without query or fragment');
  }
  if (isLocalCoreRoutePath(endpoint)) {
    throw new Error('config endpoint must not use a Rainrail core route');
  }
  return endpoint;
}

function resolveLocalWebhookSecret(
  value: string,
  rawValue: unknown,
  env: Record<string, string | undefined>,
): string | undefined {
  if (wasWebhookSecretFieldExpanded(rawValue, value, env)) {
    return value;
  }
  const envValue = env[value];
  if (envValue !== undefined) {
    return envValue.length === 0 ? undefined : envValue;
  }
  return /^[A-Z_][A-Z0-9_]*$/u.test(value) ? undefined : value;
}

function wasWebhookSecretFieldExpanded(
  rawValue: unknown,
  value: string,
  env: Record<string, string | undefined>,
): boolean {
  const marker = parseWebhookSecretEnvMarker(rawValue);
  return marker !== undefined && (env[marker] ?? '') === value;
}

function parseWebhookSecretEnvMarker(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const marker = value.__rainrailWebhookSecretEnv;
  return typeof marker === 'string' ? marker : undefined;
}

function isLocalCoreRoutePath(pathname: string): boolean {
  return localCoreRoutePaths.has(pathname) ||
    localCoreRoutePrefixes.some((prefix) => pathname.startsWith(prefix));
}

function parseStartAllowedHosts(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((host, index) => {
    if (typeof host !== 'string' || host.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    const hostName = hostHeaderName(host);
    if (hostName === undefined) {
      throw new Error(`${label}[${index}] must be a hostname or IP address`);
    }
    return hostName;
  });
}

function parseLocalSourceMaxBodyBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('config source maxBodyBytes must be a finite non-negative number');
  }
  return value;
}

function dedupeLocalSources(sources: readonly RainrailLocalSource[]): RainrailLocalSource[] {
  const endpoints = new Set<string>();
  const names = new Set<string>();
  const deduped: RainrailLocalSource[] = [];
  for (const source of sources) {
    if (endpoints.has(source.endpoint)) {
      throw new Error(`config endpoints must be unique: ${source.endpoint}`);
    }
    if (names.has(source.name)) {
      throw new Error(`config source names must be unique: ${source.name}`);
    }
    endpoints.add(source.endpoint);
    names.add(source.name);
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

  let envAllowedHosts: readonly string[] | undefined;
  try {
    envAllowedHosts = env.RAINRAIL_ALLOWED_HOSTS === undefined || env.RAINRAIL_ALLOWED_HOSTS.length === 0
      ? undefined
      : parseStartAllowedHosts(
        env.RAINRAIL_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter((host) => host.length > 0),
        'RAINRAIL_ALLOWED_HOSTS',
      );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const host = args.host ?? envHost ?? config.server?.host ?? '127.0.0.1';
  const dashboardToken = env.SSE_BEARER_TOKEN === undefined || env.SSE_BEARER_TOKEN.length === 0
    ? undefined
    : env.SSE_BEARER_TOKEN;
  const dashboardAuth = mergeDashboardAuth(config.dashboardAuth, dashboardToken);
  if (!isLocalBindHost(host) && !hasAnyDashboardAuthToken(dashboardAuth) && dashboardToken === undefined) {
    return { error: 'dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, dashboardAuth.adminToken, or SSE_BEARER_TOKEN is required when rainrail start binds outside localhost' };
  }
  const dashboardAssetRoot = resolveDashboardAssetRoot(env);

  return {
    options: {
      host,
      port: args.port ?? envPort ?? config.server?.port ?? 8787,
      root: project.root,
      configPath: project.configPath,
      allowedHosts: envAllowedHosts ?? config.server?.allowedHosts ?? [],
      ...(dashboardAssetRoot === undefined ? {} : { dashboardAssetRoot }),
      sources: config.sources,
      dashboardAuth,
      ...(dashboardToken === undefined ? {} : { dashboardToken }),
    },
  };
}

function mergeDashboardAuth(configAuth: RainrailDashboardAuth, eventsBearerToken: string | undefined): RainrailDashboardAuth {
  return {
    ...configAuth,
    ...(configAuth.readOnlyToken === undefined && eventsBearerToken !== undefined ? { readOnlyToken: eventsBearerToken } : {}),
  };
}

function hasAnyDashboardAuthToken(auth: RainrailDashboardAuth): boolean {
  return [auth.readOnlyToken, auth.operatorToken, auth.adminToken].some((token) => token !== undefined && token.length > 0);
}

function isLocalBindHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function parseStartHost(value: unknown, label: string): string | { readonly message: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `${label} must be a non-empty string` };
  }
  return value === '[::1]' ? '::1' : value;
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

function parseStartConfigPort(value: unknown, label: string): number | { readonly message: string } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    return { message: `${label} must be an integer from 1 to 65535` };
  }
  return value;
}

function formatStartOutput(options: RainrailStartOptions): string {
  const baseUrl = `http://${formatUrlHost(options.host)}:${options.port}`;
  const localIntakeRows = options.sources.map((source) =>
    `  ${source.name} (${source.sourceType}): ${baseUrl}${source.endpoint}`
  );
  const dashboardAuthRows = formatDashboardAuthRows(options.dashboardAuth, options.configPath);
  return [
    'Rainrail local harness server starting',
    `Workspace: ${options.root}`,
    `Config: ${options.configPath}`,
    `Host: ${options.host}`,
    `Port: ${options.port}`,
    `Health: ${baseUrl}/healthz`,
    `Dashboard: ${baseUrl}/dashboard`,
    `Dashboard API: ${baseUrl}/api/v1/overview`,
    ...dashboardAuthRows,
    `Event Stream: ${baseUrl}/events`,
    ...(localIntakeRows.length === 0 ? [] : [
      'Local intake:',
      ...localIntakeRows,
    ]),
    'Press Ctrl+C to stop.',
    '',
  ].join('\n');
}

function formatDashboardAuthRows(auth: RainrailDashboardAuth, configPath: string): readonly string[] {
  const scopes = [
    auth.readOnlyToken === undefined ? undefined : 'read-only',
    auth.operatorToken === undefined ? undefined : 'operator',
    auth.adminToken === undefined ? undefined : 'admin',
  ].filter((scope) => scope !== undefined);

  if (scopes.length > 0) {
    return [`Dashboard Auth: configured scopes: ${scopes.join(', ')}`];
  }

  return [
    'Dashboard Auth: not configured',
    `Run \`${formatDashboardAuthOnlySetupCommand({ config: configPath })}\` to generate local dashboardAuth tokens.`,
    `Or set dashboardAuth.readOnlyToken, dashboardAuth.operatorToken, or dashboardAuth.adminToken in ${configPath}.`,
  ];
}

function formatDashboardAuthOnlySetupCommand(
  options: Pick<SharedOptions, 'config' | 'profile'>,
  rotate = false,
): string {
  return [
    'rainrail',
    ...formatForwardedTargetOptions(options),
    'setup',
    '--dashboard-auth-only',
    ...(rotate ? ['--rotate'] : []),
    '--yes',
  ].map(shellQuoteArgument).join(' ');
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

type ParsedDispatchArguments = {
  readonly request?: RainrailDispatchRequest | undefined;
  readonly errors: readonly string[];
  readonly help: boolean;
};

type DispatchEnvelopeInputSource =
  | { readonly kind: 'inline'; readonly input: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' };

const dispatchUsage = 'Usage: rainrail dispatch <message> | --stdin | --message <text> | --json <file> | --json --stdin | --envelope-json <json>';
const dispatchCliConversationId = 'cli-manual';
const dispatchCliSourceName = 'cli';
const maxDispatchManualMessageTextLength = 8_000;
const maxDispatchStdinMessageBytes = 65_536;
let dispatchDeliverySequence = 0;

function runDispatchCommand(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailCliResult {
  if (args.length === 1 && (args[0] === 'help' || args[0] === '--help')) {
    return {
      exitCode: 0,
      stdout: formatDispatchHelp(),
      stderr: '',
    };
  }

  if (environment.asyncDispatchRunner !== undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'rainrail dispatch requires the async CLI runner for asynchronous dispatch runners.\n',
    };
  }

  const parsed = parseDispatchArguments(args, options, environment);
  if (parsed.help) {
    return {
      exitCode: 0,
      stdout: formatDispatchHelp(),
      stderr: '',
    };
  }

  if (parsed.errors.length > 0 || parsed.request === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.length > 0 ? parsed.errors.join('\n') : dispatchUsage}\n`,
    };
  }

  return runDispatchRequest(parsed.request, environment.dispatchRunner);
}

async function runDispatchCommandAsync(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): Promise<RainrailCliResult> {
  if (args.length === 1 && (args[0] === 'help' || args[0] === '--help')) {
    return {
      exitCode: 0,
      stdout: formatDispatchHelp(),
      stderr: '',
    };
  }

  const preflightError = environment.asyncDispatchRunner?.preflight?.();
  if (preflightError !== undefined) {
    return preflightError;
  }

  const parsed = parseDispatchArguments(args, options, environment);
  if (parsed.help) {
    return {
      exitCode: 0,
      stdout: formatDispatchHelp(),
      stderr: '',
    };
  }

  if (parsed.errors.length > 0 || parsed.request === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${parsed.errors.length > 0 ? parsed.errors.join('\n') : dispatchUsage}\n`,
    };
  }

  return runDispatchRequestAsync(
    parsed.request,
    environment.asyncDispatchRunner ?? environment.dispatchRunner,
  );
}

function runDispatchRequest(
  request: RainrailDispatchRequest,
  dispatchRunner: RainrailDispatchRunner | undefined,
): RainrailCliResult {
  if (dispatchRunner === undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'rainrail dispatch requires a dispatch runner, which is not implemented yet.\n',
    };
  }

  const result = dispatchRunner(request);
  return result;
}

async function runDispatchRequestAsync(
  request: RainrailDispatchRequest,
  dispatchRunner: RainrailDispatchRunner | RainrailAsyncDispatchRunner | undefined,
): Promise<RainrailCliResult> {
  if (dispatchRunner === undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'rainrail dispatch requires a dispatch runner, which is not implemented yet.\n',
    };
  }

  return dispatchRunner(request);
}

export function createStandaloneRainrailDispatchRunner(
  options: RainrailStandaloneDispatchRunnerOptions = {},
): RainrailAsyncDispatchRunner {
  const preflight = (): RainrailCliResult | undefined => {
    const env = options.env ?? process.env;
    const publishUrl = env.RAINRAIL_PUBLISH_URL;
    const publishToken = env.RAINRAIL_PUBLISH_TOKEN;
    if (publishUrl === undefined || publishUrl.trim().length === 0 ||
      publishToken === undefined || publishToken.trim().length === 0) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'rainrail dispatch requires RAINRAIL_PUBLISH_URL and RAINRAIL_PUBLISH_TOKEN for standalone event delivery.\n',
      };
    }
    return undefined;
  };

  return Object.assign(async (request: RainrailDispatchRequest) => {
    const env = options.env ?? process.env;
    const configError = preflight();
    if (configError !== undefined) {
      return configError;
    }
    const publishUrl = env.RAINRAIL_PUBLISH_URL as string;
    const publishToken = env.RAINRAIL_PUBLISH_TOKEN as string;

    const body = request.mode === 'message' ? JSON.stringify(request.event) : request.input;
    const fetcher = options.fetcher ?? defaultStandaloneDispatchFetcher;
    let response: RainrailStandaloneDispatchFetchResult;
    try {
      response = await fetcher(publishUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `rainrail dispatch publish failed: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `rainrail dispatch publish failed with status ${response.status}.\n`,
      };
    }

    const summary = summarizeStandaloneDispatchResponse(response);
    if (request.options.json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          published: true,
          status: response.status,
          ...(summary.eventId === undefined ? {} : { eventId: summary.eventId }),
          ...(summary.eventName === undefined ? {} : { eventName: summary.eventName }),
        })}\n`,
        stderr: '',
      };
    }

    const eventDescription = summary.eventName === undefined || summary.eventId === undefined
      ? 'event'
      : `${summary.eventName} event ${summary.eventId}`;
    return {
      exitCode: 0,
      stdout: `Published ${eventDescription}.\n`,
      stderr: '',
    };
  }, { preflight });
}

async function defaultStandaloneDispatchFetcher(
  url: string,
  options: Parameters<RainrailStandaloneDispatchFetcher>[1],
): Promise<RainrailStandaloneDispatchFetchResult> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function summarizeStandaloneDispatchResponse(
  response: RainrailStandaloneDispatchFetchResult,
): { readonly eventId?: string; readonly eventName?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const eventId = typeof parsed.id === 'string' ? parsed.id : undefined;
  const eventName = typeof parsed.name === 'string' ? parsed.name : undefined;
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventName === undefined ? {} : { eventName }),
  };
}

function parseDispatchArguments(
  args: readonly string[],
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): ParsedDispatchArguments {
  if (args.length === 1 && (args[0] === 'help' || args[0] === '--help')) {
    return { errors: [], help: true };
  }

  const errors: string[] = [];
  let mode: RainrailDispatchMode | undefined;
  let input: string | undefined;
  let shouldReadStdin = false;
  let envelopeSource: DispatchEnvelopeInputSource | undefined;
  const positionalParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    const parsedInlineMode = parseInlineDispatchMode(arg);
    if (parsedInlineMode !== undefined) {
      if (mode !== undefined) {
        errors.push('Choose only one dispatch input mode.');
        continue;
      }
      mode = parsedInlineMode.mode;
      if (parsedInlineMode.mode === 'envelope-json') {
        envelopeSource = { kind: 'inline', input: parsedInlineMode.input };
      } else {
        input = parsedInlineMode.input;
      }
      continue;
    }

    if (arg.startsWith('--json=')) {
      const value = arg.slice('--json='.length);
      if (value.length === 0) {
        errors.push('Missing value for --json.');
        continue;
      }
      if (mode !== undefined || positionalParts.length > 0) {
        errors.push('Choose only one dispatch input mode.');
        continue;
      }
      mode = 'envelope-json';
      envelopeSource = { kind: 'file', path: value };
      continue;
    }

    if (arg === '--json') {
      const value = args[index + 1];
      if (value === undefined) {
        errors.push('Missing value for --json.');
        continue;
      }
      if (mode !== undefined || positionalParts.length > 0) {
        errors.push('Choose only one dispatch input mode.');
        index += 1;
        continue;
      }
      mode = 'envelope-json';
      envelopeSource = value === '--stdin'
        ? { kind: 'stdin' }
        : { kind: 'file', path: value };
      index += 1;
      continue;
    }

    if (arg === '--stdin') {
      if (mode !== undefined || positionalParts.length > 0) {
        errors.push('Choose only one dispatch input mode.');
        continue;
      }
      mode = 'message';
      shouldReadStdin = true;
      continue;
    }

    if (arg === '--message' || arg === '--envelope-json') {
      const value = args[index + 1];
      if (value === undefined) {
        errors.push(`Missing value for ${arg}.`);
        continue;
      }
      if (mode !== undefined || positionalParts.length > 0) {
        errors.push('Choose only one dispatch input mode.');
        index += 1;
        continue;
      }
      mode = arg === '--message' ? 'message' : 'envelope-json';
      if (mode === 'envelope-json') {
        envelopeSource = { kind: 'inline', input: value };
      } else {
        input = value;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      errors.push(`Unknown rainrail dispatch option: ${arg}.`);
      continue;
    }

    if (mode !== undefined && (mode !== 'message' || input !== undefined || shouldReadStdin)) {
      errors.push(`Unexpected rainrail dispatch argument: ${arg}.`);
      continue;
    }
    mode = 'message';
    positionalParts.push(arg);
  }

  if (errors.length === 0 && mode === 'envelope-json' && envelopeSource !== undefined) {
    if (environment.dispatchRunner === undefined && environment.asyncDispatchRunner === undefined) {
      input = '';
    } else {
      const envelopeInput = readDispatchEnvelopeInput(envelopeSource, environment);
      if (envelopeInput.error !== undefined) {
        return { errors: [envelopeInput.error], help: false };
      }
      const validated = parseAndValidateDispatchEnvelope(envelopeInput.input);
      if (validated.error !== undefined) {
        return { errors: [validated.error], help: false };
      }
      input = validated.input;
    }
  } else if (errors.length === 0 && shouldReadStdin) {
    const stdinInput = readDispatchStdin(environment);
    if ('error' in stdinInput) {
      return { errors: [stdinInput.error], help: false };
    }
    input = stdinInput.input;
  } else if (input === undefined && positionalParts.length > 0) {
    input = positionalParts.join(' ');
  }

  if (errors.length === 0 && mode === 'message' && input !== undefined && input.trim().length === 0) {
    return { errors: ['Message must not be empty.'], help: false };
  }

  if (errors.length === 0 && (mode === undefined || input === undefined)) {
    return { errors: [dispatchUsage], help: false };
  }

  const request = createDispatchRequest(mode, input, options, environment);

  return {
    errors,
    help: false,
    request,
  };
}

function parseInlineDispatchMode(
  arg: string,
): { readonly mode: RainrailDispatchMode; readonly input: string } | undefined {
  if (arg.startsWith('--message=')) {
    return { mode: 'message', input: arg.slice('--message='.length) };
  }

  if (arg.startsWith('--envelope-json=')) {
    return { mode: 'envelope-json', input: arg.slice('--envelope-json='.length) };
  }

  return undefined;
}

function formatDispatchHelp(): string {
  return [
    dispatchUsage,
    '',
    'Input modes:',
    '  <message>               Dispatch a message-only input as a manual Rainrail event.',
    '  --stdin                 Read the message from standard input.',
    '  --message <text>        Dispatch a message-only input payload.',
    '  --json <file>           Dispatch a complete Rainrail event envelope JSON file.',
    '  --json --stdin          Dispatch a complete Rainrail event envelope from stdin.',
    '  --envelope-json <json>  Dispatch a complete Rainrail event envelope JSON string.',
    '',
  ].join('\n');
}

function readDispatchEnvelopeInput(
  source: DispatchEnvelopeInputSource,
  environment: RainrailCliEnvironment,
): { readonly input: string; readonly error?: undefined } | { readonly error: string } {
  if (source.kind === 'inline') {
    return { input: source.input };
  }
  if (source.kind === 'stdin') {
    return readDispatchJsonStdin(environment);
  }
  return readDispatchJsonFile(source.path, environment);
}

function readDispatchJsonFile(
  path: string,
  environment: RainrailCliEnvironment,
): { readonly input: string; readonly error?: undefined } | { readonly error: string } {
  const fileSystem = {
    ...defaultRainrailCliFileSystem,
    ...environment.fileSystem,
  };
  const resolvedPath = resolve(environment.cwd ?? process.cwd(), path);
  try {
    return { input: fileSystem.readFileSync(resolvedPath, 'utf8') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unable to read rainrail dispatch JSON file: ${message}` };
  }
}

function readDispatchJsonStdin(
  environment: RainrailCliEnvironment,
): { readonly input: string; readonly error?: undefined } | { readonly error: string } {
  try {
    if (environment.stdinReader !== undefined) {
      return { input: environment.stdinReader() };
    }
    return { input: environment.stdin ?? readFileSync(0, 'utf8') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unable to read rainrail dispatch JSON from stdin: ${message}` };
  }
}

function createDispatchRequest(
  mode: RainrailDispatchMode | undefined,
  input: string | undefined,
  options: SharedOptions,
  environment: RainrailCliEnvironment,
): RainrailDispatchRequest | undefined {
  if (mode === undefined || input === undefined) {
    return undefined;
  }

  const requestOptions = {
    config: options.config,
    profile: options.profile,
    json: options.json,
  };

  if (mode === 'envelope-json') {
    return {
      mode,
      input,
      options: requestOptions,
    };
  }

  return {
    mode,
    input,
    event: createDispatchManualMessageEvent(input, environment.now?.() ?? new Date()),
    options: requestOptions,
  };
}

function createDispatchManualMessageEvent(
  message: string,
  receivedAt: Date,
): RainrailDispatchEventEnvelope {
  const occurredAt = receivedAt.toISOString();
  const redactedMessage = redactDispatchManualMessageText(message);
  const messageSha256 = sha256Hex(message);
  dispatchDeliverySequence += 1;
  const sequence = dispatchDeliverySequence.toString(36);
  const entropy = randomBytes(8).toString('hex');
  const deliveryId = `cli-${sha256Hex(`${occurredAt}\n${message}`).slice(0, 16)}-${sequence}-${entropy}`;

  return {
    id: `${dispatchCliSourceName}:${deliveryId}:rainrail.manual.message`,
    schemaVersion: 'rainrail.event.v1',
    source: {
      type: 'manual',
      name: dispatchCliSourceName,
    },
    name: 'rainrail.manual.message',
    delivery: {
      id: deliveryId,
      receivedAt: occurredAt,
    },
    occurredAt,
    subject: {
      type: 'conversation',
      id: dispatchCliConversationId,
    },
    payload: {
      provider: 'rainrail',
      channel: 'manual',
      action: 'message',
      conversation: {
        id: dispatchCliConversationId,
      },
      message: {
        text: redactedMessage,
      },
      actor: {
        id: 'rainrail-cli',
        displayName: 'Rainrail CLI',
        type: 'cli',
      },
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: `manual://deliveries/${deliveryId}`,
      contentType: 'text/plain',
      sha256: messageSha256,
    },
  };
}

function parseAndValidateDispatchEnvelope(input: string): { readonly input: string; readonly error?: undefined } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Invalid JSON for rainrail dispatch envelope: ${message}` };
  }

  const validation = validateDispatchEnvelopeInput(parsed);
  if (validation.error !== undefined) {
    return { error: `Invalid Rainrail event envelope: ${validation.error}` };
  }

  return {
    input: validation.complete ? input : addDispatchEnvelopeDefaults(input, validation),
  };
}

type DispatchEnvelopeObject = Record<string, unknown>;
type DispatchEnvelopeValidation = {
  readonly envelope: DispatchEnvelopeObject & {
    readonly id: string;
    readonly schemaVersion: 'rainrail.event.v1';
  };
  readonly complete: boolean;
  readonly hasId: boolean;
  readonly hasSchemaVersion: boolean;
  readonly error?: undefined;
};
const dispatchSafeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const dispatchSafeRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/u;
const dispatchSafeRefSubjectIdPattern = /^(?:(?:branch|tag):|refs\/(?:heads|tags)\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const dispatchSafeDeliveryReferenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const dispatchSafeGithubUrlSegmentPattern = /^[A-Za-z0-9_.-]{1,64}$/u;
const dispatchSafeGithubNumericIdPattern = /^\d{1,20}$/u;
const dispatchUtcIsoTimestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;
const dispatchAllowedRawPayloadKinds = new Set(['external-reference', 'inline-redacted']);

function validateDispatchEnvelopeInput(
  value: unknown,
): DispatchEnvelopeValidation | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: 'envelope must be a JSON object.' };
  }

  const source = readRequiredObject(value, 'source');
  if (source.error !== undefined) return source;
  const sourceType = readRequiredString(source.value, 'source.type');
  if (sourceType.error !== undefined) return sourceType;
  if (!isDispatchSafeIdentifier(sourceType.value)) {
    return { error: 'source.type must be a safe identifier.' };
  }
  const sourceName = readRequiredString(source.value, 'source.name');
  if (sourceName.error !== undefined) return sourceName;
  if (!isDispatchSafeIdentifier(sourceName.value)) {
    return { error: 'source.name must be a safe identifier.' };
  }
  const sourceRepository = validateOptionalDispatchRepository(source.value, 'source.repository');
  if (sourceRepository.error !== undefined) return sourceRepository;
  const sourceAccount = validateOptionalDispatchIdentifier(source.value, 'source.account');
  if (sourceAccount.error !== undefined) return sourceAccount;
  const sourceEnvironment = validateOptionalDispatchIdentifier(source.value, 'source.environment');
  if (sourceEnvironment.error !== undefined) return sourceEnvironment;

  const name = readRequiredString(value, 'name');
  if (name.error !== undefined) return name;
  if (!isDispatchSafeIdentifier(name.value)) {
    return { error: 'name must be a safe identifier.' };
  }
  const manualSourceMatch = validateManualInputEventSourceMatches(sourceType.value, name.value);
  if (manualSourceMatch.error !== undefined) return manualSourceMatch;

  const delivery = readRequiredObject(value, 'delivery');
  if (delivery.error !== undefined) return delivery;
  const deliveryId = readRequiredString(delivery.value, 'delivery.id');
  if (deliveryId.error !== undefined) return deliveryId;
  if (!isDispatchSafeIdentifier(deliveryId.value)) {
    return { error: 'delivery.id must be a safe identifier.' };
  }
  const deliveryReceivedAt = readRequiredString(delivery.value, 'delivery.receivedAt');
  if (deliveryReceivedAt.error !== undefined) return deliveryReceivedAt;
  if (!isDispatchUtcIsoTimestamp(deliveryReceivedAt.value)) {
    return { error: 'delivery.receivedAt must be a UTC ISO timestamp.' };
  }

  const occurredAt = readRequiredString(value, 'occurredAt');
  if (occurredAt.error !== undefined) return occurredAt;
  if (!isDispatchUtcIsoTimestamp(occurredAt.value)) {
    return { error: 'occurredAt must be a UTC ISO timestamp.' };
  }

  const subject = readRequiredObject(value, 'subject');
  if (subject.error !== undefined) return subject;
  const subjectType = readRequiredString(subject.value, 'subject.type');
  if (subjectType.error !== undefined) return subjectType;
  if (!isDispatchSafeIdentifier(subjectType.value)) {
    return { error: 'subject.type must be a safe identifier.' };
  }
  const subjectId = readRequiredString(subject.value, 'subject.id');
  if (subjectId.error !== undefined) return subjectId;
  if (!isDispatchSafeSubjectIdentifier(subjectId.value)) {
    return { error: 'subject.id must be a safe identifier.' };
  }
  const subjectUrl = validateOptionalDispatchUrl(subject.value, 'subject.url');
  if (subjectUrl.error !== undefined) return subjectUrl;

  if (!Object.hasOwn(value, 'payload')) {
    return { error: 'payload is required.' };
  }
  const manualPayload = validateManualInputPayload(
    value.payload,
    {
      sourceType: sourceType.value,
      name: name.value,
      subjectType: subjectType.value,
      subjectId: subjectId.value,
    },
  );
  if (manualPayload.error !== undefined) return manualPayload;

  const rawPayload = readRequiredObject(value, 'rawPayload');
  if (rawPayload.error !== undefined) return rawPayload;
  const rawPayloadKind = readRequiredString(rawPayload.value, 'rawPayload.kind');
  if (rawPayloadKind.error !== undefined) return rawPayloadKind;
  if (!dispatchAllowedRawPayloadKinds.has(rawPayloadKind.value)) {
    return { error: 'rawPayload.kind must be a known raw payload kind.' };
  }
  const rawPayloadReference = readRequiredString(rawPayload.value, 'rawPayload.reference');
  if (rawPayloadReference.error !== undefined) return rawPayloadReference;
  if (!isAllowedDispatchEventUrl(rawPayloadReference.value)) {
    return { error: 'rawPayload.reference must be an allowed Rainrail event URL.' };
  }
  const manualRawPayload = validateManualInputRawPayloadMatches(
    sourceType.value,
    name.value,
    rawPayloadKind.value,
    rawPayloadReference.value,
  );
  if (manualRawPayload.error !== undefined) return manualRawPayload;
  const rawPayloadContentType = validateOptionalDispatchContentType(rawPayload.value, 'rawPayload.contentType');
  if (rawPayloadContentType.error !== undefined) return rawPayloadContentType;
  const rawPayloadSha256 = validateOptionalDispatchSha256(rawPayload.value, 'rawPayload.sha256');
  if (rawPayloadSha256.error !== undefined) return rawPayloadSha256;

  const hasSchemaVersion = Object.hasOwn(value, 'schemaVersion');
  const schemaVersion = hasSchemaVersion ? value.schemaVersion : 'rainrail.event.v1';
  if (schemaVersion !== 'rainrail.event.v1') {
    return { error: 'schemaVersion must be "rainrail.event.v1".' };
  }

  const hasId = Object.hasOwn(value, 'id');
  const id = hasId ? value.id : `${sourceName.value}:${deliveryId.value}:${name.value}`;
  if (typeof id !== 'string') {
    return { error: 'id must be a string.' };
  }
  if (!isDispatchSafeIdentifier(id)) {
    return { error: 'id must be a safe identifier.' };
  }

  return {
    envelope: {
      ...value,
      id,
      schemaVersion,
    },
    complete: hasId && hasSchemaVersion,
    hasId,
    hasSchemaVersion,
  };
}

function addDispatchEnvelopeDefaults(
  input: string,
  validation: DispatchEnvelopeValidation,
): string {
  const properties: string[] = [];
  if (!validation.hasId) {
    properties.push(`"id":${JSON.stringify(validation.envelope.id)}`);
  }
  if (!validation.hasSchemaVersion) {
    properties.push('"schemaVersion":"rainrail.event.v1"');
  }
  if (properties.length === 0) {
    return input;
  }

  const objectStartIndex = input.search(/\S/u);
  if (objectStartIndex < 0 || input[objectStartIndex] !== '{') {
    return JSON.stringify(validation.envelope);
  }

  const afterOpenBrace = input.slice(objectStartIndex + 1);
  const hasExistingProperties = !afterOpenBrace.trimStart().startsWith('}');
  return [
    input.slice(0, objectStartIndex + 1),
    properties.join(','),
    hasExistingProperties ? ',' : '',
    input.slice(objectStartIndex + 1),
  ].join('');
}

function validateOptionalDispatchIdentifier(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (field === undefined) return {};
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  return {};
}

function validateOptionalDispatchRepository(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (field === undefined) return {};
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  if (!dispatchSafeRepositoryNamePattern.test(field)) {
    return { error: `${path} must be an owner/repo identifier.` };
  }
  return {};
}

function validateOptionalDispatchUrl(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (field === undefined) return {};
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  if (!isAllowedDispatchEventUrl(field)) {
    return { error: `${path} must be an allowed Rainrail event URL.` };
  }
  return {};
}

function validateOptionalDispatchContentType(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (field === undefined) return {};
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  const contentType = field.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)) {
    return { error: `${path} must be a MIME type.` };
  }
  return {};
}

function validateOptionalDispatchSha256(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (field === undefined) return {};
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  if (!/^[a-f0-9]{64}$/iu.test(field)) {
    return { error: `${path} must be a SHA-256 hex digest.` };
  }
  return {};
}

function validateManualInputEventSourceMatches(
  sourceType: string,
  name: string,
): { readonly error?: undefined } | { readonly error: string } {
  if (
    (name === 'rainrail.manual.message' && sourceType !== 'manual')
    || (name === 'rainrail.chat.message' && sourceType !== 'chat')
  ) {
    return { error: 'manual/chat event name must match source.type.' };
  }
  if (
    (sourceType === 'manual' && name !== 'rainrail.manual.message')
    || (sourceType === 'chat' && name !== 'rainrail.chat.message')
  ) {
    return { error: 'manual/chat source.type must use the matching event name.' };
  }
  return {};
}

function validateManualInputPayload(
  payload: unknown,
  context: {
    readonly sourceType: string;
    readonly name: string;
    readonly subjectType: string;
    readonly subjectId: string;
  },
): { readonly error?: undefined } | { readonly error: string } {
  if (!isManualInputDispatchEnvelope(context)) return {};
  if (!isRecord(payload)) {
    return { error: 'manual/chat payload must be an object.' };
  }
  if (payload.provider !== 'rainrail' || payload.channel !== context.sourceType || payload.action !== 'message') {
    return { error: 'manual/chat payload is missing required fields.' };
  }
  if (!isRecord(payload.conversation) || typeof payload.conversation.id !== 'string' || payload.conversation.id.length === 0) {
    return { error: 'manual/chat payload is missing required fields.' };
  }
  if (context.subjectType !== 'conversation' || payload.conversation.id !== context.subjectId) {
    return { error: 'manual/chat subject must match payload conversation.' };
  }
  if (!isRecord(payload.message) || typeof payload.message.text !== 'string' || payload.message.text.trim().length === 0) {
    return { error: 'payload.message.text is required.' };
  }
  return {};
}

function validateManualInputRawPayloadMatches(
  sourceType: string,
  name: string,
  kind: string,
  reference: string,
): { readonly error?: undefined } | { readonly error: string } {
  if (!isManualInputDispatchEnvelope({ sourceType, name })) return {};
  if (kind !== 'inline-redacted') {
    return { error: 'manual/chat raw payload kind must be inline-redacted.' };
  }
  if (new URL(reference).protocol !== `${sourceType}:`) {
    return { error: 'manual/chat raw payload reference must match source.type.' };
  }
  return {};
}

function isManualInputDispatchEnvelope(context: { readonly sourceType: string; readonly name: string }): boolean {
  return (context.sourceType === 'manual' && context.name === 'rainrail.manual.message')
    || (context.sourceType === 'chat' && context.name === 'rainrail.chat.message');
}

function isDispatchSafeIdentifier(value: string): boolean {
  return dispatchSafeIdentifierPattern.test(value) || dispatchSafeRepositoryNamePattern.test(value);
}

function isDispatchSafeSubjectIdentifier(value: string): boolean {
  return isDispatchSafeIdentifier(value) || dispatchSafeRefSubjectIdPattern.test(value);
}

function isDispatchUtcIsoTimestamp(value: string): boolean {
  const match = dispatchUtcIsoTimestampPattern.exec(value);
  if (match === null) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const [, seconds, milliseconds] = match;
  const canonical = `${seconds}.${(milliseconds ?? '').padEnd(3, '0')}Z`;
  return new Date(parsed).toISOString() === canonical;
}

function isAllowedDispatchEventUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '') {
    return false;
  }
  if (url.protocol === 'github:' || url.protocol === 'cloudflare:' || url.protocol === 'manual:' || url.protocol === 'chat:') {
    return url.hostname === 'deliveries'
      && url.port.length === 0
      && url.hash.length === 0
      && dispatchSafeDeliveryReferenceIdPattern.test(url.pathname.slice(1))
      && !url.pathname.slice(1).includes('/');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !segments.every((segment) => dispatchSafeGithubUrlSegmentPattern.test(segment))) {
    return false;
  }
  if (segments.length === 2) return true;
  if (segments.length === 4 && (segments[2] === 'issues' || segments[2] === 'pull' || segments[2] === 'runs')) {
    return dispatchSafeGithubNumericIdPattern.test(segments[3] ?? '');
  }
  if (segments.length === 5 && segments[2] === 'actions' && segments[3] === 'runs') {
    return dispatchSafeGithubNumericIdPattern.test(segments[4] ?? '');
  }
  return false;
}

function readRequiredObject(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly value: DispatchEnvelopeObject; readonly error?: undefined } | { readonly error: string } {
  const field = value[path];
  if (!isRecord(field)) {
    return { error: `${path} must be an object.` };
  }
  return { value: field };
}

function readRequiredString(
  value: DispatchEnvelopeObject,
  path: string,
): { readonly value: string; readonly error?: undefined } | { readonly error: string } {
  const fieldName = path.split('.').at(-1);
  const field = fieldName === undefined ? undefined : value[fieldName];
  if (typeof field !== 'string') {
    return { error: `${path} must be a string.` };
  }
  return { value: field };
}

function readDispatchStdin(environment: RainrailCliEnvironment):
  | { readonly input: string }
  | { readonly error: string } {
  if (environment.stdin !== undefined) {
    return dispatchStdinInputResult(environment.stdin);
  }

  if (environment.stdinReader !== undefined) {
    return dispatchStdinInputResult(environment.stdinReader());
  }

  if (process.stdin.isTTY) {
    return { input: '' };
  }

  return readStdinAllSync();
}

function dispatchStdinInputResult(input: string):
  | { readonly input: string }
  | { readonly error: string } {
  return Buffer.byteLength(input, 'utf8') > maxDispatchStdinMessageBytes
    ? { error: formatDispatchStdinTooLargeError() }
    : { input };
}

function readStdinAllSync():
  | { readonly input: string }
  | { readonly error: string } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(4096);
  let bytesTotal = 0;

  while (true) {
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    bytesTotal += bytesRead;
    if (bytesTotal > maxDispatchStdinMessageBytes) {
      return { error: formatDispatchStdinTooLargeError() };
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }

  return { input: Buffer.concat(chunks).toString('utf8') };
}

function formatDispatchStdinTooLargeError(): string {
  return `Message from stdin must not exceed ${maxDispatchStdinMessageBytes} bytes.`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactDispatchManualMessageText(value: string): string {
  return redactDispatchManualSecretStructuredValues(value)
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`/@]*@[^\s"'<>`,;)]+/giu, () => '[redacted-url]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`,;)]+/giu, (url) => sanitizeDispatchManualTextUrl(url))
    .replace(/(^|\r?\n)([ \t]*)(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, '$1$2$3: [redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*([^&\s"'<>`,;)]+)/giu, '$1$2$3$2=[redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*\5/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(?!["']|\[redacted\])([^,\s\r\n}\]]+)/giu, '$1$2$3$2$4[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [redacted]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, '[redacted-token]')
    .trim()
    .slice(0, maxDispatchManualMessageTextLength);
}

function redactDispatchManualSecretStructuredValues(value: string): string {
  const keyPattern = /(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*[:=]\s*)([\[{])/giu;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchText = match[0];
    const matchIndex = match.index;
    if (matchIndex < cursor) continue;
    const valueStart = matchIndex + matchText.length - 1;
    const valueEnd = findDispatchManualBalancedStructuredValueEnd(value, valueStart);
    redacted += value.slice(cursor, matchIndex);
    redacted += `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}${match[2] ?? ''}${match[4] ?? ''}[redacted]`;
    if (valueEnd === undefined) {
      const newlineIndex = value.indexOf('\n', valueStart);
      cursor = newlineIndex === -1 ? value.length : newlineIndex;
    } else {
      cursor = valueEnd + 1;
    }
  }
  return redacted + value.slice(cursor);
}

function findDispatchManualBalancedStructuredValueEnd(value: string, valueStart: number): number | undefined {
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = valueStart; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '{') {
      stack.push('}');
    } else if (char === ']') {
      if (stack.at(-1) !== ']') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    } else if (char === '}') {
      if (stack.at(-1) !== '}') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

function sanitizeDispatchManualTextUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '[redacted-url]';
    url.username = '';
    url.password = '';
    url.pathname = sanitizeDispatchManualUrlPathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, maxDispatchManualMessageTextLength);
  } catch {
    return '[redacted-url]';
  }
}

function sanitizeDispatchManualUrlPathname(pathname: string): string {
  const segments = pathname.split('/');
  return segments.map((segment, index) => {
    if (segment.length === 0) return segment;
    const previous = segments[index - 1]?.toLowerCase() ?? '';
    if (/^(token|secret|password|code|reset|magic-link|invite|session|auth|verify|verification)$/iu.test(previous)) {
      return '[redacted]';
    }
    if (/^(token|secret|password|code|reset)$/iu.test(segment)) {
      return '[redacted]';
    }
    return /^[A-Za-z0-9_-]{16,}$/u.test(segment) && /[A-Za-z]/u.test(segment) && /\d/u.test(segment)
      ? '[redacted]'
      : segment;
  }).join('/') || '/';
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

  const setupArguments = parseSetupCommandArguments(args);
  if (setupArguments.error !== undefined) {
    return formatSetupError(options, setupArguments.error);
  }

  const selectedPlugins = setupArguments.dashboardAuthOnly
    ? { plugins: [] }
    : resolveSetupPlugins(setupArguments.pluginArgs);
  if (selectedPlugins.error !== undefined) {
    return formatSetupError(options, selectedPlugins.error);
  }
  const plugins = selectedPlugins.plugins;

  if (!options.yes) {
    if (options.json) {
      if (setupArguments.dashboardAuthOnly) {
        return {
          exitCode: 0,
          stdout: formatJson({
            command: 'setup',
            completed: false,
            plugins: [],
            steps: [],
            nextAction: formatDashboardAuthOnlySetupCommand(setupOptions, setupArguments.rotateDashboardAuth),
          }),
          stderr: '',
        };
      }
      return formatSetupPreview(plugins, setupArguments.pluginArgs.length > 0, setupOptions);
    }

    if (setupArguments.dashboardAuthOnly) {
      const action = setupArguments.rotateDashboardAuth ? 'rotate local dashboardAuth tokens' : 'generate local dashboardAuth tokens';
      return {
        exitCode: 0,
        stdout: `Run \`${formatDashboardAuthOnlySetupCommand(setupOptions, setupArguments.rotateDashboardAuth)}\` to ${action} without plugin setup.\n`,
        stderr: '',
      };
    }

    return {
      exitCode: 0,
      stdout: formatSetupChoices(plugins, setupArguments.pluginArgs.length > 0, setupOptions),
      stderr: '',
    };
  }

  const invocation = createRainrailCommandInvocation(environment.currentBinPath ?? process.argv[1]);
  const steps: SetupStepResult[] = [];
  let dashboardAuthResult: LocalDashboardAuthSetupResult;
  try {
    if (!setupArguments.dashboardAuthOnly) {
      validateRainrailProjectForSetup(project, fileSystem);
    }
    dashboardAuthResult = ensureLocalDashboardAuth(
      project.configPath,
      fileSystem,
      environment.env ?? process.env,
      { rotate: setupArguments.rotateDashboardAuth },
    );
  } catch (error) {
    return formatSetupError(options, error);
  }

  if (setupArguments.dashboardAuthOnly) {
    return formatSetupResult(true, plugins, steps, options, undefined, dashboardAuthResult);
  }

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
      return formatSetupResult(false, plugins, steps, options, installStep, dashboardAuthResult);
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
      return formatSetupResult(false, plugins, steps, options, setupStep, dashboardAuthResult);
    }
  }

  return formatSetupResult(true, plugins, steps, options, undefined, dashboardAuthResult);
}

function parseSetupCommandArguments(args: readonly string[]): {
  readonly dashboardAuthOnly: boolean;
  readonly rotateDashboardAuth: boolean;
  readonly pluginArgs: readonly string[];
  readonly error?: string;
} {
  const pluginArgs: string[] = [];
  let dashboardAuthOnly = false;
  let rotateDashboardAuth = false;

  for (const arg of args) {
    if (arg === '--dashboard-auth-only') {
      dashboardAuthOnly = true;
      continue;
    }
    if (arg === '--rotate') {
      rotateDashboardAuth = true;
      continue;
    }
    pluginArgs.push(arg);
  }

  if (rotateDashboardAuth && !dashboardAuthOnly) {
    return {
      dashboardAuthOnly,
      rotateDashboardAuth,
      pluginArgs,
      error: 'rainrail setup --rotate must be combined with --dashboard-auth-only.',
    };
  }

  if (dashboardAuthOnly && pluginArgs.length > 0) {
    return {
      dashboardAuthOnly,
      rotateDashboardAuth,
      pluginArgs,
      error: 'rainrail setup --dashboard-auth-only cannot be combined with plugin arguments.',
    };
  }

  return { dashboardAuthOnly, rotateDashboardAuth, pluginArgs };
}

type LocalDashboardAuthSetupResult = {
  readonly created: readonly (keyof RainrailDashboardAuth)[];
  readonly rotated: readonly (keyof RainrailDashboardAuth)[];
  readonly configPath: string;
};

function ensureLocalDashboardAuth(
  configPath: string,
  fileSystem: RainrailCliFileSystem,
  env: Record<string, string | undefined>,
  options: { readonly rotate?: boolean } = {},
): LocalDashboardAuthSetupResult {
  const raw = fileSystem.readFileSync(configPath, 'utf8');
  const rawDashboardAuth = parseRawDashboardAuthObject(raw);
  if (hasDashboardAuthProperty(raw) && rawDashboardAuth === undefined) {
    throw new Error('config.dashboardAuth must be an object in rainrail.config.json before setup can add local tokens');
  }
  const dashboardAuth = rawDashboardAuth === undefined
    ? {}
    : parseExpandedDashboardAuthObject(raw, env);
  const generatedDashboardAuth: Record<string, string> = {};
  const created: Array<keyof RainrailDashboardAuth> = [];
  const rotated: Array<keyof RainrailDashboardAuth> = [];
  for (const key of ['readOnlyToken', 'operatorToken'] as const) {
    if (dashboardAuth[key] === undefined) {
      const token = generateLocalDashboardToken(key);
      dashboardAuth[key] = token;
      generatedDashboardAuth[key] = token;
      created.push(key);
      continue;
    }
    const rawValue = rawDashboardAuth?.[key];
    const rawValueIsEnvReference = isDashboardAuthEnvReference(rawValue);
    if (dashboardAuth[key] === '' && rawValueIsEnvReference) {
      continue;
    }
    parseLocalNonEmptyString(dashboardAuth[key], `config.dashboardAuth.${key}`);
    if (options.rotate === true && !rawValueIsEnvReference) {
      const token = generateLocalDashboardToken(key);
      dashboardAuth[key] = token;
      generatedDashboardAuth[key] = token;
      rotated.push(key);
    }
  }
  if (dashboardAuth.adminToken !== undefined) {
    const rawAdminToken = rawDashboardAuth?.adminToken;
    const rawAdminTokenIsEnvReference = isDashboardAuthEnvReference(rawAdminToken);
    if (!(dashboardAuth.adminToken === '' && rawAdminTokenIsEnvReference)) {
      parseLocalNonEmptyString(dashboardAuth.adminToken, 'config.dashboardAuth.adminToken');
      if (options.rotate === true && !rawAdminTokenIsEnvReference) {
        const token = generateLocalDashboardToken('adminToken');
        dashboardAuth.adminToken = token;
        generatedDashboardAuth.adminToken = token;
        rotated.push('adminToken');
      }
    }
  }
  assertUniqueLocalDashboardAuthTokens(dashboardAuth as RainrailDashboardAuth);
  if (created.length > 0 || rotated.length > 0) {
    fileSystem.writeFileSync(configPath, formatConfigWithLocalDashboardAuth(raw, generatedDashboardAuth));
  }
  return { created, rotated, configPath };
}

function parseExpandedDashboardAuthObject(raw: string, env: Record<string, string | undefined>): Record<string, unknown> {
  const objectStart = findDashboardAuthObjectStart(raw);
  if (objectStart === undefined) {
    throw new Error('config.dashboardAuth must be an object in rainrail.config.json before setup can add local tokens');
  }
  const objectEnd = findJsonObjectEnd(raw, objectStart);
  if (objectEnd === undefined) {
    throw new Error('config.dashboardAuth must be an object in rainrail.config.json before setup can add local tokens');
  }
  const value = JSON.parse(expandConfigEnv(raw.slice(objectStart, objectEnd + 1), env)) as unknown;
  if (!isRecord(value)) {
    throw new Error('config.dashboardAuth must be an object');
  }
  return { ...value };
}

function parseRawDashboardAuthObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) && isRecord(value.dashboardAuth) ? value.dashboardAuth : undefined;
  } catch {
    const objectStart = findDashboardAuthObjectStart(raw);
    if (objectStart === undefined) {
      return undefined;
    }
    const objectEnd = findJsonObjectEnd(raw, objectStart);
    if (objectEnd === undefined) {
      return undefined;
    }
    try {
      const value = JSON.parse(raw.slice(objectStart, objectEnd + 1)) as unknown;
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

function isDashboardAuthEnvReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/u.test(value);
}

function formatConfigWithLocalDashboardAuth(
  raw: string,
  generatedDashboardAuth: Record<string, string>,
): string {
  try {
    const rawValue = JSON.parse(raw) as unknown;
    if (isRecord(rawValue)) {
      const rawDashboardAuth = isRecord(rawValue.dashboardAuth) ? rawValue.dashboardAuth : {};
      return `${JSON.stringify({
        ...rawValue,
        dashboardAuth: {
          ...rawDashboardAuth,
          ...generatedDashboardAuth,
        },
      }, null, 2)}\n`;
    }
  } catch {
    const dashboardAuthObjectStart = findDashboardAuthObjectStart(raw);
    if (dashboardAuthObjectStart !== undefined) {
      const dashboardAuthObjectEnd = findJsonObjectEnd(raw, dashboardAuthObjectStart);
      const rawDashboardAuth = parseRawDashboardAuthObject(raw);
      if (dashboardAuthObjectEnd !== undefined && rawDashboardAuth !== undefined) {
        return replaceJsonObjectValue(raw, dashboardAuthObjectStart, dashboardAuthObjectEnd, {
          ...rawDashboardAuth,
          ...generatedDashboardAuth,
        });
      }
      return insertObjectEntries(raw, dashboardAuthObjectStart, generatedDashboardAuth, '    ');
    }
    if (hasDashboardAuthProperty(raw)) {
      throw new Error('config.dashboardAuth must be an object in rainrail.config.json before setup can add local tokens');
    }
  }

  return insertTopLevelDashboardAuth(raw, generatedDashboardAuth);
}

function insertTopLevelDashboardAuth(raw: string, dashboardAuth: Record<string, unknown>): string {
  const objectStart = raw.indexOf('{');
  if (objectStart < 0) {
    throw new Error('config must be an object');
  }
  const afterStart = raw.slice(objectStart + 1);
  const newline = afterStart.startsWith('\r\n') ? '\r\n' : afterStart.startsWith('\n') ? '\n' : '';
  const rest = newline.length === 0 ? afterStart : afterStart.slice(newline.length);
  const property = `"dashboardAuth": ${JSON.stringify(dashboardAuth, null, 2).replaceAll('\n', `${newline}  `)}`;
  return `${raw.slice(0, objectStart + 1)}${newline}  ${property},${newline}${rest}`;
}

function replaceJsonObjectValue(
  raw: string,
  objectStart: number,
  objectEnd: number,
  value: Record<string, unknown>,
): string {
  const indent = findLineIndent(raw, objectStart);
  const formatted = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => index === 0 ? line : `${indent}${line}`)
    .join('\n');
  return `${raw.slice(0, objectStart)}${formatted}${raw.slice(objectEnd + 1)}`;
}

function findLineIndent(raw: string, index: number): string {
  const lineStart = raw.lastIndexOf('\n', index - 1) + 1;
  const linePrefix = raw.slice(lineStart, index);
  return linePrefix.match(/^\s*/u)?.[0] ?? '';
}

function findDashboardAuthObjectStart(raw: string): number | undefined {
  const valueStart = findTopLevelPropertyValueStart(raw, 'dashboardAuth');
  if (valueStart === undefined) {
    return undefined;
  }
  return raw[valueStart] === '{' ? valueStart : undefined;
}

function hasDashboardAuthProperty(raw: string): boolean {
  return findTopLevelPropertyValueStart(raw, 'dashboardAuth') !== undefined;
}

function findTopLevelPropertyValueStart(raw: string, propertyName: string): number | undefined {
  const objectStart = raw.indexOf('{');
  if (objectStart < 0) {
    return undefined;
  }

  let depth = 0;
  for (let index = objectStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const stringEnd = findJsonStringEnd(raw, index);
      if (stringEnd === undefined) {
        return undefined;
      }
      if (depth === 1) {
        const name = parseJsonStringLiteral(raw.slice(index, stringEnd + 1));
        let cursor = skipJsonWhitespace(raw, stringEnd + 1);
        if (name === propertyName && raw[cursor] === ':') {
          cursor = skipJsonWhitespace(raw, cursor + 1);
          return cursor;
        }
      }
      index = stringEnd;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth -= 1;
      if (depth < 1) {
        return undefined;
      }
    }
  }
  return undefined;
}

function findJsonStringEnd(raw: string, stringStart: number): number | undefined {
  let escaped = false;
  for (let index = stringStart + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return index;
    }
  }
  return undefined;
}

function parseJsonStringLiteral(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (/\s/u.test(raw[index] ?? '')) {
    index += 1;
  }
  return index;
}

function findJsonObjectEnd(raw: string, objectStart: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function insertObjectEntries(
  raw: string,
  objectStart: number,
  entries: Record<string, string>,
  indent: string,
): string {
  const afterStart = raw.slice(objectStart + 1);
  const newline = afterStart.startsWith('\r\n') ? '\r\n' : afterStart.startsWith('\n') ? '\n' : '';
  const rest = newline.length === 0 ? afterStart : afterStart.slice(newline.length);
  const entriesText = Object.entries(entries)
    .map(([key, value]) => `${indent}"${key}": ${JSON.stringify(value)}`)
    .join(`,${newline}`);
  const hasExistingEntries = !rest.trimStart().startsWith('}');
  const suffix = hasExistingEntries ? `,${newline}` : newline;
  return `${raw.slice(0, objectStart + 1)}${newline}${entriesText}${suffix}${rest}`;
}

function validateRainrailProjectForSetup(
  project: RainrailProject,
  fileSystem: RainrailCliFileSystem,
): void {
  if (!isCompleteRainrailProject(project, fileSystem)) {
    throw new Error('rainrail setup requires a complete Rainrail project. Run rainrail init first.');
  }
}

function isCompleteRainrailProject(
  project: RainrailProject,
  fileSystem: RainrailCliFileSystem,
): boolean {
  if (
    !fileSystem.existsSync(project.configPath) ||
    !isRegularFile(project.configPath, fileSystem) ||
    !fileSystem.existsSync(project.lockPath) ||
    !fileSystem.existsSync(project.pluginDirectory) ||
    lstatPath(project.pluginDirectory, fileSystem)?.isDirectory() !== true
  ) {
    return false;
  }

  readRainrailLockfile(project.lockPath, fileSystem);
  return true;
}

function generateLocalDashboardToken(scope: keyof RainrailDashboardAuth): string {
  const label = scope.replace(/Token$/u, '').replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  return `rr_local_${label}_${randomBytes(24).toString('base64url')}`;
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
  dashboardAuthResult?: LocalDashboardAuthSetupResult,
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

  const dashboardAuthOutput = dashboardAuthResult === undefined
    ? ''
    : formatDashboardAuthSetupOutput(dashboardAuthResult);
  const stdout = `${dashboardAuthOutput}${steps.map((step) => step.stdout).join('')}`;
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

function formatDashboardAuthSetupOutput(result: LocalDashboardAuthSetupResult): string {
  const rotatedOutput = result.rotated.length === 0
    ? ''
    : `Rotated ${formatDashboardAuthKeyList(result.rotated)} in ${basename(result.configPath)}.\n`;
  const createdOutput = result.created.length === 0
    ? ''
    : `Generated ${formatDashboardAuthKeyList(result.created)} in ${basename(result.configPath)}.\n`;
  return `${rotatedOutput}${createdOutput}`;
}

function formatDashboardAuthKeyList(keys: readonly (keyof RainrailDashboardAuth)[]): string {
  const labels = keys.map((key) => `dashboardAuth.${key}`);
  if (labels.length <= 2) {
    return labels.join(' and ');
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
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
    dashboardAuth: {},
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

const localCorsHeaders = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID, X-GitHub-Delivery, X-GitHub-Event, X-Hub-Signature-256, X-Rainrail-Client, X-Rainrail-Publish-Token, X-Request-ID',
  'Access-Control-Expose-Headers': 'X-Request-ID',
  'Access-Control-Max-Age': '86400',
} as const;

const localCoreRoutePaths = new Set([
  '/healthz',
  '/events',
  '/dashboard',
  '/dashboard/',
  '/ja/dashboard',
  '/ja/dashboard/',
  '/en/dashboard',
  '/en/dashboard/',
  '/api/state',
  '/api/v1/overview',
  '/api/v1/events',
  '/api/v1/workflow-runs',
  '/api/v1/agent-tasks',
  '/api/v1/sources',
  '/api/v1/queue',
  '/api/v1/settings',
]);
const localCoreRoutePrefixes = [
  '/_astro/',
  '/api/events/',
  '/api/v1/events/',
  '/api/v1/workflow-runs/',
  '/api/v1/agent-tasks/',
  '/api/v1/sources/',
  '/api/v1/queue/',
  '/api/v1/settings/',
] as const;

type LocalRainrailEvent = {
  readonly id: string;
  readonly type: 'event';
  readonly name: string;
  readonly status: string;
  readonly summary: string;
  readonly deliveryId: string;
  readonly rawPayloadReference: string;
  readonly workflowRunCount: number;
  readonly handlerRetryCount: number;
  readonly subject: {
    readonly type: string;
    readonly id: string;
  };
  readonly occurredAt: string;
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

type LocalDashboardScope = 'read-only' | 'operator' | 'admin';

type LocalDashboardCommand = {
  readonly actionType: 'agent_task_resume' | 'agent_task_reset' | 'agent_task_terminate' | 'agent_task_terminate_all';
  readonly targetType: 'agent_task' | 'agent_tasks';
  readonly targetId: string;
  readonly confirmationRequired: boolean;
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
    writeJsonResponse(response, 500, { error: 'internal_server_error' }, request);
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
    writeJsonResponse(response, 400, { error: 'invalid_host_header' }, request);
    return;
  }

  if (request.method === 'OPTIONS') {
    writeCorsPreflightResponse(response, preflightMethodsForLocalPath(url.pathname, options), request);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJsonResponse(response, 200, isLocalBindHost(options.host) ? {
      ok: true,
      runtime: 'node',
      workspace: options.root,
    } : { ok: true, runtime: 'node' }, request);
    return;
  }

  const intakeSource = options.sources.find((source) => source.endpoint === url.pathname);
  if (request.method === 'POST' && intakeSource !== undefined) {
    await handleLocalIntakeRequest(request, response, options, state, intakeSource);
    return;
  }
  if (intakeSource !== undefined) {
    writeJsonResponse(response, 405, { error: 'method_not_allowed' }, request, {
      Allow: 'POST, OPTIONS',
    });
    return;
  }

  const allowedMethods = preflightMethodsForLocalPath(url.pathname, options);
  if (allowedMethods !== undefined && !allowedMethods.includes(request.method ?? '')) {
    writeJsonResponse(response, 405, { error: 'method_not_allowed' }, request, {
      Allow: allowedMethods.join(', '),
    });
    return;
  }

  if (request.method === 'GET' && isLocalDashboardAssetRoute(url.pathname)) {
    if (writeLocalDashboardAssetResponse(response, options, url.pathname)) {
      return;
    }
  }

  const authError = getLocalServerAuthError(request, url.pathname, options);
  if (authError !== undefined) {
    writeJsonResponse(response, authError.status, authError.body, request);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, {
      ...localCorsHeaders,
      ...localOriginCorsHeader(request),
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

  if (request.method === 'GET' && url.pathname === '/api/state') {
    writeJsonResponse(response, 200, {
      counts: { events: state.events.length, activityEvents: 0 },
      events: state.events,
      workspace: options.root,
    }, request);
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
    }, request);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    const queryError = validateLocalCollectionQuery(url, ['filter[source]', 'filter[name]']);
    if (queryError !== undefined) {
      writeJsonResponse(response, 400, queryError, request);
      return;
    }
    writeLocalCollectionResponse(
      response,
      filterLocalEvents([...state.events].reverse(), url),
      url,
      request,
      (row) => typeof row.receivedAt === 'string' ? row.receivedAt : row.id,
    );
    return;
  }

  const eventDetailMatch = /^\/api\/v1\/events\/([^/]+)$/u.exec(url.pathname);
  if (request.method === 'GET' && eventDetailMatch !== null) {
    const eventId = safeDecodeURIComponent(eventDetailMatch[1] ?? '');
    const event = eventId === undefined ? undefined : state.events.find((item) => item.id === eventId);
    if (event === undefined) {
      writeJsonResponse(response, 404, { error: 'event_not_found' }, request);
      return;
    }
    writeJsonResponse(response, 200, {
      data: localEventDetail(event),
    }, request);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/workflow-runs') {
    if (!writeValidatedLocalCollectionResponse(response, localEmptyCollectionRows, url, request, (row) => row.id, ['filter[status]'])) {
      return;
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/agent-tasks') {
    if (!writeValidatedLocalCollectionResponse(response, localEmptyCollectionRows, url, request, (row) => row.id, ['filter[status]'])) {
      return;
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/sources') {
    const queryError = validateLocalCollectionQuery(url, ['filter[source]']);
    if (queryError !== undefined) {
      writeJsonResponse(response, 400, queryError, request);
      return;
    }
    writeLocalCollectionResponse(
      response,
      filterLocalSources(localSourceRows(options.sources, state), url),
      url,
      request,
      (row) => typeof row.name === 'string' ? row.name : row.id,
    );
    return;
  }

  const sourceDetailMatch = /^\/api\/v1\/sources\/([^/]+)$/u.exec(url.pathname);
  if (request.method === 'GET' && sourceDetailMatch !== null) {
    const sourceId = safeDecodeURIComponent(sourceDetailMatch[1] ?? '');
    const row = sourceId === undefined
      ? undefined
      : localSourceRows(options.sources, state).find((source) => source.id === sourceId);
    if (row === undefined) {
      writeJsonResponse(response, 404, { error: 'source_not_found' }, request);
      return;
    }
    writeJsonResponse(response, 200, {
      data: row,
    }, request);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/queue') {
    if (!writeValidatedLocalCollectionResponse(response, localEmptyCollectionRows, url, request, (row) => row.id, ['filter[status]'], {
      summary: {
        upcomingIssues: 0,
        blockedReasons: [],
        inProgressCount: 0,
        claimedCount: 0,
      },
    })) {
      return;
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/settings') {
    writeLocalCollectionResponse(
      response,
      localSettingsRows(options),
      url,
      request,
      (row) => row.id,
    );
    return;
  }

  const localCommand = localDashboardCommandForPath(url.pathname);
  if (request.method === 'POST' && localCommand !== undefined) {
    await handleLocalDashboardCommandRequest(request, response, localCommand);
    return;
  }

  writeJsonResponse(response, 404, { error: 'not_found' }, request);
}

async function handleLocalDashboardCommandRequest(
  request: IncomingMessage,
  response: ServerResponse,
  command: LocalDashboardCommand,
): Promise<void> {
  const requestId = localRequestId(request);
  const body = await readLocalJsonObjectBody(request);
  if (!body.ok) {
    writeJsonResponse(response, body.status, { error: body.error }, request, {
      'X-Request-ID': requestId,
    });
    return;
  }

  const confirmationToken = localConfirmationTokenFor(command);
  const preview = localCommandPreview(command, confirmationToken);
  if (body.value.dryRun === true) {
    writeJsonResponse(response, 200, {
      data: {
        ...preview,
        status: 'preview',
        dryRun: true,
      },
    }, request, {
      'X-Request-ID': requestId,
    });
    return;
  }

  if (command.confirmationRequired && body.value.confirmationToken !== confirmationToken) {
    writeJsonResponse(response, 409, {
      error: 'action_confirmation_required',
      data: preview,
    }, request, {
      'X-Request-ID': requestId,
    });
    return;
  }

  writeJsonResponse(response, 503, { error: 'command_handler_not_configured' }, request, {
    'X-Request-ID': requestId,
  });
}

async function readLocalJsonObjectBody(
  request: IncomingMessage,
): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: 'invalid_json_body' | 'request_body_too_large'; readonly status: number }
> {
  let body: Buffer;
  try {
    body = await readRequestBodyForLocalServer(request, localDefaultMaxRequestBodyBytes);
  } catch (error) {
    if (error instanceof LocalRequestBodyTooLargeError) {
      return { ok: false, error: 'request_body_too_large', status: 413 };
    }
    throw error;
  }
  if (body.byteLength === 0) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, error: 'invalid_json_body', status: 400 };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'invalid_json_body', status: 400 };
  }
}

function localDashboardCommandForPath(pathname: string): LocalDashboardCommand | undefined {
  const agentTaskActionMatch = /^\/api\/v1\/agent-tasks\/([^/]+)\/actions\/(resume|reset|terminate)$/u.exec(pathname);
  if (agentTaskActionMatch !== null) {
    const targetId = safeDecodeURIComponent(agentTaskActionMatch[1] ?? '');
    const action = agentTaskActionMatch[2];
    if (targetId === undefined || !isLocalAgentTaskCommandAction(action)) {
      return undefined;
    }
    return {
      actionType: localAgentTaskCommandActionType(action),
      targetType: 'agent_task',
      targetId,
      confirmationRequired: action !== 'resume',
    };
  }
  if (pathname === '/api/v1/agent-tasks/actions/terminate-all') {
    return {
      actionType: 'agent_task_terminate_all',
      targetType: 'agent_tasks',
      targetId: 'all',
      confirmationRequired: true,
    };
  }
  return undefined;
}

function isLocalAgentTaskCommandAction(action: string | undefined): action is 'resume' | 'reset' | 'terminate' {
  return action === 'resume' || action === 'reset' || action === 'terminate';
}

function localAgentTaskCommandActionType(
  action: 'resume' | 'reset' | 'terminate',
): LocalDashboardCommand['actionType'] {
  switch (action) {
    case 'resume':
      return 'agent_task_resume';
    case 'reset':
      return 'agent_task_reset';
    case 'terminate':
      return 'agent_task_terminate';
  }
}

function localConfirmationTokenFor(command: LocalDashboardCommand): string {
  return `confirm:${command.actionType}:${command.targetType}:${command.targetId}`;
}

function localCommandPreview(
  command: LocalDashboardCommand,
  confirmationToken: string,
): {
  readonly action: LocalDashboardCommand['actionType'];
  readonly targetType: LocalDashboardCommand['targetType'];
  readonly targetId: string;
  readonly confirmationRequired: boolean;
  readonly confirmationToken?: string;
} {
  return {
    action: command.actionType,
    targetType: command.targetType,
    targetId: command.targetId,
    confirmationRequired: command.confirmationRequired,
    ...(command.confirmationRequired ? { confirmationToken } : {}),
  };
}

function localRequestId(request: IncomingMessage): string {
  const header = request.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && /^[\w:./-]{1,128}$/u.test(value)) {
    return value;
  }
  return `req_${randomBytes(16).toString('hex')}`;
}

async function handleLocalIntakeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RainrailStartOptions,
  state: LocalRainrailServerState,
  intakeSource: RainrailLocalSource,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readRequestBodyForLocalServer(request, intakeSource.maxBodyBytes ?? localDefaultMaxRequestBodyBytes);
  } catch (error) {
    if (error instanceof LocalRequestBodyTooLargeError) {
      writeJsonResponse(response, 413, { error: 'request_body_too_large' }, request);
      return;
    }
    throw error;
  }
  if (!isAuthorizedLocalIntakeRequest(request, options, intakeSource, body)) {
    writeJsonResponse(response, 401, { error: 'intake_auth_invalid' }, request);
    return;
  }
  const payload = validateLocalIntakePayload(request, intakeSource, body);
  if (!payload.ok) {
    writeJsonResponse(response, 400, { error: payload.error }, request);
    return;
  }
  const id = `local-event-${String(state.nextEventId).padStart(6, '0')}`;
  state.nextEventId += 1;
  const eventName = payload.eventName ?? `${intakeSource.sourceType}.event`;
  const deliveryId = payload.deliveryId ?? id;
  const occurredAt = new Date().toISOString();
  const event: LocalRainrailEvent = {
    id,
    type: 'event',
    name: eventName,
    status: 'received',
    summary: `${intakeSource.name} event received`,
    deliveryId,
    rawPayloadReference: `local://events/${id}`,
    workflowRunCount: 0,
    handlerRetryCount: 0,
    subject: {
      type: localSubjectTypeForEventName(eventName),
      id,
    },
    occurredAt,
    receivedAt: occurredAt,
    source: {
      type: intakeSource.sourceType,
      name: intakeSource.name,
    },
    links: {
      self: `/api/v1/events/${encodeURIComponent(id)}`,
    },
  };
  state.events.push(event);
  if (state.events.length > localEventHistoryLimit) {
    state.events.splice(0, state.events.length - localEventHistoryLimit);
  }
  broadcastLocalEvent(state, event);
  writeJsonResponse(response, 202, { data: event }, request);
}

function filterLocalEvents(events: readonly LocalRainrailEvent[], url: URL): readonly LocalRainrailEvent[] {
  const sourceFilter = url.searchParams.get('filter[source]');
  const nameFilter = url.searchParams.get('filter[name]');
  return events
    .filter((event) => matchesOptionalLocalFilter(event.source.type, sourceFilter))
    .filter((event) => matchesOptionalLocalFilter(event.name, nameFilter));
}

function localEventDetail(event: LocalRainrailEvent): {
  readonly id: string;
  readonly type: 'event';
  readonly compact: LocalRainrailEvent;
  readonly record: {
    readonly name: string;
    readonly humanSummary: string;
    readonly source: LocalRainrailEvent['source'];
    readonly delivery: { readonly id: string; readonly receivedAt: string };
    readonly subject: LocalRainrailEvent['subject'];
    readonly occurredAt: string;
    readonly receivedAt: string;
    readonly envelope: LocalRainrailEvent;
    readonly activityEvents: readonly [];
    readonly handlerRetries: readonly [];
  };
} {
  return {
    id: event.id,
    type: 'event',
    compact: event,
    record: {
      name: event.name,
      humanSummary: event.summary,
      source: event.source,
      delivery: { id: event.deliveryId, receivedAt: event.receivedAt },
      subject: event.subject,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      envelope: event,
      activityEvents: [],
      handlerRetries: [],
    },
  };
}

type LocalSourceRow = {
  readonly id: string;
  readonly type: 'source';
  readonly status: 'configured';
  readonly sourceType: string;
  readonly name: string;
  readonly endpoint: string;
  readonly transport: 'http';
  readonly auth: { readonly status: string };
  readonly links: { readonly self: string };
  readonly lastDelivery?: {
    readonly id: string;
    readonly status: string;
    readonly occurredAt: string;
    readonly receivedAt: string;
    readonly links: { readonly self: string };
  };
};

function localSourceRows(
  sources: readonly RainrailLocalSource[],
  state: LocalRainrailServerState,
): readonly LocalSourceRow[] {
  return sources.map((source) => {
    const latestEvent = [...state.events]
      .reverse()
      .find((event) => event.source.name === source.name && event.source.type === source.sourceType);
    const row = {
      id: source.name,
      type: 'source',
      status: 'configured',
      sourceType: source.sourceType,
      name: source.name,
      endpoint: source.endpoint,
      transport: source.transport,
      auth: { status: source.authConfigured ? 'configured' : 'not configured' },
      links: { self: `/api/v1/sources/${encodeURIComponent(source.name)}` },
    } satisfies Omit<LocalSourceRow, 'lastDelivery'>;
    return latestEvent === undefined
      ? row
      : {
        ...row,
        lastDelivery: {
          id: latestEvent.id,
          status: latestEvent.status,
          occurredAt: latestEvent.occurredAt,
          receivedAt: latestEvent.receivedAt,
          links: latestEvent.links,
        },
      };
  });
}

function filterLocalSources(sources: readonly LocalSourceRow[], url: URL): readonly LocalSourceRow[] {
  const sourceFilter = url.searchParams.get('filter[source]');
  return sources.filter((source) => {
    if (!isRecord(source)) {
      return false;
    }
    return matchesOptionalLocalFilter(typeof source.sourceType === 'string' ? source.sourceType : undefined, sourceFilter);
  });
}

type LocalSettingRow = {
  readonly id: string;
  readonly type: 'setting';
  readonly status: 'read-only';
  readonly label: string;
  readonly value: string;
};

function localSettingsRows(options: RainrailStartOptions): readonly LocalSettingRow[] {
  return [
    { id: 'max-concurrency', type: 'setting', status: 'read-only', label: 'Max concurrency', value: '1 task' },
    { id: 'auto-start', type: 'setting', status: 'read-only', label: 'Auto-start', value: 'not configured' },
    { id: 'retry-policy', type: 'setting', status: 'read-only', label: 'Retry policy', value: '0 retries pending' },
    { id: 'operational-snapshot-limit', type: 'setting', status: 'read-only', label: 'Operational snapshot limit', value: `${localEventHistoryLimit} events` },
    { id: 'dashboard-auth', type: 'setting', status: 'read-only', label: 'Dashboard auth', value: hasAnyDashboardAuthToken(options.dashboardAuth) ? 'bearer token configured' : 'not configured' },
    { id: 'runtime', type: 'setting', status: 'read-only', label: 'Runtime', value: 'node' },
  ];
}

function matchesOptionalLocalFilter(value: string | undefined, filter: string | null): boolean {
  return filter === null || filter.length === 0 || value === filter;
}

function validateLocalCollectionQuery(
  url: URL,
  supportedFilters: readonly string[],
): { readonly error: 'unsupported_filter'; readonly filter: string } | {
  readonly error: 'unsupported_sort';
  readonly sort: string;
} | undefined {
  for (const key of url.searchParams.keys()) {
    if (key.startsWith('filter[') && !supportedFilters.includes(key)) {
      return { error: 'unsupported_filter', filter: key };
    }
  }
  const sort = url.searchParams.get('sort');
  if (sort !== null && sort.length > 0) {
    return { error: 'unsupported_sort', sort };
  }
  return undefined;
}

function resolveDashboardAssetRoot(env: Record<string, string | undefined>): string | undefined {
  const configured = env.RAINRAIL_DASHBOARD_DIST_DIR;
  if (configured !== undefined && configured.length > 0 && existsSync(configured) && statSync(configured).isDirectory()) {
    return configured;
  }
  if (existsSync(bundledDashboardAssetRoot) && statSync(bundledDashboardAssetRoot).isDirectory()) {
    return bundledDashboardAssetRoot;
  }
  if (existsSync(workspaceDashboardAssetRoot) && statSync(workspaceDashboardAssetRoot).isDirectory()) {
    return workspaceDashboardAssetRoot;
  }
  return undefined;
}

function isLocalDashboardAssetRoute(pathname: string): boolean {
  return pathname === '/dashboard' ||
    pathname === '/dashboard/' ||
    /^\/(?:ja|en)\/dashboard\/?$/u.test(pathname) ||
    pathname.startsWith('/_astro/');
}

function writeLocalDashboardAssetResponse(
  response: ServerResponse,
  options: RainrailStartOptions,
  pathname: string,
): boolean {
  const assetRoot = options.dashboardAssetRoot;
  if (assetRoot === undefined) {
    return false;
  }
  const assetPath = localDashboardAssetPath(assetRoot, pathname);
  if (assetPath === undefined || !existsSync(assetPath) || !statSync(assetPath).isFile()) {
    return false;
  }
  response.writeHead(200, {
    'Content-Type': localDashboardContentType(assetPath),
    'Cache-Control': pathname.startsWith('/_astro/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  response.end(localDashboardAssetBody(assetPath, options, pathname));
  return true;
}

function localDashboardAssetBody(assetPath: string, options: RainrailStartOptions, pathname: string): Buffer | string {
  const body = readFileSync(assetPath);
  if (isLocalDashboardHtmlRoute(pathname)) {
    const sameOriginBody = body.toString('utf8')
      .replace(/\sdata-api-base-url(?:="[^"]*")?/u, ' data-api-base-url=""');
    if (!hasAnyDashboardAuthToken(options.dashboardAuth) && options.dashboardToken === undefined) {
      return sameOriginBody.replace('data-auth-required="true"', 'data-auth-required="false"');
    }
    return sameOriginBody;
  }
  return body;
}

function localDashboardAssetPath(assetRoot: string, pathname: string): string | undefined {
  const localeDashboard = /^\/(ja|en)\/dashboard\/?$/u.exec(pathname);
  if (localeDashboard?.[1] !== undefined) {
    return resolve(assetRoot, localeDashboard[1], 'dashboard', 'index.html');
  }
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    const localizedDashboard = resolve(assetRoot, 'en', 'dashboard', 'index.html');
    if (existsSync(localizedDashboard)) {
      return localizedDashboard;
    }
  }
  const relativePath = pathname === '/dashboard' || pathname === '/dashboard/'
    ? 'dashboard/index.html'
    : pathname.slice(1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return undefined;
  }
  const normalized = normalize(decoded);
  if (pathname.startsWith('/_astro/') && !normalized.startsWith(`_astro${sep}`)) {
    return undefined;
  }
  if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`)) {
    return undefined;
  }
  const root = resolve(assetRoot);
  const target = resolve(root, normalized);
  return target === root || target.startsWith(`${root}${sep}`) ? target : undefined;
}

function isLocalDashboardHtmlRoute(pathname: string): boolean {
  return pathname === '/dashboard' ||
    pathname === '/dashboard/' ||
    /^\/(?:ja|en)\/dashboard\/?$/u.test(pathname);
}

function localDashboardContentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
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
    ...options.allowedHosts,
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
  return (hasAnyDashboardAuthToken(options.dashboardAuth) || options.dashboardToken !== undefined) &&
    (pathname === '/events' || pathname.startsWith('/api/'));
}

function getLocalServerAuthError(
  request: IncomingMessage,
  pathname: string,
  options: RainrailStartOptions,
): { readonly status: number; readonly body: { readonly error: string; readonly requiredScope?: LocalDashboardScope } } | undefined {
  if (!requiresLocalServerAuth(pathname, options)) {
    return undefined;
  }
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || authorization.length === 0) {
    return { status: 401, body: { error: 'missing_bearer_token' } };
  }
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return { status: 401, body: { error: 'missing_bearer_token' } };
  }
  const token = authorization.slice(prefix.length);
  const principal = localDashboardPrincipalForToken(token, options);
  if (principal === undefined) {
    return { status: 403, body: { error: 'invalid_bearer_token' } };
  }
  const requiredScope = requiredLocalDashboardScopeForPath(pathname);
  if (!localDashboardScopeIncludes(principal.scope, requiredScope)) {
    return { status: 403, body: { error: 'insufficient_scope', requiredScope } };
  }
  return undefined;
}

function requiredLocalDashboardScopeForPath(pathname: string): LocalDashboardScope {
  return localDashboardCommandForPath(pathname) === undefined ? 'read-only' : 'operator';
}

function localDashboardPrincipalForToken(
  token: string,
  options: RainrailStartOptions,
): { readonly scope: LocalDashboardScope } | undefined {
  if (matchesLocalDashboardToken(token, options.dashboardAuth.adminToken)) {
    return { scope: 'admin' };
  }
  if (matchesLocalDashboardToken(token, options.dashboardAuth.operatorToken)) {
    return { scope: 'operator' };
  }
  if (
    matchesLocalDashboardToken(token, options.dashboardAuth.readOnlyToken) ||
    matchesLocalDashboardToken(token, options.dashboardToken)
  ) {
    return { scope: 'read-only' };
  }
  return undefined;
}

function matchesLocalDashboardToken(token: string, configured: string | undefined): boolean {
  return configured !== undefined && configured.length > 0 && timingSafeStringEqual(token, configured);
}

function localDashboardScopeIncludes(actual: LocalDashboardScope, required: LocalDashboardScope): boolean {
  const rank: Record<LocalDashboardScope, number> = {
    'read-only': 1,
    operator: 2,
    admin: 3,
  };
  return rank[actual] >= rank[required];
}

function validateLocalIntakePayload(
  request: IncomingMessage,
  source: RainrailLocalSource,
  body: Buffer,
): { readonly ok: true; readonly eventName?: string; readonly deliveryId?: string } | {
  readonly ok: false;
  readonly error: 'missing_github_headers' | 'invalid_json_payload';
} {
  if (source.sourceType !== 'github') {
    return { ok: true };
  }
  const githubEvent = request.headers['x-github-event'];
  const deliveryId = request.headers['x-github-delivery'];
  if (typeof githubEvent !== 'string' || githubEvent.length === 0 ||
    typeof deliveryId !== 'string' || deliveryId.length === 0) {
    return { ok: false, error: 'missing_github_headers' };
  }
  if (!isValidLocalGitHubPayload(request, body)) {
    return { ok: false, error: 'invalid_json_payload' };
  }
  return {
    ok: true,
    eventName: toLocalGitHubEventName(githubEvent),
    deliveryId,
  };
}

function isValidLocalGitHubPayload(request: IncomingMessage, body: Buffer): boolean {
  const contentType = request.headers['content-type'];
  const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
  try {
    if (typeof contentTypeValue === 'string' &&
      contentTypeValue.toLowerCase().split(';', 1)[0]?.trim() === 'application/x-www-form-urlencoded') {
      const payload = new URLSearchParams(body.toString('utf8')).get('payload');
      if (payload === null) {
        return false;
      }
      JSON.parse(payload) as unknown;
      return true;
    }
    JSON.parse(body.toString('utf8')) as unknown;
    return true;
  } catch {
    return false;
  }
}

function toLocalGitHubEventName(githubEvent: string): string {
  const normalized = normalizeLocalToken(githubEvent);
  if (normalized === 'issues' || normalized === 'issue_comment') {
    return 'github.issue';
  }
  if (normalized === 'pull_request') {
    return 'github.pull_request';
  }
  if (normalized === 'check_run' || normalized === 'check_suite' || normalized === 'workflow_run') {
    return 'github.check_run';
  }
  if (
    normalized === 'pull_request_review' ||
    normalized === 'pull_request_review_comment' ||
    normalized === 'pull_request_review_thread'
  ) {
    return 'github.review';
  }
  return `github.${normalized || 'unknown'}`;
}

function localSubjectTypeForEventName(eventName: string): string {
  if (eventName === 'github.issue') {
    return 'issue';
  }
  if (eventName === 'github.pull_request') {
    return 'pull_request';
  }
  if (eventName === 'github.review') {
    return 'review';
  }
  if (eventName === 'github.check_run') {
    return 'check_run';
  }
  return eventName;
}

function normalizeLocalToken(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_');
}

function isAuthorizedLocalIntakeRequest(
  request: IncomingMessage,
  options: RainrailStartOptions,
  source: RainrailLocalSource,
  body: Buffer,
): boolean {
  if (source.webhookSecret === undefined) {
    return isLocalBindHost(options.host);
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

function writeLocalCollectionResponse<TRow extends { readonly id: string }>(
  response: ServerResponse,
  data: readonly TRow[],
  url: URL,
  request: IncomingMessage,
  cursorValue: (row: TRow) => string,
): void {
  const page = paginatedCollectionResponse(data, url, cursorValue);
  if (!page.ok) {
    writeJsonResponse(response, 400, { error: page.error }, request);
    return;
  }
  writeJsonResponse(response, 200, page.body, request);
}

function writeValidatedLocalCollectionResponse<TRow extends { readonly id: string }>(
  response: ServerResponse,
  data: readonly TRow[],
  url: URL,
  request: IncomingMessage,
  cursorValue: (row: TRow) => string,
  supportedFilters: readonly string[],
  extra?: Record<string, unknown>,
): boolean {
  const queryError = validateLocalCollectionQuery(url, supportedFilters);
  if (queryError !== undefined) {
    writeJsonResponse(response, 400, queryError, request);
    return false;
  }
  const page = paginatedCollectionResponse(data, url, cursorValue);
  if (!page.ok) {
    writeJsonResponse(response, 400, { error: page.error }, request);
    return false;
  }
  writeJsonResponse(response, 200, extra === undefined ? page.body : {
    ...page.body,
    ...extra,
  }, request);
  return true;
}

function paginatedCollectionResponse<TRow extends { readonly id: string }>(
  data: readonly TRow[],
  url: URL,
  cursorValue: (row: TRow) => string,
): { readonly ok: false; readonly error: 'invalid_cursor' | 'invalid_limit' } | {
  readonly ok: true;
  readonly body: {
    readonly data: readonly unknown[];
    readonly page: {
      readonly limit: number;
      readonly nextCursor: string | null;
    };
  };
} {
  const limitValue = url.searchParams.get('limit');
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, error: 'invalid_limit' };
  }
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam === null ? undefined : decodeLocalPageCursor(cursorParam);
  if (cursorParam !== null && cursor === undefined) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const offset = cursor === undefined
    ? 0
    : data.findIndex((row) => cursorValue(row) === cursor.value && row.id === cursor.id) + 1;
  if (cursor !== undefined && offset === 0) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const pageData = data.slice(offset, offset + limit);
  const last = pageData.at(-1);
  const hasNext = offset + limit < data.length;
  return {
    ok: true,
    body: {
      data: pageData,
      page: {
        limit,
        nextCursor: hasNext && last !== undefined
          ? encodeLocalPageCursor({ value: cursorValue(last), id: last.id })
          : null,
      },
    },
  };
}

type LocalPageCursor = {
  readonly value: string;
  readonly id: string;
};

function encodeLocalPageCursor(cursor: LocalPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeLocalPageCursor(value: string): LocalPageCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LocalPageCursor>;
    if (typeof parsed.value !== 'string' || typeof parsed.id !== 'string') {
      return undefined;
    }
    return { value: parsed.value, id: parsed.id };
  } catch {
    return undefined;
  }
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

function preflightMethodsForLocalPath(pathname: string, options: RainrailStartOptions): readonly string[] | undefined {
  if (pathname === '/healthz') return ['GET', 'OPTIONS'];
  if (pathname === '/events') return ['GET', 'OPTIONS'];
  if (pathname === '/api/state') return ['GET', 'OPTIONS'];
  if (pathname === '/api/v1/overview') return ['GET', 'OPTIONS'];
  if (pathname === '/api/v1/events') return ['GET', 'OPTIONS'];
  if (/^\/api\/v1\/events\/[^/]+$/u.test(pathname)) return ['GET', 'OPTIONS'];
  if (localDashboardCommandForPath(pathname) !== undefined) return ['POST', 'OPTIONS'];
  if (
    pathname === '/api/v1/workflow-runs' ||
    pathname === '/api/v1/agent-tasks' ||
    pathname === '/api/v1/sources' ||
    pathname === '/api/v1/queue' ||
    pathname === '/api/v1/settings'
  ) {
    return ['GET', 'OPTIONS'];
  }
  if (options.sources.some((source) => source.endpoint === pathname)) {
    return ['POST', 'OPTIONS'];
  }
  return undefined;
}

function writeCorsPreflightResponse(
  response: ServerResponse,
  allowedMethods: readonly string[] | undefined,
  request: IncomingMessage,
): void {
  response.writeHead(204, {
    ...localCorsHeaders,
    ...localOriginCorsHeader(request),
    ...(allowedMethods === undefined ? {} : {
      'Access-Control-Allow-Methods': allowedMethods.join(', '),
    }),
  });
  response.end();
}

function writeJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  request?: IncomingMessage,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(statusCode, {
    ...localCorsHeaders,
    ...localOriginCorsHeader(request),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function localOriginCorsHeader(request: IncomingMessage | undefined): { readonly 'Access-Control-Allow-Origin'?: string; readonly Vary?: string } {
  const origin = request?.headers.origin;
  if (typeof origin !== 'string' || !isAllowedLocalCorsOrigin(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

function isAllowedLocalCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function expandConfigEnv(raw: string, env: Record<string, string | undefined>): string {
  return raw
    .replace(
      /(:\s*)\$\{([A-Z0-9_]+)\}/gu,
      (_match, prefix: string, name: string) => `${prefix}${env[name] ?? ''}`,
    )
    .replace(
      /([\[,]\s*)\$\{([A-Z0-9_]+)\}/gu,
      (_match, prefix: string, name: string) => `${prefix}${env[name] ?? ''}`,
    )
    .replace(
      /\$\{([A-Z0-9_]+)\}/gu,
      (_match, name: string) => escapeJsonStringContent(env[name] ?? ''),
    );
}

function markWebhookSecretEnvExpansions(raw: string, env: Record<string, string | undefined>): string {
  const markerEnv = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value === undefined ? undefined : markWebhookSecretEnvReferences(value, env),
    ]),
  ) as Record<string, string | undefined>;
  const marked = markWebhookSecretEnvReferences(raw, env);
  return expandConfigEnv(marked, markerEnv);
}

function markWebhookSecretEnvReferences(raw: string, env: Record<string, string | undefined>): string {
  return raw.replace(
    /("webhookSecret"\s*:\s*)"\$\{([A-Z0-9_]+)\}"/gu,
    (_match, prefix: string, name: string) => `${prefix}${JSON.stringify({
      __rainrailWebhookSecretEnv: name,
      value: env[name] ?? '',
    })}`,
  );
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
