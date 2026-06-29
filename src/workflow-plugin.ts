import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeProvider } from './runtime-provider.js';
import type { TaskProviderRegistry } from './task-provider.js';

export interface RuntimeCapabilities {
  provider: string;
  dispatchAgent?: (request: {
    event: RainrailEventEnvelope;
    workflow: string;
    runId: string;
  }) => Promise<unknown>;
  [capability: string]: unknown;
}

export interface PluginRuntimeContext {
  runId: string;
  now: () => Date;
  providers: TaskProviderRegistry;
  runtime: RuntimeProvider;
  capabilities?: RuntimeCapabilities;
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
  accepts?: (event: RainrailEventEnvelope) => boolean;
  handle(event: TEvent, context: PluginRuntimeContext): unknown | Promise<unknown>;
}

export function defineWorkflowPlugin<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
  plugin: WorkflowPlugin<TEvent>,
): WorkflowPlugin<TEvent> {
  return plugin;
}
