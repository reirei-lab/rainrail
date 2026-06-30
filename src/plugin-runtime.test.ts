import { createContext, runInContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  createEventEnvelope,
  createPluginLoader,
  createRuntimeDispatcher,
  defineSourcePlugin,
  defineWorkflowPlugin,
  type PluginRuntimeContext,
  type RainrailEventEnvelope,
  type RuntimeCapabilities,
  type RuntimeCapabilityName,
  type RuntimeDispatcherContext,
  type TaskProvider,
  type WorkflowPlugin,
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
    signal: new AbortController().signal,
    actions: {
      mergePullRequest: async () => {
        throw new Error('mock mergePullRequest action is not configured');
      },
      startRuntime: async () => {
        throw new Error('mock startRuntime action is not configured');
      },
      readSecret: async () => {
        throw new Error('mock readSecret action is not configured');
      },
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
      capabilities: ['runtime:start'],
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
      runtime: mockRuntimeContext({
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
      }),
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
    expect(getIssue).toHaveBeenCalledWith(
      {
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 14,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(startRun).toHaveBeenCalledWith(
      {
        workflow: 'issue-agent-workflow',
        event,
        task: expect.objectContaining({ id: 'issue:14' }),
        requestedBy: 'issue-agent-workflow',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(createComment).toHaveBeenCalledWith(
      {
        target: expect.objectContaining({ id: 'issue:14' }),
        body: 'Queued run:14',
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not read unused provider getters when creating workflow contexts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-provider-getter',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      occurredAt: '2026-06-29T13:00:44.000Z',
      subject: { type: 'issue', id: '14' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-provider-getter',
      },
    });
    const getIssue = vi.fn(async () => ({
      id: 'issue:14',
      provider: 'github' as const,
      repository: 'reirei-lab/rainrail',
      number: 14,
      title: 'Lazy providers',
    }));
    let forgejoReads = 0;
    const providers: RuntimeDispatcherContext['providers'] = {
      tasks: {
        name: 'mock-github',
        kind: 'task-provider',
        getIssue,
        createComment: async () => ({ id: 'comment:unused' }),
      },
      get forgejo(): never {
        forgejoReads += 1;
        throw new Error('forgejo provider is not configured');
      },
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'lazy-provider-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          async handle(_handledEvent, context) {
            return context.providers.tasks.getIssue({
              provider: 'github',
              repository: 'reirei-lab/rainrail',
              number: 14,
            });
          },
        }),
      ],
      runtime: mockRuntimeContext({
        runId: 'dispatch-14',
        now: () => new Date('2026-06-29T13:01:00.000Z'),
        providers,
      }),
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'lazy-provider-handler',
        eventId: 'github-webhook:delivery-unused-provider-getter:github.issue',
        status: 'fulfilled',
        value: {
          id: 'issue:14',
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 14,
          title: 'Lazy providers',
        },
      },
    ]);
    expect(forgejoReads).toBe(0);
  });

  it('does not read unused provider registry getters when creating workflow contexts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-provider-registry-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-provider-registry-getter',
      },
    });
    let providerReads = 0;
    const runtime = {
      runId: 'run-13',
      now: () => new Date('2026-06-29T14:01:00.000Z'),
      get providers(): never {
        providerReads += 1;
        throw new Error('task providers are not configured');
      },
    } satisfies RuntimeDispatcherContext;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'unused-provider-registry-getter-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          handle: () => ({ ok: true }),
        }),
      ],
      runtime,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'unused-provider-registry-getter-handler',
        eventId: 'github-webhook:delivery-unused-provider-registry-getter:github.issue',
        status: 'fulfilled',
        value: { ok: true },
      },
    ]);
    expect(providerReads).toBe(0);
  });

  it('does not read unused optional task provider method getters', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-provider-method-getter',
        receivedAt: '2026-06-29T13:00:44.000Z',
      },
      occurredAt: '2026-06-29T13:00:44.000Z',
      subject: { type: 'issue', id: '14' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-provider-method-getter',
      },
    });
    let addToProjectReads = 0;
    const tasks = {
      name: 'mock-github',
      kind: 'task-provider' as const,
      getIssue: async () => ({
        id: 'issue:14',
        provider: 'github' as const,
        repository: 'reirei-lab/rainrail',
        number: 14,
        title: 'Lazy task methods',
      }),
      createComment: async () => ({ id: 'comment:unused' }),
      get addToProject(): never {
        addToProjectReads += 1;
        throw new Error('project integration is not configured');
      },
    } satisfies TaskProvider;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'lazy-task-method-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          async handle(_handledEvent, context) {
            return context.providers.tasks.getIssue({
              provider: 'github',
              repository: 'reirei-lab/rainrail',
              number: 14,
            });
          },
        }),
      ],
      runtime: mockRuntimeContext({
        runId: 'dispatch-14',
        now: () => new Date('2026-06-29T13:01:00.000Z'),
        providers: { tasks },
      }),
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'lazy-task-method-handler',
        eventId: 'github-webhook:delivery-unused-provider-method-getter:github.issue',
        status: 'fulfilled',
        value: {
          id: 'issue:14',
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 14,
          title: 'Lazy task methods',
        },
      },
    ]);
    expect(addToProjectReads).toBe(0);
  });

  it('checks lifecycle before reading optional task provider method getters', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-late-provider-method-getter',
          receivedAt: '2026-06-29T13:00:44.000Z',
        },
        occurredAt: '2026-06-29T13:00:44.000Z',
        subject: { type: 'issue', id: '14' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-late-provider-method-getter',
        },
      });
      let addToProjectReads = 0;
      const tasks = {
        name: 'mock-github',
        kind: 'task-provider' as const,
        getIssue: async () => ({
          id: 'issue:14',
          provider: 'github' as const,
          repository: 'reirei-lab/rainrail',
          number: 14,
          title: 'Late provider methods',
        }),
        createComment: async () => ({ id: 'comment:unused' }),
        get addToProject(): never {
          addToProjectReads += 1;
          throw new Error('project integration is not configured');
        },
      } satisfies TaskProvider;
      const lateErrors: unknown[] = [];
      const dispatcher = createRuntimeDispatcher({
        workflows: [
          defineWorkflowPlugin({
            name: 'late-provider-method-handler',
            accepts: (candidate) => candidate.name === 'github.issue',
            handle: (_handledEvent, context) => {
              setTimeout(() => {
                void (context.providers.tasks.addToProject?.({
                  target: {
                    provider: 'github',
                    id: 'issue:14',
                  },
                  project: 'backlog',
                }) as Promise<unknown> | undefined)?.catch((reason: unknown) => {
                  lateErrors.push(reason);
                });
              }, 1);
              return { queued: true };
            },
          }),
        ],
        runtime: mockRuntimeContext({
          runId: 'dispatch-14',
          now: () => new Date('2026-06-29T13:01:00.000Z'),
          providers: { tasks },
        }),
      });

      await expect(dispatcher.dispatch(event)).resolves.toEqual([
        {
          pluginName: 'late-provider-method-handler',
          eventId: 'github-webhook:delivery-late-provider-method-getter:github.issue',
          status: 'fulfilled',
          value: { queued: true },
        },
      ]);
      await vi.advanceTimersByTimeAsync(1);

      expect(addToProjectReads).toBe(0);
      expect(lateErrors).toEqual([expect.any(Error)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read unused runtime provider getters when creating workflow contexts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-runtime-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-runtime-getter',
      },
    });
    let runtimeReads = 0;
    const runtime = {
      runId: 'run-13',
      now: () => new Date('2026-06-29T14:01:00.000Z'),
      get runtime(): never {
        runtimeReads += 1;
        throw new Error('runtime provider is not configured');
      },
    } satisfies RuntimeDispatcherContext;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'unused-runtime-getter-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          handle: () => ({ ok: true }),
        }),
      ],
      runtime,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'unused-runtime-getter-handler',
        eventId: 'github-webhook:delivery-unused-runtime-getter:github.issue',
        status: 'fulfilled',
        value: { ok: true },
      },
    ]);
    expect(runtimeReads).toBe(0);
  });

  it('checks runtime:start capability before reading runtime provider getters', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-denied-runtime-provider-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-denied-runtime-provider-getter',
      },
    });
    let runtimeReads = 0;
    const runtime = {
      runId: 'run-13',
      now: () => new Date('2026-06-29T14:01:00.000Z'),
      get runtime(): never {
        runtimeReads += 1;
        throw new Error('runtime provider should not be read before denial');
      },
    } satisfies RuntimeDispatcherContext;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'denied-runtime-provider-getter-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          handle: (handledEvent, context) =>
            context.runtime.startRun({
              workflow: 'denied-runtime-provider-getter-handler',
              event: handledEvent,
              requestedBy: 'denied-runtime-provider-getter-handler',
            }),
        }),
      ],
      runtime,
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'denied-runtime-provider-getter-handler',
      eventId: 'github-webhook:delivery-denied-runtime-provider-getter:github.issue',
      status: 'rejected',
    });
    expect(runtimeReads).toBe(0);
  });

  it('does not read unused runtime capability getters when creating workflow contexts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-runtime-capabilities-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-runtime-capabilities-getter',
      },
    });
    let capabilityReads = 0;
    const runtime = {
      runId: 'run-13',
      now: () => new Date('2026-06-29T14:01:00.000Z'),
      get capabilities(): never {
        capabilityReads += 1;
        throw new Error('capabilities are not configured');
      },
    } satisfies RuntimeDispatcherContext;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'unused-runtime-capabilities-getter-handler',
          accepts: (candidate) => candidate.name === 'github.issue',
          handle: (_handledEvent, context) => context.runId,
        }),
      ],
      runtime,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'unused-runtime-capabilities-getter-handler',
        eventId: 'github-webhook:delivery-unused-runtime-capabilities-getter:github.issue',
        status: 'fulfilled',
        value: 'run-13',
      },
    ]);
    expect(capabilityReads).toBe(0);
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
    expect(readSecret).toHaveBeenCalledWith({ name: 'api-token' }, { signal: expect.any(AbortSignal) });
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

  it('denies gated actions that run after the handler timeout has fired', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.pull_request',
        delivery: {
          id: 'delivery-late-action',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'pull_request', id: '44' },
        payload: { action: 'synchronize' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-late-action',
        },
      });
      const mergePullRequest = vi.fn(async () => ({ merged: true }));
      let lateActionReason: unknown;
      const auditEntries: unknown[] = [];
      const loader = createPluginLoader({
        runtime: {
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          capabilities: { provider: 'codex' },
          actions: { mergePullRequest },
        },
        defaultTimeoutMs: 25,
        audit: {
          record: (entry) => {
            auditEntries.push(entry);
          },
        },
      });

      loader.on(
        'github.pull_request',
        async (_event, context) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });

          try {
            await context.actions.mergePullRequest({ pullRequestId: '44' });
          } catch (reason) {
            lateActionReason = reason;
          }

          return { late: true };
        },
        { name: 'late-merge-handler', capabilities: ['merge'] },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'late-merge-handler',
          eventId: 'github-webhook:delivery-late-action:github.pull_request',
          status: 'rejected',
        },
      ]);

      await vi.advanceTimersByTimeAsync(75);
      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(lateActionReason).toBeInstanceOf(Error);
      expect(auditEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'late-merge-handler',
            eventId: 'github-webhook:delivery-late-action:github.pull_request',
            action: 'mergePullRequest',
            result: 'denied',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report an action failure when fulfilled audit recording fails', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-audit-action',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-audit-action',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
        actions: { mergePullRequest },
      },
      audit: {
        record: (entry) => {
          if (entry.action === 'mergePullRequest' && entry.result === 'fulfilled') {
            throw new Error('audit backend unavailable');
          }
        },
      },
    });

    loader.on(
      'github.pull_request',
      async (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
      { name: 'audited-merge-handler', capabilities: ['merge'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'audited-merge-handler',
        eventId: 'github-webhook:delivery-audit-action:github.pull_request',
        status: 'fulfilled',
        value: { merged: true },
      },
    ]);
    expect(mergePullRequest).toHaveBeenCalledOnce();
  });

  it('returns plugin results when failure audit recording fails', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-audit-failure',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-audit-failure',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
      },
      audit: {
        record: (entry) => {
          if (entry.pluginId === 'failing-handler') {
            throw new Error('audit backend unavailable');
          }
        },
      },
    });

    loader.on(
      'github.issue',
      async () => {
        throw new Error('handler failed');
      },
      { name: 'failing-handler' },
    );
    loader.on('github.issue', laterHandler, { name: 'later-handler' });

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'failing-handler',
        eventId: 'github-webhook:delivery-audit-failure:github.issue',
        status: 'rejected',
      },
      {
        pluginName: 'later-handler',
        eventId: 'github-webhook:delivery-audit-failure:github.issue',
        status: 'fulfilled',
        value: { continued: true },
      },
    ]);
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('passes the plugin abort signal to an already running gated action', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'system', name: 'local-runtime' },
        name: 'system.runtime-start',
        delivery: {
          id: 'delivery-running-action',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'worker', id: 'runtime-1' },
        payload: {},
        rawPayload: {
          kind: 'inline-redacted',
          reference: 'redacted://delivery-running-action',
        },
      });
      let actionSignal: AbortSignal | undefined;
      let actionAbortReason: unknown;
      const startRuntime = vi.fn(
        async (_request: { runtimeId: string }, context: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            actionSignal = context.signal;
            context.signal.addEventListener(
              'abort',
              () => {
                actionAbortReason = context.signal.reason;
                reject(context.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const loader = createPluginLoader({
        runtime: {
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          capabilities: { provider: 'local' },
          actions: { startRuntime },
        },
        defaultTimeoutMs: 25,
      });

      loader.on(
        'system.runtime-start',
        async (_event, context) => context.actions.startRuntime({ runtimeId: 'runtime-1' }),
        { name: 'runtime-starter', capabilities: ['runtime:start'] },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'runtime-starter',
          eventId: 'local-runtime:delivery-running-action:system.runtime-start',
          status: 'rejected',
        },
      ]);
      expect(startRuntime).toHaveBeenCalledOnce();
      expect(actionSignal?.aborted).toBe(true);
      expect(actionAbortReason).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes parent abort listeners after workflow dispatch settles', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-listener-cleanup',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-listener-cleanup',
      },
    });
    const parentController = new AbortController();
    const originalAddEventListener = parentController.signal.addEventListener.bind(parentController.signal);
    const originalRemoveEventListener = parentController.signal.removeEventListener.bind(parentController.signal);
    const listeners = new Set<NonNullable<Parameters<AbortSignal['addEventListener']>[1]>>();

    parentController.signal.addEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.add(listener);
      }

      return originalAddEventListener(type, listener, options);
    }) as AbortSignal['addEventListener'];
    parentController.signal.removeEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.delete(listener);
      }

      return originalRemoveEventListener(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
        signal: parentController.signal,
      },
    });

    loader.on('github.issue', async () => ({ ok: true }), { name: 'listener-cleanup-handler' });

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'listener-cleanup-handler',
        eventId: 'github-webhook:delivery-listener-cleanup:github.issue',
        status: 'fulfilled',
      },
    ]);
    expect(listeners.size).toBe(0);
  });

  it('redacts readSecret audit reasons without leaking secret manager messages', async () => {
    const event = createEventEnvelope({
      source: { type: 'system', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: {
        id: 'delivery-secret-error',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: {},
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'redacted://delivery-secret-error',
      },
    });
    const auditEntries: unknown[] = [];
    const readSecret = vi.fn(async () => {
      throw new Error('secret manager returned token=super-secret-value');
    });
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

    loader.on(
      'system.secret-requested',
      async (_event, context) => context.actions.readSecret({ name: 'api-token' }),
      { name: 'secret-reader', capabilities: ['secret:access'] },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'secret-reader',
        eventId: 'local-runtime:delivery-secret-error:system.secret-requested',
        status: 'rejected',
      },
    ]);
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(JSON.stringify(auditEntries)).not.toContain('token=');
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'secret-reader',
          eventId: 'local-runtime:delivery-secret-error:system.secret-requested',
          action: 'readSecret',
          result: 'rejected',
          reason: 'Error: redacted secret action failure',
        }),
      ]),
    );
  });

  it('does not wait for a hanging audit sink before returning plugin results', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-hanging-audit',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-hanging-audit',
      },
    });
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'codex' },
      },
      audit: {
        record: () =>
          new Promise(() => {
            // Simulates a backend write that never resolves.
          }),
      },
    });

    loader.on('github.issue', async () => ({ ok: true }), { name: 'hanging-audit-handler' });

    await expect(
      Promise.race([
        loader.dispatch(event),
        new Promise((resolve) => {
          setTimeout(() => resolve('blocked-on-audit'), 20);
        }),
      ]),
    ).resolves.toEqual([
      {
        pluginName: 'hanging-audit-handler',
        eventId: 'github-webhook:delivery-hanging-audit:github.issue',
        status: 'fulfilled',
        value: { ok: true },
      },
    ]);
  });

  it('denies gated actions scheduled after the handler has already completed', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.pull_request',
        delivery: {
          id: 'delivery-post-settle-action',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'pull_request', id: '44' },
        payload: { action: 'synchronize' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-post-settle-action',
        },
      });
      const mergePullRequest = vi.fn(async () => ({ merged: true }));
      let lateActionReason: unknown;
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

      loader.on(
        'github.pull_request',
        async (_event, context) => {
          setTimeout(() => {
            void context.actions.mergePullRequest({ pullRequestId: '44' }).catch((reason: unknown) => {
              lateActionReason = reason;
            });
          }, 100);

          return { returned: true };
        },
        { name: 'post-settle-merge-handler', capabilities: ['merge'] },
      );

      await expect(loader.dispatch(event)).resolves.toEqual([
        {
          pluginName: 'post-settle-merge-handler',
          eventId: 'github-webhook:delivery-post-settle-action:github.pull_request',
          status: 'fulfilled',
          value: { returned: true },
        },
      ]);

      await vi.advanceTimersByTimeAsync(100);
      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(lateActionReason).toBeInstanceOf(Error);
      expect(auditEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'post-settle-merge-handler',
            eventId: 'github-webhook:delivery-post-settle-action:github.pull_request',
            action: 'mergePullRequest',
            result: 'denied',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the original readSecret error to the plugin result while redacting audit', async () => {
    const event = createEventEnvelope({
      source: { type: 'system', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: {
        id: 'delivery-secret-original-error',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: {},
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'redacted://delivery-secret-original-error',
      },
    });
    const originalError = new Error('SecretNotFound: api-token');
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'local' },
        actions: {
          readSecret: async () => {
            throw originalError;
          },
        },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'system.secret-requested',
      async (_event, context) => context.actions.readSecret({ name: 'api-token' }),
      { name: 'secret-reader-original-error', capabilities: ['secret:access'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'secret-reader-original-error',
      eventId: 'local-runtime:delivery-secret-original-error:system.secret-requested',
      status: 'rejected',
    });
    expect(result?.reason).toBe(originalError);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'secret-reader-original-error',
          eventId: 'local-runtime:delivery-secret-original-error:system.secret-requested',
          action: 'readSecret',
          result: 'rejected',
          reason: 'Error: redacted secret action failure',
        }),
      ]),
    );
  });

  it('redacts secret-capable handler failure reasons in audit entries', async () => {
    const event = createEventEnvelope({
      source: { type: 'system', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: {
        id: 'delivery-secret-handler-error',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: {},
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'redacted://delivery-secret-handler-error',
      },
    });
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: { provider: 'local' },
        actions: {
          readSecret: async () => 'super-secret-value',
        },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'system.secret-requested',
      async (_event, context) => {
        const token = await context.actions.readSecret({ name: 'api-token' });
        throw new Error(`token=${token}`);
      },
      { name: 'secret-capable-handler-error', capabilities: ['secret:access'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'secret-capable-handler-error',
      eventId: 'local-runtime:delivery-secret-handler-error:system.secret-requested',
      status: 'rejected',
    });
    expect(result?.reason).toBeInstanceOf(Error);
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(JSON.stringify(auditEntries)).not.toContain('token=');
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'secret-capable-handler-error',
          eventId: 'local-runtime:delivery-secret-handler-error:system.secret-requested',
          action: 'plugin.handle',
          result: 'rejected',
          reason: 'Error: redacted secret-capable plugin failure',
        }),
      ]),
    );
  });

  it('gates runtime provider startRun behind runtime:start capability', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-runtime-gate',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-runtime-gate',
      },
    });
    const startRun = vi.fn(async () => ({
      id: 'run:unsafe',
      provider: 'codex',
      status: 'queued' as const,
    }));
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        runtime: {
          name: 'mock-runtime',
          kind: 'runtime-provider',
          startRun,
        },
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        context.runtime.startRun({
          workflow: 'unsafe-runtime-starter',
          event: handledEvent,
          requestedBy: 'unsafe-runtime-starter',
        }),
      { name: 'unsafe-runtime-starter' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'unsafe-runtime-starter',
      eventId: 'github-webhook:delivery-runtime-gate:github.issue',
      status: 'rejected',
    });
    expect(startRun).not.toHaveBeenCalled();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'unsafe-runtime-starter',
          eventId: 'github-webhook:delivery-runtime-gate:github.issue',
          action: 'startRuntime',
          result: 'denied',
        }),
      ]),
    );
  });

  it('returns a rejected plugin result when the parent runtime signal aborts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-parent-abort',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-parent-abort',
      },
    });
    const parentController = new AbortController();
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        signal: parentController.signal,
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'github.issue',
      async () =>
        new Promise(() => {
          // Simulates a handler waiting on external work until the daemon shuts down.
        }),
      { name: 'parent-abort-handler' },
    );

    const dispatchPromise = loader.dispatch(event);
    parentController.abort(new Error('daemon shutdown'));

    await expect(dispatchPromise).resolves.toMatchObject([
      {
        pluginName: 'parent-abort-handler',
        eventId: 'github-webhook:delivery-parent-abort:github.issue',
        status: 'rejected',
      },
    ]);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'parent-abort-handler',
          eventId: 'github-webhook:delivery-parent-abort:github.issue',
          action: 'plugin.handle',
          result: 'rejected',
        }),
      ]),
    );
  });

  it('keeps timeout classification when abort cleanup settles the handler promise', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-timeout-first',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-timeout-first',
        },
      });
      const auditEntries: unknown[] = [];
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
        }),
        defaultTimeoutMs: 25,
        audit: {
          record: (entry) => {
            auditEntries.push(entry);
          },
        },
      });

      loader.on(
        'github.issue',
        async (_event, context) =>
          new Promise((resolve) => {
            context.signal.addEventListener('abort', () => resolve({ cleanedUp: true }), { once: true });
          }),
        { name: 'timeout-cleanup-handler' },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'timeout-cleanup-handler',
          eventId: 'github-webhook:delivery-timeout-first:github.issue',
          status: 'rejected',
        },
      ]);
      expect(auditEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'timeout-cleanup-handler',
            eventId: 'github-webhook:delivery-timeout-first:github.issue',
            action: 'plugin.handle',
            result: 'timeout',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a handler when the parent runtime signal is already aborted', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-pre-aborted',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-pre-aborted',
      },
    });
    const parentController = new AbortController();
    const handler = vi.fn(async () => ({ unreachable: true }));
    const auditEntries: unknown[] = [];
    parentController.abort(new Error('daemon already stopped'));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        signal: parentController.signal,
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on('github.issue', handler, { name: 'pre-aborted-handler' });

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'pre-aborted-handler',
        eventId: 'github-webhook:delivery-pre-aborted:github.issue',
        status: 'rejected',
      },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'pre-aborted-handler',
          eventId: 'github-webhook:delivery-pre-aborted:github.issue',
          action: 'plugin.handle',
          result: 'rejected',
        }),
      ]),
    );
  });

  it('uses the registered capability snapshot even if the workflow mutates itself later', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-mutated-capability',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-mutated-capability',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const auditEntries: unknown[] = [];
    const workflow = defineWorkflowPlugin({
      name: 'mutating-capability-handler',
      capabilities: [],
      accepts: (candidate) => candidate.name === 'github.pull_request',
      async handle(_event, context) {
        workflow.capabilities?.push('merge');
        return context.actions.mergePullRequest({ pullRequestId: '44' });
      },
    });
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'mutating-capability-handler',
      eventId: 'github-webhook:delivery-mutated-capability:github.pull_request',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'mutating-capability-handler',
          eventId: 'github-webhook:delivery-mutated-capability:github.pull_request',
          action: 'mergePullRequest',
          result: 'denied',
        }),
      ]),
    );
  });

  it('denies task provider side effects after the handler timeout has fired', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-late-task-provider',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-late-task-provider',
        },
      });
      const createComment = vi.fn(async () => ({ id: 'comment:late' }));
      let lateProviderReason: unknown;
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          providers: {
            tasks: {
              name: 'mock-tasks',
              kind: 'task-provider',
              getIssue: async () => ({
                id: 'issue:13',
                provider: 'github',
                repository: 'reirei-lab/rainrail',
                number: 13,
                title: 'Mock issue',
              }),
              createComment,
            },
          },
        }),
        defaultTimeoutMs: 25,
      });

      loader.on(
        'github.issue',
        async (_event, context) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });

          try {
            await context.providers.tasks.createComment({
              target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
              body: 'late comment',
            });
          } catch (reason) {
            lateProviderReason = reason;
          }

          return { late: true };
        },
        { name: 'late-task-provider-handler' },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'late-task-provider-handler',
          eventId: 'github-webhook:delivery-late-task-provider:github.issue',
          status: 'rejected',
        },
      ]);

      await vi.advanceTimersByTimeAsync(75);
      expect(createComment).not.toHaveBeenCalled();
      expect(lateProviderReason).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps parent abort classification when handler abort cleanup resolves first', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-parent-abort-cleanup',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-parent-abort-cleanup',
      },
    });
    const parentController = new AbortController();
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        signal: parentController.signal,
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'github.issue',
      async (_event, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve({ cleanedUp: true }), { once: true });
        }),
      { name: 'parent-abort-cleanup-handler' },
    );

    const dispatchPromise = loader.dispatch(event);
    parentController.abort(new Error('daemon shutdown'));

    await expect(dispatchPromise).resolves.toMatchObject([
      {
        pluginName: 'parent-abort-cleanup-handler',
        eventId: 'github-webhook:delivery-parent-abort-cleanup:github.issue',
        status: 'rejected',
      },
    ]);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'parent-abort-cleanup-handler',
          eventId: 'github-webhook:delivery-parent-abort-cleanup:github.issue',
          action: 'plugin.handle',
          result: 'rejected',
        }),
      ]),
    );
  });

  it('passes the plugin abort signal to an already running task provider side effect', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-running-task-provider',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-running-task-provider',
        },
      });
      let providerSignal: AbortSignal | undefined;
      let providerAbortReason: unknown;
      const createComment = vi.fn(
        async (_input, context?: { signal: AbortSignal }) =>
          new Promise<{ id: string }>((_resolve, reject) => {
            providerSignal = context?.signal;
            context?.signal.addEventListener(
              'abort',
              () => {
                providerAbortReason = context.signal.reason;
                reject(context.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          providers: {
            tasks: {
              name: 'mock-tasks',
              kind: 'task-provider',
              getIssue: async () => ({
                id: 'issue:13',
                provider: 'github',
                repository: 'reirei-lab/rainrail',
                number: 13,
                title: 'Mock issue',
              }),
              createComment,
            },
          },
        }),
        defaultTimeoutMs: 25,
      });

      loader.on(
        'github.issue',
        async (_event, context) =>
          context.providers.tasks.createComment({
            target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
            body: 'running comment',
          }),
        { name: 'running-task-provider-handler' },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'running-task-provider-handler',
          eventId: 'github-webhook:delivery-running-task-provider:github.issue',
          status: 'rejected',
        },
      ]);
      expect(createComment).toHaveBeenCalledOnce();
      expect(providerSignal?.aborted).toBe(true);
      expect(providerAbortReason).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gates legacy dispatchAgent behind runtime:start capability', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-dispatch-agent-gate',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-dispatch-agent-gate',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:unsafe' }));
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent,
        },
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'unsafe-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'unsafe-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'unsafe-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-gate:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'unsafe-dispatch-agent-handler',
          eventId: 'github-webhook:delivery-dispatch-agent-gate:github.issue',
          action: 'startRuntime',
          result: 'denied',
        }),
      ]),
    );
  });

  it('preserves this when calling runtime action implementations', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-action-this',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-action-this',
      },
    });
    const actionImplementations = {
      client: { merged: true },
      async mergePullRequest() {
        return this.client;
      },
    };
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: actionImplementations,
      },
    });

    loader.on(
      'github.pull_request',
      async (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
      { name: 'this-aware-action-handler', capabilities: ['merge'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'this-aware-action-handler',
        eventId: 'github-webhook:delivery-action-this:github.pull_request',
        status: 'fulfilled',
        value: { merged: true },
      },
    ]);
  });

  it('preserves this when calling optional task provider methods', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-task-this',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-task-this',
      },
    });
    const taskProvider = {
      name: 'this-aware-tasks',
      kind: 'task-provider' as const,
      async getIssue() {
        return {
          id: 'issue:13',
          provider: 'github' as const,
          repository: 'reirei-lab/rainrail',
          number: 13,
          title: 'Mock issue',
        };
      },
      async createComment() {
        return { id: 'comment:unused' };
      },
      async setStatus() {
        return { providerName: this.name };
      },
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        providers: { tasks: taskProvider },
      }),
    });

    loader.on(
      'github.issue',
      async (_event, context) =>
        context.providers.tasks.setStatus?.({
          target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
          state: 'pending',
        }),
      { name: 'this-aware-task-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'this-aware-task-handler',
        eventId: 'github-webhook:delivery-task-this:github.issue',
        status: 'fulfilled',
        value: { providerName: 'this-aware-tasks' },
      },
    ]);
  });

  it('redacts secret-capable action failure reasons in audit entries', async () => {
    const event = createEventEnvelope({
      source: { type: 'system', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: {
        id: 'delivery-secret-action-error',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: {},
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'redacted://delivery-secret-action-error',
      },
    });
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: {
          readSecret: async () => 'super-secret-value',
          startRuntime: async (request) => {
            throw new Error(`failed for ${JSON.stringify(request)}`);
          },
        },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'system.secret-requested',
      async (_event, context) => {
        const token = await context.actions.readSecret({ name: 'api-token' });
        return context.actions.startRuntime({ runtimeId: 'runtime-1', token });
      },
      { name: 'secret-action-error-handler', capabilities: ['secret:access', 'runtime:start'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'secret-action-error-handler',
      eventId: 'local-runtime:delivery-secret-action-error:system.secret-requested',
      status: 'rejected',
    });
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'secret-action-error-handler',
          eventId: 'local-runtime:delivery-secret-action-error:system.secret-requested',
          action: 'startRuntime',
          result: 'rejected',
          reason: 'Error: redacted secret-capable action failure',
        }),
      ]),
    );
  });

  it('isolates capability metadata failures to the malformed workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-bad-capability-metadata',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-bad-capability-metadata',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const malformedWorkflow = {
      name: 'malformed-capability-plugin',
      accepts: () => true,
      get capabilities(): never {
        throw new Error('capabilities metadata is malformed');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        malformedWorkflow,
        defineWorkflowPlugin({
          name: 'later-after-malformed-capability',
          accepts: () => true,
          handle: laterHandler,
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });

    const results = await dispatcher.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'malformed-capability-plugin',
      eventId: 'github-webhook:delivery-bad-capability-metadata:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'later-after-malformed-capability',
      eventId: 'github-webhook:delivery-bad-capability-metadata:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('isolates capability descriptor failures to the malformed workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-bad-capability-descriptor',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-bad-capability-descriptor',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const malformedWorkflow = new Proxy(
      {
        name: 'malformed-capability-descriptor-plugin',
        accepts: () => true,
        handle: async () => ({ unreachable: true }),
      } satisfies WorkflowPlugin,
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'capabilities') {
            throw new Error('capabilities descriptor is malformed');
          }

          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        malformedWorkflow,
        defineWorkflowPlugin({
          name: 'later-after-malformed-capability-descriptor',
          accepts: () => true,
          handle: laterHandler,
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });

    const results = await dispatcher.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'malformed-capability-descriptor-plugin',
      eventId: 'github-webhook:delivery-bad-capability-descriptor:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'later-after-malformed-capability-descriptor',
      eventId: 'github-webhook:delivery-bad-capability-descriptor:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('combines caller and lifecycle abort signals for legacy dispatchAgent', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-dispatch-agent-combined-signal',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-dispatch-agent-combined-signal',
        },
      });
      const callerController = new AbortController();
      let dispatchAgentSignal: AbortSignal | undefined;
      let dispatchAgentAbortReason: unknown;
      const dispatchAgent = vi.fn(
        async (_request, context?: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            dispatchAgentSignal = context?.signal;
            context?.signal.addEventListener(
              'abort',
              () => {
                dispatchAgentAbortReason = context.signal.reason;
                reject(context.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          capabilities: {
            provider: 'codex',
            dispatchAgent,
          },
        }),
        defaultTimeoutMs: 25,
      });

      loader.on(
        'github.issue',
        async (handledEvent, context) =>
          context.capabilities?.dispatchAgent?.(
            {
              event: handledEvent,
              workflow: 'dispatch-agent-combined-signal-handler',
              runId: context.runId,
            },
            { signal: callerController.signal },
          ),
        { name: 'dispatch-agent-combined-signal-handler', capabilities: ['runtime:start'] },
      );

      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'dispatch-agent-combined-signal-handler',
          eventId: 'github-webhook:delivery-dispatch-agent-combined-signal:github.issue',
          status: 'rejected',
        },
      ]);
      expect(dispatchAgent).toHaveBeenCalledOnce();
      expect(dispatchAgentSignal?.aborted).toBe(true);
      expect(dispatchAgentAbortReason).toBeInstanceOf(Error);
      expect(callerController.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read capabilities for workflows rejected by accepts', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-accepts-false-capability',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-accepts-false-capability',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const skippedWorkflow = {
      name: 'skipped-malformed-capability-plugin',
      accepts: () => false,
      get capabilities(): never {
        throw new Error('capabilities should not be read');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        skippedWorkflow,
        defineWorkflowPlugin({
          name: 'later-after-skipped-capability',
          accepts: () => true,
          handle: laterHandler,
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'later-after-skipped-capability',
        eventId: 'github-webhook:delivery-accepts-false-capability:github.issue',
        status: 'fulfilled',
        value: { continued: true },
      },
    ]);
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('does not call runtime.now when audit is disabled', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-audit-disabled',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-audit-disabled',
      },
    });
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'audit-disabled-handler',
          accepts: () => true,
          handle: async () => ({ ok: true }),
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => {
          throw new Error('clock should not be used without audit');
        },
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'audit-disabled-handler',
        eventId: 'github-webhook:delivery-audit-disabled:github.issue',
        status: 'fulfilled',
        value: { ok: true },
      },
    ]);
  });

  it('removes parent abort listeners when handler runtime context access fails', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-context-failure-cleanup',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-context-failure-cleanup',
      },
    });
    const parentController = new AbortController();
    const originalAddEventListener = parentController.signal.addEventListener.bind(parentController.signal);
    const originalRemoveEventListener = parentController.signal.removeEventListener.bind(parentController.signal);
    const listeners = new Set<NonNullable<Parameters<AbortSignal['addEventListener']>[1]>>();

    parentController.signal.addEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.add(listener);
      }

      return originalAddEventListener(type, listener, options);
    }) as AbortSignal['addEventListener'];
    parentController.signal.removeEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.delete(listener);
      }

      return originalRemoveEventListener(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'context-failure-handler',
          accepts: () => true,
          handle: async (_handledEvent, context) => context.now(),
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => {
          throw new Error('runtime clock metadata is malformed');
        },
        signal: parentController.signal,
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'context-failure-handler',
        eventId: 'github-webhook:delivery-context-failure-cleanup:github.issue',
        status: 'rejected',
      },
    ]);
    expect(listeners.size).toBe(0);
  });

  it('combines caller and lifecycle abort signals for runtime provider startRun', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-start-run-caller-signal',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-start-run-caller-signal',
        },
      });
      const callerController = new AbortController();
      let startRunSignal: AbortSignal | undefined;
      const startRun = vi.fn(
        async (_request, context?: { signal: AbortSignal }) =>
          new Promise<{ id: string; provider: 'codex'; status: 'queued' }>((_resolve, reject) => {
            startRunSignal = context?.signal;
            context?.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          }),
      );
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          runtime: {
            name: 'mock-runtime',
            kind: 'runtime-provider',
            startRun,
          },
        }),
        defaultTimeoutMs: 25,
      });

      loader.on(
        'github.issue',
        async (handledEvent, context) =>
          context.runtime.startRun(
            {
              workflow: 'start-run-caller-signal-handler',
              event: handledEvent,
              requestedBy: 'start-run-caller-signal-handler',
            },
            { signal: callerController.signal },
          ),
        { name: 'start-run-caller-signal-handler', capabilities: ['runtime:start'] },
      );

      const dispatchPromise = loader.dispatch(event);
      callerController.abort(new Error('caller canceled run'));
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledOnce();
      expect(startRunSignal?.aborted).toBe(true);
      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'start-run-caller-signal-handler',
          eventId: 'github-webhook:delivery-start-run-caller-signal:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines caller and lifecycle abort signals for task provider methods', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-task-caller-signal',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-task-caller-signal',
      },
    });
    const callerController = new AbortController();
    let createCommentSignal: AbortSignal | undefined;
    const createComment = vi.fn(
      async (_input, context?: { signal: AbortSignal }) =>
        new Promise<{ id: string }>((_resolve, reject) => {
          createCommentSignal = context?.signal;
          context?.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        }),
    );
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        providers: {
          tasks: {
            name: 'mock-tasks',
            kind: 'task-provider',
            getIssue: async () => ({
              id: 'issue:13',
              provider: 'github',
              repository: 'reirei-lab/rainrail',
              number: 13,
              title: 'Mock issue',
            }),
            createComment,
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      async (_event, context) =>
        context.providers.tasks.createComment(
          {
            target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
            body: 'caller cancellable comment',
          },
          { signal: callerController.signal },
        ),
      { name: 'task-caller-signal-handler' },
    );

    const dispatchPromise = loader.dispatch(event);
    callerController.abort(new Error('caller canceled comment'));
    await Promise.resolve();

    expect(createComment).toHaveBeenCalledOnce();
    expect(createCommentSignal?.aborted).toBe(true);
    await expect(dispatchPromise).resolves.toMatchObject([
      {
        pluginName: 'task-caller-signal-handler',
        eventId: 'github-webhook:delivery-task-caller-signal:github.issue',
        status: 'rejected',
      },
    ]);
  });

  it('preserves capability prototype helpers when wrapping dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-capability-prototype',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-capability-prototype',
      },
    });
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = async () => ({ sessionKey: 'agent:main:prototype' });

      lookupRuntime() {
        return 'prototype-runtime';
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (_event, context) =>
        (context.capabilities as unknown as { lookupRuntime: () => string }).lookupRuntime(),
      { name: 'capability-prototype-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'capability-prototype-handler',
        eventId: 'github-webhook:delivery-capability-prototype:github.issue',
        status: 'fulfilled',
        value: 'prototype-runtime',
      },
    ]);
  });

  it('removes parent abort listeners when timeoutMs metadata fails after context creation', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-timeout-metadata-cleanup',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-timeout-metadata-cleanup',
      },
    });
    const parentController = new AbortController();
    const originalAddEventListener = parentController.signal.addEventListener.bind(parentController.signal);
    const originalRemoveEventListener = parentController.signal.removeEventListener.bind(parentController.signal);
    const listeners = new Set<NonNullable<Parameters<AbortSignal['addEventListener']>[1]>>();

    parentController.signal.addEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.add(listener);
      }

      return originalAddEventListener(type, listener, options);
    }) as AbortSignal['addEventListener'];
    parentController.signal.removeEventListener = ((type, listener, options) => {
      if (type === 'abort' && listener !== null) {
        listeners.delete(listener);
      }

      return originalRemoveEventListener(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    const malformedTimeoutWorkflow = {
      name: 'malformed-timeout-handler',
      accepts: () => true,
      capabilities: [],
      get timeoutMs(): never {
        throw new Error('timeout metadata is malformed');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;
    const dispatcher = createRuntimeDispatcher({
      workflows: [malformedTimeoutWorkflow],
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        signal: parentController.signal,
      }),
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'malformed-timeout-handler',
        eventId: 'github-webhook:delivery-timeout-metadata-cleanup:github.issue',
        status: 'rejected',
      },
    ]);
    expect(listeners.size).toBe(0);
  });

  it('does not expose raw dispatchAgent through property descriptors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-dispatch-agent-descriptor',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-dispatch-agent-descriptor',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:descriptor-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent,
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = Object.getOwnPropertyDescriptor(context.capabilities, 'dispatchAgent')?.value;
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'descriptor-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'descriptor-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'descriptor-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-descriptor:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw dispatchAgent through capability prototypes', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-dispatch-agent-prototype-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-dispatch-agent-prototype-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:prototype-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      dispatchAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = (
          Object.getPrototypeOf(context.capabilities) as {
            dispatchAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).dispatchAgent;
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'prototype-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'prototype-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-prototype-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('uses the capability snapshot captured before accepts can mutate workflow metadata', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-accepts-mutated-capability',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-accepts-mutated-capability',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const workflow = defineWorkflowPlugin({
      name: 'accepts-mutating-capability-handler',
      capabilities: [],
      accepts: () => {
        workflow.capabilities?.push('merge');
        return true;
      },
      async handle(_event, context) {
        return context.actions.mergePullRequest({ pullRequestId: '44' });
      },
    });
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'accepts-mutating-capability-handler',
      eventId: 'github-webhook:delivery-accepts-mutated-capability:github.pull_request',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('reads accessor capability metadata after accepts matches', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-accepts-mutated-accessor-capability',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-accepts-mutated-accessor-capability',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const workflow: WorkflowPlugin & { declaredCapabilities: RuntimeCapabilityName[] } = {
      name: 'accepts-mutating-accessor-capability-handler',
      declaredCapabilities: [],
      get capabilities() {
        return this.declaredCapabilities;
      },
      accepts() {
        this.declaredCapabilities = ['merge'];
        return true;
      },
      handle: async (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'accepts-mutating-accessor-capability-handler',
      eventId: 'github-webhook:delivery-accepts-mutated-accessor-capability:github.pull_request',
      status: 'fulfilled',
    });
    expect(mergePullRequest).toHaveBeenCalledOnce();
  });

  it('preserves runtime context prototype fields in the plugin context', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-runtime-prototype',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-runtime-prototype',
      },
    });
    class RuntimeContext {
      runId = 'run-13';

      now() {
        return new Date('2026-06-29T14:01:00.000Z');
      }
    }
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'runtime-prototype-handler',
          accepts: () => true,
          handle: async (_event, context) => context.now().toISOString(),
        }),
      ],
      runtime: new RuntimeContext() as RuntimeDispatcherContext,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'runtime-prototype-handler',
        eventId: 'github-webhook:delivery-runtime-prototype:github.issue',
        status: 'fulfilled',
        value: '2026-06-29T14:01:00.000Z',
      },
    ]);
  });

  it('returns a rejected promise instead of throwing synchronously for late task provider calls', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-late-provider-rejection',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-late-provider-rejection',
        },
      });
      const createComment = vi.fn(async () => ({ id: 'comment:late' }));
      let syncThrow: unknown;
      let lateRejection: unknown;
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          providers: {
            tasks: {
              name: 'mock-tasks',
              kind: 'task-provider',
              getIssue: async () => ({
                id: 'issue:13',
                provider: 'github',
                repository: 'reirei-lab/rainrail',
                number: 13,
                title: 'Mock issue',
              }),
              createComment,
            },
          },
        }),
      });

      loader.on(
        'github.issue',
        async (_event, context) => {
          setTimeout(() => {
            try {
              const result = context.providers.tasks.createComment({
                target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
                body: 'late comment',
              });
              void Promise.resolve(result).catch((reason: unknown) => {
                lateRejection = reason;
              });
            } catch (reason) {
              syncThrow = reason;
            }
          }, 100);

          return { returned: true };
        },
        { name: 'late-provider-rejection-handler' },
      );

      await expect(loader.dispatch(event)).resolves.toEqual([
        {
          pluginName: 'late-provider-rejection-handler',
          eventId: 'github-webhook:delivery-late-provider-rejection:github.issue',
          status: 'fulfilled',
          value: { returned: true },
        },
      ]);

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(syncThrow).toBeUndefined();
      expect(lateRejection).toBeInstanceOf(Error);
      expect(createComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose raw runtime actions through the plugin context prototype', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-runtime-prototype-action-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-runtime-prototype-action-bypass',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'runtime-prototype-action-bypass-handler',
          accepts: () => true,
          handle: async (_event, context) =>
            (Object.getPrototypeOf(context) as RuntimeDispatcherContext).actions?.mergePullRequest?.(
              {
                pullRequestId: '44',
              },
              { signal: context.signal },
            ),
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toEqual({
      pluginName: 'runtime-prototype-action-bypass-handler',
      eventId: 'github-webhook:delivery-runtime-prototype-action-bypass:github.pull_request',
      status: 'fulfilled',
      value: undefined,
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('calls runtime context methods with the original receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-runtime-private-now',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-runtime-private-now',
      },
    });
    class RuntimeContext {
      #clock = new Date('2026-06-29T14:01:00.000Z');
      runId = 'run-13';

      now() {
        return this.#clock;
      }
    }
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        defineWorkflowPlugin({
          name: 'runtime-private-now-handler',
          accepts: () => true,
          handle: async (_event, context) => context.now().toISOString(),
        }),
      ],
      runtime: new RuntimeContext() as RuntimeDispatcherContext,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'runtime-private-now-handler',
        eventId: 'github-webhook:delivery-runtime-private-now:github.issue',
        status: 'fulfilled',
        value: '2026-06-29T14:01:00.000Z',
      },
    ]);
  });

  it('does not expose raw dispatchAgent through capability constructors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-dispatch-agent-constructor-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-dispatch-agent-constructor-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:constructor-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      dispatchAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = (
          context.capabilities?.constructor as {
            prototype?: { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).prototype?.dispatchAgent;
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'constructor-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-constructor-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('calls capability helpers with the original receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-capability-private-helper',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-capability-private-helper',
      },
    });
    class RuntimeCapabilityBag {
      #runtime = 'private-runtime';
      provider = 'codex';
      dispatchAgent = async () => ({ sessionKey: 'agent:main:private-helper' });

      lookupRuntime() {
        return this.#runtime;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (_event, context) =>
        (context.capabilities as unknown as { lookupRuntime: () => string }).lookupRuntime(),
      { name: 'capability-private-helper-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'capability-private-helper-handler',
        eventId: 'github-webhook:delivery-capability-private-helper:github.issue',
        status: 'fulfilled',
        value: 'private-runtime',
      },
    ]);
  });

  it('allows gated dispatchAgent from frozen capabilities', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-frozen-dispatch-agent',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-frozen-dispatch-agent',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:frozen' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: Object.freeze({
          provider: 'codex',
          dispatchAgent,
        }),
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'frozen-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'frozen-dispatch-agent-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'frozen-dispatch-agent-handler',
        eventId: 'github-webhook:delivery-frozen-dispatch-agent:github.issue',
        status: 'fulfilled',
        value: { sessionKey: 'agent:main:frozen' },
      },
    ]);
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it('does not expose raw capabilities through valueOf', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-capability-valueof-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-capability-valueof-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:valueof-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent,
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawCapabilities = (context.capabilities as unknown as { valueOf: () => RuntimeCapabilities }).valueOf();
        return rawCapabilities.dispatchAgent?.({
          event: handledEvent,
          workflow: 'valueof-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'valueof-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'valueof-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-capability-valueof-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw dispatchAgent through __proto__', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-capability-proto-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-capability-proto-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:proto-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      dispatchAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = (
          context.capabilities as unknown as {
            __proto__: { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).__proto__.dispatchAgent;
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'proto-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'proto-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'proto-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-capability-proto-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('keeps loader capability snapshots fixed after handler metadata mutation', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-loader-capability-snapshot',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-loader-capability-snapshot',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const workflow = defineWorkflowPlugin({
      name: 'loader-mutating-capability-handler',
      capabilities: [],
      accepts: () => true,
      async handle(_event, context) {
        workflow.capabilities?.push('merge');
        return context.actions.mergePullRequest({ pullRequestId: '44' });
      },
    });
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });
    loader.register(workflow);

    const first = await loader.dispatch(event);
    const second = await loader.dispatch(event);

    expect(first[0]).toMatchObject({
      pluginName: 'loader-mutating-capability-handler',
      eventId: 'github-webhook:delivery-loader-capability-snapshot:github.pull_request',
      status: 'rejected',
    });
    expect(second[0]).toMatchObject({
      pluginName: 'loader-mutating-capability-handler',
      eventId: 'github-webhook:delivery-loader-capability-snapshot:github.pull_request',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('does not read loader accessor capability metadata for skipped workflows', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-loader-skipped-capability',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-loader-skipped-capability',
      },
    });
    let capabilityReads = 0;
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });
    const skippedWorkflow = {
      name: 'loader-skipped-capability-handler',
      accepts: () => false,
      get capabilities() {
        capabilityReads += 1;
        return [];
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;

    expect(() => loader.register(skippedWorkflow)).not.toThrow();
    await expect(loader.dispatch(event)).resolves.toEqual([]);
    expect(capabilityReads).toBe(0);
  });

  it('isolates loader capability descriptor failures to the malformed workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-bad-capability-descriptor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-bad-capability-descriptor' },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const malformedWorkflow = new Proxy(
      {
        name: 'loader-malformed-capability-descriptor-plugin',
        accepts: () => true,
        handle: async () => ({ unreachable: true }),
      } satisfies WorkflowPlugin,
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'capabilities') {
            throw new Error('loader capabilities descriptor is malformed');
          }

          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const loader = createPluginLoader({
      runtime: mockRuntimeContext(),
    });

    expect(() => loader.register(malformedWorkflow)).not.toThrow();
    loader.register(
      defineWorkflowPlugin({
        name: 'loader-later-after-malformed-capability-descriptor',
        accepts: () => true,
        handle: laterHandler,
      }),
    );

    const results = await loader.dispatch(event);

    expect(results[0]).toMatchObject({
      pluginName: 'loader-malformed-capability-descriptor-plugin',
      eventId: 'github-webhook:delivery-loader-bad-capability-descriptor:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'loader-later-after-malformed-capability-descriptor',
      eventId: 'github-webhook:delivery-loader-bad-capability-descriptor:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('does not expose raw dispatchAgent through __lookupGetter__', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-capability-lookup-getter-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-capability-lookup-getter-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:lookup-getter-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = (
          context.capabilities as unknown as {
            __lookupGetter__: (property: string) => (() => RuntimeCapabilities['dispatchAgent']) | undefined;
          }
        ).__lookupGetter__('dispatchAgent')?.call(context.capabilities);
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'lookup-getter-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'lookup-getter-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'lookup-getter-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-capability-lookup-getter-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('isolates malformed loader timeout metadata to the workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-loader-timeout-metadata',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-loader-timeout-metadata',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });
    const malformedTimeoutWorkflow = {
      name: 'loader-malformed-timeout-handler',
      accepts: () => true,
      capabilities: [],
      get timeoutMs(): never {
        throw new Error('timeout metadata is malformed');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;

    expect(() => loader.register(malformedTimeoutWorkflow)).not.toThrow();
    loader.on('github.issue', laterHandler, { name: 'loader-later-after-timeout-metadata' });

    const results = await loader.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'loader-malformed-timeout-handler',
      eventId: 'github-webhook:delivery-loader-timeout-metadata:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'loader-later-after-timeout-metadata',
      eventId: 'github-webhook:delivery-loader-timeout-metadata:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('isolates malformed loader accepts metadata to the workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-loader-accepts-metadata',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-loader-accepts-metadata',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });
    const malformedAcceptsWorkflow = {
      name: 'loader-malformed-accepts-handler',
      capabilities: [],
      get accepts(): never {
        throw new Error('accepts metadata is malformed');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;

    expect(() => loader.register(malformedAcceptsWorkflow)).not.toThrow();
    loader.on('github.issue', laterHandler, { name: 'loader-later-after-accepts-metadata' });

    const results = await loader.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'loader-malformed-accepts-handler',
      eventId: 'github-webhook:delivery-loader-accepts-metadata:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'loader-later-after-accepts-metadata',
      eventId: 'github-webhook:delivery-loader-accepts-metadata:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('isolates malformed loader name metadata to the workflow result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-loader-name-metadata',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-loader-name-metadata',
      },
    });
    const laterHandler = vi.fn(async () => ({ continued: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });
    const malformedNameWorkflow = {
      get name(): never {
        throw new Error('name metadata is malformed');
      },
      accepts: () => true,
      capabilities: [],
      handle: async () => ({ handled: true }),
    } satisfies WorkflowPlugin;

    expect(() => loader.register(malformedNameWorkflow)).not.toThrow();
    loader.on('github.issue', laterHandler, { name: 'loader-later-after-name-metadata' });

    const results = await loader.dispatch(event);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      pluginName: 'unknown-workflow',
      eventId: 'github-webhook:delivery-loader-name-metadata:github.issue',
      status: 'rejected',
    });
    expect(results[1]).toEqual({
      pluginName: 'loader-later-after-name-metadata',
      eventId: 'github-webhook:delivery-loader-name-metadata:github.issue',
      status: 'fulfilled',
      value: { continued: true },
    });
    expect(laterHandler).toHaveBeenCalledOnce();
  });

  it('uses the timeout snapshot captured before accepts can mutate workflow metadata', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-accepts-mutated-timeout',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-accepts-mutated-timeout',
        },
      });
      const workflow = defineWorkflowPlugin({
        name: 'accepts-mutating-timeout-handler',
        timeoutMs: 25,
        accepts: () => {
          delete workflow.timeoutMs;
          return true;
        },
        handle: async () =>
          new Promise(() => {
            // Simulates a handler that would hang without the registered timeout.
          }),
      });
      const dispatcher = createRuntimeDispatcher({
        workflows: [workflow],
        runtime: {
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
        },
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'accepts-mutating-timeout-handler',
          eventId: 'github-webhook:delivery-accepts-mutated-timeout:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards task provider aliases after the handler has already completed', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: {
          id: 'delivery-provider-alias',
          receivedAt: '2026-06-29T14:00:00.000Z',
        },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'github://deliveries/delivery-provider-alias',
        },
      });
      const createComment = vi.fn(async () => ({ id: 'comment:alias' }));
      let lateRejection: unknown;
      const taskProvider: TaskProvider = {
        name: 'mock-github',
        kind: 'task-provider',
        getIssue: async () => ({
          id: 'issue:13',
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 13,
          title: 'Mock issue',
        }),
        createComment,
      };
      const loader = createPluginLoader({
        runtime: mockRuntimeContext({
          runId: 'run-13',
          now: () => new Date('2026-06-29T14:01:00.000Z'),
          providers: {
            tasks: taskProvider,
            github: taskProvider,
          },
        }),
      });

      loader.on(
        'github.issue',
        async (_event, context) => {
          setTimeout(() => {
            const githubProvider = context.providers.github as TaskProvider;
            void Promise.resolve(
              githubProvider.createComment({
                target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
                body: 'late alias comment',
              }),
            ).catch((reason: unknown) => {
              lateRejection = reason;
            });
          }, 100);

          return { returned: true };
        },
        { name: 'provider-alias-handler' },
      );

      await expect(loader.dispatch(event)).resolves.toEqual([
        {
          pluginName: 'provider-alias-handler',
          eventId: 'github-webhook:delivery-provider-alias:github.issue',
          status: 'fulfilled',
          value: { returned: true },
        },
      ]);

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(lateRejection).toBeInstanceOf(Error);
      expect(createComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose raw dispatchAgent through constructor static accessors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-static-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-static-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:constructor-static-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      static get rawDispatchAgent() {
        return this.prototype.dispatchAgent;
      }

      dispatchAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const rawDispatchAgent = (
          context.capabilities?.constructor as {
            rawDispatchAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).rawDispatchAgent;
        return rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-static-dispatch-agent-handler',
          runId: context.runId,
        });
      },
      { name: 'constructor-static-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-static-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-constructor-static-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw capabilities through constructor prototype accessors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-prototype-self-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-prototype-self-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-prototype-self-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      get self() {
        return this;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities?.constructor as {
            prototype?: { self?: RuntimeCapabilities };
          }
        ).prototype?.self?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-prototype-self-handler',
          runId: context.runId,
        }),
      { name: 'constructor-prototype-self-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-prototype-self-handler',
      eventId: 'github-webhook:delivery-constructor-prototype-self-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates static data aliases for raw dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-static-data-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-static-data-bypass',
      },
    });
    const dispatchAgent = vi.fn(
      async (
        _request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0],
        _context?: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[1],
      ) => ({ sessionKey: 'agent:main:constructor-static-data-bypass' }),
    );
    class RuntimeCapabilityBag {
      static rawDispatchAgent: RuntimeCapabilities['dispatchAgent'];
      provider = 'codex';

      dispatchAgent(...args: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>) {
        return dispatchAgent(...args);
      }
    }
    RuntimeCapabilityBag.rawDispatchAgent = RuntimeCapabilityBag.prototype.dispatchAgent;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities?.constructor as {
            rawDispatchAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-static-data-handler',
          runId: context.runId,
        }),
      { name: 'constructor-static-data-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-static-data-handler',
      eventId: 'github-webhook:delivery-constructor-static-data-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates constructor prototype descriptor aliases for raw dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-prototype-descriptor-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-prototype-descriptor-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-prototype-descriptor-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      dispatchAgent() {
        return dispatchAgent();
      }
    }
    Object.defineProperty(RuntimeCapabilityBag.prototype, 'startAgent', {
      configurable: true,
      value: RuntimeCapabilityBag.prototype.dispatchAgent,
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          Object.getOwnPropertyDescriptor(
            (context.capabilities?.constructor as { prototype?: object }).prototype,
            'startAgent',
          )?.value as RuntimeCapabilities['dispatchAgent'] | undefined
        )?.({
          event: handledEvent,
          workflow: 'constructor-prototype-descriptor-handler',
          runId: context.runId,
        }),
      { name: 'constructor-prototype-descriptor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-prototype-descriptor-handler',
      eventId: 'github-webhook:delivery-constructor-prototype-descriptor-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates constructor static descriptor aliases for raw dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-static-descriptor-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-static-descriptor-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-static-descriptor-bypass' }));
    class RuntimeCapabilityBag {
      static rawDispatchAgent: RuntimeCapabilities['dispatchAgent'];
      provider = 'codex';

      dispatchAgent() {
        return dispatchAgent();
      }
    }
    RuntimeCapabilityBag.rawDispatchAgent = RuntimeCapabilityBag.prototype.dispatchAgent;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          Object.getOwnPropertyDescriptor(context.capabilities?.constructor, 'rawDispatchAgent')?.value as
            | RuntimeCapabilities['dispatchAgent']
            | undefined
        )?.({
          event: handledEvent,
          workflow: 'constructor-static-descriptor-handler',
          runId: context.runId,
        }),
      { name: 'constructor-static-descriptor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-static-descriptor-handler',
      eventId: 'github-webhook:delivery-constructor-static-descriptor-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('normalizes constructor static helper return values', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-static-helper-return',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-static-helper-return',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-static-helper-return' }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      static getStarter() {
        return {
          dispatchAgent: RuntimeCapabilityBag.prototype.dispatchAgent,
        };
      }

      dispatchAgent() {
        return dispatchAgent();
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities?.constructor as unknown as {
            getStarter: () => { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).getStarter().dispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-static-helper-return-handler',
          runId: context.runId,
        }),
      { name: 'constructor-static-helper-return-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-static-helper-return-handler',
      eventId: 'github-webhook:delivery-constructor-static-helper-return:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('normalizes constructor accessor results', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-constructor-accessor-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-constructor-accessor-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-accessor-bypass' }));
    const capabilities = {
      provider: 'codex',
      dispatchAgent,
      get constructor() {
        return this;
      },
    } as RuntimeCapabilities;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities?.constructor as unknown as {
            dispatchAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).dispatchAgent?.({
          event: handledEvent,
          workflow: 'constructor-accessor-handler',
          runId: context.runId,
        }),
      { name: 'constructor-accessor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-accessor-handler',
      eventId: 'github-webhook:delivery-constructor-accessor-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('evaluates private field capability accessors with the raw receiver and normalizes the result', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-private-accessor-provider',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-private-accessor-provider',
      },
    });
    class RuntimeCapabilityBag {
      #provider = 'codex';

      get provider() {
        return this.#provider;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => context.capabilities?.provider,
      { name: 'private-accessor-provider-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'private-accessor-provider-handler',
        eventId: 'github-webhook:delivery-private-accessor-provider:github.issue',
        status: 'fulfilled',
        value: 'codex',
      },
    ]);
  });

  it('gates dispatchAgent reached from prototype accessors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-prototype-accessor-dispatch-agent',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-prototype-accessor-dispatch-agent',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:prototype-accessor' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = dispatchAgent;

      get starter() {
        return this.dispatchAgent({
          event,
          workflow: 'prototype-accessor-dispatch-agent-handler',
          runId: 'run-13',
        });
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities?.constructor as { prototype: { starter: Promise<unknown> } }).prototype.starter,
      { name: 'prototype-accessor-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-accessor-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-prototype-accessor-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not apply __defineGetter__ to raw capabilities', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-define-getter-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-define-getter-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:define-getter-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent,
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        (
          context.capabilities as unknown as {
            __defineGetter__: (property: string, getter: () => unknown) => void;
          }
        ).__defineGetter__('leak', function (this: RuntimeCapabilities) {
          return { raw: this };
        });

        return (
          context.capabilities as unknown as {
            leak?: { raw: RuntimeCapabilities };
          }
        ).leak?.raw.dispatchAgent?.({
          event: handledEvent,
          workflow: 'define-getter-handler',
          runId: context.runId,
        });
      },
      { name: 'define-getter-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'define-getter-handler',
      eventId: 'github-webhook:delivery-define-getter-bypass:github.issue',
      status: 'fulfilled',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not let capability helpers bypass the dispatchAgent wrapper', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-helper-dispatch-agent-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-helper-dispatch-agent-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:helper-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      startAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startAgent: (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => Promise<unknown>;
          }
        ).startAgent({
          event: handledEvent,
          workflow: 'helper-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'helper-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'helper-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-helper-dispatch-agent-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not rerun private helpers that call dispatchAgent with the raw receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-private-helper-dispatch-agent-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-private-helper-dispatch-agent-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-helper-dispatch-agent-bypass',
    }));
    class RuntimeCapabilityBag {
      #runtime = 'private-runtime';
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      startAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        if (this.#runtime.length === 0) {
          throw new Error('unreachable');
        }

        return this.dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startAgent: (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => Promise<unknown>;
          }
        ).startAgent({
          event: handledEvent,
          workflow: 'private-helper-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'private-helper-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-private-helper-dispatch-agent-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not rerun private helpers that call dispatchAgent through aliases with the raw receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-private-helper-alias-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-private-helper-alias-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-helper-alias-bypass',
    }));
    class RuntimeCapabilityBag {
      #runtime = 'private-runtime';
      provider = 'codex';
      dispatchAgent = dispatchAgent;
      startAgent = dispatchAgent;

      start(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        if (this.#runtime.length === 0) {
          throw new Error('unreachable');
        }

        return this.startAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            start: (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => Promise<unknown>;
          }
        ).start({
          event: handledEvent,
          workflow: 'private-helper-alias-handler',
          runId: context.runId,
        }),
      { name: 'private-helper-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-alias-handler',
      eventId: 'github-webhook:delivery-private-helper-alias-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('preserves private helpers that only read non-dispatch public properties', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-private-helper-public-property',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-private-helper-public-property',
      },
    });
    class RuntimeCapabilityBag {
      #token = 'private-token';
      provider = 'codex';

      describe() {
        return `${this.provider}:${this.#token}`;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            describe: () => string;
          }
        ).describe(),
      { name: 'private-helper-public-property-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'private-helper-public-property-handler',
        eventId: 'github-webhook:delivery-private-helper-public-property:github.issue',
        status: 'fulfilled',
        value: 'codex:private-token',
      },
    ]);
  });

  it('snapshots accessor capability metadata before accepts matches', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-skipped-metadata-getters',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-skipped-metadata-getters',
      },
    });
    let capabilityReads = 0;
    let timeoutReads = 0;
    const skippedWorkflow = {
      name: 'skipped-metadata-getter-handler',
      accepts: () => false,
      get capabilities() {
        capabilityReads += 1;
        return [];
      },
      get timeoutMs(): never {
        timeoutReads += 1;
        throw new Error('timeout should not be read');
      },
      handle: async () => ({ unreachable: true }),
    } satisfies WorkflowPlugin;

    const dispatcher = createRuntimeDispatcher({
      workflows: [skippedWorkflow],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
      },
    });

    expect(capabilityReads).toBe(0);
    expect(timeoutReads).toBe(0);
    await expect(dispatcher.dispatch(event)).resolves.toEqual([]);
    expect(capabilityReads).toBe(0);
    expect(timeoutReads).toBe(0);
  });

  it('does not read dispatchAgent accessors when handlers do not use dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-unused-dispatch-agent-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-unused-dispatch-agent-getter',
      },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent should not be read');
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => context.capabilities?.provider,
      { name: 'unused-dispatch-agent-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'unused-dispatch-agent-getter-handler',
        eventId: 'github-webhook:delivery-unused-dispatch-agent-getter:github.issue',
        status: 'fulfilled',
        value: 'codex',
      },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('checks runtime:start capability before reading dispatchAgent getters', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-denied-dispatch-agent-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-denied-dispatch-agent-getter',
      },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent should not be read before denial');
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'denied-dispatch-agent-getter-handler',
          runId: context.runId,
        }),
      { name: 'denied-dispatch-agent-getter-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'denied-dispatch-agent-getter-handler',
      eventId: 'github-webhook:delivery-denied-dispatch-agent-getter:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgentReads).toBe(0);
  });

  it('checks handler lifecycle before reading late dispatchAgent getters', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-late-dispatch-agent-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-late-dispatch-agent-getter',
      },
    });
    let dispatchAgentReads = 0;
    let lateDispatchAgent: RuntimeCapabilities['dispatchAgent'];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            dispatchAgentReads += 1;
            return async () => ({ sessionKey: 'agent:main:late-dispatch-agent-getter' });
          },
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        lateDispatchAgent = context.capabilities?.dispatchAgent;
        return { captured: typeof lateDispatchAgent };
      },
      { name: 'late-dispatch-agent-getter-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'late-dispatch-agent-getter-handler',
        eventId: 'github-webhook:delivery-late-dispatch-agent-getter:github.issue',
        status: 'fulfilled',
        value: { captured: 'function' },
      },
    ]);
    await expect(lateDispatchAgent?.({
      event,
      workflow: 'late-dispatch-agent-getter-handler',
      runId: 'run-1',
    })).rejects.toThrow('cannot call startRuntime after its runtime signal was aborted');
    expect(dispatchAgentReads).toBe(0);
  });

  it('checks runtime:start capability before reading dispatchAgent getters through starter aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-denied-dispatch-agent-alias-getter',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-denied-dispatch-agent-alias-getter',
      },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent should not be read before alias denial');
          },
          startAgent: async () => ({ sessionKey: 'agent:main:should-not-start' }),
        } as unknown as RuntimeCapabilities & { startAgent: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (context.capabilities as unknown as { startAgent: RuntimeCapabilities['dispatchAgent'] }).startAgent?.({
          event: handledEvent,
          workflow: 'denied-dispatch-agent-alias-getter-handler',
          runId: context.runId,
        }),
      { name: 'denied-dispatch-agent-alias-getter-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'denied-dispatch-agent-alias-getter-handler',
      eventId: 'github-webhook:delivery-denied-dispatch-agent-alias-getter:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgentReads).toBe(0);
  });

  it('keeps dispatchAgent gated through asynchronous capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-async-helper-dispatch-agent-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-async-helper-dispatch-agent-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:async-helper-bypass',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      async startAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        await Promise.resolve();
        return this.dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startAgent: (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => Promise<unknown>;
          }
        ).startAgent({
          event: handledEvent,
          workflow: 'async-helper-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'async-helper-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'async-helper-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-async-helper-dispatch-agent-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw capabilities returned from helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-helper-self-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-helper-self-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:self-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      self() {
        return this;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            self: () => RuntimeCapabilities;
          }
        ).self().dispatchAgent?.({
          event: handledEvent,
          workflow: 'helper-self-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'helper-self-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'helper-self-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-helper-self-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw capabilities yielded from helper iterators', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-helper-iterator-self-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-helper-iterator-self-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:helper-iterator-self-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      *items() {
        if (!(this instanceof RuntimeCapabilityBag)) {
          throw new Error('expected raw receiver for brand check');
        }
        yield this;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            items: () => Iterator<RuntimeCapabilities>;
          }
        ).items().next().value?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'helper-iterator-self-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'helper-iterator-self-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'helper-iterator-self-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-helper-iterator-self-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('proxies capability objects returned from helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-helper-object-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-helper-object-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:helper-object-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      getAgents() {
        return {
          dispatchAgent: this.dispatchAgent,
          self: this,
        };
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const agents = (
          context.capabilities as unknown as {
            getAgents: () => { dispatchAgent?: RuntimeCapabilities['dispatchAgent']; self?: RuntimeCapabilities };
          }
        ).getAgents();
        const first = await agents.dispatchAgent?.({
          event: handledEvent,
          workflow: 'helper-object-handler',
          runId: context.runId,
        }).catch((reason: unknown) => reason);
        const second = await agents.self?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'helper-object-handler',
          runId: context.runId,
        }).catch((reason: unknown) => reason);
        return [first, second];
      },
      { name: 'helper-object-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'helper-object-handler',
      eventId: 'github-webhook:delivery-helper-object-bypass:github.issue',
      status: 'fulfilled',
    });
    expect((result as { status: 'fulfilled'; value: unknown }).value).toEqual([
      expect.any(Error),
      expect.any(Error),
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw capabilities returned from accessors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-accessor-self-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-accessor-self-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:accessor-self-bypass' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      get self() {
        return this;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            self: RuntimeCapabilities;
          }
        ).self.dispatchAgent?.({
          event: handledEvent,
          workflow: 'accessor-self-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'accessor-self-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'accessor-self-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-accessor-self-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('proxies nested capability objects that expose raw dispatchAgent or self references', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-nested-capability-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-nested-capability-bypass',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:nested-capability-bypass' }));
    const capabilities = {
      provider: 'codex',
      dispatchAgent,
      agents: { dispatchAgent },
      state: {} as { self?: RuntimeCapabilities },
    } satisfies RuntimeCapabilities & {
      agents: { dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> };
      state: { self?: RuntimeCapabilities };
    };
    capabilities.state.self = capabilities;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const nested = context.capabilities as unknown as {
          agents: { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          state: { self?: RuntimeCapabilities };
        };
        const first = await nested.agents.dispatchAgent?.({
          event: handledEvent,
          workflow: 'nested-capability-handler',
          runId: context.runId,
        }).catch((reason: unknown) => reason);
        const second = await nested.state.self?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'nested-capability-handler',
          runId: context.runId,
        }).catch((reason: unknown) => reason);
        return [first, second];
      },
      { name: 'nested-capability-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'nested-capability-handler',
      eventId: 'github-webhook:delivery-nested-capability-bypass:github.issue',
      status: 'fulfilled',
    });
    expect((result as { status: 'fulfilled'; value: unknown }).value).toEqual([
      expect.any(Error),
      expect.any(Error),
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('preserves built-in capability metadata object receivers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-builtin-capability-metadata',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-builtin-capability-metadata',
      },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          metadata: new Map([['key', 'value']]),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Map<string, string>;
          }
        ).metadata.get('key'),
      { name: 'builtin-capability-metadata-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'builtin-capability-metadata-handler',
        eventId: 'github-webhook:delivery-builtin-capability-metadata:github.issue',
        status: 'fulfilled',
        value: 'value',
      },
    ]);
  });

  it('preserves cross-realm Date valueOf for built-in capability metadata with launcher aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-cross-realm-date-valueof-capability', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/cross-realm-date-valueof-capability' },
    });
    const realm = createContext({});
    const deadline = runInContext("new Date('2026-06-29T14:05:00.000Z')", realm) as Date & {
      dispatchAgent?: RuntimeCapabilities['dispatchAgent'];
    };
    deadline.dispatchAgent = async () => ({ sessionKey: 'agent:main:date-valueof' });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          deadline,
        } as unknown as RuntimeCapabilities & { deadline: Date },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { deadline: Date }).deadline.valueOf(),
      { name: 'cross-realm-date-valueof-capability-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'cross-realm-date-valueof-capability-handler',
        eventId: 'github-webhook:delivery-cross-realm-date-valueof-capability:github.issue',
        status: 'fulfilled',
        value: deadline.valueOf(),
      },
    ]);
  });

  it('calls nested capability helpers with the nested receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-nested-helper-receiver',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-nested-helper-receiver',
      },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent: async () => ({ sessionKey: 'agent:main:nested-helper-receiver' }),
          agents: {
            prefix: 'nested',
            getPrefix(this: { prefix: string }) {
              return this.prefix;
            },
          },
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            agents: { getPrefix: () => string };
          }
        ).agents.getPrefix(),
      { name: 'nested-helper-receiver-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'nested-helper-receiver-handler',
        eventId: 'github-webhook:delivery-nested-helper-receiver:github.issue',
        status: 'fulfilled',
        value: 'nested',
      },
    ]);
  });

  it('evaluates nested capability accessors with the nested receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-nested-accessor-receiver',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-nested-accessor-receiver',
      },
    });
    const nestedAgents: { name: string; readonly prefix: string } = {
      name: 'nested',
      get prefix() {
        return this.name;
      },
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent: async () => ({ sessionKey: 'agent:main:nested-accessor-receiver' }),
          agents: nestedAgents,
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            agents: { prefix: string };
          }
        ).agents.prefix,
      { name: 'nested-accessor-receiver-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'nested-accessor-receiver-handler',
        eventId: 'github-webhook:delivery-nested-accessor-receiver:github.issue',
        status: 'fulfilled',
        value: 'nested',
      },
    ]);
  });

  it('retries private nested capability helpers with the nested receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-private-nested-helper-receiver',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-private-nested-helper-receiver',
      },
    });
    class AgentCapabilities {
      #token = 'nested-token';

      getToken() {
        return this.#token;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          agents: new AgentCapabilities(),
        } as unknown as RuntimeCapabilities & { agents: AgentCapabilities },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            agents: { getToken: () => string };
          }
        ).agents.getToken(),
      { name: 'private-nested-helper-receiver-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'private-nested-helper-receiver-handler',
        eventId: 'github-webhook:delivery-private-nested-helper-receiver:github.issue',
        status: 'fulfilled',
        value: 'nested-token',
      },
    ]);
  });

  it('gates bound dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-bound-dispatch-agent-alias',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-bound-dispatch-agent-alias',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:bound-dispatch-agent-alias' }));
    const capabilities = {
      provider: 'codex',
      dispatchAgent,
    } satisfies RuntimeCapabilities;
    const runtimeCapabilities = {
      ...capabilities,
      startAgent: capabilities.dispatchAgent.bind(capabilities),
    } as RuntimeCapabilities & {
      startAgent: NonNullable<RuntimeCapabilities['dispatchAgent']>;
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: runtimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startAgent: RuntimeCapabilities['dispatchAgent'];
          }
        ).startAgent?.({
          event: handledEvent,
          workflow: 'bound-dispatch-agent-alias-handler',
          runId: context.runId,
        }),
      { name: 'bound-dispatch-agent-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'bound-dispatch-agent-alias-handler',
      eventId: 'github-webhook:delivery-bound-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('keeps dispatchAgent gated across parallel asynchronous capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-parallel-helper-dispatch-agent-bypass',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-parallel-helper-dispatch-agent-bypass',
      },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:parallel-helper-bypass',
    }));
    let releaseFast: (() => void) | undefined;
    let releaseSlow: (() => void) | undefined;
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      async startAgent(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0], mode: 'fast' | 'slow') {
        await new Promise<void>((resolve) => {
          if (mode === 'fast') {
            releaseFast = resolve;
          } else {
            releaseSlow = resolve;
          }
        });
        return this.dispatchAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const capabilities = context.capabilities as unknown as {
          startAgent: (
            request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0],
            mode: 'fast' | 'slow',
          ) => Promise<unknown>;
        };
        const fast = capabilities.startAgent({
          event: handledEvent,
          workflow: 'parallel-helper-dispatch-agent-handler',
          runId: context.runId,
        }, 'fast').catch((reason: unknown) => reason);
        const slow = capabilities.startAgent({
          event: handledEvent,
          workflow: 'parallel-helper-dispatch-agent-handler',
          runId: context.runId,
        }, 'slow').catch((reason: unknown) => reason);
        releaseFast?.();
        await Promise.resolve();
        releaseSlow?.();
        return Promise.all([fast, slow]);
      },
      { name: 'parallel-helper-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'parallel-helper-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-parallel-helper-dispatch-agent-bypass:github.issue',
      status: 'fulfilled',
    });
    expect((result as { status: 'fulfilled'; value: unknown }).value).toEqual([
      expect.any(Error),
      expect.any(Error),
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('supports dispatchAgent helpers on non-extensible capability instances', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-frozen-prototype-helper',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-frozen-prototype-helper',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:frozen-prototype-helper' }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      dispatchAgent() {
        return dispatchAgent();
      }

      lookupRuntime() {
        return this.provider;
      }
    }
    const capabilities = Object.freeze(new RuntimeCapabilityBag()) as unknown as RuntimeCapabilities;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            lookupRuntime: () => string;
          }
        ).lookupRuntime(),
      { name: 'frozen-prototype-helper-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'frozen-prototype-helper-handler',
        eventId: 'github-webhook:delivery-frozen-prototype-helper:github.issue',
        status: 'fulfilled',
        value: 'codex',
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('supports asynchronous private capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-async-private-helper',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-async-private-helper',
      },
    });
    class RuntimeCapabilityBag {
      #runtime = 'private-runtime';
      provider = 'codex';
      dispatchAgent = async () => ({ sessionKey: 'agent:main:async-private-helper' });

      async lookupRuntime() {
        await Promise.resolve();
        return this.#runtime;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            lookupRuntime: () => Promise<string>;
          }
        ).lookupRuntime(),
      { name: 'async-private-helper-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'async-private-helper-handler',
        eventId: 'github-webhook:delivery-async-private-helper:github.issue',
        status: 'fulfilled',
        value: 'private-runtime',
      },
    ]);
  });

  it('returns thenable capability helper results after restoring dispatchAgent shadows', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-thenable-helper',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-thenable-helper',
      },
    });
    const thenable = {
      then(resolve: (value: string) => void) {
        resolve('thenable-result');
      },
    };
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = async () => ({ sessionKey: 'agent:main:thenable-helper' });

      helper() {
        return thenable;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (
          context.capabilities as unknown as {
            helper: () => PromiseLike<string>;
          }
        ).helper(),
      { name: 'thenable-helper-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'thenable-helper-handler',
        eventId: 'github-webhook:delivery-thenable-helper:github.issue',
        status: 'fulfilled',
        value: 'thenable-result',
      },
    ]);
  });

  it('gates dispatchAgent aliases returned from capabilities', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-dispatch-agent-alias',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-dispatch-agent-alias',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:alias-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          get startAgent() {
            return dispatchAgent;
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startAgent: RuntimeCapabilities['dispatchAgent'];
          }
        ).startAgent?.({
          event: handledEvent,
          workflow: 'alias-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'alias-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'alias-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates raw dispatchAgent returned from capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-helper-returned-dispatch-agent',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-helper-returned-dispatch-agent',
      },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:helper-returned-dispatch-agent' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      startAgent = dispatchAgent;
      dispatchAgent = dispatchAgent;

      getStarter() {
        return this.startAgent;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            getStarter: () => RuntimeCapabilities['dispatchAgent'];
          }
        ).getStarter()?.({
          event: handledEvent,
          workflow: 'helper-returned-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'helper-returned-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'helper-returned-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-helper-returned-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('denies gated actions queued as microtasks after a synchronous handler return', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-microtask-action',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'synchronize' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-microtask-action',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    let lateActionReason: unknown;
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    loader.on(
      'github.pull_request',
      (_event, context) => {
        queueMicrotask(() => {
          void context.actions.mergePullRequest({ pullRequestId: '44' }).catch((reason: unknown) => {
            lateActionReason = reason;
          });
        });

        return { returned: true };
      },
      { name: 'microtask-action-handler', capabilities: ['merge'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'microtask-action-handler',
        eventId: 'github-webhook:delivery-microtask-action:github.pull_request',
        status: 'fulfilled',
        value: { returned: true },
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateActionReason).toBeInstanceOf(Error);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('preserves native microtask ordering while an async handler is running', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-native-microtask-order',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'synchronize' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-native-microtask-order',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    let ready = false;
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    loader.on(
      'github.pull_request',
      async (_event, context) => {
        queueMicrotask(() => {
          ready = true;
        });
        await Promise.resolve();
        if (!ready) {
          throw new Error('queueMicrotask callback did not run before promise continuation');
        }

        return context.actions.mergePullRequest({ pullRequestId: '44' });
      },
      { name: 'native-microtask-order-handler', capabilities: ['merge'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'native-microtask-order-handler',
        eventId: 'github-webhook:delivery-native-microtask-order:github.pull_request',
        status: 'fulfilled',
        value: { merged: true },
      },
    ]);
    expect(mergePullRequest).toHaveBeenCalledOnce();
  });

  it('keeps side effects open for microtasks while an async handler is still running', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: {
        id: 'delivery-running-microtask-action',
        receivedAt: '2026-06-29T14:00:00.000Z',
      },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'synchronize' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-running-microtask-action',
      },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const loader = createPluginLoader({
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        actions: { mergePullRequest },
      },
    });

    loader.on(
      'github.pull_request',
      async (_event, context) => {
        queueMicrotask(() => undefined);
        await Promise.resolve();
        return context.actions.mergePullRequest({ pullRequestId: '44' });
      },
      { name: 'running-microtask-action-handler', capabilities: ['merge'] },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'running-microtask-action-handler',
        eventId: 'github-webhook:delivery-running-microtask-action:github.pull_request',
        status: 'fulfilled',
        value: { merged: true },
      },
    ]);
    expect(mergePullRequest).toHaveBeenCalledOnce();
  });

  it('treats missing workflow capabilities as an empty snapshot before accepts can add them', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: { id: 'delivery-missing-capability-snapshot', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-missing-capability-snapshot' },
    });
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    let workflow: WorkflowPlugin & { capabilities?: RuntimeCapabilityName[] };
    workflow = {
      name: 'missing-capability-snapshot-handler',
      accepts: () => {
        workflow.capabilities = ['merge'];
        return true;
      },
      handle: async (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext({ actions: { mergePullRequest } as unknown as PluginRuntimeContext['actions'] }),
    });

    const [result] = await dispatcher.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'missing-capability-snapshot-handler',
      eventId: 'github-webhook:delivery-missing-capability-snapshot:github.pull_request',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('audits action getter failures as action rejections', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: { id: 'delivery-action-getter-failure', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'pull_request', id: '44' },
      payload: { action: 'closed' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-action-getter-failure' },
    });
    const auditEntries: unknown[] = [];
    const actions = {
      get mergePullRequest(): never {
        throw new Error('merge action is not configured');
      },
    } as unknown as PluginRuntimeContext['actions'];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ actions }),
      audit: { record: (entry) => void auditEntries.push(entry) },
    });

    loader.on(
      'github.pull_request',
      (_event, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
      { name: 'action-getter-failure-handler', capabilities: ['merge'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'action-getter-failure-handler',
      eventId: 'github-webhook:delivery-action-getter-failure:github.pull_request',
      status: 'rejected',
    });
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'action-getter-failure-handler',
          eventId: 'github-webhook:delivery-action-getter-failure:github.pull_request',
          action: 'mergePullRequest',
          result: 'rejected',
        }),
      ]),
    );
  });

  it('gates raw dispatchAgent values returned from capability Maps', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-map-dispatch-agent-bypass', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-map-dispatch-agent-bypass' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:map-bypass' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata: new Map([['start', dispatchAgent]]),
        },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Map<string, RuntimeCapabilities['dispatchAgent']>;
          }
        ).metadata.get('start')?.({ event: handledEvent, workflow: 'map-dispatch-agent-handler', runId: context.runId }),
      { name: 'map-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'map-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-map-dispatch-agent-bypass:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('normalizes raw dispatchAgent values yielded by capability Map iteration', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-map-iteration-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-map-iteration-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:map-iteration' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata: new Map([['start', dispatchAgent]]),
        },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const metadata = (context.capabilities as unknown as {
          metadata: Map<string, RuntimeCapabilities['dispatchAgent']>;
        }).metadata;
        let forEachWrapped = false;
        metadata.forEach((value) => {
          forEachWrapped = value !== dispatchAgent;
        });
        const iteratorValue = metadata.values().next().value;
        const entryValue = metadata.entries().next().value?.[1];
        return {
          forEachWrapped,
          valuesWrapped: iteratorValue !== dispatchAgent,
          entriesWrapped: entryValue !== dispatchAgent,
        };
      },
      { name: 'map-iteration-dispatch-agent-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'map-iteration-dispatch-agent-handler',
        eventId: 'github-webhook:delivery-map-iteration-dispatch-agent:github.issue',
        status: 'fulfilled',
        value: { forEachWrapped: true, valuesWrapped: true, entriesWrapped: true },
      },
    ]);
  });

  it('normalizes raw dispatchAgent values yielded by cross-realm capability Map iteration', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-cross-realm-map-iteration-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/cross-realm-map-iteration-dispatch-agent' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:cross-realm-map-iteration',
    }));
    const realm = createContext({ dispatchAgent });
    const metadata = runInContext('new Map([["start", dispatchAgent]])', realm) as Map<
      string,
      RuntimeCapabilities['dispatchAgent']
    >;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata,
        },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Map<string, RuntimeCapabilities['dispatchAgent']>;
          }
        ).metadata.values().next().value?.({
          event: handledEvent,
          workflow: 'cross-realm-map-iteration-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'cross-realm-map-iteration-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'cross-realm-map-iteration-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-cross-realm-map-iteration-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('normalizes raw dispatchAgent values returned from capability WeakMaps', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-weakmap-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-weakmap-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:weakmap' }));
    const key = new Date('2026-06-29T14:00:00.000Z');
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          key,
          cache: new WeakMap([[key, dispatchAgent]]),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const capabilities = context.capabilities as unknown as {
          key: Date;
          cache: WeakMap<object, RuntimeCapabilities['dispatchAgent']>;
        };
        return { wrapped: capabilities.cache.get(capabilities.key) !== dispatchAgent };
      },
      { name: 'weakmap-dispatch-agent-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'weakmap-dispatch-agent-handler',
        eventId: 'github-webhook:delivery-weakmap-dispatch-agent:github.issue',
        status: 'fulfilled',
        value: { wrapped: true },
      },
    ]);
  });

  it('does not treat unrelated bound helpers as dispatchAgent aliases by name alone', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-bound-helper-name', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-bound-helper-name' },
    });
    function startAgentInfo(this: { prefix: string }) {
      return `${this.prefix}:ok`;
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          startAgentInfo: startAgentInfo.bind({ prefix: 'helper' }),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { startAgentInfo: () => string }).startAgentInfo(),
      { name: 'bound-helper-name-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'bound-helper-name-handler',
        eventId: 'github-webhook:delivery-bound-helper-name:github.issue',
        status: 'fulfilled',
        value: 'helper:ok',
      },
    ]);
  });

  it('does not rerun private helpers that optional-chain dispatchAgent with the raw receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-optional-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-private-optional-dispatch' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:private-optional' }));
    class RuntimeCapabilityBag {
      #marker = true;
      provider = 'codex';
      dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = dispatchAgent;
      run(handledEvent: RainrailEventEnvelope, runId: string) {
        void this.#marker;
        return this?.dispatchAgent?.({ event: handledEvent, workflow: 'private-optional-handler', runId });
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { run: (event: RainrailEventEnvelope, runId: string) => unknown })
          .run(handledEvent, context.runId),
      { name: 'private-optional-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-optional-handler',
      eventId: 'github-webhook:delivery-private-optional-dispatch:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates bound raw dispatchAgent values returned from capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-helper-bound-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-helper-bound-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:helper-bound' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          getStarter() {
            return dispatchAgent.bind(this);
          },
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const starter = (context.capabilities as unknown as {
          getStarter: () => NonNullable<RuntimeCapabilities['dispatchAgent']>;
        }).getStarter();
        try {
          await starter({ event: handledEvent, workflow: 'helper-bound-dispatch-agent-handler', runId: context.runId });
          return { denied: false };
        } catch {
          return { denied: true };
        }
      },
      { name: 'helper-bound-dispatch-agent-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'helper-bound-dispatch-agent-handler',
        eventId: 'github-webhook:delivery-helper-bound-dispatch-agent:github.issue',
        status: 'fulfilled',
        value: { denied: true },
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('records startRuntime audit entries when dispatchAgent getters fail', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-dispatch-agent-getter-audit', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-dispatch-agent-getter-audit' },
    });
    const auditEntries: unknown[] = [];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            throw new Error('runtime provider is not configured');
          },
        },
      }),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'dispatch-agent-getter-audit-handler',
          runId: context.runId,
        }),
      { name: 'dispatch-agent-getter-audit-handler', capabilities: ['runtime:start'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'dispatch-agent-getter-audit-handler',
      eventId: 'github-webhook:delivery-dispatch-agent-getter-audit:github.issue',
      status: 'rejected',
    });
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'dispatch-agent-getter-audit-handler',
          eventId: 'github-webhook:delivery-dispatch-agent-getter-audit:github.issue',
          action: 'startRuntime',
          result: 'rejected',
        }),
      ]),
    );
  });

  it('does not read accessor capabilities for skipped workflows', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-skipped-accessor-capability', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-skipped-accessor-capability' },
    });
    let capabilityReads = 0;
    const workflow = {
      name: 'skipped-accessor-capability-handler',
      accepts: () => false,
      get capabilities(): RuntimeCapabilityName[] {
        capabilityReads += 1;
        throw new Error('capabilities should not be read for skipped workflows');
      },
      handle: async () => undefined,
    } satisfies WorkflowPlugin;
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext(),
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual([]);
    expect(capabilityReads).toBe(0);
  });

  it('reads built-in collection accessors with the raw collection receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-map-size-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-map-size-accessor' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          metadata: new Map([['provider', 'codex']]),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { metadata: Map<string, string> }).metadata.size,
      { name: 'map-size-accessor-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'map-size-accessor-handler',
        eventId: 'github-webhook:delivery-map-size-accessor:github.issue',
        status: 'fulfilled',
        value: 1,
      },
    ]);
  });

  it('proxies spoofed plain objects that expose raw dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-spoofed-tag-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-spoofed-tag-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:spoofed-tag' }));
    const nested = {
      [Symbol.toStringTag]: 'Date',
      dispatchAgent,
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          nested,
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { nested: RuntimeCapabilities }).nested.dispatchAgent?.({
          event: handledEvent,
          workflow: 'spoofed-tag-handler',
          runId: context.runId,
        }),
      { name: 'spoofed-tag-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'spoofed-tag-handler',
      eventId: 'github-webhook:delivery-spoofed-tag-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('unwraps capability object keys before built-in collection lookups', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-map-object-key', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-map-object-key' },
    });
    const key = { id: 'agent-runtime' };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          key,
          metadata: new Map([[key, 'found']]),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const capabilities = context.capabilities as unknown as {
          key: object;
          metadata: Map<object, string>;
        };
        return {
          value: capabilities.metadata.get(capabilities.key),
          has: capabilities.metadata.has(capabilities.key),
        };
      },
      { name: 'map-object-key-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'map-object-key-handler',
        eventId: 'github-webhook:delivery-map-object-key:github.issue',
        status: 'fulfilled',
        value: { value: 'found', has: true },
      },
    ]);
  });

  it('unwraps capability function keys before built-in collection lookups', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-map-function-key', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-map-function-key' },
    });
    const helper = Object.assign(() => 'helper:ok', { label: 'helper' });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          helper,
          metadata: new Map([[helper, 'found']]),
          cache: new WeakMap([[helper, 'weak-found']]),
        } as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const capabilities = context.capabilities as unknown as {
          helper: () => string;
          metadata: Map<() => string, string>;
          cache: WeakMap<() => string, string>;
        };
        return {
          value: capabilities.metadata.get(capabilities.helper),
          has: capabilities.metadata.has(capabilities.helper),
          weakValue: capabilities.cache.get(capabilities.helper),
          weakHas: capabilities.cache.has(capabilities.helper),
        };
      },
      { name: 'map-function-key-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'map-function-key-handler',
        eventId: 'github-webhook:delivery-map-function-key:github.issue',
        status: 'fulfilled',
        value: { value: 'found', has: true, weakValue: 'weak-found', weakHas: true },
      },
    ]);
  });

  it('treats missing workflow timeoutMs as an undefined snapshot before accepts can add it', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-accepts-added-timeout', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-accepts-added-timeout' },
      });
      const workflow = {
        name: 'accepts-added-timeout-handler',
        accepts: () => {
          (workflow as WorkflowPlugin).timeoutMs = 60_000;
          return true;
        },
        handle: async () => new Promise(() => undefined),
      } satisfies WorkflowPlugin;
      const dispatcher = createRuntimeDispatcher({
        workflows: [workflow],
        defaultTimeoutMs: 25,
        runtime: mockRuntimeContext(),
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'accepts-added-timeout-handler',
          eventId: 'github-webhook:delivery-accepts-added-timeout:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves Array brand for capability metadata arrays', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-array-capability-metadata', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-array-capability-metadata' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          items: ['alpha', 'beta'],
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const items = (context.capabilities as unknown as { items: string[] }).items;
        return { isArray: Array.isArray(items), json: JSON.stringify(items), first: items[0] };
      },
      { name: 'array-capability-metadata-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'array-capability-metadata-handler',
        eventId: 'github-webhook:delivery-array-capability-metadata:github.issue',
        status: 'fulfilled',
        value: { isArray: true, json: '["alpha","beta"]', first: 'alpha' },
      },
    ]);
  });

  it('does not read dispatchAgent getters when reading unrelated capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-unrelated-helper-dispatch-getter', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-unrelated-helper-dispatch-getter' },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          describe: () => 'metadata',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent should not be read');
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => ({
        helperType: typeof (context.capabilities as unknown as { describe: () => string }).describe,
      }),
      { name: 'unrelated-helper-dispatch-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'unrelated-helper-dispatch-getter-handler',
        eventId: 'github-webhook:delivery-unrelated-helper-dispatch-getter:github.issue',
        status: 'fulfilled',
        value: { helperType: 'function' },
      },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('exposes missing optional dispatchAgent capabilities as undefined', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-missing-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-missing-dispatch-agent' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
        },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'missing-dispatch-agent-handler',
          runId: context.runId,
        }) ?? { skipped: true },
      { name: 'missing-dispatch-agent-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'missing-dispatch-agent-handler',
        eventId: 'github-webhook:delivery-missing-dispatch-agent:github.issue',
        status: 'fulfilled',
        value: { skipped: true },
      },
    ]);
  });

  it('checks provider lifecycle denial before reading late provider getters', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-late-provider-getter', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-late-provider-getter' },
    });
    let providerReads = 0;
    let lateReason: unknown;
    const runtime = {
      runId: 'run-13',
      now: () => new Date('2026-06-29T14:01:00.000Z'),
      get providers(): never {
        providerReads += 1;
        throw new Error('providers should not be read after lifecycle closed');
      },
    } satisfies RuntimeDispatcherContext;
    const loader = createPluginLoader({ runtime });

    loader.on(
      'github.issue',
      (_event, context) => {
        setTimeout(() => {
          void Promise.resolve(
            context.providers.tasks.createComment({
              target: { provider: 'github', repository: 'reirei-lab/rainrail', number: 13 },
              body: 'late',
            }),
          ).catch((reason: unknown) => {
            lateReason = reason;
          });
        }, 0);
        return { done: true };
      },
      { name: 'late-provider-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'late-provider-getter-handler', status: 'fulfilled' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(lateReason).toBeInstanceOf(Error);
    expect(providerReads).toBe(0);
  });

  it('does not read optional provider method getters during late introspection', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-late-provider-introspection', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/late-provider-introspection' },
    });
    let addToProjectReads = 0;
    let lateHasAddToProject: boolean | undefined;
    const tasks = {
      name: 'mock-tasks',
      kind: 'task-provider' as const,
      getIssue: async () => ({
        id: 'issue:13',
        provider: 'github' as const,
        repository: 'reirei-lab/rainrail',
        number: 13,
        title: 'Issue',
      }),
      createComment: async () => ({ id: 'comment:mock' }),
      get addToProject(): never {
        addToProjectReads += 1;
        throw new Error('project integration should not initialize after lifecycle closed');
      },
    } satisfies TaskProvider;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ providers: { tasks } }),
    });

    loader.on(
      'github.issue',
      (_event, context) => {
        const guardedTasks = context.providers.tasks;
        setTimeout(() => {
          lateHasAddToProject = 'addToProject' in guardedTasks;
        }, 0);
        return { done: true };
      },
      { name: 'late-provider-introspection-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'late-provider-introspection-handler', status: 'fulfilled' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lateHasAddToProject).toBe(false);
    expect(addToProjectReads).toBe(0);
  });

  it('keeps undefined optional task provider methods hidden', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-undefined-optional-task-method', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-undefined-optional-task-method' },
    });
    const tasks = {
      name: 'mock-tasks',
      kind: 'task-provider',
      getIssue: async () => ({ id: 'issue:13', provider: 'github' as const, repository: 'reirei-lab/rainrail', number: 13, title: 'Issue' }),
      createComment: async () => ({ id: 'comment:mock' }),
      addToProject: undefined,
    } as unknown as TaskProvider;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ providers: { tasks } }),
    });

    loader.on(
      'github.issue',
      (_event, context) => ({ addToProject: context.providers.tasks.addToProject }),
      { name: 'undefined-optional-task-method-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'undefined-optional-task-method-handler',
        eventId: 'github-webhook:delivery-undefined-optional-task-method:github.issue',
        status: 'fulfilled',
        value: { addToProject: undefined },
      },
    ]);
  });

  it('normalizes promise-valued capability objects before exposing their dispatchAgent fields', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-promise-capability-object', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-promise-capability-object' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:promise-capability' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          agents: Promise.resolve({ dispatchAgent }),
        },
      }),
    });

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        const agents = await (context.capabilities as unknown as {
          agents: Promise<{ dispatchAgent?: RuntimeCapabilities['dispatchAgent'] }>;
        }).agents;
        return agents.dispatchAgent?.({
          event: handledEvent,
          workflow: 'promise-capability-object-handler',
          runId: context.runId,
        });
      },
      { name: 'promise-capability-object-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'promise-capability-object-handler',
      eventId: 'github-webhook:delivery-promise-capability-object:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry private helpers that destructure dispatchAgent on the raw receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-destructured-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-private-destructured-dispatch' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:private-destructured' }));
    class RuntimeCapabilityBag {
      #runtime = 'private-runtime';
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      launch(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        if (this.#runtime.length === 0) {
          throw new Error('unreachable');
        }

        const { dispatchAgent: launcher } = this;
        return (launcher as RuntimeCapabilities['dispatchAgent'] | undefined)?.(request, undefined);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { launch: RuntimeCapabilityBag['launch'] }).launch({
          event: handledEvent,
          workflow: 'private-destructured-dispatch-handler',
          runId: context.runId,
        }),
      { name: 'private-destructured-dispatch-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-destructured-dispatch-handler',
      eventId: 'github-webhook:delivery-private-destructured-dispatch:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('uses the timeout accessor descriptor captured before accepts can replace workflow metadata', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-accepts-replaced-timeout-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-accepts-replaced-timeout-accessor' },
      });
      const workflow = {
        name: 'accepts-replaced-timeout-accessor-handler',
        get timeoutMs() {
          return 25;
        },
        accepts: () => {
          Object.defineProperty(workflow, 'timeoutMs', { configurable: true, value: 60_000 });
          return true;
        },
        handle: async () => new Promise(() => undefined),
      } satisfies WorkflowPlugin;
      const dispatcher = createRuntimeDispatcher({
        workflows: [workflow],
        runtime: mockRuntimeContext(),
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'accepts-replaced-timeout-accessor-handler',
          eventId: 'github-webhook:delivery-accepts-replaced-timeout-accessor:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gates bound dispatchAgent aliases on constructor prototypes', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-prototype-bound-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-prototype-bound-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:prototype-bound-alias' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;
    }
    (RuntimeCapabilityBag.prototype as RuntimeCapabilityBag & {
      startAgent?: RuntimeCapabilities['dispatchAgent'];
    }).startAgent = dispatchAgent.bind(new RuntimeCapabilityBag());
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            constructor: { prototype: { startAgent?: RuntimeCapabilities['dispatchAgent'] } };
          }
        ).constructor.prototype.startAgent?.({
          event: handledEvent,
          workflow: 'prototype-bound-alias-handler',
          runId: context.runId,
        }),
      { name: 'prototype-bound-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-bound-alias-handler',
      eventId: 'github-webhook:delivery-prototype-bound-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates raw dispatchAgent aliases regardless of property name', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-arbitrary-dispatch-agent-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-arbitrary-dispatch-agent-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:arbitrary-alias' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          launcher: dispatchAgent,
          items: [dispatchAgent],
        } as RuntimeCapabilities & { launcher: RuntimeCapabilities['dispatchAgent']; items: RuntimeCapabilities['dispatchAgent'][] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { launcher: RuntimeCapabilities['dispatchAgent'] }).launcher?.({
          event: handledEvent,
          workflow: 'arbitrary-alias-handler',
          runId: context.runId,
        }),
      { name: 'arbitrary-alias-handler' },
    );
    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { items: RuntimeCapabilities['dispatchAgent'][] }).items[0]?.({
          event: handledEvent,
          workflow: 'array-alias-handler',
          runId: context.runId,
        }),
      { name: 'array-alias-handler' },
    );

    const results = await loader.dispatch(event);

    expect(results).toMatchObject([
      { pluginName: 'arbitrary-alias-handler', status: 'rejected' },
      { pluginName: 'array-alias-handler', status: 'rejected' },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('freezes loader data capability metadata at registration time', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-data-capability-snapshot', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-data-capability-snapshot' },
    });
    const capabilities: RuntimeCapabilityName[] = [];
    const workflow: WorkflowPlugin = {
      name: 'loader-data-capability-snapshot-handler',
      capabilities,
      accepts: () => true,
      handle: (_handledEvent, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
    };
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        actions: { ...mockRuntimeContext().actions, mergePullRequest },
      }),
    });

    loader.register(workflow);
    capabilities.push('merge');

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'loader-data-capability-snapshot-handler',
      eventId: 'github-webhook:delivery-loader-data-capability-snapshot:github.issue',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('freezes missing loader capability metadata as empty at registration time', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-missing-capability-snapshot', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-missing-capability-snapshot' },
    });
    const workflow = {
      name: 'loader-missing-capability-snapshot-handler',
      accepts() {
        this.capabilities = ['merge'];
        return true;
      },
      handle: (_handledEvent, context) => context.actions.mergePullRequest({ pullRequestId: '44' }),
    } satisfies WorkflowPlugin;
    const mergePullRequest = vi.fn(async () => ({ merged: true }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        actions: { ...mockRuntimeContext().actions, mergePullRequest },
      }),
    });

    loader.register(workflow);

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'loader-missing-capability-snapshot-handler',
      eventId: 'github-webhook:delivery-loader-missing-capability-snapshot:github.issue',
      status: 'rejected',
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('does not read loader timeout accessors at registration time', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-timeout-accessor-register', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-timeout-accessor-register' },
    });
    let timeoutReads = 0;
    const workflow = {
      name: 'loader-timeout-accessor-register-handler',
      accepts: () => false,
      get timeoutMs(): never {
        timeoutReads += 1;
        throw new Error('timeout should not be read for skipped workflow');
      },
      handle: async () => ({ ok: true }),
    } satisfies WorkflowPlugin;
    const loader = createPluginLoader({ runtime: mockRuntimeContext() });

    expect(() => loader.register(workflow)).not.toThrow();
    await expect(loader.dispatch(event)).resolves.toEqual([]);
    expect(timeoutReads).toBe(0);
  });

  it('keeps frozen array descriptors compatible with capability views', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-frozen-array-descriptor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/frozen-array-descriptor' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          items: Object.freeze(['alpha']),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const items = (context.capabilities as unknown as { items: string[] }).items;
        return { keys: Object.keys(items), spread: { ...items } };
      },
      { name: 'frozen-array-descriptor-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'frozen-array-descriptor-handler',
        eventId: 'github-webhook:delivery-frozen-array-descriptor:github.issue',
        status: 'fulfilled',
        value: { keys: ['0'], spread: { 0: 'alpha' } },
      },
    ]);
  });

  it('unwraps capability object keys for Set and WeakSet lookups', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-set-object-key', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/set-object-key' },
    });
    const key = { id: 'allowed' };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          key,
          allowed: new Set([key]),
          weakAllowed: new WeakSet([key]),
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => {
        const capabilities = context.capabilities as unknown as {
          key: object;
          allowed: Set<object>;
          weakAllowed: WeakSet<object>;
        };
        return {
          setHas: capabilities.allowed.has(capabilities.key),
          weakSetHas: capabilities.weakAllowed.has(capabilities.key),
        };
      },
      { name: 'set-object-key-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'set-object-key-handler',
        eventId: 'github-webhook:delivery-set-object-key:github.issue',
        status: 'fulfilled',
        value: { setHas: true, weakSetHas: true },
      },
    ]);
  });

  it('reads accessor timeout metadata after accepts updates public state', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-accepts-mutated-accessor-timeout', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/accepts-mutated-accessor-timeout' },
      });
      const workflow = {
        name: 'accepts-mutated-accessor-timeout-handler',
        _timeoutMs: 60_000,
        accepts() {
          this._timeoutMs = 25;
          return true;
        },
        get timeoutMs() {
          return this._timeoutMs;
        },
        handle: async () => new Promise(() => undefined),
      } satisfies WorkflowPlugin & { _timeoutMs: number };
      const dispatcher = createRuntimeDispatcher({
        workflows: [workflow],
        runtime: mockRuntimeContext(),
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'accepts-mutated-accessor-timeout-handler',
          eventId: 'github-webhook:delivery-accepts-mutated-accessor-timeout:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gates dispatchAgent aliases when dispatchAgent is exposed through a getter', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-getter-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/getter-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:getter-alias' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          launchAgent: dispatchAgent,
        } as RuntimeCapabilities & { launchAgent: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { launchAgent: RuntimeCapabilities['dispatchAgent'] }).launchAgent?.({
          event: handledEvent,
          workflow: 'getter-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'getter-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'getter-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-getter-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('reads private timeout accessors with the original workflow receiver', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-private-timeout-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-timeout-accessor' },
      });
      class PrivateTimeoutWorkflow implements WorkflowPlugin {
        #timeoutMs = 25;
        name = 'private-timeout-accessor-handler';
        accepts = () => true;
        get timeoutMs() {
          return this.#timeoutMs;
        }
        handle = async () => new Promise(() => undefined);
      }
      const dispatcher = createRuntimeDispatcher({
        workflows: [new PrivateTimeoutWorkflow()],
        runtime: mockRuntimeContext(),
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'private-timeout-accessor-handler',
          eventId: 'github-webhook:delivery-private-timeout-accessor:github.issue',
          status: 'rejected',
          reason: expect.objectContaining({ message: 'Plugin timed out after 25ms' }),
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read lazy dispatchAgent getters for unrelated helper calls', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-unrelated-helper-call-dispatch-getter', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/unrelated-helper-call-dispatch-getter' },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          lookupRuntime: () => 'metadata',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent should not be read');
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { lookupRuntime: () => string }).lookupRuntime(),
      { name: 'unrelated-helper-call-dispatch-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'unrelated-helper-call-dispatch-getter-handler', status: 'fulfilled', value: 'metadata' },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('gates dispatch request calls through arbitrary helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-arbitrary-helper-dispatch-request', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/arbitrary-helper-dispatch-request' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:arbitrary-helper-dispatch-request',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          run(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
            return dispatchAgent(request);
          },
        } as RuntimeCapabilities & { run: NonNullable<RuntimeCapabilities['dispatchAgent']> },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { run: RuntimeCapabilities['dispatchAgent'] }).run?.({
          event: handledEvent,
          workflow: 'arbitrary-helper-dispatch-request-handler',
          runId: context.runId,
        }),
      { name: 'arbitrary-helper-dispatch-request-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'arbitrary-helper-dispatch-request-handler',
      eventId: 'github-webhook:delivery-arbitrary-helper-dispatch-request:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates proxy dispatch request calls through arbitrary helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-proxy-helper-dispatch-request', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/proxy-helper-dispatch-request' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:proxy-helper-dispatch-request',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          run(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
            return dispatchAgent(request);
          },
        } as RuntimeCapabilities & { run: NonNullable<RuntimeCapabilities['dispatchAgent']> },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) => {
        const request = new Proxy(
          {
            event: handledEvent,
            workflow: 'proxy-helper-dispatch-request-handler',
            runId: context.runId,
          },
          { has: () => false },
        );
        return (context.capabilities as unknown as { run: RuntimeCapabilities['dispatchAgent'] }).run?.(request);
      },
      { name: 'proxy-helper-dispatch-request-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'proxy-helper-dispatch-request-handler',
      eventId: 'github-webhook:delivery-proxy-helper-dispatch-request:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates getter-backed raw dispatchAgent helper calls before trusting proxy request shapes', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-raw-dispatch-hostile-request', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/raw-dispatch-hostile-request' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:raw-hostile-request' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          get go() {
            return dispatchAgent;
          },
        } as RuntimeCapabilities & { go: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) => {
        const request = new Proxy(
          {
            event: handledEvent,
            workflow: 'raw-dispatch-hostile-request-handler',
            runId: context.runId,
          },
          {
            has(target, property) {
              if (property === 'event') {
                return false;
              }

              return property in target;
            },
          },
        );

        return (context.capabilities as unknown as {
          go: RuntimeCapabilities['dispatchAgent'];
        }).go?.(request);
      },
      { name: 'raw-dispatch-hostile-request-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'raw-dispatch-hostile-request-handler',
      eventId: 'github-webhook:delivery-raw-dispatch-hostile-request:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not expose raw dispatchAgent through frozen array descriptors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-frozen-array-dispatch-descriptor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/frozen-array-dispatch-descriptor' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:frozen-array-descriptor' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          items: Object.freeze([dispatchAgent]),
        } as unknown as RuntimeCapabilities & { items: RuntimeCapabilities['dispatchAgent'][] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        Object.getOwnPropertyDescriptor(
          (context.capabilities as unknown as { items: RuntimeCapabilities['dispatchAgent'][] }).items,
          '0',
        )?.value?.({
          event: handledEvent,
          workflow: 'frozen-array-dispatch-descriptor-handler',
          runId: context.runId,
        }),
      { name: 'frozen-array-dispatch-descriptor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'frozen-array-dispatch-descriptor-handler',
      eventId: 'github-webhook:delivery-frozen-array-dispatch-descriptor:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry private helpers that use private dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-field-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-field-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-field-alias',
    }));
    class RuntimeCapabilityBag {
      #launch = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      start(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.#launch(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { start: RuntimeCapabilityBag['start'] }).start({
          event: handledEvent,
          workflow: 'private-field-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'private-field-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-field-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-private-field-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('redacts secret-capable accepts failures in audit entries', async () => {
    const event = createEventEnvelope({
      source: { type: 'local', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: { id: 'delivery-secret-accepts-error', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: { action: 'read' },
      rawPayload: { kind: 'external-reference', reference: 'redacted://delivery-secret-accepts-error' },
    });
    const auditEntries: unknown[] = [];
    const workflow: WorkflowPlugin = {
      name: 'secret-accepts-error-handler',
      get capabilities() {
        return ['secret:access'] as RuntimeCapabilityName[];
      },
      accepts: () => {
        throw new Error('accepts saw token=super-secret-value');
      },
      handle: async () => ({ ok: true }),
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext(),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'secret-accepts-error-handler', status: 'rejected' },
    ]);
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        pluginId: 'secret-accepts-error-handler',
        action: 'plugin.handle',
        result: 'rejected',
        reason: 'Error: redacted secret-capable plugin failure',
      }),
    );
  });

  it('redacts accepts failures with the pre-accepts secret capability state', async () => {
    const event = createEventEnvelope({
      source: { type: 'local', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: { id: 'delivery-secret-accepts-mutated-error', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: { action: 'read' },
      rawPayload: { kind: 'external-reference', reference: 'redacted://delivery-secret-accepts-mutated-error' },
    });
    const auditEntries: unknown[] = [];
    let currentCapabilities: RuntimeCapabilityName[] = ['secret:access'];
    const workflow: WorkflowPlugin = {
      name: 'secret-accepts-mutated-error-handler',
      get capabilities() {
        return currentCapabilities;
      },
      accepts: () => {
        currentCapabilities = [];
        throw new Error('accepts saw token=super-secret-value');
      },
      handle: async () => ({ ok: true }),
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext(),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'secret-accepts-mutated-error-handler', status: 'rejected' },
    ]);
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        pluginId: 'secret-accepts-mutated-error-handler',
        action: 'plugin.handle',
        result: 'rejected',
        reason: 'Error: redacted secret-capable plugin failure',
      }),
    );
  });

  it('keeps non-secret accepts failure reasons in audit entries', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-non-secret-accepts-error', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/non-secret-accepts-error' },
    });
    const auditEntries: unknown[] = [];
    const dispatcher = createRuntimeDispatcher({
      workflows: [
        {
          name: 'non-secret-accepts-error-handler',
          capabilities: [],
          accepts: () => {
            throw new Error('accepts route configuration failed');
          },
          handle: async () => ({ ok: true }),
        },
      ],
      runtime: mockRuntimeContext(),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'non-secret-accepts-error-handler', status: 'rejected' },
    ]);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        pluginId: 'non-secret-accepts-error-handler',
        action: 'plugin.handle',
        result: 'rejected',
        reason: 'Error: accepts route configuration failed',
      }),
    );
  });

  it('gates anonymous bound dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-anonymous-bound-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/anonymous-bound-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:anonymous-bound' }));
    const rawDispatchAgent = async () => dispatchAgent();
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent: rawDispatchAgent,
          startAgent: rawDispatchAgent.bind({}),
        } as RuntimeCapabilities & { startAgent: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { startAgent: RuntimeCapabilities['dispatchAgent'] }).startAgent?.({
          event: handledEvent,
          workflow: 'anonymous-bound-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'anonymous-bound-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'anonymous-bound-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-anonymous-bound-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates anonymous raw dispatchAgent bound aliases by the alias property name', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-empty-name-bound-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/empty-name-bound-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:empty-name-bound' }));
    const rawDispatchAgent = Object.defineProperty(
      async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => dispatchAgent(),
      'name',
      { value: '' },
    ) as NonNullable<RuntimeCapabilities['dispatchAgent']>;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent: rawDispatchAgent,
          startAgent: rawDispatchAgent.bind({}),
        } as RuntimeCapabilities & { startAgent: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { startAgent: RuntimeCapabilities['dispatchAgent'] }).startAgent?.({
          event: handledEvent,
          workflow: 'empty-name-bound-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'empty-name-bound-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'empty-name-bound-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-empty-name-bound-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('normalizes dispatchAgent return values before exposing capability references', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-dispatch-return-capability', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/dispatch-return-capability' },
    });
    const dispatchAgent = vi.fn(async function (this: RuntimeCapabilities) {
      return { self: this, dispatchAgent: this.dispatchAgent };
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
        } as RuntimeCapabilities,
      }),
    });
    let returned: { self: RuntimeCapabilities } | undefined;

    loader.on(
      'github.issue',
      async (handledEvent, context) => {
        returned = (await context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'dispatch-return-capability-handler',
          runId: context.runId,
        })) as { self: RuntimeCapabilities };
        return { captured: true };
      },
      { name: 'dispatch-return-capability-handler', capabilities: ['runtime:start'] },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'dispatch-return-capability-handler',
      eventId: 'github-webhook:delivery-dispatch-return-capability:github.issue',
      status: 'fulfilled',
      value: { captured: true },
    });
    await expect(
      returned?.self.dispatchAgent?.({
        event,
        workflow: 'dispatch-return-capability-handler',
        runId: 'run-1',
      }),
    ).rejects.toThrow('cannot call startRuntime after its runtime signal was aborted');
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps the execution capability snapshot when auditing handler failures', async () => {
    const event = createEventEnvelope({
      source: { type: 'local', name: 'local-runtime' },
      name: 'system.secret-requested',
      delivery: { id: 'delivery-secret-handler-mutates-capability', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'secret', id: 'api-token' },
      payload: { action: 'read' },
      rawPayload: { kind: 'external-reference', reference: 'redacted://delivery-secret-handler-mutates-capability' },
    });
    let capabilities: RuntimeCapabilityName[] = ['secret:access'];
    const auditEntries: unknown[] = [];
    const workflow: WorkflowPlugin = {
      name: 'secret-handler-mutates-capability',
      accepts: () => true,
      get capabilities() {
        return capabilities;
      },
      handle: async () => {
        capabilities = [];
        throw new Error('handler saw token=super-secret-value');
      },
    };
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext(),
      audit: {
        record: (entry) => {
          auditEntries.push(entry);
        },
      },
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      { pluginName: 'secret-handler-mutates-capability', status: 'rejected' },
    ]);
    expect(JSON.stringify(auditEntries)).not.toContain('super-secret-value');
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        pluginId: 'secret-handler-mutates-capability',
        action: 'plugin.handle',
        result: 'rejected',
        reason: 'Error: redacted secret-capable plugin failure',
      }),
    );
  });

  it('gates arbitrary accessor aliases for getter-backed dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-accessor-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/accessor-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:accessor-alias' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          get launcher() {
            return dispatchAgent;
          },
        } as RuntimeCapabilities & { launcher: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { launcher: RuntimeCapabilities['dispatchAgent'] }).launcher?.({
          event: handledEvent,
          workflow: 'accessor-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'accessor-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'accessor-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-accessor-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry zero-argument private helpers that compute dispatchAgent names', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-computed-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-computed-dispatch' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:private-computed' }));
    class RuntimeCapabilityBag {
      #request = { event, workflow: 'private-computed-dispatch-handler', runId: 'run-1' };
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      start() {
        const key = ['dispatch', 'Agent'].join('');
        return (this as unknown as Record<string, RuntimeCapabilities['dispatchAgent']>)[key]?.(this.#request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as { start: () => unknown }).start(),
      { name: 'private-computed-dispatch-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-computed-dispatch-handler',
      eventId: 'github-webhook:delivery-private-computed-dispatch:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('retries argument-taking private helpers that do not resolve dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-lookup-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-lookup-helper' },
    });
    class RuntimeCapabilityBag {
      #client = new Map([['runtime', 'codex']]);
      provider = 'codex';

      lookup(id: string) {
        return this.#client.get(id);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as { lookup: (id: string) => string }).lookup('runtime'),
      { name: 'private-lookup-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'private-lookup-helper-handler',
        eventId: 'github-webhook:delivery-private-lookup-helper:github.issue',
        status: 'fulfilled',
        value: 'codex',
      },
    ]);
  });

  it('proxies capability bags with custom Symbol.toStringTag values', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-tagged-capability-bag', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/tagged-capability-bag' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:tagged-capability' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;
      get [Symbol.toStringTag]() {
        return 'RuntimeCapabilityBag';
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'tagged-capability-bag-handler',
          runId: context.runId,
        }),
      { name: 'tagged-capability-bag-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'tagged-capability-bag-handler',
      eventId: 'github-webhook:delivery-tagged-capability-bag:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('proxies custom tagged capability bags with private starter helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-tagged-private-run-capability-bag', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/tagged-private-run-capability-bag' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:tagged-private-run',
    }));
    class RuntimeCapabilityBag {
      #runAgent = dispatchAgent;
      provider = 'codex';
      get [Symbol.toStringTag]() {
        return 'RuntimeCapabilityBag';
      }

      run(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.#runAgent(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { run: NonNullable<RuntimeCapabilities['dispatchAgent']> }).run({
          event: handledEvent,
          workflow: 'tagged-private-run-capability-bag-handler',
          runId: context.runId,
        }),
      { name: 'tagged-private-run-capability-bag-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'tagged-private-run-capability-bag-handler',
      eventId: 'github-webhook:delivery-tagged-private-run-capability-bag:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not gate unrelated anonymous bound helpers by name alone', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-empty-name-bound-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/empty-name-bound-dispatch' },
    });
    const rawDispatchAgent = [async () => ({ sessionKey: 'agent:main:empty-name-bound' })][0] as NonNullable<
      RuntimeCapabilities['dispatchAgent']
    >;
    const describe = function () {
      return 'helper:ok';
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent: rawDispatchAgent,
          describe: describe.bind({}),
        } as RuntimeCapabilities & { describe: () => string },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as { describe: () => string }).describe(),
      { name: 'empty-name-bound-dispatch-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'empty-name-bound-dispatch-handler',
        eventId: 'github-webhook:delivery-empty-name-bound-dispatch:github.issue',
        status: 'fulfilled',
        value: 'helper:ok',
      },
    ]);
  });

  it('does not read failing dispatchAgent getters for unrelated accessor helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-accessor-helper-dispatch-getter', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/accessor-helper-dispatch-getter' },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent is not configured');
          },
          get describe() {
            return () => 'helper:ok';
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as { describe: () => string }).describe(),
      { name: 'accessor-helper-dispatch-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'accessor-helper-dispatch-getter-handler',
        eventId: 'github-webhook:delivery-accessor-helper-dispatch-getter:github.issue',
        status: 'fulfilled',
        value: 'helper:ok',
      },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('preserves undefined dispatchAgent accessors for optional callers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-undefined-dispatch-agent-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/undefined-dispatch-agent-accessor' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return undefined;
          },
        } as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'undefined-dispatch-agent-accessor-handler',
          runId: context.runId,
        }) ?? { skipped: true },
      { name: 'undefined-dispatch-agent-accessor-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'undefined-dispatch-agent-accessor-handler',
        eventId: 'github-webhook:delivery-undefined-dispatch-agent-accessor:github.issue',
        status: 'fulfilled',
        value: { skipped: true },
      },
    ]);
  });

  it('preserves undefined dispatchAgent accessors for optional callers without runtime:start', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-undefined-dispatch-agent-accessor-denied', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/undefined-dispatch-agent-accessor-denied' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return undefined;
          },
        } as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'undefined-dispatch-agent-accessor-denied-handler',
          runId: context.runId,
        }) ?? { skipped: true },
      { name: 'undefined-dispatch-agent-accessor-denied-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'undefined-dispatch-agent-accessor-denied-handler',
        eventId: 'github-webhook:delivery-undefined-dispatch-agent-accessor-denied:github.issue',
        status: 'fulfilled',
        value: { skipped: true },
      },
    ]);
  });

  it('preserves undefined dispatchAgent accessors in property descriptors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-undefined-dispatch-agent-descriptor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/undefined-dispatch-agent-descriptor' },
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return undefined;
          },
        } as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        Object.getOwnPropertyDescriptor(context.capabilities, 'dispatchAgent')?.value ?? { skipped: true },
      { name: 'undefined-dispatch-agent-descriptor-handler', capabilities: ['runtime:start'] },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'undefined-dispatch-agent-descriptor-handler',
        eventId: 'github-webhook:delivery-undefined-dispatch-agent-descriptor:github.issue',
        status: 'fulfilled',
        value: { skipped: true },
      },
    ]);
  });

  it('gates arbitrary data aliases for getter-backed dispatchAgent when invoked as a starter', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-getter-backed-run-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/getter-backed-run-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:getter-backed-run-alias' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          run: dispatchAgent,
        } as RuntimeCapabilities & { run: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { run: RuntimeCapabilities['dispatchAgent'] }).run?.({
          event: handledEvent,
          workflow: 'getter-backed-run-alias-handler',
          runId: context.runId,
        }),
      { name: 'getter-backed-run-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'getter-backed-run-alias-handler',
      eventId: 'github-webhook:delivery-getter-backed-run-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('proxies callable capability objects that expose dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-callable-capabilities', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/callable-capabilities' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:callable-capabilities' }));
    const capabilities = Object.assign(() => 'callable:ok', {
      provider: 'codex',
      dispatchAgent,
    }) as unknown as RuntimeCapabilities & (() => string);
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ capabilities }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'callable-capabilities-handler',
          runId: context.runId,
        }),
      { name: 'callable-capabilities-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'callable-capabilities-handler',
      eventId: 'github-webhook:delivery-callable-capabilities:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('keeps callable capability objects callable while gating dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-callable-capabilities-call', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/callable-capabilities-call' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:callable-capabilities-call' }));
    const capabilities = Object.assign(function () {
      return 'callable:ok';
    }, {
      provider: 'codex',
      dispatchAgent,
    }) as unknown as RuntimeCapabilities & (() => string);
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ capabilities }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as (() => string))(),
      { name: 'callable-capabilities-call-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'callable-capabilities-call-handler',
        eventId: 'github-webhook:delivery-callable-capabilities-call:github.issue',
        status: 'fulfilled',
        value: 'callable:ok',
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates direct callable capability dispatch requests', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-callable-capabilities-direct-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/callable-capabilities-direct-dispatch' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:callable-capabilities-direct-dispatch' }));
    const capabilities = Object.assign(dispatchAgent, {
      provider: 'codex',
      dispatchAgent,
    }) as unknown as RuntimeCapabilities & RuntimeCapabilities['dispatchAgent'];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ capabilities }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as NonNullable<RuntimeCapabilities['dispatchAgent']>)({
          event: handledEvent,
          workflow: 'callable-capabilities-direct-dispatch-handler',
          runId: context.runId,
        }),
      { name: 'callable-capabilities-direct-dispatch-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'callable-capabilities-direct-dispatch-handler',
      eventId: 'github-webhook:delivery-callable-capabilities-direct-dispatch:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('keeps callable capability descriptors compatible with function invariants', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-callable-capabilities-descriptors', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/callable-capabilities-descriptors' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:callable-capabilities-descriptors' }));
    function capabilities() {
      return 'callable:ok';
    }
    Object.assign(capabilities, {
      provider: 'codex',
      dispatchAgent,
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ capabilities: capabilities as unknown as RuntimeCapabilities }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => ({
        keys: Object.keys(context.capabilities as unknown as object),
        prototypeDescriptor: Object.getOwnPropertyDescriptor(context.capabilities, 'prototype')?.configurable,
      }),
      { name: 'callable-capabilities-descriptors-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'callable-capabilities-descriptors-handler',
        eventId: 'github-webhook:delivery-callable-capabilities-descriptors:github.issue',
        status: 'fulfilled',
        value: { keys: ['provider', 'dispatchAgent'], prototypeDescriptor: true },
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry private capability helpers with dispatch requests on the raw receiver', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-run-dispatch-request', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-run-dispatch-request' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-run',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;
      #run = dispatchAgent;

      start(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.#run(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { start: RuntimeCapabilityBag['start'] }).start({
          event: handledEvent,
          workflow: 'private-run-dispatch-request-handler',
          runId: context.runId,
        }),
      { name: 'private-run-dispatch-request-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-run-dispatch-request-handler',
      eventId: 'github-webhook:delivery-private-run-dispatch-request:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('retries benign private helpers that accept request-shaped inputs', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-request-shaped-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-request-shaped-helper' },
    });
    class RuntimeCapabilityBag {
      provider = 'codex';

      #format(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return `${request.workflow}:${request.runId}`;
      }

      buildInputs(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.#format(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { buildInputs: RuntimeCapabilityBag['buildInputs'] }).buildInputs({
          event: handledEvent,
          workflow: 'private-request-shaped-helper-handler',
          runId: context.runId,
        }),
      { name: 'private-request-shaped-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'private-request-shaped-helper-handler',
        eventId: 'github-webhook:delivery-private-request-shaped-helper:github.issue',
        status: 'fulfilled',
        value: 'private-request-shaped-helper-handler:run-1',
      },
    ]);
  });

  it('does not retry private runAgent helpers that start agents internally', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-run-agent-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-run-agent-helper' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-run-agent-helper',
    }));
    class RuntimeCapabilityBag {
      #runAgent = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      execute() {
        return this.#runAgent({
          event,
          workflow: 'private-run-agent-helper-handler',
          runId: 'run-1',
        });
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { execute: RuntimeCapabilityBag['execute'] }).execute(),
      { name: 'private-run-agent-helper-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-run-agent-helper-handler',
      eventId: 'github-webhook:delivery-private-run-agent-helper:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry private starter helpers with arbitrary private aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-starter-helper-arbitrary-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-starter-helper-arbitrary-alias' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-starter-helper-arbitrary-alias',
    }));
    class RuntimeCapabilityBag {
      #fn = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      run() {
        return this.#fn({
          event,
          workflow: 'private-starter-helper-arbitrary-alias-handler',
          runId: 'run-1',
        });
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { run: RuntimeCapabilityBag['run'] }).run(),
      { name: 'private-starter-helper-arbitrary-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-starter-helper-arbitrary-alias-handler',
      eventId: 'github-webhook:delivery-private-starter-helper-arbitrary-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates dispatchAgent returned through private helper aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-helper-function-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-helper-function-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:private-helper-function-alias' }));
    class RuntimeCapabilityBag {
      #fn = dispatchAgent;
      provider = 'codex';

      get dispatchAgent() {
        return dispatchAgent;
      }

      getFn() {
        return this.#fn;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { getFn: () => RuntimeCapabilities['dispatchAgent'] }).getFn()?.({
          event: handledEvent,
          workflow: 'private-helper-function-alias-handler',
          runId: context.runId,
        }),
      { name: 'private-helper-function-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-function-alias-handler',
      eventId: 'github-webhook:delivery-private-helper-function-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates private helper methods that return dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-method-returned-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-method-returned-dispatch-agent' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(
      async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
        sessionKey: 'agent:main:private-method-returned-dispatch-agent',
      }),
    );
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      #get() {
        return dispatchAgent;
      }

      go(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this.#get()(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { go: RuntimeCapabilityBag['go'] }).go({
          event: handledEvent,
          workflow: 'private-method-returned-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'private-method-returned-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-method-returned-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-private-method-returned-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not leak raw receivers through private helper callbacks', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-helper-callback-receiver', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-helper-callback-receiver' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:private-helper-callback-receiver' }));
    class RuntimeCapabilityBag {
      #token = 'private';
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      expose(callback: (receiver: RuntimeCapabilities) => void) {
        callback(this as unknown as RuntimeCapabilities);
        return this.#token;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) => {
        let leaked: RuntimeCapabilities | undefined;
        (context.capabilities as unknown as { expose: RuntimeCapabilityBag['expose'] }).expose((receiver) => {
          leaked = receiver;
        });
        return leaked?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'private-helper-callback-receiver-handler',
          runId: context.runId,
        });
      },
      { name: 'private-helper-callback-receiver-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-callback-receiver-handler',
      eventId: 'github-webhook:delivery-private-helper-callback-receiver:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates private helper closures that capture dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-helper-closure-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-helper-closure-alias' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:private-helper-closure-alias',
    }));
    class RuntimeCapabilityBag {
      #fn = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      getStarter() {
        const fn = this.#fn;
        return (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => fn(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { getStarter: () => RuntimeCapabilities['dispatchAgent'] }).getStarter()?.({
          event: handledEvent,
          workflow: 'private-helper-closure-alias-handler',
          runId: context.runId,
        }),
      { name: 'private-helper-closure-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-closure-alias-handler',
      eventId: 'github-webhook:delivery-private-helper-closure-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates closures returned from public helpers when called with dispatch requests', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-public-helper-closure-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/public-helper-closure-alias' },
    });
    const dispatchAgent = vi.fn(async (_request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => ({
      sessionKey: 'agent:main:public-helper-closure-alias',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          getStarter() {
            const rawDispatchAgent = dispatchAgent;
            return (request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) => rawDispatchAgent(request);
          },
        } as RuntimeCapabilities & { getStarter: () => NonNullable<RuntimeCapabilities['dispatchAgent']> },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { getStarter: () => RuntimeCapabilities['dispatchAgent'] }).getStarter()?.({
          event: handledEvent,
          workflow: 'public-helper-closure-alias-handler',
          runId: context.runId,
        }),
      { name: 'public-helper-closure-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'public-helper-closure-alias-handler',
      eventId: 'github-webhook:delivery-public-helper-closure-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates prototype aliases for getter-backed dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-prototype-getter-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/prototype-getter-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:prototype-getter-alias' }));
    class RuntimeCapabilityBag {
      provider = 'codex';

      get dispatchAgent() {
        return dispatchAgent;
      }
    }
    (RuntimeCapabilityBag.prototype as RuntimeCapabilityBag & {
      startAgent?: RuntimeCapabilities['dispatchAgent'];
    }).startAgent = dispatchAgent;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          Object.getPrototypeOf(context.capabilities) as {
            startAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).startAgent?.({
          event: handledEvent,
          workflow: 'prototype-getter-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'prototype-getter-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-getter-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-prototype-getter-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates prototype run aliases for field-backed dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-prototype-run-dispatch-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/prototype-run-dispatch-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:prototype-run-alias' }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;
    }
    (RuntimeCapabilityBag.prototype as RuntimeCapabilityBag & {
      run?: RuntimeCapabilities['dispatchAgent'];
    }).run = dispatchAgent;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          Object.getPrototypeOf(context.capabilities) as {
            run?: RuntimeCapabilities['dispatchAgent'];
          }
        ).run?.({
          event: handledEvent,
          workflow: 'prototype-run-dispatch-alias-handler',
          runId: context.runId,
        }),
      { name: 'prototype-run-dispatch-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-run-dispatch-alias-handler',
      eventId: 'github-webhook:delivery-prototype-run-dispatch-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('reads registered accessor capabilities for each dispatch', async () => {
    const firstEvent = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-accessor-capability-first', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-accessor-capability-first' },
    });
    const secondEvent = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-loader-accessor-capability-second', receivedAt: '2026-06-29T14:01:00.000Z' },
      occurredAt: '2026-06-29T14:01:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'merge' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-accessor-capability-second' },
    });
    let currentCapabilities: RuntimeCapabilityName[] = [];
    const mergePullRequest = vi.fn(async () => ({ id: 'merge:ok' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        actions: {
          mergePullRequest,
          startRuntime: async () => ({ id: 'run:mock', provider: 'codex', status: 'queued' }),
          readSecret: async () => 'secret',
        },
      }),
    });

    loader.register({
      name: 'loader-accessor-capability-handler',
      accepts(event) {
        currentCapabilities = event.payload && typeof event.payload === 'object' && 'action' in event.payload && event.payload.action === 'merge'
          ? ['merge']
          : [];
        return true;
      },
      get capabilities() {
        return currentCapabilities;
      },
      async handle(event, context) {
        if (event.payload && typeof event.payload === 'object' && 'action' in event.payload && event.payload.action === 'merge') {
          await context.actions.mergePullRequest({
            pullRequestId: 'github:reirei-lab/rainrail#36',
          });
          return { merged: true };
        }

        return { skipped: true };
      },
    });

    await expect(loader.dispatch(firstEvent)).resolves.toMatchObject([
      {
        pluginName: 'loader-accessor-capability-handler',
        eventId: 'github-webhook:delivery-loader-accessor-capability-first:github.issue',
        status: 'fulfilled',
        value: { skipped: true },
      },
    ]);
    await expect(loader.dispatch(secondEvent)).resolves.toMatchObject([
      {
        pluginName: 'loader-accessor-capability-handler',
        eventId: 'github-webhook:delivery-loader-accessor-capability-second:github.issue',
        status: 'fulfilled',
        value: { merged: true },
      },
    ]);
    expect(mergePullRequest).toHaveBeenCalledOnce();
  });

  it('reads registered accessor timeouts for each dispatch', async () => {
    vi.useFakeTimers();
    try {
      const firstEvent = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-loader-accessor-timeout-first', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-accessor-timeout-first' },
      });
      const secondEvent = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-loader-accessor-timeout-second', receivedAt: '2026-06-29T14:01:00.000Z' },
        occurredAt: '2026-06-29T14:01:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'timeout' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-accessor-timeout-second' },
      });
      let currentTimeoutMs: number | undefined;
      const loader = createPluginLoader({ runtime: mockRuntimeContext() });

      loader.register({
        name: 'loader-accessor-timeout-handler',
        accepts(event: RainrailEventEnvelope) {
          currentTimeoutMs = event.payload && typeof event.payload === 'object' && 'action' in event.payload && event.payload.action === 'timeout'
            ? 25
            : undefined;
          return true;
        },
        get timeoutMs() {
          return currentTimeoutMs;
        },
        handle(event: RainrailEventEnvelope) {
          return event.payload && typeof event.payload === 'object' && 'action' in event.payload && event.payload.action === 'timeout'
            ? new Promise(() => undefined)
            : { skipped: true };
        },
      } as unknown as WorkflowPlugin);

      await expect(loader.dispatch(firstEvent)).resolves.toMatchObject([
        {
          pluginName: 'loader-accessor-timeout-handler',
          eventId: 'github-webhook:delivery-loader-accessor-timeout-first:github.issue',
          status: 'fulfilled',
          value: { skipped: true },
        },
      ]);

      const secondDispatch = loader.dispatch(secondEvent);
      await vi.advanceTimersByTimeAsync(25);
      const secondResult = await Promise.race([secondDispatch, Promise.resolve('still-pending')]);
      expect(secondResult).toMatchObject([
        {
          pluginName: 'loader-accessor-timeout-handler',
          eventId: 'github-webhook:delivery-loader-accessor-timeout-second:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read dispatchAgent getters for unrelated function helper results', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-function-helper-result', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/function-helper-result' },
    });
    let dispatchAgentReads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent(): never {
            dispatchAgentReads += 1;
            throw new Error('dispatchAgent is not configured');
          },
          getCallback: () => () => 'callback:ok',
        } as unknown as RuntimeCapabilities & { getCallback: () => () => string },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { getCallback: () => () => string }).getCallback()(),
      { name: 'function-helper-result-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'function-helper-result-handler',
        eventId: 'github-webhook:delivery-function-helper-result:github.issue',
        status: 'fulfilled',
        value: 'callback:ok',
      },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('does not read dispatchAgent getters for unrelated constructor metadata', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-constructor-name-dispatch-getter', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/constructor-name-dispatch-getter' },
    });
    let dispatchAgentReads = 0;
    class RuntimeCapabilityBag {
      provider = 'codex';
      get dispatchAgent(): never {
        dispatchAgentReads += 1;
        throw new Error('dispatchAgent is not configured');
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => context.capabilities?.constructor.name,
      { name: 'constructor-name-dispatch-getter-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'constructor-name-dispatch-getter-handler',
        eventId: 'github-webhook:delivery-constructor-name-dispatch-getter:github.issue',
        status: 'fulfilled',
        value: 'RuntimeCapabilityBag',
      },
    ]);
    expect(dispatchAgentReads).toBe(0);
  });

  it('wraps dispatchAgent properties on built-in capability objects', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-builtin-dispatch-agent-property', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/builtin-dispatch-agent-property' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:builtin-dispatch-agent-property' }));
    const metadata = Object.assign(new Date('2026-06-29T14:00:00.000Z'), { dispatchAgent });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: Date & { dispatchAgent: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Date & { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).metadata.dispatchAgent?.({
          event: handledEvent,
          workflow: 'builtin-dispatch-agent-property-handler',
          runId: context.runId,
        }),
      { name: 'builtin-dispatch-agent-property-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'builtin-dispatch-agent-property-handler',
      eventId: 'github-webhook:delivery-builtin-dispatch-agent-property:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('wraps dispatchAgent-like aliases on built-in capability objects', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-builtin-start-agent-property', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/builtin-start-agent-property' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:builtin-start-agent-property' }));
    const metadata = Object.assign(new Date('2026-06-29T14:00:00.000Z'), { startAgent: dispatchAgent });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: Date & { startAgent: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Date & { startAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).metadata.startAgent?.({
          event: handledEvent,
          workflow: 'builtin-start-agent-property-handler',
          runId: context.runId,
        }),
      { name: 'builtin-start-agent-property-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'builtin-start-agent-property-handler',
      eventId: 'github-webhook:delivery-builtin-start-agent-property:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates bound dispatchAgent aliases on built-in capability objects', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-builtin-bound-launcher', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/builtin-bound-launcher' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:builtin-bound-launcher',
    }));
    const metadata = Object.assign(new Date('2026-06-29T14:00:00.000Z'), {
      launcher: dispatchAgent.bind(undefined) as RuntimeCapabilities['dispatchAgent'],
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: Date & { launcher: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: Date & { launcher?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).metadata.launcher?.({
          event: handledEvent,
          workflow: 'builtin-bound-launcher-handler',
          runId: context.runId,
        }),
      { name: 'builtin-bound-launcher-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'builtin-bound-launcher-handler',
      eventId: 'github-webhook:delivery-builtin-bound-launcher:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates startRun capability aliases without canonical dispatchAgent metadata', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-start-run-capability-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/start-run-capability-alias' },
    });
    const startRun = vi.fn(async () => ({ sessionKey: 'agent:main:start-run-capability-alias' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          startRun,
        } as unknown as RuntimeCapabilities & { startRun: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            startRun?: RuntimeCapabilities['dispatchAgent'];
          }
        ).startRun?.({
          event: handledEvent,
          workflow: 'start-run-capability-alias-handler',
          runId: context.runId,
        }),
      { name: 'start-run-capability-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'start-run-capability-alias-handler',
      eventId: 'github-webhook:delivery-start-run-capability-alias:github.issue',
      status: 'rejected',
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('retries benign private agent metadata helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-agent-id-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-agent-id-helper' },
    });
    class RuntimeCapabilityBag {
      #agentId = 'agent-metadata';
      provider = 'codex';

      describe() {
        return this.#agentId;
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => (context.capabilities as unknown as { describe: () => string }).describe(),
      { name: 'private-agent-id-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'private-agent-id-helper-handler',
        eventId: 'github-webhook:delivery-private-agent-id-helper:github.issue',
        status: 'fulfilled',
        value: 'agent-metadata',
      },
    ]);
  });

  it('preserves instanceof checks for capability prototype helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-capability-instanceof-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/capability-instanceof-helper' },
    });
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = async () => ({ sessionKey: 'agent:main:instanceof-helper' });

      lookupRuntime() {
        return this instanceof RuntimeCapabilityBag ? 'runtime:ok' : 'runtime:bad';
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { lookupRuntime: () => string }).lookupRuntime(),
      { name: 'capability-instanceof-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'capability-instanceof-helper-handler',
        eventId: 'github-webhook:delivery-capability-instanceof-helper:github.issue',
        status: 'fulfilled',
        value: 'runtime:ok',
      },
    ]);
  });

  it('treats timeout values outside the timer range as no timeout', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-invalid-default-timeout', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/invalid-default-timeout' },
      });
      let resolveHandler: ((value: { finished: true }) => void) | undefined;
      const dispatcher = createRuntimeDispatcher({
        workflows: [
          {
            name: 'invalid-default-timeout-handler',
            handle: async () =>
              new Promise<{ finished: true }>((resolve) => {
                resolveHandler = resolve;
              }),
          },
        ],
        runtime: mockRuntimeContext(),
        defaultTimeoutMs: Infinity,
      });

      const dispatchPromise = dispatcher.dispatch(event);
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.race([dispatchPromise, Promise.resolve('still-pending')])).resolves.toBe('still-pending');
      resolveHandler?.({ finished: true });

      await expect(dispatchPromise).resolves.toMatchObject([
        {
          pluginName: 'invalid-default-timeout-handler',
          eventId: 'github-webhook:delivery-invalid-default-timeout:github.issue',
          status: 'fulfilled',
          value: { finished: true },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read timeout accessors before accepts initializes matching workflows', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-accepts-initialized-timeout', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/accepts-initialized-timeout' },
    });
    let initialized = false;
    const workflow = {
      name: 'accepts-initialized-timeout-handler',
      accepts() {
        // Match timeout-related events after initializing metadata state.
        initialized = true;
        return true;
      },
      get timeoutMs() {
        if (!initialized) {
          throw new Error('timeout is not initialized');
        }

        return 25;
      },
      handle: () => ({ handled: true }),
    } satisfies WorkflowPlugin;
    const dispatcher = createRuntimeDispatcher({
      workflows: [workflow],
      runtime: mockRuntimeContext(),
    });

    await expect(dispatcher.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'accepts-initialized-timeout-handler',
        eventId: 'github-webhook:delivery-accepts-initialized-timeout:github.issue',
        status: 'fulfilled',
        value: { handled: true },
      },
    ]);
  });

  it('does not advertise missing optional task provider methods', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-missing-optional-task-method', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/missing-optional-task-method' },
    });
    const tasks = {
      name: 'mock-tasks',
      kind: 'task-provider',
      getIssue: async () => ({ id: 'issue:13', provider: 'github' as const, repository: 'reirei-lab/rainrail', number: 13, title: 'Issue' }),
      createComment: async () => ({ id: 'comment:mock' }),
    } satisfies TaskProvider;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({ providers: { tasks } }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) => ({
        hasCreateProposal: 'createProposal' in context.providers.tasks,
        keys: Object.keys(context.providers.tasks),
      }),
      { name: 'missing-optional-task-method-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'missing-optional-task-method-handler',
        eventId: 'github-webhook:delivery-missing-optional-task-method:github.issue',
        status: 'fulfilled',
        value: { hasCreateProposal: false, keys: ['name', 'kind', 'getIssue', 'createComment'] },
      },
    ]);
  });

  it('gates dispatchAgent aliases exposed through prototype constructors', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-prototype-constructor-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/prototype-constructor-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:prototype-constructor-alias' }));
    class RuntimeCapabilityBag {
      static rawDispatchAgent = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          Object.getPrototypeOf(context.capabilities) as {
            constructor: { rawDispatchAgent?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).constructor.rawDispatchAgent?.({
          event: handledEvent,
          workflow: 'prototype-constructor-alias-handler',
          runId: context.runId,
        }),
      { name: 'prototype-constructor-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'prototype-constructor-alias-handler',
      eventId: 'github-webhook:delivery-prototype-constructor-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not invoke raw dispatchAgent during private helper retries', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-helper-go-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-helper-go-alias' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:private-helper-go-alias',
    }));
    class RuntimeCapabilityBag {
      #fn = dispatchAgent;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      go() {
        return this.#fn({
          event,
          workflow: 'private-helper-go-alias-handler',
          runId: 'private-run',
        });
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { go: RuntimeCapabilityBag['go'] }).go(),
      { name: 'private-helper-go-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-helper-go-alias-handler',
      eventId: 'github-webhook:delivery-private-helper-go-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not steal dispatch-shaped requests from unrelated capability helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-unrelated-request-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/unrelated-request-helper' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:unrelated-request-helper' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          buildInputs(request: { event: RainrailEventEnvelope; workflow: string; runId: string }) {
            return {
              eventId: request.event.id,
              workflow: request.workflow,
              runId: request.runId,
            };
          },
        } as RuntimeCapabilities & {
          buildInputs: (request: { event: RainrailEventEnvelope; workflow: string; runId: string }) => unknown;
        },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            buildInputs: (request: { event: RainrailEventEnvelope; workflow: string; runId: string }) => unknown;
          }
        ).buildInputs({
          event: handledEvent,
          workflow: 'unrelated-request-helper-handler',
          runId: context.runId,
        }),
      { name: 'unrelated-request-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'unrelated-request-helper-handler',
        eventId: 'github-webhook:delivery-unrelated-request-helper:github.issue',
        status: 'fulfilled',
        value: {
          eventId: 'github-webhook:delivery-unrelated-request-helper:github.issue',
          workflow: 'unrelated-request-helper-handler',
          runId: 'run-1',
        },
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('wraps inherited capability prototypes that expose dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-inherited-prototype-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/inherited-prototype-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:inherited-prototype' }));
    class BaseCapabilityBag {
      dispatchAgent = dispatchAgent;
    }
    class RuntimeCapabilityBag extends BaseCapabilityBag {
      provider = 'codex';
    }
    BaseCapabilityBag.prototype.dispatchAgent = dispatchAgent;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          Object.getPrototypeOf(Object.getPrototypeOf(context.capabilities)) as {
            dispatchAgent?: RuntimeCapabilities['dispatchAgent'];
          }
        ).dispatchAgent?.({
          event: handledEvent,
          workflow: 'inherited-prototype-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'inherited-prototype-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'inherited-prototype-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-inherited-prototype-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not retry private helpers that hide dispatch requests in private fields', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-request-field-dispatch', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-request-field-dispatch' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:private-request-field-dispatch',
    }));
    class RuntimeCapabilityBag {
      #fn = dispatchAgent;
      #request = {
        event,
        workflow: 'private-request-field-dispatch-handler',
        runId: 'private-run',
      };
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      go() {
        return this.#fn(this.#request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { go: RuntimeCapabilityBag['go'] }).go(),
      { name: 'private-request-field-dispatch-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-request-field-dispatch-handler',
      eventId: 'github-webhook:delivery-private-request-field-dispatch:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not read dynamically undefined dispatchAgent accessors before denial', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-dynamic-undefined-dispatch-agent-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/dynamic-undefined-dispatch-agent-accessor' },
    });
    let reads = 0;
    const client = undefined as { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] } | undefined;
    const capabilities = {
      provider: 'codex',
      get dispatchAgent() {
        reads += 1;
        return client?.dispatchAgent;
      },
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: capabilities as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'dynamic-undefined-dispatch-agent-accessor-handler',
          runId: context.runId,
        }) ?? { skipped: true },
      { name: 'dynamic-undefined-dispatch-agent-accessor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'dynamic-undefined-dispatch-agent-accessor-handler',
      eventId: 'github-webhook:delivery-dynamic-undefined-dispatch-agent-accessor:github.issue',
      status: 'rejected',
    });
    expect(reads).toBe(0);
  });

  it('does not expose raw constructors through capability prototypes', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-raw-prototype-constructor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/raw-prototype-constructor' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:raw-prototype-constructor',
    }));
    class RuntimeCapabilityBag {
      provider = 'codex';
      dispatchAgent = dispatchAgent;
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) => {
        const Constructor = Object.getPrototypeOf(context.capabilities).constructor as new () => RuntimeCapabilityBag;
        const raw = new Constructor();
        return raw.dispatchAgent?.({
          event: handledEvent,
          workflow: 'raw-prototype-constructor-handler',
          runId: context.runId,
        });
      },
      { name: 'raw-prototype-constructor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'raw-prototype-constructor-handler',
      eventId: 'github-webhook:delivery-raw-prototype-constructor:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('preserves built-in capability method receivers while wrapping dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-builtin-method-receiver', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/builtin-method-receiver' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:builtin-method-receiver' }));
    const metadata = Object.assign(new Date('2026-06-29T14:00:00.000Z'), { dispatchAgent });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: Date & { dispatchAgent: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { metadata: Date }).metadata.toISOString(),
      { name: 'builtin-method-receiver-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'builtin-method-receiver-handler',
        eventId: 'github-webhook:delivery-builtin-method-receiver:github.issue',
        status: 'fulfilled',
        value: '2026-06-29T14:00:00.000Z',
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not read logically undefined dispatchAgent accessors before denial', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-logical-undefined-dispatch-agent-accessor', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/logical-undefined-dispatch-agent-accessor' },
    });
    let reads = 0;
    const client = undefined as { dispatchAgent?: RuntimeCapabilities['dispatchAgent'] } | undefined;
    const capabilities = {
      provider: 'codex',
      get dispatchAgent() {
        reads += 1;
        return client && client.dispatchAgent;
      },
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: capabilities as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'logical-undefined-dispatch-agent-accessor-handler',
          runId: context.runId,
        }) ?? { skipped: true },
      { name: 'logical-undefined-dispatch-agent-accessor-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'logical-undefined-dispatch-agent-accessor-handler',
      eventId: 'github-webhook:delivery-logical-undefined-dispatch-agent-accessor:github.issue',
      status: 'rejected',
    });
    expect(reads).toBe(0);
  });

  it('wraps raw dispatchAgent stored as a constructor function property', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-constructor-function-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/constructor-function-dispatch-agent' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:constructor-function-dispatch-agent' }));
    const metadata = {
      constructor: dispatchAgent,
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: { constructor: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            metadata: { constructor?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).metadata.constructor?.({
          event: handledEvent,
          workflow: 'constructor-function-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'constructor-function-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'constructor-function-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-constructor-function-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates getter-backed dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-getter-backed-dispatch-agent-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/getter-backed-dispatch-agent-alias' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:getter-backed-dispatch-agent-alias',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          alias: dispatchAgent,
        } as unknown as RuntimeCapabilities & { alias: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { alias?: RuntimeCapabilities['dispatchAgent'] }).alias?.({
          event: handledEvent,
          workflow: 'getter-backed-dispatch-agent-alias-handler',
          runId: context.runId,
        }),
      { name: 'getter-backed-dispatch-agent-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'getter-backed-dispatch-agent-alias-handler',
      eventId: 'github-webhook:delivery-getter-backed-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates neutral getter-backed dispatchAgent aliases', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-neutral-getter-backed-dispatch-agent-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/neutral-getter-backed-dispatch-agent-alias' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:neutral-getter-backed-dispatch-agent-alias',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          helper: dispatchAgent,
        } as unknown as RuntimeCapabilities & { helper: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { helper?: RuntimeCapabilities['dispatchAgent'] }).helper?.({
          event: handledEvent,
          workflow: 'neutral-getter-backed-dispatch-agent-alias-handler',
          runId: context.runId,
        }),
      { name: 'neutral-getter-backed-dispatch-agent-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'neutral-getter-backed-dispatch-agent-alias-handler',
      eventId: 'github-webhook:delivery-neutral-getter-backed-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('wraps raw dispatchAgent stored as an own constructor value', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-own-constructor-dispatch-agent', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/own-constructor-dispatch-agent' },
    });
    let dispatchAgentCalls = 0;
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = async () => {
      dispatchAgentCalls += 1;
      return {
        sessionKey: 'agent:main:own-constructor-dispatch-agent',
      };
    };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          constructor: dispatchAgent,
        } as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { constructor?: RuntimeCapabilities['dispatchAgent'] }).constructor?.({
          event: handledEvent,
          workflow: 'own-constructor-dispatch-agent-handler',
          runId: context.runId,
        }),
      { name: 'own-constructor-dispatch-agent-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'own-constructor-dispatch-agent-handler',
      eventId: 'github-webhook:delivery-own-constructor-dispatch-agent:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgentCalls).toBe(0);
  });

  it('gates dispatch requests during private receiver retries', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-computed-dispatch-key', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-computed-dispatch-key' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:private-computed-dispatch-key',
    }));
    class RuntimeCapabilityBag {
      #key = 'dispatchAgent' as const;
      provider = 'codex';
      dispatchAgent = dispatchAgent;

      go(request: Parameters<NonNullable<RuntimeCapabilities['dispatchAgent']>>[0]) {
        return this[this.#key]?.(request);
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { go: RuntimeCapabilityBag['go'] }).go({
          event: handledEvent,
          workflow: 'private-computed-dispatch-key-handler',
          runId: context.runId,
        }),
      { name: 'private-computed-dispatch-key-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'private-computed-dispatch-key-handler',
      eventId: 'github-webhook:delivery-private-computed-dispatch-key:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates anonymous bound dispatchAgent aliases regardless of property name', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-anonymous-bound-launcher', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/anonymous-bound-launcher' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:anonymous-bound-launcher',
    }));
    Object.defineProperty(dispatchAgent, 'name', { value: '' });
    const launcher = dispatchAgent.bind(undefined) as RuntimeCapabilities['dispatchAgent'];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          launcher,
        } as unknown as RuntimeCapabilities & { launcher: RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { launcher?: RuntimeCapabilities['dispatchAgent'] }).launcher?.({
          event: handledEvent,
          workflow: 'anonymous-bound-launcher-handler',
          runId: context.runId,
        }),
      { name: 'anonymous-bound-launcher-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(launcher?.name).toBe('bound ');
    expect(result).toMatchObject({
      pluginName: 'anonymous-bound-launcher-handler',
      eventId: 'github-webhook:delivery-anonymous-bound-launcher:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates aliases of already-bound dispatchAgent values returned from helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-bound-dispatch-agent-returned-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/bound-dispatch-agent-returned-alias' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:bound-dispatch-agent-returned-alias' }));
    const rawDispatchAgent = dispatchAgent.bind(undefined) as RuntimeCapabilities['dispatchAgent'];
    const alias = dispatchAgent.bind(undefined) as RuntimeCapabilities['dispatchAgent'];
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent: rawDispatchAgent,
          getLauncher: () => alias,
        } as RuntimeCapabilities & { getLauncher: () => RuntimeCapabilities['dispatchAgent'] },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            getLauncher: () => RuntimeCapabilities['dispatchAgent'];
          }
        ).getLauncher()?.({
          event: handledEvent,
          workflow: 'bound-dispatch-agent-returned-alias-handler',
          runId: context.runId,
        }),
      { name: 'bound-dispatch-agent-returned-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'bound-dispatch-agent-returned-alias-handler',
      eventId: 'github-webhook:delivery-bound-dispatch-agent-returned-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('gates nested neutral aliases for getter-backed dispatchAgent', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-nested-getter-backed-dispatch-agent-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/nested-getter-backed-dispatch-agent-alias' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:nested-getter-backed-dispatch-agent-alias',
    }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            return dispatchAgent;
          },
          nested: { fn: dispatchAgent },
        } as unknown as RuntimeCapabilities & { nested: { fn: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (
          context.capabilities as unknown as {
            nested: { fn?: RuntimeCapabilities['dispatchAgent'] };
          }
        ).nested.fn?.({
          event: handledEvent,
          workflow: 'nested-getter-backed-dispatch-agent-alias-handler',
          runId: context.runId,
        }),
      { name: 'nested-getter-backed-dispatch-agent-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'nested-getter-backed-dispatch-agent-alias-handler',
      eventId: 'github-webhook:delivery-nested-getter-backed-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not read logically undefined dispatchAgent accessors before denial', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-logical-undefined-denial', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/logical-undefined-denial' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:logical-undefined-denial' }));
    let reads = 0;
    const client = { dispatchAgent };
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            reads += 1;
            return client && client.dispatchAgent;
          },
        } as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'logical-undefined-denial-handler',
          runId: context.runId,
        }),
      { name: 'logical-undefined-denial-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'logical-undefined-denial-handler',
      eventId: 'github-webhook:delivery-logical-undefined-denial:github.issue',
      status: 'rejected',
    });
    expect(reads).toBe(0);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('wraps raw dispatchAgent aliases on built-in capability objects', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-builtin-neutral-dispatch-agent-alias', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/builtin-neutral-dispatch-agent-alias' },
    });
    const dispatchAgent: NonNullable<RuntimeCapabilities['dispatchAgent']> = vi.fn(async () => ({
      sessionKey: 'agent:main:builtin-neutral-dispatch-agent-alias',
    }));
    const metadata = Object.assign(new Date('2026-06-29T14:00:00.000Z'), { fn: dispatchAgent });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          dispatchAgent,
          metadata,
        } as unknown as RuntimeCapabilities & { metadata: Date & { fn: RuntimeCapabilities['dispatchAgent'] } },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        (context.capabilities as unknown as { metadata: Date & { fn?: RuntimeCapabilities['dispatchAgent'] } }).metadata.fn?.({
          event: handledEvent,
          workflow: 'builtin-neutral-dispatch-agent-alias-handler',
          runId: context.runId,
        }),
      { name: 'builtin-neutral-dispatch-agent-alias-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'builtin-neutral-dispatch-agent-alias-handler',
      eventId: 'github-webhook:delivery-builtin-neutral-dispatch-agent-alias:github.issue',
      status: 'rejected',
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('retries benign private method helpers', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-private-method-helper', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/private-method-helper' },
    });
    class RuntimeCapabilityBag {
      provider = 'codex';

      #format() {
        return 'runtime:ok';
      }

      describe() {
        return this.#format();
      }
    }
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: new RuntimeCapabilityBag() as unknown as RuntimeCapabilities,
      }),
    });

    loader.on(
      'github.issue',
      (_handledEvent, context) =>
        (context.capabilities as unknown as { describe: RuntimeCapabilityBag['describe'] }).describe(),
      { name: 'private-method-helper-handler' },
    );

    await expect(loader.dispatch(event)).resolves.toMatchObject([
      {
        pluginName: 'private-method-helper-handler',
        eventId: 'github-webhook:delivery-private-method-helper:github.issue',
        status: 'fulfilled',
        value: 'runtime:ok',
      },
    ]);
  });

  it('does not read defined dispatchAgent accessors before denial', async () => {
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.issue',
      delivery: { id: 'delivery-defined-dispatch-agent-accessor-denial', receivedAt: '2026-06-29T14:00:00.000Z' },
      occurredAt: '2026-06-29T14:00:00.000Z',
      subject: { type: 'issue', id: '13' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/defined-dispatch-agent-accessor-denial' },
    });
    const dispatchAgent = vi.fn(async () => ({ sessionKey: 'agent:main:defined-dispatch-agent-accessor-denial' }));
    let reads = 0;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        capabilities: {
          provider: 'codex',
          get dispatchAgent() {
            reads += 1;
            return dispatchAgent;
          },
        },
      }),
    });

    loader.on(
      'github.issue',
      (handledEvent, context) =>
        context.capabilities?.dispatchAgent?.({
          event: handledEvent,
          workflow: 'defined-dispatch-agent-accessor-denial-handler',
          runId: context.runId,
        }),
      { name: 'defined-dispatch-agent-accessor-denial-handler' },
    );

    const [result] = await loader.dispatch(event);

    expect(result).toMatchObject({
      pluginName: 'defined-dispatch-agent-accessor-denial-handler',
      eventId: 'github-webhook:delivery-defined-dispatch-agent-accessor-denial:github.issue',
      status: 'rejected',
    });
    expect(reads).toBe(0);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('freezes missing loader timeout metadata at registration time', async () => {
    vi.useFakeTimers();
    try {
      const event = createEventEnvelope({
        source: { type: 'github', name: 'github-webhook' },
        name: 'github.issue',
        delivery: { id: 'delivery-loader-missing-timeout-snapshot', receivedAt: '2026-06-29T14:00:00.000Z' },
        occurredAt: '2026-06-29T14:00:00.000Z',
        subject: { type: 'issue', id: '13' },
        payload: { action: 'opened' },
        rawPayload: { kind: 'external-reference', reference: 'github://deliveries/loader-missing-timeout-snapshot' },
      });
      const workflow = {
        name: 'loader-missing-timeout-snapshot-handler',
        accepts() {
          this.timeoutMs = 60_000;
          return true;
        },
        handle: async () => new Promise(() => undefined),
      } satisfies WorkflowPlugin;
      const loader = createPluginLoader({
        runtime: mockRuntimeContext(),
        defaultTimeoutMs: 25,
      });

      loader.register(workflow);
      const dispatchPromise = loader.dispatch(event);
      await vi.advanceTimersByTimeAsync(25);
      const result = await Promise.race([dispatchPromise, Promise.resolve('still-pending')]);

      expect(result).toMatchObject([
        {
          pluginName: 'loader-missing-timeout-snapshot-handler',
          eventId: 'github-webhook:delivery-loader-missing-timeout-snapshot:github.issue',
          status: 'rejected',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
