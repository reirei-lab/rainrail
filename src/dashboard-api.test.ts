import { describe, expect, it, vi } from 'vitest';

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
        name: 'github.pull_request',
        status: 'received',
        summary: 'github.pull_request reirei-lab/rainrail#25',
        deliveryId: 'delivery-latest',
        rawPayloadReference: 'github://deliveries/delivery-latest',
        workflowRunCount: 1,
        handlerRetryCount: 1,
        latestOutcome: 'success',
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

    const nameFilteredEvents = await app.fetch(new Request('https://rainrail.local/api/v1/events?filter[name]=github.issue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(nameFilteredEvents.json()).resolves.toMatchObject({
      data: [{ id: older.id, name: 'github.issue', deliveryId: 'delivery-older' }],
      page: { limit: 50, nextCursor: null },
    });

    const eventDetail = await app.fetch(new Request(`https://rainrail.local/api/v1/events/${encodeURIComponent(latest.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(eventDetail.status).toBe(200);
    const eventDetailBody = await eventDetail.json();
    expect(eventDetailBody).toMatchObject({
      data: {
        id: latest.id,
        type: 'event',
        record: {
          name: latest.name,
          humanSummary: 'github.pull_request reirei-lab/rainrail#25',
          envelope: {
            schemaVersion: 'rainrail.event.v1',
            rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-latest' },
          },
          activityEvents: [{ id: workflow.id }],
          handlerRetries: [{ handlerName: 'conflict-check' }],
        },
      },
    });
    expect(JSON.stringify(eventDetailBody)).not.toContain('"payload"');

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

  it('reports dashboard auth misconfiguration before missing credentials', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/overview'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'events_auth_not_configured' });
    operationalStore.close();
  });

  it('accepts scoped dashboard tokens for read-only operational APIs', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        readOnlyToken: 'read-only-token',
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      },
    });

    for (const token of ['read-only-token', 'operator-token', 'admin-token']) {
      const response = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { counts: { agentTasks: 1 } },
      });
    }

    const invalid = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(invalid.status).toBe(403);
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_bearer_token' });

    operationalStore.close();
  });

  it('rejects duplicated dashboard tokens across different scopes', () => {
    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'shared-token',
      dashboardAuth: {
        adminToken: 'shared-token',
      },
    })).toThrow(/duplicate dashboard token scopes/i);

    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      dashboardAuth: {
        operatorToken: 'shared-token',
        adminToken: 'shared-token',
      },
    })).toThrow(/duplicate dashboard token scopes/i);

    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'read-token',
      dashboardAuth: {
        readOnlyToken: 'read-token',
      },
    })).not.toThrow();
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

  it('gates agent task command actions to operator tokens and records dry-run audit', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'Resume / reset / terminate / settings の command API を権限付きで設計する',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'read-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    const readOnlyResponse = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer read-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: true }),
    }));
    expect(readOnlyResponse.status).toBe(403);
    await expect(readOnlyResponse.json()).resolves.toEqual({
      error: 'insufficient_scope',
      requiredScope: 'operator',
    });

    const dryRunResponse = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-rainrail-client': 'dashboard',
        'x-request-id': 'request-resume-preview',
      },
      body: JSON.stringify({ dryRun: true }),
    }));

    expect(dryRunResponse.status).toBe(200);
    expect(dryRunResponse.headers.get('x-request-id')).toBe('request-resume-preview');
    await expect(dryRunResponse.json()).resolves.toMatchObject({
      data: {
        action: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_rainrail_111',
        status: 'preview',
        dryRun: true,
      },
    });
    expect(commandHandler).not.toHaveBeenCalled();
    expect(operationalStore.snapshot()).toMatchObject({
      counts: { activityEvents: 1, commandResults: 1 },
      activityEvents: [{
        category: 'command',
        actionType: 'agent_task_resume',
        outcome: 'skipped',
        metadata: {
          actor: 'operator',
          client: 'dashboard',
          requestId: 'request-resume-preview',
          dryRun: true,
        },
      }],
      commandResults: [{
        actionType: 'agent_task_resume',
        status: 'preview',
        actor: 'operator',
        client: 'dashboard',
        requestId: 'request-resume-preview',
        dryRun: true,
      }],
    });
    operationalStore.close();
  });

  it('requires confirmation for destructive commands before dispatching them', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn(async () => ({ stopped: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    const preview = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/terminate', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(preview.status).toBe(409);
    await expect(preview.json()).resolves.toMatchObject({
      error: 'action_confirmation_required',
      data: {
        action: 'agent_task_terminate',
        confirmationToken: 'confirm:agent_task_terminate:agent_task:agent_task_rainrail_111',
      },
    });
    expect(commandHandler).not.toHaveBeenCalled();

    const confirmed = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/terminate', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-terminate',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:agent_task_terminate:agent_task:agent_task_rainrail_111',
      }),
    }));

    expect(confirmed.status).toBe(202);
    await expect(confirmed.json()).resolves.toMatchObject({
      data: {
        action: 'agent_task_terminate',
        status: 'accepted',
        result: { stopped: true },
      },
    });
    expect(commandHandler).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'agent_task_terminate',
      targetType: 'agent_task',
      targetId: 'agent_task_rainrail_111',
      actor: 'operator',
      requestId: 'request-terminate',
    }));
    operationalStore.close();
  });

  it('rejects accepted commands when no command handler is configured', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'command_handler_not_configured' });
    expect(operationalStore.snapshot()).toMatchObject({ counts: { commandResults: 0, activityEvents: 0 } });
    operationalStore.close();
  });

  it('enforces a size limit before parsing command action bodies', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      dashboardCommandMaxBodyBytes: 4,
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: '{"too":"large"}',
    }));

    expect(response.status).toBe(413);
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
    await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    operationalStore.close();
  });

  it('returns request ids on invalid command action bodies', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-invalid-json',
      },
      body: '{',
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('request-invalid-json');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_json_body' });
    operationalStore.close();
  });

  it('limits settings updates to admin tokens', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => ({
      updated: command.inputs,
      providerResponse: {
        secretToken: 'handler-result-secret',
        publicStatus: 'applied',
      },
    }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const operatorResponse = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ settings: { autoAssign: false } }),
    }));
    expect(operatorResponse.status).toBe(403);
    await expect(operatorResponse.json()).resolves.toEqual({
      error: 'insufficient_scope',
      requiredScope: 'admin',
    });

    const adminResponse = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          autoAssign: false,
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));
    expect(adminResponse.status).toBe(202);
    await expect(adminResponse.json()).resolves.toMatchObject({
      data: {
        action: 'settings_update',
        status: 'accepted',
        result: {
          updated: {
            settings: {
              autoAssign: false,
              apiToken: '[redacted]',
            },
            confirmationToken: '[redacted]',
          },
          providerResponse: {
            secretToken: '[redacted]',
            publicStatus: 'applied',
          },
        },
      },
    });
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('handler-result-secret');
    operationalStore.close();
  });

  it('redacts sensitive input values echoed under neutral command result keys', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => ({
      appliedValue: command.inputs.settings && typeof command.inputs.settings === 'object' && 'apiToken' in command.inputs.settings
        ? command.inputs.settings.apiToken
        : undefined,
      providerMessage: `stored ${String((command.inputs.settings as { apiToken?: unknown }).apiToken)}`,
    }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    operationalStore.close();
  });

  it('redacts original sensitive inputs when handlers mutate command inputs before returning', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => {
      const settings = command.inputs.settings as { apiToken?: unknown };
      const originalToken = settings.apiToken;
      delete settings.apiToken;

      return { message: `applied ${String(originalToken)}` };
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    operationalStore.close();
  });

  it('does not dispatch commands when audit storage is unavailable', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.close();
    const commandHandler = vi.fn(async () => ({ applied: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_unavailable' });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it('does not persist secrets exposed through command result toJSON hooks', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        return {
          publicStatus: 'applied',
          toJSON() {
            return {
              publicStatus: 'serialized',
              secretToken: 'tojson-secret',
            };
          },
        };
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).not.toContain('tojson-secret');
    expect(JSON.parse(bodyText)).toMatchObject({
      data: {
        status: 'accepted',
        result: { publicStatus: 'applied' },
      },
    });
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('tojson-secret');
    operationalStore.close();
  });

  it('records accepted commands when handler results need safe JSON normalization', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      async commandHandler() {
        const result: Record<string, unknown> = {
          publicStatus: 'resumed',
          count: BigInt(1),
          callback() {
            return 'not serializable';
          },
        };
        result.self = result;

        return result;
      },
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'accepted',
        result: {
          publicStatus: 'resumed',
          count: '[unserializable]',
          self: '[circular]',
        },
      },
    });
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        status: 'accepted',
        result: {
          publicStatus: 'resumed',
          count: '[unserializable]',
          self: '[circular]',
        },
      }, {
        status: 'dispatching',
      }],
      activityEvents: [{
        outcome: 'success',
      }],
    });
    operationalStore.close();
  });

  it('redacts sensitive settings values from failed command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('provider rejected apiToken=admin-input-secret password: handler-password');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
          password: 'handler-password',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const body = await response.json() as { data: { error: string } };
    expect(body.data.error).toContain('[redacted]');
    expect(body.data.error).not.toContain('admin-input-secret');
    expect(body.data.error).not.toContain('handler-password');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('admin-input-secret');
    expect(commandResults).not.toContain('handler-password');
    operationalStore.close();
  });

  it('redacts multi-word sensitive headers from failed command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('upstream rejected Authorization: Basic dXNlcjpwYXNz Authorization=Bearer ghp_handler_secret apiToken=Bearer ghp_api_secret Cookie: sessionid=secret_cookie');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('dXNlcjpwYXNz');
    expect(bodyText).not.toContain('ghp_handler_secret');
    expect(bodyText).not.toContain('ghp_api_secret');
    expect(bodyText).not.toContain('secret_cookie');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('dXNlcjpwYXNz');
    expect(commandResults).not.toContain('ghp_handler_secret');
    expect(commandResults).not.toContain('ghp_api_secret');
    expect(commandResults).not.toContain('secret_cookie');
    operationalStore.close();
  });

  it('redacts JSON-formatted sensitive command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('provider rejected {"accessToken":"ghp_json_secret","password":"json-password"}');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('ghp_json_secret');
    expect(bodyText).not.toContain('json-password');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('ghp_json_secret');
    expect(commandResults).not.toContain('json-password');
    operationalStore.close();
  });
});

function createTestApp(options: {
  eventsBearerToken?: string;
  operationalStore?: RainrailOperationalStore;
} = {}) {
  return createRainrailHttpApp({
    room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
    publishToken: 'publish-token',
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    ...(options.operationalStore === undefined ? {} : { operationalStore: options.operationalStore }),
    intakeAdapters: [
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
