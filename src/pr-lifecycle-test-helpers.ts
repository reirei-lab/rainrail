import { createEventEnvelope, type RainrailEventEnvelope } from './events.js';
import type { AgentTask, AgentTaskHandoffClient, PullRequestReviewTarget } from './pr-lifecycle.js';

export const task: AgentTask = {
  id: 'agent_task_1',
  agentSessionId: 'agent:main:session',
  branchName: 'agent/test-pr',
  issue: {
    contentId: 'I_issue',
    contentType: 'Issue',
    repository: 'reirei-lab/rainrail',
    number: 23,
    state: 'OPEN',
  },
  claim: {
    projectItemId: 'PVTI_item',
    projectId: 'PVT_project',
  },
};

export function pullRequest(overrides: Partial<PullRequestReviewTarget> = {}): PullRequestReviewTarget {
  return {
    repository: 'reirei-lab/rainrail',
    number: 44,
    title: 'feat: add PR lifecycle workflows',
    url: 'https://github.com/reirei-lab/rainrail/pull/44',
    authorLogin: 'reirei-agent',
    headRefName: 'agent/test-pr',
    headRepository: 'reirei-lab/rainrail',
    headSha: 'abc123',
    isDraft: false,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    reviewRequests: [],
    reviews: [{ authorLogin: 'hiragram', state: 'APPROVED' }],
    ...overrides,
  };
}

export function handoffRecorder(records: {
  updates?: Array<{ reason: string; commentBody?: string }>;
  statusRecords?: string[];
  taskOverride?: Partial<AgentTask>;
} = {}): AgentTaskHandoffClient {
  return {
    getAgentTaskByBranchName(branchName) {
      return branchName === task.branchName ? { ...task, ...records.taskOverride } : undefined;
    },
    async returnTaskToTodo(input) {
      records.updates?.push({
        reason: input.reason,
        ...(input.commentBody === undefined ? {} : { commentBody: input.commentBody }),
      });
      return {
        projectItemId: input.task.claim?.projectItemId ?? 'PVTI_item',
        status: 'Todo',
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/23#issuecomment-1',
      };
    },
    recordTaskStatus(input) {
      records.statusRecords?.push(input.result);
    },
  };
}

export function reviewEvent(overrides: {
  state?: string;
  reviewerLogin?: string;
  prAuthor?: string;
  prState?: string;
  repository?: string;
  headRepository?: string;
  missingHeadRepository?: boolean;
  branchName?: string;
  stringReviewId?: boolean;
  reviewBody?: string;
  reviewCommitId?: string;
  headSha?: string;
} = {}): RainrailEventEnvelope {
  const repository = overrides.repository ?? 'reirei-lab/rainrail';
  const reviewId = 4493317816;
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository },
    name: 'github.review',
    delivery: { id: 'delivery-review', receivedAt: '2026-07-01T00:00:00.000Z' },
    occurredAt: '2026-07-01T00:00:00.000Z',
    subject: { type: 'review', id: String(reviewId) },
    payload: {
      provider: 'github',
      event: 'pull_request_review',
      action: 'submitted',
      repository: { fullName: repository },
      resource: {
        type: 'review',
        id: String(reviewId),
        state: overrides.state ?? 'approved',
        url: `https://github.com/${repository}/pull/44#pullrequestreview-${reviewId}`,
      },
      pullRequest: {
        type: 'pull_request',
        id: '44',
        number: 44,
        headRef: overrides.branchName ?? 'agent/test-pr',
        headSha: overrides.headSha ?? 'abc123',
        ...(overrides.missingHeadRepository === true ? {} : { headRepository: overrides.headRepository ?? repository }),
        state: overrides.prState ?? 'open',
        author: overrides.prAuthor ?? 'reirei-agent',
      },
      review: {
        id: overrides.stringReviewId === true ? String(reviewId) : reviewId,
        state: overrides.state ?? 'approved',
        author: overrides.reviewerLogin ?? 'hiragram',
        body: overrides.reviewBody ?? '### Codex Review',
        ...(overrides.reviewCommitId === undefined ? {} : { commitId: overrides.reviewCommitId }),
        url: `https://github.com/${repository}/pull/44#pullrequestreview-${reviewId}`,
      },
    },
    rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/delivery-review' },
  });
}

export function pullRequestEvent(overrides: { action?: string; branchName?: string; headSha?: string } = {}): RainrailEventEnvelope {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.pull_request',
    delivery: { id: 'delivery-pr', receivedAt: '2026-07-01T00:00:00.000Z' },
    occurredAt: '2026-07-01T00:00:00.000Z',
    subject: { type: 'pull_request', id: '44' },
    payload: {
      provider: 'github',
      event: 'pull_request',
      action: overrides.action ?? 'ready_for_review',
      repository: { fullName: 'reirei-lab/rainrail' },
      resource: {
        type: 'pull_request',
        id: '44',
        number: 44,
        headRef: overrides.branchName ?? 'agent/test-pr',
        headSha: overrides.headSha ?? 'abc123',
      },
    },
    rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/delivery-pr' },
  });
}

export function checkRunEvent(overrides: {
  conclusion?: string;
  status?: string;
  headSha?: string;
  pullRequests?: Array<{ number: number }>;
} = {}): RainrailEventEnvelope {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.check_run',
    delivery: { id: 'delivery-check', receivedAt: '2026-07-01T00:00:00.000Z' },
    occurredAt: '2026-07-01T00:00:00.000Z',
    subject: { type: 'check_run', id: '1' },
    payload: {
      provider: 'github',
      event: 'check_run',
      action: 'completed',
      status: overrides.status ?? 'completed',
      conclusion: overrides.conclusion ?? 'success',
      repository: { fullName: 'reirei-lab/rainrail' },
      resource: {
        type: 'check_run',
        id: '1',
        name: 'Typecheck, Test, Build',
        status: overrides.status ?? 'completed',
        conclusion: overrides.conclusion ?? 'success',
        headSha: overrides.headSha ?? 'abc123',
        url: 'https://github.com/reirei-lab/rainrail/actions/runs/1/job/2',
      },
      pullRequests: (overrides.pullRequests ?? [{ number: 44 }])
        .map((pullRequest) => ({ type: 'pull_request', id: String(pullRequest.number), number: pullRequest.number })),
    },
    rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/delivery-check' },
  });
}

export function statusEvent(overrides: { state?: string; headSha?: string; normalizedResourceOnly?: boolean } = {}): RainrailEventEnvelope {
  const state = overrides.state ?? 'success';
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.status',
    delivery: { id: 'delivery-status', receivedAt: '2026-07-01T00:00:00.000Z' },
    occurredAt: '2026-07-01T00:00:00.000Z',
    subject: { type: 'status', id: overrides.headSha ?? 'abc123' },
    payload: {
      provider: 'github',
      event: 'status',
      action: 'received',
      ...(overrides.normalizedResourceOnly === true ? {} : { state }),
      repository: { fullName: 'reirei-lab/rainrail' },
      resource: {
        type: 'status',
        id: overrides.headSha ?? 'abc123',
        context: 'legacy-ci',
        ...(overrides.normalizedResourceOnly === true ? {} : { status: state, conclusion: state }),
        state,
        headSha: overrides.headSha ?? 'abc123',
        url: 'https://github.com/reirei-lab/rainrail/status/abc123',
      },
    },
    rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/delivery-status' },
  });
}

export function pushEvent(ref = 'refs/heads/main'): RainrailEventEnvelope {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.push',
    delivery: { id: 'delivery-push', receivedAt: '2026-07-01T00:00:00.000Z' },
    occurredAt: '2026-07-01T00:00:00.000Z',
    subject: { type: 'push', id: 'abc123' },
    payload: {
      provider: 'github',
      event: 'push',
      action: 'received',
      repository: { fullName: 'reirei-lab/rainrail' },
      resource: { type: 'push', id: 'abc123', ref },
    },
    rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/delivery-push' },
  });
}
