import { readFile } from 'node:fs/promises';

import type { GitHubAuthConfig } from './github-auth.js';
import type { RainrailEventSourceType } from './events.js';

export interface SourceProviderConfig {
  type: RainrailEventSourceType;
  name: string;
  webhookSecret?: string;
  endpoint?: string;
}

export interface OpenClawRuntimeProviderConfig {
  enabled: boolean;
  command: string;
  agentId: string;
  sessionKeyPrefix: string;
  timeoutSeconds: number;
  logDirectory: string;
}

export interface TaskProviderConfig {
  github: GitHubAuthConfig;
}

export interface RuntimeProviderConfig {
  openclaw: OpenClawRuntimeProviderConfig;
}

export interface RainrailConfig {
  sources: SourceProviderConfig[];
  taskProviders: TaskProviderConfig;
  runtimeProviders: RuntimeProviderConfig;
}

const defaultGitHubTaskProviderConfig: GitHubAuthConfig = {};

const defaultOpenClawRuntimeProviderConfig: OpenClawRuntimeProviderConfig = {
  enabled: false,
  command: 'openclaw',
  agentId: 'main',
  sessionKeyPrefix: 'rainrail',
  timeoutSeconds: 600,
  logDirectory: 'var/agent-task-logs',
};

export async function loadConfig(path: string): Promise<RainrailConfig> {
  const raw = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(expandEnv(raw)) as unknown);
}

export function parseConfig(value: unknown): RainrailConfig {
  if (!isRecord(value)) {
    throw new Error('config must be an object');
  }

  return {
    sources: parseSources(value.sources),
    taskProviders: parseTaskProviders(value.taskProviders),
    runtimeProviders: parseRuntimeProviders(value.runtimeProviders),
  };
}

function parseSources(value: unknown): SourceProviderConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('config.sources must be an array');
  }
  return value.map((source, index) => parseSource(source, `config.sources[${index}]`));
}

function parseSource(value: unknown, path: string): SourceProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  const source: SourceProviderConfig = {
    type: parseRequiredString(value.type, `${path}.type`) as RainrailEventSourceType,
    name: parseRequiredString(value.name, `${path}.name`),
  };
  const webhookSecret = parseOptionalString(value.webhookSecret, `${path}.webhookSecret`);
  const endpoint = parseOptionalString(value.endpoint, `${path}.endpoint`);
  if (webhookSecret !== undefined) {
    source.webhookSecret = webhookSecret;
  }
  if (endpoint !== undefined) {
    source.endpoint = endpoint;
  }
  return source;
}

function parseTaskProviders(value: unknown): TaskProviderConfig {
  if (value === undefined) {
    return { github: { ...defaultGitHubTaskProviderConfig } };
  }
  if (!isRecord(value)) {
    throw new Error('config.taskProviders must be an object');
  }
  return {
    github: parseGitHubAuthConfig(value.github, 'config.taskProviders.github'),
  };
}

function parseRuntimeProviders(value: unknown): RuntimeProviderConfig {
  if (value === undefined) {
    return { openclaw: { ...defaultOpenClawRuntimeProviderConfig } };
  }
  if (!isRecord(value)) {
    throw new Error('config.runtimeProviders must be an object');
  }
  return {
    openclaw: parseOpenClawRuntimeProvider(value.openclaw),
  };
}

function parseOpenClawRuntimeProvider(value: unknown): OpenClawRuntimeProviderConfig {
  if (value === undefined) {
    return { ...defaultOpenClawRuntimeProviderConfig };
  }
  if (!isRecord(value)) {
    throw new Error('config.runtimeProviders.openclaw must be an object');
  }

  return {
    enabled: parseOptionalBoolean(value.enabled, 'config.runtimeProviders.openclaw.enabled')
      ?? defaultOpenClawRuntimeProviderConfig.enabled,
    command: parseOptionalString(value.command, 'config.runtimeProviders.openclaw.command')
      ?? defaultOpenClawRuntimeProviderConfig.command,
    agentId: parseOptionalString(value.agentId, 'config.runtimeProviders.openclaw.agentId')
      ?? defaultOpenClawRuntimeProviderConfig.agentId,
    sessionKeyPrefix: parseOptionalString(value.sessionKeyPrefix, 'config.runtimeProviders.openclaw.sessionKeyPrefix')
      ?? defaultOpenClawRuntimeProviderConfig.sessionKeyPrefix,
    timeoutSeconds: parseOptionalNonNegativeNumber(value.timeoutSeconds, 'config.runtimeProviders.openclaw.timeoutSeconds')
      ?? defaultOpenClawRuntimeProviderConfig.timeoutSeconds,
    logDirectory: parseOptionalString(value.logDirectory, 'config.runtimeProviders.openclaw.logDirectory')
      ?? defaultOpenClawRuntimeProviderConfig.logDirectory,
  };
}

function parseGitHubAuthConfig(value: unknown, path: string): GitHubAuthConfig {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  const config: GitHubAuthConfig = {};
  const token = parseOptionalString(value.token, `${path}.token`);
  const githubApp = parseGitHubAppAuthConfig(value.githubApp, `${path}.githubApp`);
  if (token !== undefined) {
    config.token = token;
  }
  if (githubApp !== undefined) {
    config.githubApp = githubApp;
  }
  return config;
}

function parseGitHubAppAuthConfig(value: unknown, path: string): GitHubAuthConfig['githubApp'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    appId: parseRequiredString(value.appId, `${path}.appId`),
    installationId: parseRequiredString(value.installationId, `${path}.installationId`),
    privateKeyPath: parseRequiredString(value.privateKeyPath, `${path}.privateKeyPath`),
  };
}

function parseRequiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function parseOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseRequiredString(value, path);
}

function parseOptionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  if (value < 0) {
    throw new Error(`${path} must be a finite non-negative number`);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function expandEnv(raw: string): string {
  return raw.replace(
    /\$\{([A-Z0-9_]+)\}/gu,
    (_match, name: string) => escapeJsonStringContent(process.env[name] ?? ''),
  );
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
