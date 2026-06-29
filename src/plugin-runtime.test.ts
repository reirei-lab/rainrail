import { describe, expect, it, vi } from 'vitest';

import {
  createEventEnvelope,
  createPluginLoader,
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

  it('isolates accepts predicate failures to the failing workflow result', async () => {
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
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'malformed-event-sensitive-router',
          accepts: () => {
            throw new Error('unexpected event shape');
          },
          handle: async () => ({ unreachable: true }),
        }),
        defineWorkflowPlugin({
          name: 'later-router',
          accepts: () => true,
          handle: laterHandler,
        }),
      ],
      runtime: {
        runId: 'run-1',
        now: () => new Date('2026-06-29T13:01:00.000Z'),
        capabilities: { provider: 'codex' },
      },
    });

    const results = await dispatcher.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'malformed-event-sensitive-router',
      eventId: 'github-webhook:delivery-12:github.issue',
      status: 'rejected',
    });
    expect(results[0]?.reason).toBeInstanceOf(Error);
    expect(results[1]).toEqual({
      pluginName: 'later-router',
      eventId: 'github-webhook:delivery-12:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledWith(event, expect.objectContaining({ runId: 'run-1' }));
  });

  it('loads packaged plugins and local handlers into the same event runtime', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-13',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-13',
      },
    });
    const packagedHandler = vi.fn(async () => ({ packaged: true }));
    const localHandler = vi.fn(async () => ({ local: true }));
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
      },
      audit: {
        record: async (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.register(
      defineWorkflowPlugin({
        name: 'packaged-issue-plugin',
        accepts: (candidate) => candidate.name === 'github.issue',
        handle: packagedHandler,
      }),
    );
    loader.on('github.issue', localHandler, { name: 'local-issue-handler' });

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'packaged-issue-plugin',
        eventId: 'github-webhook:delivery-13:github.issue',
        status: 'fulfilled',
        value: { packaged: true },
      },
      {
        pluginName: 'local-issue-handler',
        eventId: 'github-webhook:delivery-13:github.issue',
        status: 'fulfilled',
        value: { local: true },
      },
    ]);
    expect(packagedHandler).toHaveBeenCalledOnce();
    expect(localHandler).toHaveBeenCalledOnce();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'packaged-issue-plugin',
          eventId: 'github-webhook:delivery-13:github.issue',
          action: 'plugin.handle',
          result: 'fulfilled',
        }),
        expect.objectContaining({
          pluginId: 'local-issue-handler',
          eventId: 'github-webhook:delivery-13:github.issue',
          action: 'plugin.handle',
          result: 'fulfilled',
        }),
      ]),
    );
  });

  it('denies dangerous runtime actions when a handler lacks the declared capability', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-merge',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-merge',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
        actions: { mergePullRequest },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on('github.pull_request', async (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }), {
      name: 'unsafe-local-handler',
    });

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'unsafe-local-handler',
      eventId: 'github-webhook:delivery-merge:github.pull_request',
      status: 'rejected',
    });
    expect(result?.reason).toBeInstanceOf(Error);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'unsafe-local-handler',
          eventId: 'github-webhook:delivery-merge:github.pull_request',
          action: 'mergePullRequest',
          result: 'denied',
        }),
      ]),
    );
  });

  it('allows declared capabilities and audits the action result without exposing secrets as values', async () => {
    const event = createEventEnvelope({
      source: { type: 'system', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: {
        id: 'delivery-secret',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: {},
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'redacted://delivery-secret',
      },
    });
    const readSecret = vi.fn(async () => 'super-secret-value');
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'local' },
        actions: { readSecret },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.register(
      defineWorkflowPlugin({
        name: 'secret-aware-plugin',
        capabilities: ['secret:access'],
        accepts: (candidate) => candidate.name === 'system.secret-requested',
        async handle(_event, context) {
          return {
            present: Boolean(await context.actions.readSecret({ name: 'api-token' })),
          };
        },
      }),
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'secret-aware-plugin',
        eventId: 'local-runtime:delivery-secret:system.secret-requested',
        status: 'fulfilled',
        value: { present: true },
      },
    ]);
    expect(readSecret).toHaveBeenCalledWith({ name: 'api-token' });
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'secret-aware-plugin',
          eventId: 'local-runtime:delivery-secret:system.secret-requested',
          action: 'readSecret',
          result: 'fulfilled',
        }),
      ]),
    );
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
  });

  it('isolates handler failures and timeouts without stopping later plugins', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-timeout',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-timeout',
        },
      });
      const laterHandler = vi.fn(async () => ({ continued: true }));
      const auditEntries: unknown[] = [];
      const loader = createPluginLoader({
        runtime: {
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          capabilities: { provider: 'codex' },
        },
        defaultTimeoutMs: 25,
        audit: {
          record: (entry) => {
            auditEntries.push(entry);
          },
        },
      });

      loader.on(
        'github.issue',
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ unreachable: true }), 1000);
          }),
        { name: 'slow-local-handler' },
      );
      loader.on('github.issue', laterHandler, { name: 'later-local-handler' });

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'slow-local-handler',
          eventId: 'github-webhook:delivery-timeout:github.issue',
          status: 'rejected',
        },
        {
          pluginName: 'later-local-handler',
          eventId: 'github-webhook:delivery-timeout:github.issue',
          status: 'fulfilled',
          value: { continued: true },
        },
      ]);
      expect(laterHandler).toHaveBeenCalledOnce();
      expect(auditEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'slow-local-handler',
            eventId: 'github-webhook:delivery-timeout:github.issue',
            action: 'plugin.handle',
            result: 'timeout',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
