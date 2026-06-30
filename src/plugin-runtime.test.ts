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

  it('removes parent abort listeners when context creation fails before runWorkflow starts', async () => {
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
          handle: async () => ({ unreachable: true }),
        }),
      ],
      runtime: {
        runId: 'run-13',
        now: () => new Date('2026-06-29T14:01:00.000Z'),
        signal: parentController.signal,
        get providers(): never {
          throw new Error('task provider metadata is malformed');
        },
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

  it('does not read workflow metadata getters before accepts matches', async () => {
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
      get capabilities(): never {
        capabilityReads += 1;
        throw new Error('capabilities should not be read');
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
});
