import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeProvider } from './runtime-provider.js';
import type { TaskProviderRegistry } from './task-provider.js';

export interface RuntimeCapabilities {
  provider: string;
  dispatchAgent?: (request: {
    event: RainrailEventEnvelope;
    workflow: string;
    runId: string;
  }, context?: RuntimeActionContext) => Promise<unknown>;
  [capability: string]: unknown;
}

export type RuntimeCapabilityName = 'merge' | 'runtime:start' | 'secret:access' | (string & {});

export interface RuntimeActionContext {
  signal: AbortSignal;
}

export interface RuntimeActions {
  mergePullRequest(request: { pullRequestId: string; [key: string]: unknown }): Promise<unknown>;
  startRuntime(request: { runtimeId: string; [key: string]: unknown }): Promise<unknown>;
  readSecret(request: { name: string; [key: string]: unknown }): Promise<string>;
}

export interface RuntimeActionImplementations {
  mergePullRequest(
    request: { pullRequestId: string; [key: string]: unknown },
    context: RuntimeActionContext,
  ): Promise<unknown>;
  startRuntime(request: { runtimeId: string; [key: string]: unknown }, context: RuntimeActionContext): Promise<unknown>;
  readSecret(request: { name: string; [key: string]: unknown }, context: RuntimeActionContext): Promise<string>;
}

export interface PluginRuntimeContext {
  runId: string;
  now: () => Date;
  providers: TaskProviderRegistry;
  runtime: RuntimeProvider;
  capabilities?: RuntimeCapabilities;
  signal: AbortSignal;
  actions: RuntimeActions;
}

export interface WorkflowPluginResult {
  pluginName: string;
  eventId: string;
  status: 'fulfilled' | 'rejected';
  value?: unknown;
  reason?: unknown;
}

export interface WorkflowPlugin<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope> {
  name: string;
  capabilities?: RuntimeCapabilityName[];
  timeoutMs?: number;
  accepts?: (event: RainrailEventEnvelope) => boolean;
  handle(event: TEvent, context: PluginRuntimeContext): unknown | Promise<unknown>;
}

export function defineWorkflowPlugin<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
  plugin: WorkflowPlugin<TEvent>,
): WorkflowPlugin<TEvent> {
  return plugin;
}
