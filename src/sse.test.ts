import { describe, expect, it } from 'vitest';

import { createEventEnvelope, formatRainrailSseEvent, rainrailSseHeaders } from './index.js';

describe('Rainrail SSE formatting', () => {
  it('formats a Rainrail event envelope with its neutral event name', () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-17',
        receivedAt: '2026-06-29T18:18:21.000Z',
      },
      occurredAt: '2026-06-29T18:18:20.000Z',
      subject: { type: 'issue', id: '17', url: 'https://github.com/reirei-lab/rainrail/issues/17' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-17',
      },
    });

    const text = formatRainrailSseEvent(event);
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));

    expect(text).toMatch(/^id: github-webhook:delivery-17:github\.issue\n/);
    expect(text).toContain('\nevent: github.issue\n');
    expect(text.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(dataLine?.slice('data: '.length) ?? '')).toMatchObject({
      id: event.id,
      schemaVersion: 'rainrail.event.v1',
      name: 'github.issue',
      source: {
        type: 'github',
        name: 'github-webhook',
        repository: 'reirei-lab/rainrail',
      },
      payload: { action: 'opened' },
    });
  });

  it('defines SSE headers shared by Node and Worker endpoints', () => {
    expect(rainrailSseHeaders).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });
});
