import { describe, expect, it } from 'vitest';

import {
  createEventEnvelope,
  createPluginLoader,
  createRouteLocalHandler,
  createRouteWorkflow,
  matchesRoute,
  routeRainrailEvent,
  type Matcher,
  type PluginRuntimeContext,
} from './index.js';

function mockRuntimeContext(overrides: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  return {
    runId: 'run-route-1',
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider',
        getIssue: async () => ({
          id: 'issue:mock',
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 26,
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

const projectItemEvent = createEventEnvelope({
  source: {
    type: 'github',
    name: 'github-webhook',
    repository: 'reirei-lab/rainrail',
  },
  name: 'github.projects_v2_item',
  delivery: {
    id: 'delivery-route-1',
    receivedAt: '2026-07-01T00:00:00.000Z',
  },
  occurredAt: '2026-07-01T00:00:00.000Z',
  subject: {
    type: 'issue',
    id: '26',
    url: 'https://github.com/reirei-lab/rainrail/issues/26',
  },
  payload: {
    action: 'edited',
    changes: {
      field_value: {
        field_name: 'Agent session ID',
        to: 'session-123',
      },
    },
    labels: ['agent', 'triage'],
    repository: {
      full_name: 'reirei-lab/rainrail',
    },
  },
  rawPayload: {
    kind: 'external-reference',
    reference: 'github://deliveries/delivery-route-1',
  },
});

describe('route matcher', () => {
  it('ports the harness matcher tree to Rainrail event envelopes', () => {
    const matcher: Matcher = {
      and: [
        { source: 'github' },
        { eventName: 'github.projects_v2_item' },
        { path: 'event.action', equals: 'edited' },
        { path: 'event.changes.field_value.field_name', equals: 'Agent session ID' },
        {
          or: [
            { path: 'event.labels', includes: 'agent' },
            { path: 'subject.type', equals: 'pull_request' },
          ],
        },
        { not: { path: 'event.repository.full_name', includes: 'tastebook' } },
      ],
    };

    expect(matchesRoute(matcher, projectItemEvent)).toBe(true);
    expect(matchesRoute({ source: 'slack' }, projectItemEvent)).toBe(false);
    expect(matchesRoute({ path: 'event.missing', notEquals: 'anything' }, projectItemEvent)).toBe(false);
    expect(matchesRoute({ path: 'event.changes.field_value.to', exists: true }, projectItemEvent)).toBe(true);
    expect(matchesRoute({ path: 'event.repository.full_name', includes: 'rainrail' }, projectItemEvent)).toBe(true);
    expect(matchesRoute({ path: 'message.delivery.id', equals: 'delivery-route-1' }, projectItemEvent)).toBe(true);
  });
});

describe('routeRainrailEvent', () => {
  it('runs the baseline noop route by default', () => {
    expect(routeRainrailEvent({ event: projectItemEvent })).toEqual({
      action: 'matched',
      sourceId: 'github',
      sourceName: 'github-webhook',
      eventName: 'github.projects_v2_item',
      messageId: 'github-webhook:delivery-route-1:github.projects_v2_item',
      matchedRoutes: [
        {
          routeId: 'baseline-noop',
          action: {
            actionType: 'noop',
            status: 'completed',
            reason: 'baseline Rainrail route drops all events',
          },
        },
      ],
      unmatchedRouteIds: [],
      reason: undefined,
    });
  });

  it('matches explicit route definitions and reports unmatched routes', () => {
    expect(
      routeRainrailEvent({
        event: projectItemEvent,
        routes: [
          {
            id: 'agent-claim',
            match: {
              and: [
                { source: 'github' },
                { eventName: 'github.projects_v2_item' },
                { path: 'event.action', equals: 'edited' },
                { path: 'event.changes.field_value.field_name', equals: 'Agent session ID' },
              ],
            },
            action: { type: 'noop', reason: 'claim routing placeholder' },
          },
          {
            id: 'issue-comment',
            match: { eventName: 'github.issue_comment' },
            action: { type: 'noop' },
          },
        ],
      }),
    ).toMatchObject({
      action: 'matched',
      matchedRoutes: [
        {
          routeId: 'agent-claim',
          action: {
            actionType: 'noop',
            status: 'completed',
            reason: 'claim routing placeholder',
          },
        },
      ],
      unmatchedRouteIds: ['issue-comment'],
    });
  });

  it('returns noop when no route matches', () => {
    expect(
      routeRainrailEvent({
        event: projectItemEvent,
        routes: [
          {
            id: 'issue-comment',
            match: { eventName: 'github.issue_comment' },
            action: { type: 'noop' },
          },
        ],
      }),
    ).toMatchObject({
      action: 'noop',
      matchedRoutes: [],
      unmatchedRouteIds: ['issue-comment'],
      reason: 'no routes matched',
    });
  });
});

describe('route workflow plugin dispatch', () => {
  it('dispatches packaged route workflows through the plugin runtime', async () => {
    const workflow = createRouteWorkflow({
      name: 'route:agent-claim',
      routes: [
        {
          id: 'agent-claim',
          match: { eventName: 'github.projects_v2_item' },
          action: { type: 'noop', reason: 'claim routing placeholder' },
        },
      ],
    });
    const loader = createPluginLoader({
      runtime: mockRuntimeContext(),
    });

    loader.register(workflow);

    await expect(loader.dispatch(projectItemEvent)).resolves.toEqual([
      {
        pluginName: 'route:agent-claim',
        eventId: 'github-webhook:delivery-route-1:github.projects_v2_item',
        status: 'fulfilled',
        value: expect.objectContaining({
          action: 'matched',
          matchedRoutes: [
            {
              routeId: 'agent-claim',
              action: {
                actionType: 'noop',
                status: 'completed',
                reason: 'claim routing placeholder',
              },
            },
          ],
        }),
      },
    ]);
  });

  it('lets local handlers and packaged workflows share the same route dispatch value', async () => {
    const routes = [
      {
        id: 'agent-claim',
        match: { eventName: 'github.projects_v2_item' },
        action: { type: 'noop', reason: 'claim routing placeholder' },
      },
    ] as const;
    const loader = createPluginLoader({
      runtime: mockRuntimeContext(),
    });

    loader.register(createRouteWorkflow({ name: 'packaged-route', routes }));
    loader.on('github.projects_v2_item', createRouteLocalHandler({ routes }), {
      name: 'local-route',
    });

    const results = await loader.dispatch(projectItemEvent);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ pluginName: 'packaged-route', status: 'fulfilled' });
    expect(results[1]).toMatchObject({ pluginName: 'local-route', status: 'fulfilled' });
    expect(results[0]?.value).toEqual(results[1]?.value);
  });
});
