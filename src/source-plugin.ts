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

export function defineSourcePlugin<TInput, TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
  plugin: SourcePlugin<TInput, TEvent>,
): SourcePlugin<TInput, TEvent> {
  return plugin;
}
