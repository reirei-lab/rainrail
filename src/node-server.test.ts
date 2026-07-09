import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { getReaderOrThrow, readUntil, waitForValue } from './test-helpers.js';

import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RainrailOperationalStore,
  createOperationalStoreFromConfig,
  createDashboardCardRegistry,
  createManualInputIntakeAdapter,
  createGitHubWebhookSignature,
  createRainrailNodeServer,
  type DashboardCardDefinition,
  type RainrailIntakeAdapter,
} from './index.js';

describe('Rainrail Node server', () => {
  it('adapts Node HTTP requests to the shared Rainrail HTTP app', async () => {
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      runtime: 'node-test',
      replayLimit: 10,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const payload = JSON.stringify({
        action: 'opened',
        repository: { full_name: 'reirei-lab/rainrail' },
        issue: {
          number: 19,
          html_url: 'https://github.com/reirei-lab/rainrail/issues/19',
        },
      });

      const webhook = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-node-19',
          'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
        },
        body: payload,
      });
      expect(webhook.status).toBe(202);

      const events = await fetch(`http://127.0.0.1:${address.port}/events`, {
        headers: { authorization: 'Bearer events-token' },
      });
      expect(events.status).toBe(200);

      const reader = getReaderOrThrow(events);
      const chunk = await readUntil(reader, 'github.issue');
      await reader.cancel();

      expect(chunk).toContain(': connected\n\n');
      expect(chunk).toContain('event: github.issue\n');
      expect(chunk).toContain('"id":"github-webhook:delivery-node-19:github.issue"');
    } finally {
      await closeServer(server);
    }
  });

  it('builds Node ingress through the EEP Bridge bundle', async () => {
    const { app } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      githubSourceName: 'github-production-webhook',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      runtime: 'node-test',
      replayLimit: 10,
    });

    const payload = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'reirei-lab/rainrail' },
      issue: {
        number: 102,
        html_url: 'https://github.com/reirei-lab/rainrail/issues/102',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-node-bundle',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
      },
      body: payload,
    }));
    expect(webhook.status).toBe(202);
    await expect(webhook.json()).resolves.toMatchObject({
      id: 'github-production-webhook:delivery-node-bundle:github.issue',
    });

    await expect(app.tail?.([{
      eventTimestamp: '2026-07-04T12:00:00.000Z',
      outcome: 'ok',
      scriptName: 'rainrail-worker',
      event: {
        request: {
          method: 'GET',
          url: 'https://rainrail.example/healthz',
          headers: { 'cf-ray': 'ray-node-bundle' },
        },
        response: { status: 200 },
      },
    }])).resolves.toEqual([
      {
        ok: true,
        id: 'cloudflare-tail:tail-rainrail-worker-20260704T120000000Z-ray-node-bundle:cloudflare.tail',
      },
    ]);

    const events = await app.fetch(new Request('https://rainrail.local/events', {
      headers: { authorization: 'Bearer events-token' },
    }));
    const reader = getReaderOrThrow(events);
    const chunk = await readUntil(reader, 'cloudflare.tail');
    await reader.cancel();

    expect(chunk).toContain('event: github.issue\n');
    expect(chunk).toContain('event: cloudflare.tail\n');
  });

  it('passes task queue options into the shared HTTP dashboard app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const { app } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        listProjectIssues: async () => [{
          id: 'PVTI_NODE',
          title: 'Node queued issue',
          status: 'Todo',
          state: 'OPEN',
          assigneeLogins: ['reirei-agent'],
          repository: 'reirei-lab/rainrail',
          number: 115,
          url: 'https://github.com/reirei-lab/rainrail/issues/115',
        }],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{ id: 'project:PVTI_NODE', status: 'upcoming', title: 'Node queued issue' }],
      summary: { upcomingIssues: 1 },
    });

    operationalStore.close();
  });

  it('passes dashboard card options into the shared HTTP dashboard app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const registry = createDashboardCardRegistry();
    registry.register(nodePluginCard);
    const { app } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read', 'github:read'],
        enabledPlugins: ['github'],
      },
      dashboardDefaultLayout: [{
        id: 'node-queue',
        cardId: 'plugin:github.nodeQueue',
        x: 0,
        y: 0,
        columns: 3,
        rows: 2,
      }],
    });

    const catalog = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards', {
      headers: { authorization: 'Bearer read-token' },
    }));
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json() as {
      data: Array<{ definition: { id: string }; availability: { status: string } }>;
    };
    const catalogIds = catalogBody.data.map((entry) => entry.definition.id);
    expect(catalogIds).toContain('core.operationalTotals');
    expect(catalogIds).toContain('plugin:github.nodeQueue');
    expect(catalogBody.data.find((entry) => entry.definition.id === 'plugin:github.nodeQueue')?.availability)
      .toEqual({ status: 'available' });

    const layout = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }));
    await expect(layout.json()).resolves.toMatchObject({
      data: { items: [{ id: 'node-queue', cardId: 'plugin:github.nodeQueue' }] },
    });

    const saved = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ id: 'node-queue', cardId: 'plugin:github.nodeQueue', x: 0, y: 0, columns: 3, rows: 2 }],
      }),
    }));
    expect(saved.status).toBe(200);

    operationalStore.close();
  });

  it('preserves custom Node tail adapters instead of registering the bundled Cloudflare tail twice', async () => {
    const customTail: RainrailIntakeAdapter = {
      name: 'custom-tail',
      async tail(events) {
        return [{ ok: true, count: events.length }];
      },
    };
    const { app } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      intakeAdapters: [customTail],
    });

    await expect(app.tail?.([{ id: 1 }, { id: 2 }])).resolves.toEqual([
      { ok: true, count: 2 },
    ]);
  });

  it('aborts the Fetch request when an SSE client disconnects', async () => {
    const { server, room } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      runtime: 'node-test',
      replayLimit: 10,
      keepAliveIntervalMs: 10_000,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const events = await fetch(`http://127.0.0.1:${address.port}/events`, {
        headers: { authorization: 'Bearer events-token' },
      });
      expect(events.status).toBe(200);

      await events.body?.cancel();
      await waitForValue(async () => {
        const health = await room.fetch(new Request('https://rainrail.local/healthz'));
        const body = await health.json() as { clients: number };
        return body.clients;
      }, 0);

      const health = await room.fetch(new Request('https://rainrail.local/healthz'));
      await expect(health.json()).resolves.toMatchObject({ clients: 0 });
    } finally {
      await closeServer(server);
    }
  });

  it('defaults the Node request body limit to the GitHub webhook payload cap', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(25 * 1024 * 1024);
  });

  it('applies maxWebhookBodyBytes to Node GitHub webhook requests', async () => {
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      maxWebhookBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'oversized-node-webhook',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    } finally {
      await closeServer(server);
    }
  });

  it('falls back to maxBodyBytes for Node GitHub webhook request limits', async () => {
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      maxBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'oversized-node-webhook-fallback',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    } finally {
      await closeServer(server);
    }
  });

  it('streams manual intake bodies so adapter auth runs before body limits', async () => {
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      maxBodyBytes: 4,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          maxBodyBytes: 4,
        }),
      ],
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${address.port}/intake/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"too":"large"}',
      });

      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toEqual({ error: 'missing_bearer_token' });

      const authorizedTooLarge = await fetch(`http://127.0.0.1:${address.port}/intake/chat`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer chat-intake-token',
          'content-type': 'application/json',
        },
        body: '{"too":"large"}',
      });

      expect(authorizedTooLarge.status).toBe(413);
      await expect(authorizedTooLarge.json()).resolves.toEqual({ error: 'request_body_too_large' });
    } finally {
      await closeServer(server);
    }
  });

  it('does not attach empty bodies to Node GET intake adapter routes', async () => {
    const intakeAdapters: RainrailIntakeAdapter[] = [{
      name: 'readiness',
      routes: [{
        path: '/intake/readiness',
        methods: ['GET'],
        async handle() {
          return Response.json({ ok: true });
        },
      }],
    }];
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      intakeAdapters,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/intake/readiness`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await closeServer(server);
    }
  });

  it('forwards operationalStore to the shared HTTP app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/state`, {
        headers: { authorization: 'Bearer events-token' },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ counts: { events: 0 } });
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('creates a SQLite operational store from local Node server config', async () => {
    const directory = join(tmpdir(), `rainrail-node-store-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, 'rainrail-operational.sqlite');
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      operationalStoreConfig: {
        kind: 'sqlite',
        databasePath,
        eventLimit: 10,
      },
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const payload = JSON.stringify({
        action: 'opened',
        repository: { full_name: 'reirei-lab/rainrail' },
        issue: {
          number: 271,
          html_url: 'https://github.com/reirei-lab/rainrail/issues/271',
        },
      });
      const webhook = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-node-sqlite-config',
          'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
        },
        body: payload,
      });
      expect(webhook.status).toBe(202);
    } finally {
      await closeServer(server);
    }

    const reopened = new RainrailOperationalStore({
      databasePath,
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    try {
      expect(reopened.getEvent('github-webhook:delivery-node-sqlite-config:github.issue')).toMatchObject({
        subject: {
          type: 'issue',
          url: 'https://github.com/reirei-lab/rainrail/issues/271',
        },
      });
    } finally {
      reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps JSON and in-memory operational store config paths available for focused tests', async () => {
    const directory = join(tmpdir(), `rainrail-node-json-store-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const jsonPath = join(directory, 'operational.json');
    const jsonStore = createOperationalStoreFromConfig({
      kind: 'json',
      databasePath: jsonPath,
      eventLimit: 5,
    });
    const memoryStore = createOperationalStoreFromConfig({
      kind: 'memory',
      eventLimit: 5,
    });

    try {
      expect(jsonStore.eventLimit()).toBe(5);
      expect(memoryStore.eventLimit()).toBe(5);
    } finally {
      jsonStore.close();
      memoryStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unparsed operational store config values in the public helper', () => {
    expect(() => createOperationalStoreFromConfig({
      kind: 'memory',
      databasePath: 'var/ignored.sqlite',
      eventLimit: 5,
    })).toThrow('operationalStoreConfig.databasePath must be omitted for memory stores');

    expect(() => createOperationalStoreFromConfig({
      kind: 'postgres',
      databasePath: 'var/postgres.sqlite',
      eventLimit: 5,
    } as never)).toThrow('operationalStoreConfig.kind must be one of: sqlite, json, memory');

    expect(() => createOperationalStoreFromConfig({
      kind: 'sqlite',
      databasePath: '',
      eventLimit: 5,
    })).toThrow('operationalStoreConfig.databasePath is required for sqlite stores');
  });

  it('closes an owned operational store when app creation validation fails', async () => {
    const directory = join(tmpdir(), `rainrail-node-owned-store-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, 'operational.json');

    try {
      expect(() => createRainrailNodeServer({
        githubWebhookSecret: 'secret',
        publishToken: 'test-publish-token',
        eventsBearerToken: 'same-token',
        dashboardAuth: {
          operatorToken: 'same-token',
        },
        operationalStoreConfig: {
          kind: 'json',
          databasePath,
          eventLimit: 5,
        },
      })).toThrow('duplicate dashboard token scopes are not allowed');

      await expect(readFile(databasePath, 'utf8')).resolves.toContain('"events"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes an owned operational store when listen emits an error', async () => {
    const directory = join(tmpdir(), `rainrail-node-listen-owned-store-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, 'operational.json');
    const { server: occupied } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
    });
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const address = occupied.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStoreConfig: {
        kind: 'json',
        databasePath,
        eventLimit: 5,
      },
    });

    try {
      const errorPromise = once(server, 'error');
      server.listen(address.port, '127.0.0.1');
      await expect(errorPromise).resolves.toEqual([expect.objectContaining({ code: 'EADDRINUSE' })]);
      await expect(readFile(databasePath, 'utf8')).resolves.toContain('"events"');
    } finally {
      await closeServer(occupied);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards command API options and bodies to the shared HTTP app', async () => {
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
    const commandHandler = vi.fn(async (command) => ({ received: command.inputs }));
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-tasks/agent_task_rainrail_111/actions/terminate`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
          'x-request-id': 'request-node-command',
        },
        body: JSON.stringify({
          confirmationToken: 'confirm:agent_task_terminate:agent_task:agent_task_rainrail_111',
          reason: 'review feedback',
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          action: 'agent_task_terminate',
          status: 'accepted',
        },
      });
      expect(commandHandler).toHaveBeenCalledWith(expect.objectContaining({
        actionType: 'agent_task_terminate',
        inputs: expect.objectContaining({ reason: 'review feedback' }),
      }));
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('treats empty Node command action bodies as empty objects', async () => {
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
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn(async (command) => ({ received: command.inputs }));
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'x-request-id': 'request-node-empty-command',
        },
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          action: 'agent_task_resume',
          status: 'accepted',
          result: { received: {} },
        },
      });
      expect(commandHandler).toHaveBeenCalledWith(expect.objectContaining({
        inputs: {},
      }));
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('applies dashboardCommandMaxBodyBytes to Node command action requests', async () => {
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
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
      dashboardCommandMaxBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('forwards Node dashboard layout update bodies into the shared HTTP app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/dashboard/layout`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          items: [{
            id: 'overview',
            cardId: 'core.overview',
            x: 0,
            y: 0,
            columns: 4,
            rows: 2,
          }],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          source: 'user',
          items: [{ id: 'overview', cardId: 'core.overview' }],
        },
      });
      expect(operationalStore.getDashboardLayout()).toMatchObject({
        items: [{ id: 'overview', cardId: 'core.overview' }],
      });
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('falls back to maxBodyBytes for Node command action request limits', async () => {
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
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
      maxBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('does not buffer oversized unauthorized Node command bodies before auth', async () => {
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
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn();
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'read-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
      maxBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer read-token',
          'content-type': 'application/json',
        },
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'insufficient_scope',
        requiredScope: 'operator',
      });
      expect(commandHandler).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('uses maxBodyBytes as the effective Node command action app limit', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => ({ noteLength: String(command.inputs.note).length }));
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
      maxBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES + 4096,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const note = 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_BYTES);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/settings/actions/update`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          note,
          confirmationToken: 'confirm:settings_update:settings:global',
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          action: 'settings_update',
          status: 'accepted',
          result: { noteLength: note.length },
        },
      });
      expect(String(commandHandler.mock.calls[0]?.[0].inputs.note).length).toBe(note.length);
    } finally {
      await closeServer(server);
      operationalStore.close();
    }
  });

  it('does not read bodies for non-webhook routes before method handling', async () => {
    const { server } = createRainrailNodeServer({
      githubWebhookSecret: 'secret',
      publishToken: 'test-publish-token',
      eventsBearerToken: 'events-token',
      maxBodyBytes: 4,
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
        method: 'POST',
        body: '{"too":"large"}',
      });

      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' });
    } finally {
      await closeServer(server);
    }
  });
});

const nodePluginCard: DashboardCardDefinition = {
  id: 'plugin:github.nodeQueue',
  title: 'Node queue',
  entry: { type: 'plugin', pluginName: 'github', cardName: 'nodeQueue' },
  category: 'operations',
  requiredCapabilities: ['dashboard:read', 'github:read'],
  size: {
    default: { columns: 3, rows: 2 },
    min: { columns: 2, rows: 1 },
    max: { columns: 6, rows: 4 },
  },
};

async function closeServer(server: { listening: boolean; closeAllConnections?: () => void; close: (callback: () => void) => void }): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(resolve));
}
