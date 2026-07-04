import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { getReaderOrThrow, readUntil, waitForValue } from './test-helpers.js';

import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RainrailOperationalStore,
  createGitHubWebhookSignature,
  createRainrailNodeServer,
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

async function closeServer(server: { listening: boolean; closeAllConnections?: () => void; close: (callback: () => void) => void }): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(resolve));
}
