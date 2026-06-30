import type { RainrailEventEnvelope } from './events.js';

export const rainrailSseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
} as const;

export function formatRainrailSseEvent(event: RainrailEventEnvelope): string {
  const id = formatSseFieldValue('id', event.id);
  const name = formatSseFieldValue('event', event.name);

  return [`id: ${id}`, `event: ${name}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
}

export function formatRainrailSseComment(comment: string): string {
  if (/[\r\n]/u.test(comment)) {
    throw new TypeError('SSE comment must not contain CR or LF');
  }

  return `: ${comment}\n\n`;
}

function formatSseFieldValue(field: string, value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new TypeError(`SSE field "${field}" must not contain CR or LF`);
  }

  if (field === 'id' && value.includes('\u0000')) {
    throw new TypeError('SSE field "id" must not contain NUL');
  }

  return value;
}
