import { describe, expect, it } from 'vitest';

import { getReaderOrThrow, readUntil } from './test-helpers.js';

import rainrailWorker, {
  createGitHubWebhookSignature,
  createRainrailEepBridgeIntakeAdaptersFromEnv,
  RainrailBridgeRoom,
} from './index.js';

describe('Rainrail Cloudflare Worker entrypoint', () => {
  it('routes fetch and tail events through the same bridge room core', async () => {
    const env = fakeEnv();
    const payload = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'reirei-lab/rainrail' },
      issue: {
        number: 19,
        html_url: 'https://github.com/reirei-lab/rainrail/issues/19',
      },
    });

    const webhook = await rainrailWorker.fetch(new Request('https://worker.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-worker-19',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
      },
      body: payload,
    }), env);
    expect(webhook.status).toBe(202);

    const waitUntilPromises: Promise<unknown>[] = [];
    const tailResult = rainrailWorker.tail?.([{
      eventTimestamp: '2026-06-30T12:00:00.000Z',
      outcome: 'ok',
      scriptName: 'rainrail-worker',
      event: {
        request: {
          method: 'GET',
          url: 'https://rainrail.example/healthz',
          headers: { 'cf-ray': 'ray-worker-19' },
        },
        response: { status: 200 },
      },
    }], env, {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });
    expect(tailResult).toBeUndefined();
    expect(waitUntilPromises).toHaveLength(1);
    await expect(waitUntilPromises[0]).resolves.toEqual([
      {
        ok: true,
        id: 'cloudflare-tail:tail-rainrail-worker-20260630T120000000Z-ray-worker-19:cloudflare.tail',
      },
    ]);

    const events = await rainrailWorker.fetch(new Request('https://worker.local/events', {
      headers: { authorization: 'Bearer events-token' },
    }), env);
    expect(events.status).toBe(200);

    const reader = getReaderOrThrow(events);
    const chunk = await readUntil(reader, 'cloudflare.tail');
    await reader.cancel();

    expect(chunk).toContain('event: github.issue\n');
    expect(chunk).toContain('event: cloudflare.tail\n');
  });

  it('keeps GitHub webhook env parsing inside the EEP Bridge bundle', async () => {
    const { GITHUB_WEBHOOK_SECRET: _secret, ...env } = fakeEnv();

    const response = await rainrailWorker.fetch(new Request('https://worker.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'delivery-missing-secret',
        'x-hub-signature-256': 'sha256=invalid',
      },
      body: JSON.stringify({ zen: 'missing secret stays provider-specific' }),
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'missing_secret' });
  });

  it('falls back to env-only composition when Rainrail config JSON is empty', async () => {
    const env = {
      ...fakeEnv(),
      RAINRAIL_CONFIG_JSON: '',
    };
    const payload = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'reirei-lab/rainrail' },
      issue: {
        number: 105,
        html_url: 'https://github.com/reirei-lab/rainrail/issues/105',
      },
    });

    const webhook = await rainrailWorker.fetch(new Request('https://worker.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-empty-config',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
      },
      body: payload,
    }), env);

    expect(webhook.status).toBe(202);
  });

  it('creates the Worker intake adapters through the EEP Bridge bundle', () => {
    const adapters = createRainrailEepBridgeIntakeAdaptersFromEnv({
      GITHUB_WEBHOOK_SECRET: 'secret',
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual([
      'github-webhook',
      'cloudflare-tail',
    ]);
    expect(adapters[0]?.routes?.map((route) => route.path)).toEqual(['/webhooks/github']);
    expect(adapters[1]?.tail).toEqual(expect.any(Function));
  });

  it('uses Rainrail config JSON to compose Worker intake adapters when provided', async () => {
    const env = {
      ...fakeEnv(),
      RAINRAIL_CONFIG_JSON: JSON.stringify({
        sourceBundles: [
          {
            type: 'eep-bridge',
            name: '${RAINRAIL_BUNDLE_NAME}',
            sources: [
              {
                type: 'github-webhook',
                name: '${RAINRAIL_GITHUB_SOURCE_NAME}',
                sourceType: 'github',
                provider: 'github',
                runtime: 'openclaw',
                webhookSecret: '${RAINRAIL_WEBHOOK_SECRET_NAME}',
                endpoint: '/github',
              },
            ],
          },
        ],
      }),
      RAINRAIL_BUNDLE_NAME: 'worker-ingress',
      RAINRAIL_GITHUB_SOURCE_NAME: 'github-configured-webhook',
      RAINRAIL_WEBHOOK_SECRET_NAME: 'GITHUB_WEBHOOK_SECRET',
    };
    const payload = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'reirei-lab/rainrail' },
      issue: {
        number: 105,
        html_url: 'https://github.com/reirei-lab/rainrail/issues/105',
      },
    });

    const webhook = await rainrailWorker.fetch(new Request('https://worker.local/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-worker-config',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', payload),
      },
      body: payload,
    }), env);
    expect(webhook.status).toBe(202);

    const waitUntilPromises: Promise<unknown>[] = [];
    rainrailWorker.tail?.([{
      eventTimestamp: '2026-06-30T12:00:00.000Z',
      outcome: 'ok',
      scriptName: 'rainrail-worker',
      event: {
        request: {
          method: 'GET',
          url: 'https://rainrail.example/healthz',
          headers: { 'cf-ray': 'ray-worker-config' },
        },
        response: { status: 200 },
      },
    }], env, {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    expect(waitUntilPromises).toHaveLength(1);
    await expect(waitUntilPromises[0]).resolves.toEqual([]);

    const events = await rainrailWorker.fetch(new Request('https://worker.local/events', {
      headers: { authorization: 'Bearer events-token' },
    }), env);
    expect(events.status).toBe(200);

    const reader = getReaderOrThrow(events);
    const chunk = await readUntil(reader, 'github.issue');
    await reader.cancel();

    expect(chunk).toContain('id: github-configured-webhook:delivery-worker-config:github.issue\n');
  });
});

function fakeEnv() {
  const rooms = new Map<string, InstanceType<typeof RainrailBridgeRoom>>();
  const state = {
    values: new Map<string, unknown>(),
    storage: {
      async get(key: string) {
        return state.values.get(key);
      },
      async put(key: string, value: unknown) {
        state.values.set(key, value);
      },
    },
  };

  return {
    GITHUB_WEBHOOK_SECRET: 'secret',
    RAINRAIL_PUBLISH_TOKEN: 'test-publish-token',
    SSE_BEARER_TOKEN: 'events-token',
    BRIDGE_ID: 'events',
    BRIDGE_ROOM: {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        let room = rooms.get(id);
        if (room === undefined) {
          room = new RainrailBridgeRoom(state, {
            publishToken: 'test-publish-token',
            replayLimit: 10,
          });
          rooms.set(id, room);
        }
        return room;
      },
    },
  };
}
