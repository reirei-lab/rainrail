import { describe, expect, it, vi } from 'vitest';

import {
  createEventEnvelope,
  createRuntimeDispatcher,
  defineSourcePlugin,
  defineWorkflowPlugin,
  type RainrailEventEnvelope,
} from './index.js';

describe('Rainrail neutral event model', () => {
  it('wraps GitHub issue webhooks without leaking GitHub-specific routing into the envelope', () => {
    const event = createEventEnvelope({
      source: {
        type: 'github',
        name: 'github-webhook',
        repository: 'reirei-lab/rainrail',
      },
      name: 'github.issue',
      delivery: {
        id: 'gh-delivery-1',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      occurredAt: '2026-06-29T13:00:44.000Z',
      subject: {
        type: 'issue',
        id: '12',
        url: 'https://github.com/reirei-lab/rainrail/issues/12',
      },
      payload: {
        action: 'opened',
        issue: { number: 12, title: 'Define plugin runtime contract' },
      },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/gh-delivery-1',
      },
    });

    expect(event).toMatchObject({
      id: 'github-webhook:gh-delivery-1:github.issue',
      schemaVersion: 'rainrail.event.v1',
      source: {
        type: 'github',
        name: 'github-webhook',
        repository: 'reirei-lab/rainrail',
      },
      name: 'github.issue',
      delivery: {
        id: 'gh-delivery-1',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      subject: {
        type: 'issue',
        id: '12',
      },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/gh-delivery-1',
      },
    });
  });

  it('can represent GitHub and Cloudflare development events with the same envelope', () => {
    const examples = [
      ['github.pull_request', 'github', 'pull_request'],
      ['github.check_run', 'github', 'check_run'],
      ['github.review', 'github', 'review'],
      ['cloudflare.tail', 'cloudflare', 'worker'],
      ['cloudflare.error', 'cloudflare', 'worker'],
    ] as const;

    for (const [name, sourceType, subjectType] of examples) {
      const event = createEventEnvelope({
        source: { type: sourceType, name: `${sourceType}-source` },
        name,
        delivery: {
          id: `${name}-delivery`,
          receivedAt: '2026-06-29T13:00:44.000Z',
        },
        occurredAt: '2026-06-29T13:00:44.000Z',
        subject: { type: subjectType, id: `${name}-subject` },
        payload: { sample: true },
        rawPayload: {
          kind: 'external-reference',
          reference: `${sourceType}://deliveries/${name}`,
        },
      });

      expect(event.name).toBe(name);
      expect(event.source.type).toBe(sourceType);
      expect(event.subject?.type).toBe(subjectType);
    }
  });
});

describe('plugin runtime contract', () => {
  it('lets source plugins produce normalized events', async () => {
    const plugin = defineSourcePlugin<{ action: string; issue: { number: number } }>({
      name: 'github-issues',
      sourceType: 'github',
      async normalize(input, context) {
        return createEventEnvelope({
          source: {
            type: 'github',
            name: context.pluginName,
            repository: context.metadata.repository ?? 'unknown',
          },
          name: 'github.issue',
          delivery: {
            id: context.deliveryId,
            receivedAt: context.receivedAt,
          },
          occurredAt: context.receivedAt,
          subject: {
            type: 'issue',
            id: String(input.issue.number),
          },
          payload: input,
          rawPayload: context.rawPayload,
        });
      },
    });

    await expect(
      plugin.normalize(
        { action: 'opened', issue: { number: 12 } },
        {
          pluginName: plugin.name,
          deliveryId: 'delivery-12',
          receivedAt: '2026-06-29T13:00:44.000Z',
          metadata: { repository: 'reirei-lab/rainrail' },
          rawPayload: {
            kind: 'external-reference',
            reference: 'github://deliveries/delivery-12',
          },
        },
      ),
    ).resolves.toMatchObject({
      name: 'github.issue',
      subject: { type: 'issue', id: '12' },
    });
  });

  it('dispatches matching workflow plugins with capability context', async () => {
    const handler = vi.fn(async () => ({ queued: true }));
    const workflow = defineWorkflowPlugin({
      name: 'issue-router',
      accepts: (event: RainrailEventEnvelope) => event.name === 'github.issue',
      handle: handler,
    });
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: {
        runId: 'run-1',
        now: () => new Date('2026-06-29T13:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent: async () => ({ sessionKey: 'agent:main:rainrail-12' }),
        },
      },
    });
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-12',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      occurredAt: '2026-06-29T13:00:44.000Z',
      subject: { type: 'issue', id: '12' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-12',
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'issue-router',
        eventId: 'github-webhook:delivery-12:github.issue',
        status: 'fulfilled',
        value: { queued: true },
      },
    ]);
    expect(handler).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        runId: 'run-1',
        capabilities: expect.objectContaining({ provider: 'codex' }),
      }),
    );
  });
});
