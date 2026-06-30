import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createGitHubWebhookSignature, createRainrailNodeServer } from './index.js';

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

      const reader = events.body?.getReader();
      expect(reader).toBeDefined();
      const chunk = await readUntil(reader!, 'github.issue');
      await reader?.cancel();

      expect(chunk).toContain(': connected\n\n');
      expect(chunk).toContain('event: github.issue\n');
      expect(chunk).toContain('"id":"github-webhook:delivery-node-19:github.issue"');
    } finally {
      await closeServer(server);
    }
  });
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for (let index = 0; index < 10; index += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    if (text.includes(expected)) break;
  }

  return text;
}

async function closeServer(server: { listening: boolean; closeAllConnections?: () => void; close: (callback: () => void) => void }): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(resolve));
}
