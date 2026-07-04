import { describe, expect, it } from 'vitest';

import {
  createEventEnvelope,
  createGitHubWebhookIntakeAdapter,
  createGitHubWebhookSignature,
  createRainrailHttpApp,
  RainrailBridgeRoom,
  RainrailOperationalStore,
  type RainrailBridgeRoomState,
} from './index.js';

describe('Rainrail dashboard API', () => {
  it('serves split v1 overview, events, workflow runs, and agent tasks without requiring the snapshot shape', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 1,
      now: () => new Date('2026-07-02T00:05:00.000Z'),
    });
    const older = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-older', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '24', url: 'https://github.com/reirei-lab/rainrail/issues/24' },
      payload: { action: 'opened', token: 'should-not-appear-in-list' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-older' },
    }));
    const latest = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.pull_request',
      delivery: { id: 'delivery-latest', receivedAt: '2026-07-02T00:01:00.000Z' },
      occurredAt: '2026-07-02T00:01:00.000Z',
      subject: { type: 'pull_request', id: '25', url: 'https://github.com/reirei-lab/rainrail/pull/25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-latest' },
    }));
    const workflow = operationalStore.recordActivityEvent({
      sourceEventId: latest.id,
      sourceEventName: latest.name,
      category: 'plugin',
      targetType: 'event',
      targetId: latest.id,
      actionType: 'plugin_executed',
      outcome: 'success',
      summary: 'review-request plugin completed',
      metadata: { pluginName: 'review-request' },
    });
    operationalStore.recordEventHandlerRetry({
      eventId: latest.id,
      handlerName: 'conflict-check',
      nextRetryAt: '2026-07-02T00:10:00.000Z',
      lastError: 'GitHub mergeability is pending',
    });
    const task = operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_110',
      title: 'Dashboard query API を分割する',
      agentSessionId: 'agent:main:rainrail-110',
      branchName: 'agent/reirei-lab-rainrail-110-dashboard-query-api',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 110 },
      claim: { projectItemId: 'PVTI_110' },
      logPath: 'var/log/rainrail-110.log',
      pid: 2468,
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const overview = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      data: {
        counts: { events: 2, activityEvents: 1, agentTasks: 1, eventHandlerRetries: 1 },
        warnings: { staleProjectClaims: [] },
        recentActivity: [{ id: workflow.id, summary: 'review-request plugin completed' }],
      },
    });

    const events = await app.fetch(new Request('https://rainrail.local/api/v1/events?limit=1', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(events.status).toBe(200);
    const eventsBody = await events.json() as { data: Array<{ id: string }>; page: { nextCursor: string | null } };
    expect(eventsBody).toMatchObject({
      data: [{
        id: latest.id,
        type: 'event',
        status: 'received',
        summary: 'github.pull_request reirei-lab/rainrail#25',
        links: { self: `/api/v1/events/${encodeURIComponent(latest.id)}` },
      }],
      page: { limit: 1 },
    });
    expect(JSON.stringify(eventsBody)).not.toContain('should-not-appear-in-list');
    expect(eventsBody.page.nextCursor).toEqual(expect.any(String));

    const nextEvents = await app.fetch(new Request(`https://rainrail.local/api/v1/events?limit=1&cursor=${encodeURIComponent(eventsBody.page.nextCursor!)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(nextEvents.json()).resolves.toMatchObject({
      data: [{ id: older.id }],
      page: { limit: 1, nextCursor: null },
    });

    const eventDetail = await app.fetch(new Request(`https://rainrail.local/api/v1/events/${encodeURIComponent(latest.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(eventDetail.status).toBe(200);
    await expect(eventDetail.json()).resolves.toMatchObject({
      data: {
        id: latest.id,
        type: 'event',
        record: {
          name: latest.name,
          envelope: { schemaVersion: 'rainrail.event.v1' },
          activityEvents: [{ id: workflow.id }],
          handlerRetries: [{ handlerName: 'conflict-check' }],
        },
      },
    });

    const workflowRuns = await app.fetch(new Request('https://rainrail.local/api/v1/workflow-runs', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(workflowRuns.json()).resolves.toMatchObject({
      data: [{ id: workflow.id, type: 'workflow-run', status: 'success', sourceEventId: latest.id }],
      page: { limit: 50, nextCursor: null },
    });

    const agentTasks = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(agentTasks.json()).resolves.toMatchObject({
      data: [{
        id: task.id,
        type: 'agent-task',
        status: 'running',
        branchName: 'agent/reirei-lab-rainrail-110-dashboard-query-api',
        links: { self: `/api/v1/agent-tasks/${encodeURIComponent(task.id)}` },
      }],
      page: { limit: 50, nextCursor: null },
    });

    const taskDetail = await app.fetch(new Request(`https://rainrail.local/api/v1/agent-tasks/${task.id}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(taskDetail.json()).resolves.toMatchObject({
      data: {
        id: task.id,
        type: 'agent-task',
        record: { runtime: { status: 'running', pid: 2468 }, logPath: 'var/log/rainrail-110.log' },
      },
    });

    operationalStore.close();
  });

  it('rejects invalid v1 pagination and unsupported event list filters', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const badCursor = await app.fetch(new Request('https://rainrail.local/api/v1/events?cursor=not-a-cursor', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(badCursor.status).toBe(400);
    await expect(badCursor.json()).resolves.toEqual({ error: 'invalid_cursor' });

    const badFilter = await app.fetch(new Request('https://rainrail.local/api/v1/events?filter[unknown]=value', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(badFilter.status).toBe(400);
    await expect(badFilter.json()).resolves.toEqual({ error: 'unsupported_filter', filter: 'filter[unknown]' });

    operationalStore.close();
  });

  it('serves source, queue, and settings dashboard views without exposing secrets', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-source', receivedAt: '2026-07-02T00:02:00.000Z' },
      occurredAt: '2026-07-02T00:02:00.000Z',
      subject: { type: 'issue', id: '115', url: 'https://github.com/reirei-lab/rainrail/issues/115' },
      payload: { action: 'opened', webhookSecret: 'should-not-appear' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-source' },
    }));
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Sources / Queue / Settings view を追加する',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115-sources-queue-settings-view',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'Todo' },
      pid: 1150,
    });
    operationalStore.recordEventHandlerRetry({
      eventId: 'github-webhook:delivery-source:github.issue',
      handlerName: 'queue-dispatch',
      nextRetryAt: '2026-07-02T00:20:00.000Z',
      lastError: 'Project item is blocked',
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      runtime: 'node',
      intakeAdapters: [
        createGitHubWebhookIntakeAdapter({ secret: 'should-not-appear', sourceName: 'github-webhook', endpoint: '/webhooks/github' }),
      ],
    });

    const sources = await app.fetch(new Request('https://rainrail.local/api/v1/sources', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(sources.status).toBe(200);
    const sourcesBody = await sources.json();
    expect(sourcesBody).toMatchObject({
      data: [{
        id: 'github-webhook',
        type: 'source',
        status: 'configured',
        sourceType: 'github',
        name: 'github-webhook',
        endpoint: '/webhooks/github',
        auth: { status: 'configured' },
        lastDelivery: { id: 'delivery-source', receivedAt: '2026-07-02T00:02:00.000Z' },
      }],
      page: { limit: 50, nextCursor: null },
    });
    expect(JSON.stringify(sourcesBody)).not.toContain('should-not-appear');

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'agent_task_running',
        type: 'queue-item',
        status: 'in-progress',
        title: 'Sources / Queue / Settings view を追加する',
        projectStatus: 'Todo',
        claimLock: { projectItemId: 'PVTI_115', heldBy: 'agent:main:rainrail-115' },
      }],
      summary: {
        upcomingIssues: 0,
        blockedReasons: ['Project item is blocked'],
        inProgressCount: 1,
        claimedCount: 1,
      },
      page: { limit: 50, nextCursor: null },
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      data: [
        { id: 'max-concurrency', type: 'setting', status: 'read-only', value: 'not configured' },
        { id: 'auto-start', type: 'setting', status: 'read-only', value: 'not configured' },
        { id: 'retry-policy', type: 'setting', status: 'read-only', value: '1 retry pending' },
        { id: 'replay-retention', type: 'setting', status: 'read-only', value: '10 events' },
        { id: 'dashboard-auth', type: 'setting', status: 'read-only', value: 'bearer token configured' },
        { id: 'runtime', type: 'setting', status: 'read-only', value: 'node' },
      ],
      updatePolicy: { requiredScope: 'admin', audit: 'required' },
      page: { limit: 50, nextCursor: null },
    });

    operationalStore.close();
  });

  it('serves provider-neutral operational state through the HTTP app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-25', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25', url: 'https://github.com/reirei-lab/rainrail/issues/25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-25' },
    }));
    operationalStore.recordActivityEvent({
      category: 'plugin',
      targetType: 'event',
      actionType: 'plugin_executed',
      outcome: 'success',
      summary: 'plugin execution completed',
    });

    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const stateResponse = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      counts: { events: 1, activityEvents: 1 },
      events: [{ id: event.id, name: 'github.issue', source: { type: 'github' } }],
      activityEvents: [{ summary: 'plugin execution completed' }],
    });

    const detailResponse = await app.fetch(new Request(`https://rainrail.local/api/events/${encodeURIComponent(event.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: event.id,
      envelope: { subject: { type: 'issue', id: '25' } },
    });

    operationalStore.close();
  });

  it('protects operational dashboard API with the event bearer token', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-auth', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-auth' },
    }));
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const missingStateAuth = await app.fetch(new Request('https://rainrail.local/api/state'));
    expect(missingStateAuth.status).toBe(401);
    await expect(missingStateAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const missingDetailAuth = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`));
    expect(missingDetailAuth.status).toBe(401);
    await expect(missingDetailAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const missingV1Auth = await app.fetch(new Request('https://rainrail.local/api/v1/overview'));
    expect(missingV1Auth.status).toBe(401);
    await expect(missingV1Auth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(state.status).toBe(200);

    const detail = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detail.status).toBe(200);

    const overview = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(overview.status).toBe(200);

    operationalStore.close();
  });

  it('returns a stable unavailable response when the operational store is not configured', async () => {
    const app = createTestApp();

    const response = await app.fetch(new Request('https://rainrail.local/api/state'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_not_configured' });

    const v1Response = await app.fetch(new Request('https://rainrail.local/api/v1/events'));
    expect(v1Response.status).toBe(503);
    await expect(v1Response.json()).resolves.toEqual({ error: 'operational_store_not_configured' });
  });

  it('records HTTP-ingressed events in the operational store after publish succeeds', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));
    expect(webhook.status).toBe(202);

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(state.json()).resolves.toMatchObject({
      events: [{ id: 'github-webhook:delivery-operational-store:github.issue' }],
    });

    operationalStore.close();
  });

  it('stores the bridge-validated envelope instead of the raw webhook envelope', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    const rawBody = JSON.stringify({
      action: 'agent-run',
      branch: 'agent/reirei-lab-rainrail-25',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      client_payload: {
        issue: 25,
        token: 'should-not-be-persisted',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'repository_dispatch',
        'x-github-delivery': 'delivery-validated-envelope',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));
    expect(webhook.status).toBe(202);

    const event = operationalStore.getEvent('github-webhook:delivery-validated-envelope:github.repository_dispatch');
    expect(event?.envelope.payload).toEqual({ action: 'agent_run' });
    expect(JSON.stringify(event?.envelope)).not.toContain('should-not-be-persisted');
    operationalStore.close();
  });

  it('does not fail an already-published webhook when operational event recording fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    operationalStore.close();
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store-failure',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));

    expect(webhook.status).toBe(202);
    await expect(webhook.json()).resolves.toMatchObject({
      id: 'github-webhook:delivery-operational-store-failure:github.issue',
    });
  });

  it('treats malformed percent-encoded event ids as client errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/events/%E0%A4%A', {
      headers: { authorization: 'Bearer events-token' },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_event_id' });
    operationalStore.close();
  });
});

function createTestApp(options: {
  eventsBearerToken?: string;
  operationalStore?: RainrailOperationalStore;
  runtime?: string;
  intakeAdapters?: Parameters<typeof createRainrailHttpApp>[0]['intakeAdapters'];
} = {}) {
  return createRainrailHttpApp({
    room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
    publishToken: 'publish-token',
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    ...(options.operationalStore === undefined ? {} : { operationalStore: options.operationalStore }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    intakeAdapters: options.intakeAdapters ?? [
      createGitHubWebhookIntakeAdapter({ secret: 'secret' }),
    ],
  });
}

function fakeState(): RainrailBridgeRoomState {
  const values = new Map<string, unknown>([['rainrail:recent-events', []]]);
  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };
}
