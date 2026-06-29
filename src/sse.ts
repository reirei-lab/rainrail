import type { RainrailEventEnvelope } from './events.js';

export const rainrailSseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export function formatRainrailSseEvent(event: RainrailEventEnvelope): string {
  return [`id: ${event.id}`, `event: ${event.name}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
}

export function formatRainrailSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
