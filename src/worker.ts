import { RainrailBridgeRoom as CoreRainrailBridgeRoom, type RainrailBridgeRoomState } from './bridge-room.js';
import {
  createRainrailEepBridgeIntakeAdaptersFromConfig,
  createRainrailEepBridgeIntakeAdaptersFromEnv,
  type RainrailEepBridgeBundleEnv,
} from './eep-bridge-bundle.js';
import { parseConfig, type RainrailConfig } from './config.js';
import { createRainrailHttpApp } from './http-app.js';

export interface RainrailWorkerEnv extends RainrailEepBridgeBundleEnv {
  BRIDGE_ROOM: {
    idFromName(name: string): unknown;
    get(id: unknown): RainrailWorkerBridgeRoom;
  };
  BRIDGE_ID?: string;
  RAINRAIL_PUBLISH_TOKEN: string;
  RAINRAIL_REPLAY_LIMIT?: string;
  RAINRAIL_KEEP_ALIVE_INTERVAL_MS?: string;
  RAINRAIL_CONFIG_JSON?: string;
  SSE_BEARER_TOKEN?: string;
}

export interface RainrailWorkerBridgeRoom {
  fetch(request: Request): Response | Promise<Response>;
}

export interface RainrailWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export class RainrailBridgeRoomDurableObject implements RainrailWorkerBridgeRoom {
  readonly #room: CoreRainrailBridgeRoom;

  constructor(state: RainrailBridgeRoomState, env: RainrailWorkerEnv) {
    this.#room = new CoreRainrailBridgeRoom(state, {
      publishToken: env.RAINRAIL_PUBLISH_TOKEN,
      ...optionalIntegerOption('replayLimit', env.RAINRAIL_REPLAY_LIMIT),
      ...optionalIntegerOption('keepAliveIntervalMs', env.RAINRAIL_KEEP_ALIVE_INTERVAL_MS),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.#room.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: RainrailWorkerEnv): Promise<Response> {
    return workerApp(env).fetch(request);
  },

  tail(events: unknown[], env: RainrailWorkerEnv, ctx: RainrailWorkerExecutionContext): void {
    ctx.waitUntil(workerApp(env).tail?.(events) ?? Promise.resolve([]));
  },
};

interface WorkerParsedConfig {
  readonly config: RainrailConfig;
  readonly configuresSourceBundles: boolean;
}

function workerApp(env: RainrailWorkerEnv) {
  const parsedConfig = workerConfig(env);
  return createRainrailHttpApp({
    room: bridgeRoom(env),
    publishToken: env.RAINRAIL_PUBLISH_TOKEN,
    ...(env.SSE_BEARER_TOKEN === undefined ? {} : { eventsBearerToken: env.SSE_BEARER_TOKEN }),
    ...(parsedConfig === undefined ? {} : { dashboardAuth: parsedConfig.config.dashboardAuth }),
    runtime: 'cloudflare-workers',
    intakeAdapters: workerIntakeAdapters(env, parsedConfig),
  });
}

function workerIntakeAdapters(env: RainrailWorkerEnv, parsedConfig: WorkerParsedConfig | undefined) {
  if (parsedConfig === undefined || !parsedConfig.configuresSourceBundles) {
    return createRainrailEepBridgeIntakeAdaptersFromEnv(env);
  }

  return createRainrailEepBridgeIntakeAdaptersFromConfig({
    config: parsedConfig.config,
    env,
  });
}

function workerConfig(env: RainrailWorkerEnv): WorkerParsedConfig | undefined {
  if (env.RAINRAIL_CONFIG_JSON === undefined || env.RAINRAIL_CONFIG_JSON.length === 0) {
    return undefined;
  }
  const configValue = JSON.parse(expandWorkerConfigEnv(env.RAINRAIL_CONFIG_JSON, stringEnv(env))) as unknown;
  if (isWorkerConfigRecord(configValue)) {
    delete configValue.operationalStore;
  }

  return {
    config: parseConfig(configValue),
    configuresSourceBundles: hasTopLevelJsonProperty(env.RAINRAIL_CONFIG_JSON, 'sourceBundles'),
  };
}

function expandWorkerConfigEnv(raw: string, env: Record<string, string | undefined>): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, name: string) => env[name] ?? '');
}

function isWorkerConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTopLevelJsonProperty(raw: string, propertyName: string): boolean {
  const objectStart = raw.indexOf('{');
  if (objectStart < 0) {
    return false;
  }

  let depth = 0;
  for (let index = objectStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const stringEnd = findJsonStringEnd(raw, index);
      if (stringEnd === undefined) {
        return false;
      }
      if (depth === 1) {
        const name = parseJsonStringLiteral(raw.slice(index, stringEnd + 1));
        const cursor = skipJsonWhitespace(raw, stringEnd + 1);
        if (name === propertyName && raw[cursor] === ':') {
          return true;
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
        return false;
      }
    }
  }
  return false;
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

function stringEnv(env: RainrailWorkerEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function bridgeRoom(env: RainrailWorkerEnv): RainrailWorkerBridgeRoom {
  const id = env.BRIDGE_ROOM.idFromName(env.BRIDGE_ID ?? 'events');

  return env.BRIDGE_ROOM.get(id);
}

function optionalIntegerOption(name: 'replayLimit' | 'keepAliveIntervalMs', value: string | undefined): Record<typeof name, number> | {} {
  if (value === undefined) return {};
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? { [name]: parsed } as Record<typeof name, number> : {};
}
