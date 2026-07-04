import { RainrailBridgeRoom as CoreRainrailBridgeRoom, type RainrailBridgeRoomState } from './bridge-room.js';
import {
  createRainrailEepBridgeIntakeAdaptersFromConfig,
  createRainrailEepBridgeIntakeAdaptersFromEnv,
  type RainrailEepBridgeBundleEnv,
} from './eep-bridge-bundle.js';
import { parseConfigJson } from './config.js';
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

function workerApp(env: RainrailWorkerEnv) {
  return createRainrailHttpApp({
    room: bridgeRoom(env),
    publishToken: env.RAINRAIL_PUBLISH_TOKEN,
    ...(env.SSE_BEARER_TOKEN === undefined ? {} : { eventsBearerToken: env.SSE_BEARER_TOKEN }),
    runtime: 'cloudflare-workers',
    intakeAdapters: workerIntakeAdapters(env),
  });
}

function workerIntakeAdapters(env: RainrailWorkerEnv) {
  if (env.RAINRAIL_CONFIG_JSON === undefined) {
    return createRainrailEepBridgeIntakeAdaptersFromEnv(env);
  }

  return createRainrailEepBridgeIntakeAdaptersFromConfig({
    config: parseConfigJson(env.RAINRAIL_CONFIG_JSON, stringEnv(env)),
    env,
  });
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
