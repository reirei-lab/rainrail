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
          provider: 'github',
          event: 'issues',
          action: 'opened',
          repository: {
            fullName: 'reirei-lab/rainrail',
            url: 'https://github.com/reirei-lab/rainrail',
            owner: 'reirei-lab',
            name: 'rainrail',
          },
          actor: {
            login: 'octocat',
          },
          resource: {
            type: 'issue',
            id: '15',
            number: 15,
            title: 'GitHub webhook signature',
            url: 'https://github.com/reirei-lab/rainrail/issues/15',
          },
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
        payload: {
          provider: 'github',
          event: 'issues',
          action: 'opened',
          repository: {
            fullName: 'reirei-lab/rainrail',
            owner: 'reirei-lab',
            name: 'rainrail',
          },
          resource: {
            type: 'issue',
            id: '15',
            number: 15,
            url: 'https://github.com/reirei-lab/rainrail/issues/15',
          },
        },
        rawPayload: {
          contentType: 'application/x-www-form-urlencoded',
        },
      },
    });
  });

  it('normalizes issue_comment and pull request deliveries without passing through raw GitHub payloads', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issue_comment',
        deliveryId: 'delivery-comment-1',
        payload: {
          action: 'created',
          repository: {
            id: 100,
            full_name: 'reirei-lab/rainrail',
            html_url: 'https://github.com/reirei-lab/rainrail',
          },
          sender: {
            id: 1,
            login: 'octocat',
            type: 'User',
            html_url: 'https://github.com/octocat',
          },
          issue: {
            id: 200,
            number: 16,
            title: 'Normalize GitHub payloads',
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16',
          },
          comment: {
            id: 300,
            body: 'Please route this',
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16#issuecomment-300',
            user: { login: 'octocat' },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.issue',
      subject: {
        type: 'issue',
        id: '16',
        url: 'https://github.com/reirei-lab/rainrail/issues/16',
      },
      payload: {
        provider: 'github',
        event: 'issue_comment',
        action: 'created',
        repository: {
          id: '100',
          fullName: 'reirei-lab/rainrail',
          url: 'https://github.com/reirei-lab/rainrail',
          owner: 'reirei-lab',
          name: 'rainrail',
        },
        actor: {
          id: '1',
          login: 'octocat',
          type: 'User',
          url: 'https://github.com/octocat',
        },
        resource: {
          type: 'issue',
          id: '16',
          number: 16,
          title: 'Normalize GitHub payloads',
          url: 'https://github.com/reirei-lab/rainrail/issues/16',
        },
        comment: {
          id: '300',
          body: 'Please route this',
          url: 'https://github.com/reirei-lab/rainrail/issues/16#issuecomment-300',
          author: 'octocat',
        },
      },
    });

    const event = await createGitHubWebhookEvent({
      githubEvent: 'pull_request',
      deliveryId: 'delivery-pr-2',
      payload: {
        action: 'reopened',
        repository: { full_name: 'reirei-lab/rainrail' },
        pull_request: {
          id: 400,
          number: 17,
          title: 'Bridge Rainrail events',
          state: 'open',
          merged: true,
          html_url: 'https://github.com/reirei-lab/rainrail/pull/17',
          head: { ref: 'feature', sha: 'abc123' },
          base: { ref: 'main', sha: 'def456' },
        },
      },
      rawBody: '{}',
      receivedAt: new Date('2026-06-29T13:00:44.000Z'),
    });

    expect(event.payload).toMatchObject({
      provider: 'github',
      event: 'pull_request',
      action: 'reopened',
      resource: {
        type: 'pull_request',
        id: '17',
        number: 17,
        title: 'Bridge Rainrail events',
        state: 'open',
        merged: true,
        url: 'https://github.com/reirei-lab/rainrail/pull/17',
        headRef: 'feature',
        headSha: 'abc123',
        baseRef: 'main',
        baseSha: 'def456',
      },
    });
    expect(event.payload).not.toHaveProperty('pull_request');
  });

  it('keeps pull request issue comments distinct from regular issue comments', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issue_comment',
        deliveryId: 'delivery-pr-comment-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          issue: {
            id: 201,
            number: 41,
            title: 'Normalize GitHub webhook payloads',
            html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
            pull_request: {
              html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
            },
          },
          comment: {
            id: 301,
            body: 'PR conversation',
            html_url: 'https://github.com/reirei-lab/rainrail/pull/41#issuecomment-301',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.issue',
      subject: {
        type: 'pull_request',
        id: '41',
        url: 'https://github.com/reirei-lab/rainrail/pull/41',
      },
      payload: {
        provider: 'github',
        event: 'issue_comment',
        action: 'created',
        resource: {
          type: 'pull_request',
          id: '41',
          number: 41,
          title: 'Normalize GitHub webhook payloads',
          url: 'https://github.com/reirei-lab/rainrail/pull/41',
        },
        comment: {
          id: '301',
          body: 'PR conversation',
          url: 'https://github.com/reirei-lab/rainrail/pull/41#issuecomment-301',
        },
      },
    });
  });

  it('keeps issue label routing metadata on labeled deliveries', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issues',
        deliveryId: 'delivery-label-1',
        payload: {
          action: 'labeled',
          repository: { full_name: 'reirei-lab/rainrail' },
          issue: {
            number: 16,
            title: 'Normalize GitHub payloads',
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16',
          },
          label: {
            id: 900,
            name: 'agent-ready',
            color: '0e8a16',
            description: 'Ready for agent processing',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.issue',
      payload: {
        action: 'labeled',
        label: {
          id: '900',
          name: 'agent-ready',
          color: '0e8a16',
          description: 'Ready for agent processing',
        },
      },
    });
  });

  it('keeps assignment metadata on issue and pull request assigned deliveries', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issues',
        deliveryId: 'delivery-issue-assigned-1',
        payload: {
          action: 'assigned',
          repository: { full_name: 'reirei-lab/rainrail' },
          issue: {
            number: 16,
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16',
          },
          assignee: {
            id: 42,
            login: 'rainrail-agent',
            type: 'Bot',
            html_url: 'https://github.com/apps/rainrail-agent',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      payload: {
        action: 'assigned',
        assignee: {
          id: '42',
          login: 'rainrail-agent',
          type: 'Bot',
          url: 'https://github.com/apps/rainrail-agent',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request',
        deliveryId: 'delivery-pr-assigned-1',
        payload: {
          action: 'assigned',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 41,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
          },
          assignee: {
            login: 'rainrail-agent',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.pull_request',
      payload: {
        resource: {
          type: 'pull_request',
          id: '41',
        },
        assignee: {
          login: 'rainrail-agent',
        },
      },
    });
  });

  it('normalizes review, check, workflow, and project item payload families', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request_review_comment',
        deliveryId: 'delivery-review-comment-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 39,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/39',
          },
          comment: {
            id: 500,
            body: 'nit',
            html_url: 'https://github.com/reirei-lab/rainrail/pull/39#discussion_r500',
            pull_request_review_id: 4594627585,
            path: 'src/github-webhook.ts',
            line: 660,
            side: 'RIGHT',
            start_line: 650,
            start_side: 'RIGHT',
            user: { login: 'reviewer' },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.review',
      payload: {
        provider: 'github',
        event: 'pull_request_review_comment',
        action: 'created',
        resource: {
          type: 'pull_request',
          id: '39',
          number: 39,
          url: 'https://github.com/reirei-lab/rainrail/pull/39',
        },
        comment: {
          id: '500',
          body: 'nit',
          url: 'https://github.com/reirei-lab/rainrail/pull/39#discussion_r500',
          author: 'reviewer',
          reviewId: '4594627585',
          path: 'src/github-webhook.ts',
          line: 660,
          side: 'RIGHT',
          startLine: 650,
          startSide: 'RIGHT',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'check_run',
        deliveryId: 'delivery-check-run-1',
        payload: {
          action: 'completed',
          repository: { full_name: 'reirei-lab/rainrail' },
          check_run: {
            id: 600,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            html_url: 'https://github.com/reirei-lab/rainrail/runs/600',
            pull_requests: [
              {
                number: 41,
                url: 'https://api.github.com/repos/reirei-lab/rainrail/pulls/41',
                html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
              },
            ],
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.check_run',
      payload: {
        provider: 'github',
        event: 'check_run',
        action: 'completed',
        resource: {
          type: 'check_run',
          id: '600',
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          headSha: 'abc123',
          url: 'https://github.com/reirei-lab/rainrail/runs/600',
        },
        pullRequests: [
          {
            id: '41',
            number: 41,
            url: 'https://github.com/reirei-lab/rainrail/pull/41',
          },
        ],
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'check_run',
        deliveryId: 'delivery-check-run-action-1',
        payload: {
          action: 'requested_action',
          repository: { full_name: 'reirei-lab/rainrail' },
          check_run: {
            id: 601,
            name: 'agent action',
            status: 'completed',
            html_url: 'https://github.com/reirei-lab/rainrail/runs/601',
          },
          requested_action: {
            identifier: 'retry-agent',
            label: 'Retry agent',
            description: 'Run the agent again',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.check_run',
      payload: {
        action: 'requested_action',
        resource: {
          type: 'check_run',
          id: '601',
        },
        requestedAction: {
          identifier: 'retry-agent',
          label: 'Retry agent',
          description: 'Run the agent again',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'projects_v2_item',
        deliveryId: 'delivery-project-item-1',
        payload: {
          action: 'edited',
          organization: {
            id: 700,
            login: 'reirei-lab',
            html_url: 'https://github.com/reirei-lab',
          },
          projects_v2_item: {
            id: 'PVTI_lADOExample',
            content_type: 'Issue',
            content_node_id: 'I_kwDOExample',
          },
          changes: {
            field_value: {
              field_name: 'Status',
              field_type: 'single_select',
              from: { name: 'Todo' },
              to: { name: 'Ready' },
            },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.projects_v2_item',
      subject: {
        type: 'project_item',
        id: 'PVTI_lADOExample',
      },
      payload: {
        provider: 'github',
        event: 'projects_v2_item',
        action: 'edited',
        organization: {
          id: '700',
          login: 'reirei-lab',
          url: 'https://github.com/reirei-lab',
        },
        resource: {
          type: 'project_item',
          id: 'PVTI_lADOExample',
          contentType: 'Issue',
          contentNodeId: 'I_kwDOExample',
        },
        changes: [
          {
            field: 'field_value',
            fieldName: 'Status',
            fieldType: 'single_select',
            from: 'Todo',
            to: 'Ready',
          },
        ],
      },
    });
  });

  it('normalizes projects_v2 project events and push routing resources', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'projects_v2',
        deliveryId: 'delivery-project-1',
        payload: {
          action: 'closed',
          organization: {
            id: 700,
            login: 'reirei-lab',
            html_url: 'https://github.com/reirei-lab',
          },
          projects_v2: {
            id: 'PVT_kwDOProject',
            number: 3,
            title: 'Rainrail',
            html_url: 'https://github.com/orgs/reirei-lab/projects/3',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.projects_v2',
      subject: {
        type: 'project',
        id: 'PVT_kwDOProject',
        url: 'https://github.com/orgs/reirei-lab/projects/3',
      },
      payload: {
        organization: {
          id: '700',
          login: 'reirei-lab',
          url: 'https://github.com/reirei-lab',
        },
        resource: {
          type: 'project',
          id: 'PVT_kwDOProject',
          number: 3,
          title: 'Rainrail',
          url: 'https://github.com/orgs/reirei-lab/projects/3',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'projects_v2_status_update',
        deliveryId: 'delivery-project-status-update-1',
        payload: {
          action: 'edited',
          organization: {
            login: 'reirei-lab',
          },
          projects_v2_status_update: {
            id: 'PVTSU_lADOExample',
            body: 'On track',
            html_url: 'https://github.com/orgs/reirei-lab/projects/3/views/1?pane=issue&itemId=1',
            project_node_id: 'PVT_kwDOProject',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.projects_v2_status_update',
      subject: {
        type: 'project_status_update',
        id: 'PVTSU_lADOExample',
      },
      payload: {
        organization: {
          login: 'reirei-lab',
        },
        resource: {
          type: 'project_status_update',
          id: 'PVTSU_lADOExample',
          body: 'On track',
          url: 'https://github.com/orgs/reirei-lab/projects/3/views/1?pane=issue&itemId=1',
          projectNodeId: 'PVT_kwDOProject',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'push',
        deliveryId: 'delivery-push-1',
        payload: {
          ref: 'refs/heads/main',
          before: '0000000',
          after: 'abc123',
          repository: { full_name: 'reirei-lab/rainrail' },
          head_commit: {
            id: 'abc123',
            message: 'Update workflow',
            url: 'https://github.com/reirei-lab/rainrail/commit/abc123',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.push',
      subject: {
        type: 'push',
        id: 'abc123',
        url: 'https://github.com/reirei-lab/rainrail/commit/abc123',
      },
      payload: {
        event: 'push',
        action: 'received',
        resource: {
          type: 'push',
          id: 'abc123',
          ref: 'refs/heads/main',
          beforeSha: '0000000',
          headSha: 'abc123',
          headCommitMessage: 'Update workflow',
          url: 'https://github.com/reirei-lab/rainrail/commit/abc123',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'create',
        deliveryId: 'delivery-create-1',
        payload: {
          ref: 'release/v1',
          ref_type: 'branch',
          repository: { full_name: 'reirei-lab/rainrail' },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.create',
      subject: {
        type: 'ref',
        id: 'branch:release/v1',
      },
      payload: {
        resource: {
          type: 'ref',
          id: 'branch:release/v1',
          ref: 'release/v1',
          refType: 'branch',
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
            state: 'approved',
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
      payload: {
        resource: {
          type: 'review',
          id: '4594627585',
          state: 'approved',
          url: 'https://github.com/reirei-lab/rainrail/pull/39#pullrequestreview-4594627585',
        },
        pullRequest: {
          type: 'pull_request',
          id: '39',
          number: 39,
          url: 'https://github.com/reirei-lab/rainrail/pull/39',
        },
      },
    });
  });

  it('normalizes pull request review thread deliveries as review thread resources', async () => {
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
          thread: {
            id: 'PRRT_kwDOExample',
            is_resolved: true,
            path: 'src/github-webhook.ts',
            line: 531,
            side: 'RIGHT',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.review',
      subject: {
        type: 'review_thread',
        id: 'PRRT_kwDOExample',
      },
      payload: {
        resource: {
          type: 'review_thread',
          id: 'PRRT_kwDOExample',
          isResolved: true,
          path: 'src/github-webhook.ts',
          line: 531,
          side: 'RIGHT',
        },
        pullRequest: {
          type: 'pull_request',
          id: '39',
          number: 39,
          url: 'https://github.com/reirei-lab/rainrail/pull/39',
        },
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
            pull_requests: [
              {
                number: 41,
                html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
              },
            ],
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
      payload: {
        pullRequests: [
          {
            id: '41',
            number: 41,
            url: 'https://github.com/reirei-lab/rainrail/pull/41',
          },
        ],
      },
    });
  });
});
