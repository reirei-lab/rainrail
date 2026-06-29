import { describe, expect, it } from 'vitest';

import {
  createGitHubWebhookEvent,
  createGitHubWebhookSourcePlugin,
  createGitHubWebhookSignature,
  handleGitHubWebhookRequest,
  verifyGitHubWebhookSignature,
} from './github-webhook.js';

describe('GitHub webhook signature core', () => {
  it('verifies a valid sha256 signature with a Node/Worker compatible core', async () => {
    const rawBody = new TextEncoder().encode(JSON.stringify({ action: 'opened' }));
    const signature = await createGitHubWebhookSignature('secret', rawBody);

    await expect(verifyGitHubWebhookSignature({ secret: 'secret', rawBody, signature })).resolves.toEqual({
      ok: true,
      reason: 'signature_mismatch',
    });
  });

  it('rejects invalid, missing, and unsupported signatures', async () => {
    const rawBody = new TextEncoder().encode('{}');
    const signature = await createGitHubWebhookSignature('secret', rawBody);

    await expect(verifyGitHubWebhookSignature({ secret: 'wrong', rawBody, signature })).resolves.toMatchObject({
      ok: false,
      reason: 'signature_mismatch',
    });
    await expect(verifyGitHubWebhookSignature({ secret: '', rawBody, signature })).resolves.toMatchObject({
      ok: false,
      reason: 'missing_secret',
    });
    await expect(verifyGitHubWebhookSignature({ secret: 'secret', rawBody, signature: '' })).resolves.toMatchObject({
      ok: false,
      reason: 'missing_signature',
    });
    await expect(
      verifyGitHubWebhookSignature({ secret: 'secret', rawBody, signature: 'sha1=unsupported' }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported_signature',
    });
  });
});

describe('GitHub webhook source handling', () => {
  it('exposes GitHub webhook normalization as a Rainrail source plugin', async () => {
    const plugin = createGitHubWebhookSourcePlugin();

    await expect(
      plugin.normalize(
        {
          githubEvent: 'pull_request',
          deliveryId: 'delivery-pr-1',
          payload: {
            action: 'opened',
            repository: { full_name: 'reirei-lab/rainrail' },
            pull_request: {
              number: 38,
              html_url: 'https://github.com/reirei-lab/rainrail/pull/38',
            },
          },
          rawBody: JSON.stringify({ action: 'opened' }),
          receivedAt: new Date('2026-06-29T13:00:44.000Z'),
          contentType: 'application/json',
        },
        {
          pluginName: plugin.name,
          deliveryId: 'delivery-pr-1',
          receivedAt: '2026-06-29T13:00:44.000Z',
          metadata: {},
          rawPayload: {
            kind: 'inline-redacted',
            reference: 'github://deliveries/delivery-pr-1',
          },
        },
      ),
    ).resolves.toMatchObject({
      source: { type: 'github', name: 'github-webhook' },
      name: 'github.pull_request',
      delivery: { id: 'delivery-pr-1' },
      subject: {
        type: 'pull_request',
        id: '38',
        url: 'https://github.com/reirei-lab/rainrail/pull/38',
      },
    });
  });

  it('verifies the raw request body and keeps delivery metadata in a neutral envelope', async () => {
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      sender: { login: 'octocat' },
      issue: {
        number: 15,
        title: 'GitHub webhook signature',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/15',
      },
    });
    const signature = await createGitHubWebhookSignature('secret', rawBody);

    const result = await handleGitHubWebhookRequest(
      new Request('https://rainrail.example/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-15',
          'x-hub-signature-256': signature,
        },
        body: rawBody,
      }),
      {
        secret: 'secret',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      event: {
        id: 'github-webhook:delivery-15:github.issue',
        schemaVersion: 'rainrail.event.v1',
        source: {
          type: 'github',
          name: 'github-webhook',
          repository: 'reirei-lab/rainrail',
          account: 'octocat',
        },
        name: 'github.issue',
        delivery: {
          id: 'delivery-15',
          receivedAt: '2026-06-29T13:00:44.000Z',
        },
        occurredAt: '2026-06-29T13:00:44.000Z',
        subject: {
          type: 'issue',
          id: '15',
          url: 'https://github.com/reirei-lab/rainrail/issues/15',
        },
        payload: {
          action: 'opened',
          issue: { number: 15, title: 'GitHub webhook signature' },
        },
        rawPayload: {
          kind: 'inline-redacted',
          reference: 'github://deliveries/delivery-15',
          contentType: 'application/json',
        },
      },
    });

    expect(result.ok && result.event.rawPayload.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsigned GitHub webhook requests before parsing JSON', async () => {
    const result = await handleGitHubWebhookRequest(
      new Request('https://rainrail.example/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-16',
        },
        body: '{',
      }),
      { secret: 'secret' },
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: 'missing_signature',
    });
  });

  it('parses URL-encoded GitHub payloads after verifying the raw request body', async () => {
    const payload = {
      action: 'opened',
      repository: { full_name: 'reirei-lab/rainrail' },
      issue: {
        number: 15,
        html_url: 'https://github.com/reirei-lab/rainrail/issues/15',
      },
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = await createGitHubWebhookSignature('secret', rawBody);

    const result = await handleGitHubWebhookRequest(
      new Request('https://rainrail.example/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-form-15',
          'x-hub-signature-256': signature,
        },
        body: rawBody,
      }),
      {
        secret: 'secret',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      event: {
        name: 'github.issue',
        delivery: { id: 'delivery-form-15' },
        subject: {
          type: 'issue',
          id: '15',
          url: 'https://github.com/reirei-lab/rainrail/issues/15',
        },
        payload,
        rawPayload: {
          contentType: 'application/x-www-form-urlencoded',
        },
      },
    });
  });

  it('uses the review object as the subject for pull request review deliveries', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request_review',
        deliveryId: 'delivery-review-1',
        payload: {
          action: 'submitted',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 39,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/39',
          },
          review: {
            id: 4594627585,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/39#pullrequestreview-4594627585',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.review',
      subject: {
        type: 'review',
        id: '4594627585',
        url: 'https://github.com/reirei-lab/rainrail/pull/39#pullrequestreview-4594627585',
      },
    });
  });

  it('normalizes pull request review thread deliveries as review events', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request_review_thread',
        deliveryId: 'delivery-review-thread-1',
        payload: {
          action: 'resolved',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 39,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/39',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.review',
      subject: {
        type: 'pull_request',
        id: '39',
        url: 'https://github.com/reirei-lab/rainrail/pull/39',
      },
    });
  });

  it('keeps workflow run and check suite subjects on check run deliveries', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'workflow_run',
        deliveryId: 'delivery-workflow-run-1',
        payload: {
          action: 'completed',
          repository: { full_name: 'reirei-lab/rainrail' },
          workflow_run: {
            id: 17345176172,
            html_url: 'https://github.com/reirei-lab/rainrail/actions/runs/17345176172',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.check_run',
      subject: {
        type: 'workflow_run',
        id: '17345176172',
        url: 'https://github.com/reirei-lab/rainrail/actions/runs/17345176172',
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'check_suite',
        deliveryId: 'delivery-check-suite-1',
        payload: {
          action: 'completed',
          repository: { full_name: 'reirei-lab/rainrail' },
          check_suite: {
            id: 48847904331,
            html_url: 'https://github.com/reirei-lab/rainrail/actions/runs/17345176172',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.check_run',
      subject: {
        type: 'check_suite',
        id: '48847904331',
        url: 'https://github.com/reirei-lab/rainrail/actions/runs/17345176172',
      },
    });
  });
});
