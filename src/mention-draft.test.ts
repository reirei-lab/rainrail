import { describe, expect, it, vi } from 'vitest';

import {
  createEventEnvelope,
  createMentionDraftWorkflow,
  mentionDraftMarker,
  mentionDraftRequestFromEvent,
  type MentionDraftItemInput,
  type TaskQueueProvider,
} from './index.js';

describe('mention draft workflow', () => {
  it('extracts GitHub issue comments that mention the configured agent', () => {
    const mention = mentionDraftRequestFromEvent(githubMentionEvent(), 'reirei-agent');

    expect(mention).toMatchObject({
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/17#issuecomment-1',
      title: 'Respond to reirei-lab/rainrail#17: React to mentions',
      repository: 'reirei-lab/rainrail',
      number: 17,
    });
  });

  it('ignores comments without the configured mention and comments from the agent itself', () => {
    expect(mentionDraftRequestFromEvent(githubMentionEvent({
      body: 'please handle this',
    }), 'reirei-agent')).toBeUndefined();

    expect(mentionDraftRequestFromEvent(githubMentionEvent({
      actor: 'reirei-agent',
    }), 'reirei-agent')).toBeUndefined();
  });

  it('queues the mention as a Project draft item through the queue provider', async () => {
    const addMentionDraftItem = vi.fn(async (_input: MentionDraftItemInput) => ({
      projectId: 'PVT_project',
      projectItemId: 'PVTI_draft',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'opt_todo',
      created: true,
    }));
    const workflow = createMentionDraftWorkflow({
      assigneeLogin: 'reirei-agent',
      addMentionDraftItem,
    });

    await expect(workflow.handle(githubMentionEvent(), runtimeContext())).resolves.toMatchObject({
      handled: true,
      reason: 'mention_draft_created',
      draftItem: {
        projectItemId: 'PVTI_draft',
      },
    });
    expect(addMentionDraftItem).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Respond to reirei-lab/rainrail#17: React to mentions',
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/17#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 17,
      }),
      expect.objectContaining({ runId: 'run-mention' }),
    );
    expect(addMentionDraftItem.mock.calls[0]?.[0].body).toContain(mentionDraftMarker);
    expect(addMentionDraftItem.mock.calls[0]?.[0].body).toContain('@reirei-agent please handle this');
  });

  it('uses providers.queue.addMentionDraftItem when no override is supplied', async () => {
    const addMentionDraftItem = vi.fn(async () => ({
      projectItemId: 'PVTI_queue_draft',
      created: false,
    }));
    const workflow = createMentionDraftWorkflow({
      assigneeLogin: 'reirei-agent',
    });

    await expect(workflow.handle(githubMentionEvent(), runtimeContext({
      queue: {
        name: 'mock-queue',
        kind: 'task-queue-provider',
        listProjectIssues: async () => [],
        claimProjectIssue: async () => ({ projectItemId: 'unused' }),
        addMentionDraftItem,
      },
    }))).resolves.toMatchObject({
      handled: true,
      reason: 'mention_draft_already_exists',
      draftItem: {
        projectItemId: 'PVTI_queue_draft',
      },
    });
  });

  it('extracts pull request review comments that mention the agent', () => {
    const mention = mentionDraftRequestFromEvent(githubReviewCommentEvent(), 'reirei-agent');

    expect(mention).toMatchObject({
      commentUrl: 'https://github.com/reirei-lab/rainrail/pull/18#discussion_r1',
      title: 'Respond to reirei-lab/rainrail#18: Mention handling',
      repository: 'reirei-lab/rainrail',
      number: 18,
    });
  });

  it('extracts submitted pull request review bodies that mention the agent', () => {
    const mention = mentionDraftRequestFromEvent(githubSubmittedReviewEvent(), 'reirei-agent');

    expect(mention).toMatchObject({
      commentUrl: 'https://github.com/reirei-lab/rainrail/pull/19#pullrequestreview-2',
      title: 'Respond to reirei-lab/rainrail#19: Mention handling',
      repository: 'reirei-lab/rainrail',
      number: 19,
      body: 'Could you take a look, @reirei-agent?',
    });
  });

  it('extracts normalized submitted review resources that mention the agent', () => {
    const mention = mentionDraftRequestFromEvent(githubNormalizedSubmittedReviewEvent(), 'reirei-agent');

    expect(mention).toMatchObject({
      commentUrl: 'https://github.com/reirei-lab/rainrail/pull/20#pullrequestreview-3',
      title: 'Respond to reirei-lab/rainrail#20: Normalized mention handling',
      repository: 'reirei-lab/rainrail',
      number: 20,
      body: 'Please respond, @reirei-agent.',
    });
  });
});

function githubMentionEvent(overrides: {
  body?: string;
  actor?: string;
} = {}) {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.issue',
    delivery: {
      id: 'delivery-comment-1',
      receivedAt: '2026-06-06T06:20:00.000Z',
    },
    occurredAt: '2026-06-06T06:20:00.000Z',
    subject: {
      type: 'issue',
      id: '17',
      url: 'https://github.com/reirei-lab/rainrail/issues/17',
    },
    payload: {
      provider: 'github',
      event: 'issue_comment',
      action: 'created',
      actor: { login: overrides.actor ?? 'hiragram' },
      resource: {
        type: 'issue',
        id: '17',
        number: 17,
        title: 'React to mentions',
        url: 'https://github.com/reirei-lab/rainrail/issues/17',
      },
      repository: {
        fullName: 'reirei-lab/rainrail',
      },
      comment: {
        id: '1',
        body: overrides.body ?? '@reirei-agent please handle this',
        url: 'https://github.com/reirei-lab/rainrail/issues/17#issuecomment-1',
        author: 'hiragram',
      },
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: 'github://deliveries/delivery-comment-1',
    },
  });
}

function githubReviewCommentEvent() {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.review',
    delivery: {
      id: 'delivery-review-comment-1',
      receivedAt: '2026-06-06T06:20:00.000Z',
    },
    occurredAt: '2026-06-06T06:20:00.000Z',
    subject: {
      type: 'pull_request',
      id: '18',
      url: 'https://github.com/reirei-lab/rainrail/pull/18',
    },
    payload: {
      provider: 'github',
      event: 'pull_request_review_comment',
      action: 'created',
      actor: { login: 'hiragram' },
      resource: {
        type: 'pull_request',
        id: '18',
        number: 18,
        title: 'Mention handling',
        url: 'https://github.com/reirei-lab/rainrail/pull/18',
      },
      repository: {
        fullName: 'reirei-lab/rainrail',
      },
      comment: {
        id: '1',
        body: 'Could you check this, @Reirei-Agent?',
        url: 'https://github.com/reirei-lab/rainrail/pull/18#discussion_r1',
        author: 'hiragram',
      },
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: 'github://deliveries/delivery-review-comment-1',
    },
  });
}

function githubSubmittedReviewEvent() {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.review',
    delivery: {
      id: 'delivery-review-1',
      receivedAt: '2026-06-06T06:20:00.000Z',
    },
    occurredAt: '2026-06-06T06:20:00.000Z',
    subject: {
      type: 'review',
      id: '2',
      url: 'https://github.com/reirei-lab/rainrail/pull/19#pullrequestreview-2',
    },
    payload: {
      provider: 'github',
      event: 'pull_request_review',
      action: 'submitted',
      actor: { login: 'hiragram' },
      repository: {
        full_name: 'reirei-lab/rainrail',
      },
      pull_request: {
        number: 19,
        title: 'Mention handling',
        html_url: 'https://github.com/reirei-lab/rainrail/pull/19',
      },
      review: {
        id: '2',
        body: 'Could you take a look, @reirei-agent?',
        html_url: 'https://github.com/reirei-lab/rainrail/pull/19#pullrequestreview-2',
        user: { login: 'hiragram' },
      },
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: 'github://deliveries/delivery-review-1',
    },
  });
}

function githubNormalizedSubmittedReviewEvent() {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.review',
    delivery: {
      id: 'delivery-review-normalized-1',
      receivedAt: '2026-06-06T06:20:00.000Z',
    },
    occurredAt: '2026-06-06T06:20:00.000Z',
    subject: {
      type: 'review',
      id: '3',
      url: 'https://github.com/reirei-lab/rainrail/pull/20#pullrequestreview-3',
    },
    payload: {
      provider: 'github',
      event: 'pull_request_review',
      action: 'submitted',
      actor: { login: 'hiragram' },
      resource: {
        type: 'review',
        id: '3',
        body: 'Please respond, @reirei-agent.',
        url: 'https://github.com/reirei-lab/rainrail/pull/20#pullrequestreview-3',
      },
      pullRequest: {
        type: 'pull_request',
        id: '20',
        number: 20,
        title: 'Normalized mention handling',
        url: 'https://github.com/reirei-lab/rainrail/pull/20',
      },
      repository: {
        fullName: 'reirei-lab/rainrail',
      },
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: 'github://deliveries/delivery-review-normalized-1',
    },
  });
}

function runtimeContext(overrides: {
  queue?: TaskQueueProvider;
} = {}) {
  return {
    runId: 'run-mention',
    now: () => new Date('2026-06-06T06:20:00.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider' as const,
        getIssue: async () => {
          throw new Error('not used');
        },
        createComment: async () => {
          throw new Error('not used');
        },
      },
      ...(overrides.queue === undefined ? {} : { queue: overrides.queue }),
    },
    runtime: {
      name: 'mock-runtime',
      kind: 'runtime-provider' as const,
      startRun: async () => {
        throw new Error('not used');
      },
    },
  };
}

function queueProvider() {
  return {
    name: 'mock-queue',
    kind: 'task-queue-provider' as const,
    listProjectIssues: async () => [],
    claimProjectIssue: async () => ({ projectItemId: 'unused' }),
  };
}
