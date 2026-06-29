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

  it('keeps review request targets on pull request review request deliveries', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request',
        deliveryId: 'delivery-review-requested-1',
        payload: {
          action: 'review_requested',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 41,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
          },
          requested_reviewer: {
            id: 42,
            login: 'rainrail-agent',
            type: 'Bot',
            html_url: 'https://github.com/apps/rainrail-agent',
          },
          requested_team: {
            id: 99,
            name: 'Agents',
            slug: 'agents',
            html_url: 'https://github.com/orgs/reirei-lab/teams/agents',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.pull_request',
      payload: {
        action: 'review_requested',
        requestedReviewer: {
          id: '42',
          login: 'rainrail-agent',
          type: 'Bot',
          url: 'https://github.com/apps/rainrail-agent',
        },
        requestedTeam: {
          id: '99',
          name: 'Agents',
          slug: 'agents',
          url: 'https://github.com/orgs/reirei-lab/teams/agents',
        },
      },
    });
  });

  it('keeps draft and synchronize commit range on pull request resources', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'pull_request',
        deliveryId: 'delivery-pr-synchronize-1',
        payload: {
          action: 'synchronize',
          before: 'old-head-sha',
          after: 'new-head-sha',
          repository: { full_name: 'reirei-lab/rainrail' },
          pull_request: {
            number: 41,
            title: 'Normalize GitHub payloads',
            state: 'open',
            draft: true,
            html_url: 'https://github.com/reirei-lab/rainrail/pull/41',
            head: { ref: 'feature/github-normalization', sha: 'new-head-sha' },
            base: { ref: 'main', sha: 'base-sha' },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.pull_request',
      payload: {
        action: 'synchronize',
        resource: {
          type: 'pull_request',
          id: '41',
          number: 41,
          draft: true,
          beforeSha: 'old-head-sha',
          headSha: 'new-head-sha',
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
            id: 123456,
            node_id: 'PVTI_lADOExample',
            project_node_id: 'PVT_kwDOProject',
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
        id: '123456',
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
          id: '123456',
          nodeId: 'PVTI_lADOExample',
          projectNodeId: 'PVT_kwDOProject',
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
            status: 'ON_TRACK',
            start_date: '2026-06-29',
            target_date: '2026-07-06',
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
          status: 'ON_TRACK',
          startDate: '2026-06-29',
          targetDate: '2026-07-06',
          url: 'https://github.com/orgs/reirei-lab/projects/3/views/1?pane=issue&itemId=1',
          projectNodeId: 'PVT_kwDOProject',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'release',
        deliveryId: 'delivery-release-1',
        payload: {
          action: 'published',
          repository: { full_name: 'reirei-lab/rainrail' },
          release: {
            id: 800,
            tag_name: 'v1.2.3',
            name: 'Rainrail v1.2.3',
            draft: false,
            prerelease: false,
            html_url: 'https://github.com/reirei-lab/rainrail/releases/tag/v1.2.3',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.release',
      subject: {
        type: 'release',
        id: '800',
        url: 'https://github.com/reirei-lab/rainrail/releases/tag/v1.2.3',
      },
      payload: {
        resource: {
          type: 'release',
          id: '800',
          tagName: 'v1.2.3',
          name: 'Rainrail v1.2.3',
          draft: false,
          prerelease: false,
          url: 'https://github.com/reirei-lab/rainrail/releases/tag/v1.2.3',
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

  it('normalizes status, deployment, queue, security, relation, and milestone routing resources', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'status',
        deliveryId: 'delivery-status-1',
        payload: {
          sha: 'abc123',
          state: 'success',
          context: 'ci/test',
          target_url: 'https://github.com/reirei-lab/rainrail/actions/runs/1',
          repository: { full_name: 'reirei-lab/rainrail' },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.status',
      subject: {
        type: 'commit_status',
        id: 'abc123',
        url: 'https://github.com/reirei-lab/rainrail/actions/runs/1',
      },
      payload: {
        resource: {
          type: 'commit_status',
          id: 'abc123',
          headSha: 'abc123',
          state: 'success',
          context: 'ci/test',
          url: 'https://github.com/reirei-lab/rainrail/actions/runs/1',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'deployment_status',
        deliveryId: 'delivery-deployment-status-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          deployment: {
            id: 900,
            ref: 'main',
            sha: 'def456',
            environment: 'staging',
          },
          deployment_status: {
            id: 901,
            state: 'success',
            target_url: 'https://deploy.example/status',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.deployment_status',
      payload: {
        resource: {
          type: 'deployment',
          id: '900',
          ref: 'main',
          headSha: 'def456',
          environment: 'staging',
          state: 'success',
          statusId: '901',
          url: 'https://deploy.example/status',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'merge_group',
        deliveryId: 'delivery-merge-group-1',
        payload: {
          action: 'checks_requested',
          repository: { full_name: 'reirei-lab/rainrail' },
          merge_group: {
            head_sha: 'mergeabc',
            head_ref: 'gh-readonly-queue/main/pr-41',
            base_ref: 'main',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.merge_group',
      payload: {
        resource: {
          type: 'merge_group',
          id: 'mergeabc',
          headSha: 'mergeabc',
          headRef: 'gh-readonly-queue/main/pr-41',
          baseRef: 'main',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'workflow_job',
        deliveryId: 'delivery-workflow-job-1',
        payload: {
          action: 'queued',
          repository: { full_name: 'reirei-lab/rainrail' },
          workflow_job: {
            id: 1000,
            run_id: 2000,
            name: 'test',
            status: 'queued',
            conclusion: null,
            labels: ['self-hosted', 'macOS'],
            html_url: 'https://github.com/reirei-lab/rainrail/actions/runs/2000/job/1000',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.workflow_job',
      payload: {
        resource: {
          type: 'workflow_job',
          id: '1000',
          runId: '2000',
          name: 'test',
          status: 'queued',
          labels: ['self-hosted', 'macOS'],
          url: 'https://github.com/reirei-lab/rainrail/actions/runs/2000/job/1000',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'code_scanning_alert',
        deliveryId: 'delivery-alert-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          ref: 'refs/heads/main',
          commit_oid: 'abc123',
          alert: {
            number: 7,
            state: 'open',
            html_url: 'https://github.com/reirei-lab/rainrail/security/code-scanning/7',
            rule: { security_severity_level: 'high' },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.code_scanning_alert',
      payload: {
        resource: {
          type: 'security_alert',
          id: '7',
          number: 7,
          state: 'open',
          severity: 'high',
          ref: 'refs/heads/main',
          headSha: 'abc123',
          url: 'https://github.com/reirei-lab/rainrail/security/code-scanning/7',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issue_dependencies',
        deliveryId: 'delivery-issue-relation-1',
        payload: {
          action: 'blocked_by_added',
          repository: { full_name: 'reirei-lab/rainrail' },
          blocked_issue: {
            number: 16,
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16',
          },
          blocking_issue: {
            number: 15,
            html_url: 'https://github.com/reirei-lab/rainrail/issues/15',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.issue_dependencies',
      payload: {
        resource: {
          type: 'issue_relation',
          id: '16:15',
          relationship: 'blocked_by',
          issueNumber: 16,
          issueUrl: 'https://github.com/reirei-lab/rainrail/issues/16',
          relatedIssueNumber: 15,
          relatedIssueUrl: 'https://github.com/reirei-lab/rainrail/issues/15',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'issues',
        deliveryId: 'delivery-milestoned-1',
        payload: {
          action: 'milestoned',
          repository: { full_name: 'reirei-lab/rainrail' },
          issue: {
            number: 16,
            html_url: 'https://github.com/reirei-lab/rainrail/issues/16',
            milestone: {
              id: 300,
              number: 2,
              title: 'v1',
              due_on: '2026-07-31T00:00:00Z',
              html_url: 'https://github.com/reirei-lab/rainrail/milestone/2',
            },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.issue',
      payload: {
        milestone: {
          id: '300',
          number: 2,
          title: 'v1',
          dueOn: '2026-07-31T00:00:00Z',
          url: 'https://github.com/reirei-lab/rainrail/milestone/2',
        },
      },
    });
  });

  it('normalizes dispatch inputs, commit comments, protection rules, and advisory details', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'repository_dispatch',
        deliveryId: 'delivery-repository-dispatch-1',
        payload: {
          action: 'agent-run',
          branch: 'agent/reirei-lab-rainrail-16',
          repository: { full_name: 'reirei-lab/rainrail' },
          client_payload: {
            issue: 16,
            instruction: 'normalize payload',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.repository_dispatch',
      payload: {
        dispatch: {
          eventType: 'agent-run',
          ref: 'agent/reirei-lab-rainrail-16',
          branch: 'agent/reirei-lab-rainrail-16',
          clientPayload: {
            issue: 16,
            instruction: 'normalize payload',
          },
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'workflow_dispatch',
        deliveryId: 'delivery-workflow-dispatch-1',
        payload: {
          action: 'manual',
          ref: 'refs/heads/main',
          repository: { full_name: 'reirei-lab/rainrail' },
          inputs: {
            issue: '16',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.workflow_dispatch',
      payload: {
        dispatch: {
          ref: 'refs/heads/main',
          inputs: {
            issue: '16',
          },
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'commit_comment',
        deliveryId: 'delivery-commit-comment-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          comment: {
            id: 444,
            body: 'Check this line',
            commit_id: 'abc123',
            path: 'src/github-webhook.ts',
            position: 12,
            html_url: 'https://github.com/reirei-lab/rainrail/commit/abc123#commitcomment-444',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.commit_comment',
      subject: {
        type: 'commit_comment',
        id: '444',
        url: 'https://github.com/reirei-lab/rainrail/commit/abc123#commitcomment-444',
      },
      payload: {
        resource: {
          type: 'commit_comment',
          id: '444',
          commitId: 'abc123',
          path: 'src/github-webhook.ts',
          position: 12,
          url: 'https://github.com/reirei-lab/rainrail/commit/abc123#commitcomment-444',
        },
        comment: {
          id: '444',
          body: 'Check this line',
          commitId: 'abc123',
          path: 'src/github-webhook.ts',
          position: 12,
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'deployment_protection_rule',
        deliveryId: 'delivery-deployment-protection-1',
        payload: {
          action: 'requested',
          repository: { full_name: 'reirei-lab/rainrail' },
          environment: 'staging',
          ref: 'main',
          sha: 'def456',
          deployment_callback_url: 'https://api.github.com/repos/reirei-lab/rainrail/actions/runs/1/deployment_protection_rule',
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.deployment_protection_rule',
      payload: {
        resource: {
          type: 'deployment_protection_rule',
          id: 'staging:def456',
          environment: 'staging',
          ref: 'main',
          headSha: 'def456',
          callbackUrl: 'https://api.github.com/repos/reirei-lab/rainrail/actions/runs/1/deployment_protection_rule',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'secret_scanning_alert_location',
        deliveryId: 'delivery-secret-location-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          alert: {
            number: 9,
            state: 'open',
            html_url: 'https://github.com/reirei-lab/rainrail/security/secret-scanning/9',
          },
          location: {
            type: 'commit',
            details: {
              path: 'src/secret.txt',
              start_line: 10,
              end_line: 10,
              commit_sha: 'abc123',
            },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.secret_scanning_alert_location',
      payload: {
        resource: {
          type: 'security_alert',
          id: '9',
          number: 9,
          state: 'open',
          locationType: 'commit',
          path: 'src/secret.txt',
          startLine: 10,
          endLine: 10,
          headSha: 'abc123',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'security_advisory',
        deliveryId: 'delivery-security-advisory-1',
        payload: {
          action: 'published',
          repository: { full_name: 'reirei-lab/rainrail' },
          security_advisory: {
            ghsa_id: 'GHSA-abcd-1234',
            summary: 'Example advisory',
            severity: 'high',
            html_url: 'https://github.com/advisories/GHSA-abcd-1234',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.security_advisory',
      payload: {
        resource: {
          type: 'security_advisory',
          id: 'GHSA-abcd-1234',
          ghsaId: 'GHSA-abcd-1234',
          summary: 'Example advisory',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-abcd-1234',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'repository_advisory',
        deliveryId: 'delivery-repository-advisory-1',
        payload: {
          action: 'published',
          repository: { full_name: 'reirei-lab/rainrail' },
          repository_advisory: {
            ghsa_id: 'GHSA-wxyz-5678',
            summary: 'Repository advisory',
            severity: 'critical',
            html_url: 'https://github.com/reirei-lab/rainrail/security/advisories/GHSA-wxyz-5678',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.repository_advisory',
      payload: {
        resource: {
          type: 'repository_advisory',
          id: 'GHSA-wxyz-5678',
          ghsaId: 'GHSA-wxyz-5678',
          summary: 'Repository advisory',
          severity: 'critical',
          url: 'https://github.com/reirei-lab/rainrail/security/advisories/GHSA-wxyz-5678',
        },
      },
    });
  });

  it('normalizes discussion and discussion comment resources', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'discussion',
        deliveryId: 'delivery-discussion-1',
        payload: {
          action: 'answered',
          repository: { full_name: 'reirei-lab/rainrail' },
          discussion: {
            id: 700,
            number: 12,
            title: 'How should agents route events?',
            html_url: 'https://github.com/reirei-lab/rainrail/discussions/12',
            category: { name: 'Q&A', slug: 'q-a' },
          },
          answer: {
            id: 701,
            html_url: 'https://github.com/reirei-lab/rainrail/discussions/12#discussioncomment-701',
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.discussion',
      subject: {
        type: 'discussion',
        id: '12',
        url: 'https://github.com/reirei-lab/rainrail/discussions/12',
      },
      payload: {
        resource: {
          type: 'discussion',
          id: '12',
          number: 12,
          title: 'How should agents route events?',
          url: 'https://github.com/reirei-lab/rainrail/discussions/12',
          categoryName: 'Q&A',
          categorySlug: 'q-a',
          answerId: '701',
          answerUrl: 'https://github.com/reirei-lab/rainrail/discussions/12#discussioncomment-701',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'discussion_comment',
        deliveryId: 'delivery-discussion-comment-1',
        payload: {
          action: 'created',
          repository: { full_name: 'reirei-lab/rainrail' },
          discussion: {
            id: 700,
            number: 12,
            title: 'How should agents route events?',
            html_url: 'https://github.com/reirei-lab/rainrail/discussions/12',
            category: { name: 'Q&A', slug: 'q-a' },
          },
          comment: {
            id: 702,
            body: 'Use normalized resources.',
            html_url: 'https://github.com/reirei-lab/rainrail/discussions/12#discussioncomment-702',
            user: { login: 'reviewer' },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.discussion_comment',
      payload: {
        resource: {
          type: 'discussion',
          id: '12',
          number: 12,
          categoryName: 'Q&A',
        },
        comment: {
          id: '702',
          body: 'Use normalized resources.',
          author: 'reviewer',
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
            node_id: 'PRRT_kwDOExample',
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

  it('normalizes protection, deployment review, package, installation repository, and wiki resources', async () => {
    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'branch_protection_rule',
        deliveryId: 'delivery-branch-protection-1',
        payload: {
          action: 'edited',
          repository: { full_name: 'reirei-lab/rainrail' },
          rule: {
            id: 5000,
            name: 'main',
          },
          changes: {
            required_status_checks: {
              from: ['test'],
              to: ['test', 'build'],
            },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.branch_protection_rule',
      payload: {
        resource: {
          type: 'branch_protection_rule',
          id: '5000',
          name: 'main',
        },
        changes: [
          {
            field: 'required_status_checks',
          },
        ],
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'deployment_review',
        deliveryId: 'delivery-deployment-review-1',
        payload: {
          action: 'approved',
          repository: { full_name: 'reirei-lab/rainrail' },
          workflow_run: {
            id: 9000,
            name: 'deploy',
            html_url: 'https://github.com/reirei-lab/rainrail/actions/runs/9000',
          },
          workflow_job_runs: [
            {
              id: 9100,
              environment: 'staging',
            },
          ],
          reviewers: [{ login: 'ops-team' }],
          approver: { login: 'maintainer' },
          comment: { body: 'ship it' },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.deployment_review',
      payload: {
        resource: {
          type: 'deployment_review',
          id: '9000:staging',
          runId: '9000',
          environment: 'staging',
          reviewerLogins: ['ops-team'],
          approver: 'maintainer',
          body: 'ship it',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'registry_package',
        deliveryId: 'delivery-registry-package-1',
        payload: {
          action: 'published',
          repository: { full_name: 'reirei-lab/rainrail' },
          registry_package: {
            id: 3000,
            name: '@reirei-lab/rainrail',
            package_type: 'npm',
            html_url: 'https://github.com/reirei-lab/rainrail/pkgs/npm/rainrail',
            package_version: {
              id: 3001,
              name: '1.2.3',
              html_url: 'https://github.com/reirei-lab/rainrail/pkgs/npm/rainrail/3001',
            },
          },
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.registry_package',
      payload: {
        resource: {
          type: 'package',
          id: '3000',
          name: '@reirei-lab/rainrail',
          packageType: 'npm',
          version: '1.2.3',
          versionId: '3001',
          url: 'https://github.com/reirei-lab/rainrail/pkgs/npm/rainrail',
        },
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'installation_repositories',
        deliveryId: 'delivery-installation-repositories-1',
        payload: {
          action: 'added',
          installation: { id: 123 },
          repositories_added: [
            {
              id: 1,
              full_name: 'reirei-lab/rainrail',
              html_url: 'https://github.com/reirei-lab/rainrail',
              owner: { login: 'reirei-lab' },
              name: 'rainrail',
            },
          ],
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.installation_repositories',
      payload: {
        resource: {
          type: 'installation',
          id: '123',
        },
        repositories: [
          {
            id: '1',
            fullName: 'reirei-lab/rainrail',
            url: 'https://github.com/reirei-lab/rainrail',
            owner: 'reirei-lab',
            name: 'rainrail',
          },
        ],
      },
    });

    await expect(
      createGitHubWebhookEvent({
        githubEvent: 'gollum',
        deliveryId: 'delivery-gollum-1',
        payload: {
          repository: { full_name: 'reirei-lab/rainrail' },
          pages: [
            {
              page_name: 'Agent Guide',
              title: 'Agent Guide',
              action: 'edited',
              sha: 'abc123',
              html_url: 'https://github.com/reirei-lab/rainrail/wiki/Agent-Guide',
            },
          ],
        },
        rawBody: '{}',
        receivedAt: new Date('2026-06-29T13:00:44.000Z'),
      }),
    ).resolves.toMatchObject({
      name: 'github.gollum',
      payload: {
        resource: {
          type: 'wiki_page',
          id: 'Agent Guide',
          name: 'Agent Guide',
          action: 'edited',
          headSha: 'abc123',
          url: 'https://github.com/reirei-lab/rainrail/wiki/Agent-Guide',
        },
        pages: [
          {
            name: 'Agent Guide',
            title: 'Agent Guide',
            action: 'edited',
            sha: 'abc123',
            url: 'https://github.com/reirei-lab/rainrail/wiki/Agent-Guide',
          },
        ],
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
        type: 'workflow_run',
        id: '17345176172',
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
