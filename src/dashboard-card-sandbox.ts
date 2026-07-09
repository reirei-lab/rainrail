import type { DashboardCardDefinition } from './dashboard-card-registry.js';
import type { RuntimeCapabilityName } from './workflow-plugin.js';

export type DashboardCardSandboxBridgeHandler = (request: unknown) => unknown | Promise<unknown>;

export interface DashboardCardSandboxHostOptions {
  cardBaseUrl: string;
  allowedCapabilities?: readonly RuntimeCapabilityName[];
  bridgeHandlers?: Readonly<Record<string, DashboardCardSandboxBridgeHandler>>;
  timeoutMs?: number;
}

export interface DashboardCardSandboxFrameOptions {
  layoutItemId?: string;
  settings?: Record<string, unknown>;
}

export interface DashboardCardSandboxBridge {
  capabilities: readonly RuntimeCapabilityName[];
  request(capability: RuntimeCapabilityName, request: unknown): Promise<unknown>;
}

export interface DashboardCardSandboxFrame {
  cardId: string;
  pluginName: string;
  cardName: string;
  title: string;
  src: string;
  sandbox: 'allow-scripts';
  referrerPolicy: 'no-referrer';
  loading: 'lazy';
  bridgeCapabilities: readonly RuntimeCapabilityName[];
  settings: Record<string, unknown>;
  bridge: DashboardCardSandboxBridge;
}

export type DashboardCardSandboxLoadResult<T> =
  | { status: 'loaded'; cardId: string; value: T }
  | { status: 'error'; cardId: string; error: string };

export interface DashboardCardSandboxHost {
  createFrame(
    definition: DashboardCardDefinition,
    options?: DashboardCardSandboxFrameOptions,
  ): DashboardCardSandboxFrame;
  load<T>(
    definition: DashboardCardDefinition,
    loader: (
      frame: DashboardCardSandboxFrame,
      bridge: DashboardCardSandboxBridge,
    ) => T | Promise<T>,
    options?: DashboardCardSandboxFrameOptions,
  ): Promise<DashboardCardSandboxLoadResult<Awaited<T>>>;
}

export function createDashboardCardSandboxHost(
  options: DashboardCardSandboxHostOptions,
): DashboardCardSandboxHost {
  const timeoutMs = options.timeoutMs ?? 5000;

  const createFrame = (
    definition: DashboardCardDefinition,
    frameOptions: DashboardCardSandboxFrameOptions = {},
  ): DashboardCardSandboxFrame => {
    if (definition.entry.type !== 'plugin') {
      throw new Error(`Dashboard card "${definition.id}" is not a plugin card`);
    }

    const bridgeCapabilities = grantedCapabilities(definition, options.allowedCapabilities);
    const bridge = createBridge(definition.id, bridgeCapabilities, options.bridgeHandlers ?? {});

    return {
      cardId: definition.id,
      pluginName: definition.entry.pluginName,
      cardName: definition.entry.cardName,
      title: definition.title,
      src: sandboxFrameSource(options.cardBaseUrl, definition, frameOptions.layoutItemId),
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      loading: 'lazy',
      bridgeCapabilities,
      settings: frameOptions.settings === undefined ? {} : structuredClone(frameOptions.settings),
      bridge,
    };
  };

  return {
    createFrame,
    async load(definition, loader, frameOptions) {
      const frame = createFrame(definition, frameOptions);
      try {
        const value = await withTimeout(
          Promise.resolve(loader(frame, frame.bridge)),
          timeoutMs,
        );
        return { status: 'loaded', cardId: definition.id, value };
      } catch {
        return {
          status: 'error',
          cardId: definition.id,
          error: 'Plugin card failed to load',
        };
      }
    },
  };
}

function createBridge(
  cardId: string,
  capabilities: readonly RuntimeCapabilityName[],
  handlers: Readonly<Record<string, DashboardCardSandboxBridgeHandler>>,
): DashboardCardSandboxBridge {
  const granted = new Set(capabilities);

  return {
    capabilities,
    async request(capability, request) {
      if (!granted.has(capability)) {
        throw new Error(`Capability "${capability}" is not available to dashboard card "${cardId}"`);
      }

      const handler = handlers[capability];
      if (handler === undefined) {
        throw new Error(`Capability "${capability}" does not have a dashboard card bridge handler`);
      }

      return handler(request);
    },
  };
}

function grantedCapabilities(
  definition: DashboardCardDefinition,
  allowedCapabilities: readonly RuntimeCapabilityName[] | undefined,
): RuntimeCapabilityName[] {
  const required = definition.requiredCapabilities ?? [];
  if (required.length === 0 || allowedCapabilities === undefined) return [];

  const allowed = new Set(allowedCapabilities);
  return required.filter((capability) => allowed.has(capability));
}

function sandboxFrameSource(
  cardBaseUrl: string,
  definition: DashboardCardDefinition,
  layoutItemId: string | undefined,
): string {
  if (definition.entry.type !== 'plugin') {
    throw new Error(`Dashboard card "${definition.id}" is not a plugin card`);
  }

  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//iu.test(cardBaseUrl);
  const baseUrl = isAbsolute ? ensureTrailingSlash(cardBaseUrl) : `https://rainrail.local${ensureLeadingSlash(ensureTrailingSlash(cardBaseUrl))}`;
  const url = new URL(`${encodeURIComponent(definition.entry.pluginName)}/${encodeURIComponent(definition.entry.cardName)}/`, baseUrl);
  url.searchParams.set('cardId', definition.id);
  if (layoutItemId !== undefined) url.searchParams.set('layoutItemId', layoutItemId);

  return isAbsolute ? url.href : `${url.pathname}${url.search}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Plugin card load timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}
