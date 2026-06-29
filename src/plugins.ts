import type { RainrailEventEnvelope, RainrailEventSourceType, RainrailRawPayloadReference } from './events.js';

export interface SourcePluginNormalizeContext {
  pluginName: string;
  deliveryId: string;
  receivedAt: string;
  metadata: Record<string, string>;
  rawPayload: RainrailRawPayloadReference;
}

export interface SourcePlugin<TInput = unknown, TEvent extends RainrailEventEnvelope = RainrailEventEnvelope> {
  name: string;
  sourceType: RainrailEventSourceType;
  normalize(input: TInput, context: SourcePluginNormalizeContext): TEvent | Promise<TEvent>;
}

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
  capabilities: RuntimeCapabilities;
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

export function defineSourcePlugin<TInput, TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
  plugin: SourcePlugin<TInput, TEvent>,
): SourcePlugin<TInput, TEvent> {
  return plugin;
}

export function defineWorkflowPlugin<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
  plugin: WorkflowPlugin<TEvent>,
): WorkflowPlugin<TEvent> {
  return plugin;
}
