import { describe, expect, it } from 'vitest';

import rainrailWorker, { RainrailBridgeRoom, createGitHubWebhookSignature } from './index.js';

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

    const reader = events.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'cloudflare.tail');
    await reader?.cancel();

    expect(chunk).toContain('event: github.issue\n');
    expect(chunk).toContain('event: cloudflare.tail\n');
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

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for (let index = 0; index < 20; index += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    if (text.includes(expected)) break;
  }

  return text;
}
