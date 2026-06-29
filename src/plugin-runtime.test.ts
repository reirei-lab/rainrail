import { describe, expect, it, vi } from 'vitest';

import {
  createEventEnvelope,
  createRuntimeDispatcher,
  defineSourcePlugin,
  defineWorkflowPlugin,
  type PluginRuntimeContext,
  type RainrailEventEnvelope,
} from './index.js';

function mockRuntimeContext(overrides: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  return {
    runId: 'run-1',
    now: () => new Date('2026-06-29T13:01:00.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider',
        getIssue: async () => ({
          id: 'issue:mock',
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 12,
          title: 'Mock issue',
        }),
        createComment: async () => ({ id: 'comment:mock' }),
      },
    },
    runtime: {
      name: 'mock-runtime',
      kind: 'runtime-provider',
      startRun: async () => ({
        id: 'run:mock',
        provider: 'codex',
        status: 'queued',
      }),
    },
    ...overrides,
  };
}

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
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent: async () => ({ sessionKey: 'agent:main:rainrail-12' }),
        },
      }),
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
        ...mockRuntimeContext(),
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

  it('lets workflow plugins compose mock task providers and runtimes through separated contracts', async () => {
    const getIssue = vi.fn(async () => ({
      id: 'issue:14',
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      number: 14,
      title: 'Split plugin contracts',
      url: 'https://github.com/reirei-lab/rainrail/issues/14',
    }));
    const createComment = vi.fn(async () => ({
      id: 'comment:queued',
      url: 'https://github.com/reirei-lab/rainrail/issues/14#issuecomment-queued',
    }));
    const startRun = vi.fn(async () => ({
      id: 'run:14',
      provider: 'openclaw',
      status: 'queued' as const,
      url: 'openclaw://sessions/agent:main:rainrail-14',
    }));
    const workflowName = 'issue-agent-workflow';
    const workflow = defineWorkflowPlugin({
      name: workflowName,
      accepts: (event) => event.name === 'github.issue' && event.subject.type === 'issue',
      async handle(event, context) {
        const issue = await context.providers.tasks.getIssue({
          provider: event.source.type,
          repository: event.source.repository ?? 'unknown',
          number: Number(event.subject.id),
        });

        const run = await context.runtime.startRun({
          workflow: workflowName,
          event,
          task: issue,
          requestedBy: workflowName,
        });

        await context.providers.tasks.createComment({
          target: issue,
          body: `Queued ${run.id}`,
        });

        return { issueId: issue.id, runId: run.id };
      },
    });
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: {
        runId: 'dispatch-14',
        now: () => new Date('2026-06-29T13:01:00.000Z'),
        providers: {
          tasks: {
            name: 'mock-github',
            kind: 'task-provider',
            getIssue,
            createComment,
          },
        },
        runtime: {
          name: 'mock-openclaw',
          kind: 'runtime-provider',
          startRun,
        },
      },
    });
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-14',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      occurredAt: '2026-06-29T13:00:44.000Z',
      subject: { type: 'issue', id: '14' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-14',
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'issue-agent-workflow',
        eventId: 'github-webhook:delivery-14:github.issue',
        status: 'fulfilled',
        value: { issueId: 'issue:14', runId: 'run:14' },
      },
    ]);
    expect(getIssue).toHaveBeenCalledWith({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      number: 14,
    });
    expect(startRun).toHaveBeenCalledWith({
      workflow: 'issue-agent-workflow',
      event,
      task: expect.objectContaining({ id: 'issue:14' }),
      requestedBy: 'issue-agent-workflow',
    });
    expect(createComment).toHaveBeenCalledWith({
      target: expect.objectContaining({ id: 'issue:14' }),
      body: 'Queued run:14',
    });
  });
});
