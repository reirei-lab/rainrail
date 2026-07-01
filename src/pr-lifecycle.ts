import type { RainrailEventEnvelope } from './events.js';
import type { TaskProvider, TaskProviderContext } from './task-provider.js';
import type { TaskQueueProvider } from './task-queue.js';
import type { PluginRuntimeContext, WorkflowPlugin } from './workflow-plugin.js';
import { defineWorkflowPlugin } from './workflow-plugin.js';

export interface PullRequestCheck {
  type: string;
  name?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

export interface PullRequestReview {
  authorLogin: string;
  state: string;
  commitId?: string;
}

export interface PullRequestReviewTarget {
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  headRefName: string;
  headRepository?: string;
  headSha?: string;
  isDraft: boolean;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup: PullRequestCheck[];
  reviewRequests: string[];
  reviews?: PullRequestReview[];
}

export interface PullRequestReviewComment {
  id: number;
  reviewId: number;
  path: string;
  body: string;
  url?: string;
  line?: number;
  originalLine?: number;
  startLine?: number;
  commitId?: string;
}

export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase' | (string & {});

export interface GitHubPullRequestProvider {
  getPullRequest(input: {
    repository: string;
    number: number;
  }, context?: TaskProviderContext): Promise<PullRequestReviewTarget>;
  findOpenPullRequestsByBase?(input: {
    repository: string;
    baseRefName: string;
  }, context?: TaskProviderContext): Promise<PullRequestReviewTarget[]>;
  findPullRequestByHead(input: {
    repository: string;
    headRefName?: string;
    headSha?: string;
  }, context?: TaskProviderContext): Promise<PullRequestReviewTarget | undefined>;
  findPullRequestsByHead?(input: {
    repository: string;
    headRefName?: string;
    headSha?: string;
  }, context?: TaskProviderContext): Promise<PullRequestReviewTarget[]>;
  requestReview(input: {
    repository: string;
    number: number;
    reviewerLogin: string;
  }, context?: TaskProviderContext): Promise<void>;
  removeReviewRequest?(input: {
    repository: string;
    number: number;
    reviewerLogin: string;
  }, context?: TaskProviderContext): Promise<void>;
  listReviewComments?(input: {
    repository: string;
    number: number;
  }, context?: TaskProviderContext): Promise<PullRequestReviewComment[]>;
}

export interface AgentTaskIssue {
  contentId?: string;
  contentType?: string;
  repository?: string;
  number?: number;
  state?: string;
  url?: string;
}

export interface AgentTaskClaim {
  projectId?: string;
  projectItemId: string;
  statusFieldId?: string;
  statusOptionId?: string;
  agentSessionIdFieldId?: string;
  branchFieldId?: string;
  contentId?: string;
  commentBody?: string;
  commentUrl?: string;
  lockRefId?: string;
  dispatchedLockRefId?: string;
  lockRepositoryId?: string;
  lockRepositoryNameWithOwner?: string;
  lockDefaultBranchOid?: string;
  lockDefaultBranchTreeOid?: string;
  originalStatus?: string | null;
}

export interface AgentTask {
  id: string;
  agentSessionId: string;
  branchName: string;
  issue?: AgentTaskIssue;
  claim?: AgentTaskClaim;
}

export interface AgentTaskHandoffClient {
  getAgentTaskByBranchName(branchName: string): AgentTask | undefined | Promise<AgentTask | undefined>;
  returnTaskToTodo(input: {
    task: AgentTask;
    reason: string;
    commentBody?: string;
  }, context?: PluginRuntimeContext): Promise<{ projectItemId: string; status: string; commentUrl?: string }>;
  recordTaskStatus?(input: { task: AgentTask; result: string }, context?: PluginRuntimeContext): void | Promise<void>;
}

export interface ReviewRequestWorkflowOptions {
  enabled?: boolean;
  agentLogin: string;
  reviewerLogin: string;
  branchPrefix: string;
  pullRequests?: GitHubPullRequestProvider | undefined;
}

export interface TodoHandoffWorkflowOptions {
  enabled?: boolean;
  tasks: AgentTaskHandoffClient;
}

export interface ChangeRequestWorkflowOptions extends TodoHandoffWorkflowOptions {}

export interface CodexReviewWorkflowOptions extends TodoHandoffWorkflowOptions {
  agentLogin: string;
  reviewerLogin: string;
  targetRepositories?: string[];
  pullRequests?: GitHubPullRequestProvider | undefined;
}

export interface CheckFailureWorkflowOptions extends TodoHandoffWorkflowOptions {
  agentLogin: string;
  branchPrefix: string;
  reviewRequest?: ReviewRequestRemovalOptions;
  pullRequests?: GitHubPullRequestProvider | undefined;
}

export interface ReviewRequestRemovalOptions {
  enabled?: boolean;
  reviewerLogin: string;
}

export interface ConflictCheckWorkflowOptions extends TodoHandoffWorkflowOptions {
  pullRequests?: GitHubPullRequestProvider | undefined;
  reviewRequest?: ReviewRequestRemovalOptions;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface AutoMergeWorkflowOptions {
  enabled?: boolean;
  agentLogin: string;
  reviewerLogin: string;
  branchPrefix: string;
  mergeMethod: PullRequestMergeMethod;
  targetRepositories: string[];
  pullRequests?: GitHubPullRequestProvider | undefined;
}

export interface WorkflowResult {
  handled: boolean;
  reason: string;
  [key: string]: unknown;
}

type PullRequestCandidate = {
  repository: string;
  number?: number;
  numbers?: number[];
  headRefName?: string;
  headSha?: string;
};

export function createReviewRequestWorkflow(options: ReviewRequestWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'review-request',
    accepts: (event) => event.source.type === 'github'
      && (event.name === 'github.check_run' || event.name === 'github.status' || event.name === 'github.pull_request'),
    async handle(event, context) {
      return handleReviewRequestEvent(event, { ...options, pullRequests: options.pullRequests ?? pullRequestsFromContext(context) }, context);
    },
  });
}

export function createChangeRequestWorkflow(options: ChangeRequestWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'change-request',
    accepts: (event) => event.source.type === 'github' && event.name === 'github.review',
    async handle(event, context) {
      return handleChangeRequestEvent(event, options, context);
    },
  });
}

export function createCodexReviewWorkflow(options: CodexReviewWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'codex-review',
    accepts: (event) => event.source.type === 'github' && event.name === 'github.review',
    async handle(event, context) {
      return handleCodexReviewEvent(event, { ...options, pullRequests: options.pullRequests ?? pullRequestsFromContext(context) }, context);
    },
  });
}

export function createCheckFailureWorkflow(options: CheckFailureWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'check-failure',
    accepts: (event) => event.source.type === 'github' && (event.name === 'github.check_run' || event.name === 'github.status'),
    async handle(event, context) {
      return handleCheckFailureEvent(event, { ...options, pullRequests: options.pullRequests ?? pullRequestsFromContext(context) }, context);
    },
  });
}

export function createConflictCheckWorkflow(options: ConflictCheckWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'conflict-check',
    accepts: (event) => event.source.type === 'github' && event.name === 'github.push',
    async handle(event, context) {
      return handleConflictCheckEvent(event, { ...options, pullRequests: options.pullRequests ?? pullRequestsFromContext(context) }, context);
    },
  });
}

export function createAutoMergeWorkflow(options: AutoMergeWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'auto-merge',
    capabilities: ['merge'],
    accepts: (event) => event.source.type === 'github'
      && (
        event.name === 'github.review'
        || event.name === 'github.check_run'
        || event.name === 'github.status'
        || (event.name === 'github.pull_request' && eventAction(event) === 'ready_for_review')
      ),
    async handle(event, context) {
      return handleAutoMergeEvent(event, { ...options, pullRequests: options.pullRequests ?? pullRequestsFromContext(context) }, context);
    },
  });
}

export async function handleReviewRequestEvent(
  event: RainrailEventEnvelope,
  options: ReviewRequestWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'review requests are disabled' };
  const candidate = pullRequestCandidateFromEvent(event);
  if (candidate === undefined) return { handled: false, reason: 'event is not a completed successful check for a pull request' };

  const pullRequests = requirePullRequests(options.pullRequests);
  const candidates = await resolvePullRequestCandidates(candidate, pullRequests, context);
  if (candidates.length === 0) return { handled: false, reason: 'pull request was not found' };
  let fallback: WorkflowResult = { handled: false, reason: 'pull request was not found' };
  for (const pullRequest of candidates) {
    if (candidate.headSha !== undefined && pullRequest.headSha !== undefined && candidate.headSha !== pullRequest.headSha) {
      fallback = { handled: false, reason: 'check does not match the current pull request head', candidate, pullRequest };
      continue;
    }
    if (!isReviewTarget(options, pullRequest)) {
      fallback = { handled: false, reason: 'pull request is not an agent-authored target', pullRequest };
      continue;
    }
    if (normalize(pullRequest.state) !== 'open') {
      fallback = { handled: false, reason: 'pull request is not open', pullRequest };
      continue;
    }
    if (pullRequest.isDraft) {
      fallback = { handled: false, reason: 'pull request is draft', pullRequest };
      continue;
    }
    if (hasUnresolvedChangeRequest(pullRequest)) {
      fallback = { handled: false, reason: 'pull request has unresolved change requests', pullRequest };
      continue;
    }
    if (!hasPassingCheckRollup(pullRequest)) {
      fallback = { handled: false, reason: 'not all checks have passed', pullRequest };
      continue;
    }
    if (reviewApproved(options, pullRequest)) {
      fallback = { handled: false, reason: 'pull request is already approved by configured reviewer', pullRequest };
      continue;
    }
    if (pullRequest.reviewRequests.some((login) => sameLogin(login, options.reviewerLogin))) {
      fallback = { handled: false, reason: 'review was already requested', pullRequest };
      continue;
    }

    await pullRequests.requestReview({
      repository: pullRequest.repository,
      number: pullRequest.number,
      reviewerLogin: options.reviewerLogin,
    }, taskContext(context));
    return { handled: true, reason: 'review_requested', pullRequest };
  }
  return fallback;
}

export async function handleChangeRequestEvent(
  event: RainrailEventEnvelope,
  options: ChangeRequestWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'project issue selection is not configured' };
  const target = changeRequestTargetFromEvent(event);
  if (target === undefined) return { handled: false, reason: 'event is not a pull request change request' };
  if (normalize(target.headRepository) !== normalize(target.repository)) {
    return { handled: false, reason: 'pull request head repository does not match the base repository', pullRequestNumber: target.number, branchName: target.branchName };
  }
  if (normalize(target.pullRequestState) === 'closed') {
    return { handled: false, reason: 'pull request is already closed', pullRequestNumber: target.number, branchName: target.branchName };
  }
  const task = await options.tasks.getAgentTaskByBranchName(target.branchName);
  if (task === undefined) {
    return { handled: false, reason: 'no agent task matched the PR branch', pullRequestNumber: target.number, branchName: target.branchName };
  }
  const repositorySkip = repositoryMismatchReason(task, target.repository);
  if (repositorySkip !== undefined) return { handled: false, reason: repositorySkip, pullRequestNumber: target.number, branchName: target.branchName, taskId: task.id };
  const skip = shouldIgnoreTask(task);
  if (skip !== undefined) return { handled: false, reason: skip, pullRequestNumber: target.number, branchName: target.branchName, taskId: task.id };

  const update = await options.tasks.returnTaskToTodo({
    task,
    reason: 'change_requested',
    commentBody: changeRequestComment(target, task),
  }, context);
  await options.tasks.recordTaskStatus?.({ task, result: `change_requested:${update.status}` }, context);
  return {
    handled: true,
    reason: 'change-requested pull request returned to Todo',
    pullRequestNumber: target.number,
    branchName: target.branchName,
    taskId: task.id,
    projectItemId: update.projectItemId,
    status: update.status,
  };
}

export async function handleCodexReviewEvent(
  event: RainrailEventEnvelope,
  options: CodexReviewWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'Codex review handling is disabled' };
  const review = codexReviewTargetFromEvent(event, options);
  if (review === undefined) return { handled: false, reason: 'event is not a Codex review' };
  if (normalize(review.pullRequestState) === 'closed') {
    return { handled: false, reason: 'pull request is already closed', review };
  }
  const task = await options.tasks.getAgentTaskByBranchName(review.branchName);
  if (task === undefined) return { handled: false, reason: 'no agent task matched the PR branch', review };
  const repositorySkip = repositoryMismatchReason(task, review.repository);
  if (repositorySkip !== undefined) return { handled: false, reason: repositorySkip, review, taskId: task.id };
  const skip = shouldIgnoreTask(task);
  if (skip !== undefined) return { handled: false, reason: skip, review, taskId: task.id };
  const inlineComments = await safeReviewInlineComments(options.pullRequests, review, context);
  const update = await options.tasks.returnTaskToTodo({
    task,
    reason: 'codex_review',
    commentBody: codexReviewComment({ task, review, inlineComments }),
  }, context);
  await options.tasks.recordTaskStatus?.({ task, result: `codex_review:${update.status}` }, context);
  return {
    handled: true,
    reason: 'Codex review returned issue to Todo',
    review,
    taskId: task.id,
    projectItemId: update.projectItemId,
    status: update.status,
    issueCommentUrl: update.commentUrl,
  };
}

export async function handleCheckFailureEvent(
  event: RainrailEventEnvelope,
  options: CheckFailureWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'review requests are disabled' };
  const check = failedCheckCandidateFromEvent(event);
  if (check === undefined) return { handled: false, reason: 'event is not a completed failed check for a pull request' };

  const pullRequests = requirePullRequests(options.pullRequests);
  const candidates = await resolvePullRequestCandidates(check, pullRequests, context);
  if (candidates.length === 0) return { handled: false, reason: 'pull request was not found', check };
  let fallback: WorkflowResult = { handled: false, reason: 'pull request was not found', check };
  for (const pullRequest of candidates) {
    if (check.headSha !== undefined && pullRequest.headSha !== undefined && check.headSha !== pullRequest.headSha) {
      fallback = { handled: false, reason: 'check does not match the current pull request head', check, pullRequest };
      continue;
    }
    if (!isReviewTarget(options, pullRequest)) {
      fallback = { handled: false, reason: 'pull request is not an agent-authored target', check, pullRequest };
      continue;
    }
    if (normalize(pullRequest.state) !== 'open') {
      fallback = { handled: false, reason: 'pull request is not open', check, pullRequest };
      continue;
    }
    if (!hasCurrentCheckFailure(pullRequest)) {
      fallback = { handled: false, reason: 'current pull request checks have passed', check, pullRequest };
      continue;
    }
    const task = await options.tasks.getAgentTaskByBranchName(pullRequest.headRefName);
    if (task === undefined) {
      fallback = { handled: false, reason: 'no agent task matched the PR branch', check, pullRequest };
      continue;
    }
    const repositorySkip = repositoryMismatchReason(task, pullRequest.repository);
    if (repositorySkip !== undefined) {
      fallback = { handled: false, reason: repositorySkip, check, pullRequest, taskId: task.id };
      continue;
    }
    const skip = shouldIgnoreTask(task);
    if (skip !== undefined) {
      fallback = { handled: false, reason: skip, check, pullRequest, taskId: task.id };
      continue;
    }

    const update = await options.tasks.returnTaskToTodo({
      task,
      reason: 'checks_failed',
      commentBody: checkFailureComment({ task, pullRequest, check }),
    }, context);
    await options.tasks.recordTaskStatus?.({ task, result: `checks_failed:${update.status}` }, context);
    const reviewRequestRemoved = await removePendingReviewRequest(pullRequests, pullRequest, options.reviewRequest, context);
    return {
      handled: true,
      reason: 'failed PR checks returned issue to Todo',
      check,
      pullRequest,
      taskId: task.id,
      projectItemId: update.projectItemId,
      status: update.status,
      commentUrl: update.commentUrl,
      ...(reviewRequestRemoved ? { reviewRequestRemoved } : {}),
    };
  }
  return fallback;
}

export async function handleConflictCheckEvent(
  event: RainrailEventEnvelope,
  options: ConflictCheckWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'project issue selection is not configured' };
  const target = pushTargetFromEvent(event);
  if (target === undefined) return { handled: false, reason: 'event is not a branch push' };
  const delayMs = options.delayMs ?? 30_000;
  if (delayMs > 0) await (options.sleep ?? sleep)(delayMs);

  const pullRequests = requirePullRequests(options.pullRequests);
  if (pullRequests.findOpenPullRequestsByBase === undefined) {
    throw new Error('Pull request service cannot list pull requests by base branch');
  }
  const candidates = await pullRequests.findOpenPullRequestsByBase(target, taskContext(context));
  const conflictedCandidates = candidates.filter(isConflicted);
  const manageableCandidates = [];
  for (const pullRequest of candidates) {
    if (!sameRepositoryHead(pullRequest)) continue;
    const task = await options.tasks.getAgentTaskByBranchName(pullRequest.headRefName);
    if (
      task === undefined
      || repositoryMismatchReason(task, pullRequest.repository) !== undefined
      || shouldIgnoreTask(task) !== undefined
    ) continue;
    manageableCandidates.push({ pullRequest, task });
  }
  const pending = manageableCandidates.filter(({ pullRequest }) => isMergeabilityPending(pullRequest));
  if (pending.length > 0) {
    throw new Error(`pull request mergeability is still being calculated for ${pending.length} open PR(s)`);
  }
  if (conflictedCandidates.length === 0) {
    return {
      handled: false,
      reason: 'no conflicting pull requests target the pushed branch',
      baseRefName: target.baseRefName,
      checkedPullRequests: candidates.length,
    };
  }

  const updatedTasks = [];
  for (const { pullRequest, task } of manageableCandidates.filter(({ pullRequest }) => isConflicted(pullRequest))) {
    const update = await options.tasks.returnTaskToTodo({
      task,
      reason: 'conflict',
      commentBody: conflictComment({ task, pullRequest }),
    }, context);
    await options.tasks.recordTaskStatus?.({ task, result: `conflict:${update.status}` }, context);
    const reviewRequestRemoved = await removePendingReviewRequest(pullRequests, pullRequest, options.reviewRequest, context);
    updatedTasks.push({
      taskId: task.id,
      pullRequestNumber: pullRequest.number,
      projectItemId: update.projectItemId,
      status: update.status,
      ...(reviewRequestRemoved ? { reviewRequestRemoved } : {}),
    });
  }

  if (updatedTasks.length === 0) {
    return {
      handled: false,
      reason: 'conflicting pull requests had no matching claimed agent tasks',
      baseRefName: target.baseRefName,
      checkedPullRequests: candidates.length,
      updatedTasks,
    };
  }
  return {
    handled: true,
    reason: 'conflicting pull requests returned to Todo',
    baseRefName: target.baseRefName,
    checkedPullRequests: candidates.length,
    updatedTasks,
  };
}

export async function handleAutoMergeEvent(
  event: RainrailEventEnvelope,
  options: AutoMergeWorkflowOptions,
  context?: PluginRuntimeContext,
): Promise<WorkflowResult> {
  if (options.enabled === false) return { handled: false, reason: 'auto-merge is disabled' };
  const candidate = autoMergeCandidateFromEvent(event);
  if (candidate === undefined) return { handled: false, reason: 'event is not an approved review or successful check for a pull request' };
  if (candidate.reviewerLogin !== undefined && !sameLogin(candidate.reviewerLogin, options.reviewerLogin)) {
    return { handled: false, reason: 'reviewer is not the configured reviewer' };
  }
  if (!targetRepositoryAllowed(options.targetRepositories, candidate.repository)) return { handled: false, reason: 'repository is not an auto-merge target' };

  const pullRequests = requirePullRequests(options.pullRequests);
  const candidates = await resolvePullRequestCandidates(candidate, pullRequests, context);
  if (candidates.length === 0) return { handled: false, reason: 'pull request was not found', candidate };
  let fallback: WorkflowResult = { handled: false, reason: 'pull request was not found', candidate };
  let sawPendingMergeability = false;
  for (const pullRequest of candidates) {
    if (candidate.headSha !== undefined && pullRequest.headSha !== undefined && candidate.headSha !== pullRequest.headSha) {
      fallback = { handled: false, reason: 'check does not match the current pull request head', candidate, pullRequest };
      continue;
    }
    if (!targetRepositoryAllowed(options.targetRepositories, pullRequest.repository)) {
      fallback = { handled: false, reason: 'live pull request repository is not an auto-merge target', pullRequest };
      continue;
    }
    if (!isReviewTarget(options, pullRequest)) {
      fallback = { handled: false, reason: 'pull request is not an agent-authored target', pullRequest };
      continue;
    }
    if (!reviewApproved(options, pullRequest)) {
      fallback = { handled: false, reason: 'configured reviewer approval is not confirmed', pullRequest };
      continue;
    }
    if (hasUnresolvedChangeRequest(pullRequest)) {
      fallback = { handled: false, reason: 'pull request has unresolved change requests', pullRequest };
      continue;
    }
    if (!hasPassingCheckRollup(pullRequest)) {
      fallback = { handled: false, reason: 'not all checks have passed', pullRequest };
      continue;
    }
    if (pullRequest.isDraft) {
      fallback = { handled: false, reason: 'pull request is draft', pullRequest };
      continue;
    }
    if (normalize(pullRequest.state) !== 'open') {
      fallback = { handled: false, reason: 'pull request is not open', pullRequest };
      continue;
    }
    if (isMergeabilityPending(pullRequest)) {
      fallback = { handled: false, reason: 'pull request mergeability is still being calculated', pullRequest };
      sawPendingMergeability = true;
      continue;
    }
    if (!isAutoMergeable(pullRequest)) {
      fallback = { handled: false, reason: 'pull request is not mergeable', pullRequest };
      continue;
    }

    const mergeInput = {
      repository: pullRequest.repository,
      number: pullRequest.number,
      mergeMethod: options.mergeMethod,
      ...optionalString('sha', pullRequest.headSha),
    };
    if (context === undefined) throw new Error('Auto-merge requires a gated runtime merge action');
    await context.actions.mergePullRequest({
      pullRequestId: `${pullRequest.repository}#${pullRequest.number}`,
      ...mergeInput,
    });
    return { handled: true, reason: 'pull_request_merged', pullRequest };
  }
  if (sawPendingMergeability) {
    throw new Error('pull request mergeability is still being calculated');
  }
  return fallback;
}

export function allChecksPassed(pullRequest: PullRequestReviewTarget): boolean {
  if (pullRequest.statusCheckRollup.length === 0) return true;
  return pullRequest.statusCheckRollup.every(isPassingCheck);
}

function hasPassingCheckRollup(pullRequest: PullRequestReviewTarget): boolean {
  return pullRequest.statusCheckRollup.length > 0 && allChecksPassed(pullRequest);
}

function pullRequestsFromContext(context: PluginRuntimeContext): GitHubPullRequestProvider | undefined {
  const provider = context.providers.githubPullRequests;
  return isPullRequestProvider(provider) ? provider : undefined;
}

function isPullRequestProvider(value: unknown): value is GitHubPullRequestProvider {
  return typeof value === 'object' && value !== null
    && 'getPullRequest' in value
    && 'findPullRequestByHead' in value
    && 'requestReview' in value;
}

function requirePullRequests(provider: GitHubPullRequestProvider | undefined): GitHubPullRequestProvider {
  if (provider === undefined) throw new Error('PR lifecycle workflow requires providers.githubPullRequests or pullRequests option');
  return provider;
}

async function resolvePullRequestCandidates(
  candidate: PullRequestCandidate,
  pullRequests: GitHubPullRequestProvider,
  context: PluginRuntimeContext | undefined,
): Promise<PullRequestReviewTarget[]> {
  const numbers = candidate.number === undefined
    ? [...new Set(candidate.numbers ?? [])]
    : [candidate.number];
  if (numbers.length > 0) {
    return Promise.all(numbers.map((number) =>
      pullRequests.getPullRequest({ repository: candidate.repository, number }, taskContext(context))
    ));
  }
  if (pullRequests.findPullRequestsByHead !== undefined) {
    return pullRequests.findPullRequestsByHead(candidate, taskContext(context));
  }
  const pullRequest = await pullRequests.findPullRequestByHead(candidate, taskContext(context));
  return pullRequest === undefined ? [] : [pullRequest];
}

function taskContext(context: PluginRuntimeContext | undefined): TaskProviderContext | undefined {
  return context === undefined ? undefined : { signal: context.signal };
}

function pullRequestCandidateFromEvent(event: RainrailEventEnvelope): PullRequestCandidate | undefined {
  const payload = recordValue(event.payload);
  if (event.name === 'github.check_run' && isPassingCompletedCheckRun(payload)) {
    return candidateFromPullRequests(payload, stringValue(recordValue(payload.resource).headSha));
  }
  if (event.name === 'github.status' && commitStatusState(payload) === 'success') {
    return headCandidateFromStatus(payload);
  }
  if (event.name === 'github.pull_request' && (payload.action === 'review_requested' || payload.action === 'ready_for_review')) {
    const resource = recordValue(payload.resource);
    const repository = repositoryName(payload);
    const number = numberValue(resource.number);
    if (repository === undefined || number === undefined) return undefined;
    return {
      repository,
      number,
      ...optionalString('headRefName', stringValue(resource.headRef)),
      ...optionalString('headSha', stringValue(resource.headSha)),
    };
  }
  return undefined;
}

function isPassingCompletedCheckRun(payload: Record<string, unknown>): boolean {
  const resource = recordValue(payload.resource);
  const status = normalize(payload.status ?? resource.status);
  const conclusion = normalize(payload.conclusion ?? resource.conclusion);
  return payload.action === 'completed'
    && status === 'completed'
    && ['success', 'neutral', 'skipped'].includes(conclusion);
}

function candidateFromPullRequests(payload: Record<string, unknown>, headSha: string | undefined): PullRequestCandidate | undefined {
  const repository = repositoryName(payload);
  if (repository === undefined) return undefined;
  const numbers = arrayValue(payload.pullRequests)
    .map(recordValue)
    .flatMap((candidate) => {
      const number = numberValue(candidate.number);
      return number === undefined ? [] : [number];
    });
  return {
    repository,
    ...(numbers.length === 0 ? {} : { numbers }),
    ...optionalString('headRefName', stringValue(recordValue(payload.resource).headRef)),
    ...optionalString('headSha', headSha),
  };
}

function changeRequestTargetFromEvent(event: RainrailEventEnvelope): { repository: string; number: number; branchName: string; headRepository?: string; pullRequestState?: string; reviewId?: number; reviewUrl?: string; reviewBody?: string } | undefined {
  const payload = recordValue(event.payload);
  if (event.name !== 'github.review' || payload.event !== 'pull_request_review' || payload.action !== 'submitted') return undefined;
  const review = recordValue(payload.review);
  const pullRequest = recordValue(payload.pullRequest);
  if (normalize(review.state ?? recordValue(payload.resource).state) !== 'changes_requested') return undefined;
  const repository = repositoryName(payload);
  const number = numberValue(pullRequest.number);
  const branchName = stringValue(pullRequest.headRef);
  if (repository === undefined || number === undefined || branchName === undefined) return undefined;
  return {
    repository,
    number,
    branchName,
    ...optionalString('headRepository', stringValue(pullRequest.headRepository ?? pullRequest.headRepo)),
    ...optionalString('pullRequestState', stringValue(pullRequest.state)),
    ...optionalNumber('reviewId', numberValue(review.id ?? recordValue(payload.resource).id)),
    ...optionalString('reviewUrl', stringValue(review.url ?? recordValue(payload.resource).url)),
    ...optionalString('reviewBody', stringValue(review.body ?? recordValue(payload.resource).body)),
  };
}

function codexReviewTargetFromEvent(
  event: RainrailEventEnvelope,
  options: Pick<CodexReviewWorkflowOptions, 'agentLogin' | 'reviewerLogin' | 'targetRepositories'>,
): {
  repository: string;
  pullRequestNumber: number;
  branchName: string;
  reviewId: number;
  pullRequestState?: string;
  reviewUrl?: string;
  reviewBody?: string;
} | undefined {
  const payload = recordValue(event.payload);
  if (event.name !== 'github.review' || payload.event !== 'pull_request_review' || payload.action !== 'submitted') return undefined;
  const review = recordValue(payload.review);
  const pullRequest = recordValue(payload.pullRequest);
  const resource = recordValue(payload.resource);
  const repository = repositoryName(payload);
  const pullRequestNumber = numberValue(pullRequest.number);
  const branchName = stringValue(pullRequest.headRef);
  const reviewId = numberValue(review.id ?? resource.id);
  const reviewState = normalize(review.state ?? resource.state);
  if (
    repository === undefined
    || pullRequestNumber === undefined
    || branchName === undefined
    || reviewId === undefined
    || reviewState === 'changes_requested'
    || normalize(pullRequest.headRepository) !== normalize(repository)
    || !sameLogin(stringValue(review.author), options.reviewerLogin)
    || !sameLogin(stringValue(pullRequest.author), options.agentLogin)
    || !targetRepositoryAllowed(options.targetRepositories ?? [], repository, true)
  ) {
    return undefined;
  }
  return {
    repository,
    pullRequestNumber,
    branchName,
    reviewId,
    ...optionalString('pullRequestState', stringValue(pullRequest.state)),
    ...optionalString('reviewUrl', stringValue(review.url ?? resource.url)),
    ...optionalString('reviewBody', stringValue(review.body ?? resource.body)),
  };
}

function failedCheckCandidateFromEvent(event: RainrailEventEnvelope): (PullRequestCandidate & { name?: string; conclusion: string; detailsUrl?: string }) | undefined {
  const payload = recordValue(event.payload);
  if (event.name === 'github.status') {
    const conclusion = commitStatusState(payload);
    if (!['failure', 'error'].includes(conclusion)) return undefined;
    const base = headCandidateFromStatus(payload);
    if (base === undefined) return undefined;
    const resource = recordValue(payload.resource);
    return {
      ...base,
      conclusion,
      ...optionalString('name', stringValue(resource.context ?? resource.name)),
      ...optionalString('detailsUrl', stringValue(resource.url)),
    };
  }
  if (event.name !== 'github.check_run' || payload.action !== 'completed' || payload.status !== 'completed') return undefined;
  const conclusion = normalize(payload.conclusion);
  if (conclusion.length === 0 || ['success', 'neutral', 'skipped'].includes(conclusion)) return undefined;
  const base = candidateFromPullRequests(payload, stringValue(recordValue(payload.resource).headSha));
  if (base === undefined) return undefined;
  const resource = recordValue(payload.resource);
  return {
    ...base,
    conclusion,
    ...optionalString('name', stringValue(resource.name ?? resource.context)),
    ...optionalString('detailsUrl', stringValue(resource.url)),
  };
}

function pushTargetFromEvent(event: RainrailEventEnvelope): { repository: string; baseRefName: string } | undefined {
  const payload = recordValue(event.payload);
  if (event.name !== 'github.push') return undefined;
  const resource = recordValue(payload.resource);
  const repository = repositoryName(payload);
  const ref = stringValue(resource.ref ?? payload.ref);
  if (repository === undefined || ref === undefined || !ref.startsWith('refs/heads/')) return undefined;
  return { repository, baseRefName: ref.slice('refs/heads/'.length) };
}

function autoMergeCandidateFromEvent(event: RainrailEventEnvelope): (PullRequestCandidate & { reviewerLogin?: string }) | undefined {
  const payload = recordValue(event.payload);
  if (event.name === 'github.review' && payload.event === 'pull_request_review' && payload.action === 'submitted') {
    const review = recordValue(payload.review);
    if (normalize(review.state ?? recordValue(payload.resource).state) !== 'approved') return undefined;
    const repository = repositoryName(payload);
    const number = numberValue(recordValue(payload.pullRequest).number);
    const headSha = stringValue(recordValue(payload.pullRequest).headSha);
    const reviewerLogin = stringValue(review.author);
    if (repository === undefined || number === undefined || reviewerLogin === undefined) return undefined;
    return {
      repository,
      number,
      reviewerLogin,
      ...optionalString('headSha', headSha),
    };
  }
  return pullRequestCandidateFromEvent(event);
}

async function safeReviewInlineComments(
  provider: GitHubPullRequestProvider | undefined,
  review: { repository: string; pullRequestNumber: number; reviewId: number },
  context: PluginRuntimeContext | undefined,
): Promise<{ status: 'loaded'; comments: Omit<PullRequestReviewComment, 'reviewId'>[] } | { status: 'error'; error: string }> {
  try {
    if (provider?.listReviewComments === undefined) throw new Error('pull request provider does not support review comments');
    const comments = await provider.listReviewComments({
      repository: review.repository,
      number: review.pullRequestNumber,
    }, taskContext(context));
    return {
      status: 'loaded',
      comments: comments
        .filter((comment) => comment.reviewId === review.reviewId)
        .map(({ reviewId: _reviewId, ...comment }) => comment),
    };
  } catch (error) {
    return { status: 'error', error: errorMessage(error) };
  }
}

function codexReviewComment(input: {
  task: AgentTask;
  review: { repository: string; pullRequestNumber: number; branchName: string; reviewId: number; reviewUrl?: string; reviewBody?: string };
  inlineComments: { status: 'loaded'; comments: Omit<PullRequestReviewComment, 'reviewId'>[] } | { status: 'error'; error: string };
}): string {
  const lines = [
    'Rainrail detected a Codex Cloud review on the agent PR.',
    '',
    `- PR: https://github.com/${input.review.repository}/pull/${input.review.pullRequestNumber}`,
    `- Branch: ${input.review.branchName}`,
    `- Review ID: ${input.review.reviewId}`,
  ];
  if (input.review.reviewUrl !== undefined) lines.push(`- Review: ${input.review.reviewUrl}`);
  lines.push(
    `- Agent session: ${input.task.agentSessionId}`,
    '',
    'The issue is back in Todo so the next agent pass should inspect the PR review and address its inline Codex comments.',
    'For each inline review comment, reply directly on that GitHub review discussion after handling it. Include what changed and the relevant commit hash(es), or explain why no code change was needed.',
    'Do not rely only on an issue or PR summary; each inline review discussion should get its own response.',
  );
  if (input.inlineComments.status === 'loaded') {
    lines.push('', 'Codex inline review comments:');
    if (input.inlineComments.comments.length === 0) {
      lines.push('', '- No inline comments were returned for this review ID.');
    } else {
      for (const comment of input.inlineComments.comments.slice(0, 10)) {
        lines.push('', inlineCommentSummary(comment));
      }
      const omitted = input.inlineComments.comments.length - 10;
      if (omitted > 0) {
        lines.push(
          '',
          `Only the first 10 inline comments are shown; ${omitted} more were omitted.`,
          'Fetch the full PR review before replying so no inline discussion is missed.',
        );
      }
    }
  } else {
    lines.push(
      '',
      `Codex inline review comments could not be loaded automatically: ${input.inlineComments.error}`,
      'Please fetch them directly from the PR review before making changes, then reply to each inline review discussion after handling it.',
    );
  }
  if (input.review.reviewBody !== undefined) lines.push('', 'Codex review summary:', '', truncate(input.review.reviewBody, 1200));
  lines.push('', 'Outcome: codex_review_requested');
  return lines.join('\n');
}

function changeRequestComment(target: { number: number; branchName: string; reviewId?: number; reviewUrl?: string; reviewBody?: string }, task: AgentTask): string {
  const lines = [
    'Rainrail detected that the agent PR review requested changes.',
    '',
    `- PR: ${pullRequestUrl(task, target.number)}`,
    `- Branch: ${target.branchName}`,
    `- Agent session: ${task.agentSessionId}`,
  ];
  if (target.reviewId !== undefined) lines.push(`- Review ID: ${target.reviewId}`);
  if (target.reviewUrl !== undefined) lines.push(`- Review: ${target.reviewUrl}`);
  lines.push(
    '',
    'The issue is back in Todo so the next agent pass should inspect the requested changes and address the PR review before asking for review again.',
    'For each inline review comment, reply directly on that GitHub review discussion after handling it. Include what changed and the relevant commit hash(es), or explain why no code change was needed.',
    'Do not rely only on an issue or PR summary; each inline review discussion should get its own response.',
  );
  if (target.reviewBody !== undefined && target.reviewBody.trim().length > 0) {
    lines.push('', 'Review body:', '', truncate(target.reviewBody.trim(), 1200));
  }
  lines.push('', 'Outcome: changes_requested');
  return lines.join('\n');
}

function checkFailureComment(input: {
  task: AgentTask;
  pullRequest: PullRequestReviewTarget;
  check: { name?: string; conclusion: string; detailsUrl?: string };
}): string {
  const lines = [
    'Rainrail detected that the agent PR checks failed.',
    '',
    `- PR: ${input.pullRequest.url}`,
    `- Branch: ${input.pullRequest.headRefName}`,
  ];
  if (input.check.name !== undefined) lines.push(`- Check: ${input.check.name}`);
  lines.push(`- Conclusion: ${input.check.conclusion}`);
  if (input.check.detailsUrl !== undefined) lines.push(`- Job: ${input.check.detailsUrl}`);
  lines.push(
    `- Agent session: ${input.task.agentSessionId}`,
    '',
    'The issue is back in Todo for a mechanical retry or fix.',
    '',
    'Outcome: checks_failed',
  );
  return lines.join('\n');
}

function conflictComment(input: { task: AgentTask; pullRequest: PullRequestReviewTarget }): string {
  return [
    'Rainrail detected that the agent PR has merge conflicts.',
    '',
    `- PR: ${input.pullRequest.url}`,
    `- Branch: ${input.pullRequest.headRefName}`,
    `- Agent session: ${input.task.agentSessionId}`,
    '',
    'The issue is back in Todo so the next agent pass should rebase or otherwise resolve the conflict before asking for review again.',
    '',
    'Outcome: conflict',
  ].join('\n');
}

function inlineCommentSummary(comment: Omit<PullRequestReviewComment, 'reviewId'>): string {
  const line = comment.line ?? comment.originalLine;
  const location = line === undefined
    ? comment.path
    : comment.startLine !== undefined && comment.startLine !== line
      ? `${comment.path}:${comment.startLine}-${line}`
      : `${comment.path}:${line}`;
  const lines = [`- ${location}`];
  if (comment.url !== undefined) lines.push(`  URL: ${comment.url}`);
  if (comment.commitId !== undefined) lines.push(`  Commit: ${comment.commitId}`);
  lines.push('', indent(truncate(comment.body, 1200), '  '));
  return lines.join('\n');
}

function isReviewTarget(config: { agentLogin: string; branchPrefix: string }, pullRequest: PullRequestReviewTarget): boolean {
  return sameLogin(pullRequest.authorLogin, config.agentLogin)
    && pullRequest.headRefName.startsWith(config.branchPrefix)
    && sameRepositoryHead(pullRequest);
}

function sameRepositoryHead(pullRequest: PullRequestReviewTarget): boolean {
  return normalize(pullRequest.headRepository) === normalize(pullRequest.repository);
}

function reviewApproved(config: { reviewerLogin: string }, pullRequest: PullRequestReviewTarget): boolean {
  const review = latestActionableReviewsByReviewer(pullRequest).get(normalize(config.reviewerLogin));
  if (normalize(review?.state) !== 'approved') return false;
  return review?.commitId === undefined || pullRequest.headSha === undefined || review.commitId === pullRequest.headSha;
}

function hasUnresolvedChangeRequest(pullRequest: PullRequestReviewTarget): boolean {
  if (normalize(pullRequest.reviewDecision) === 'changes_requested' && (pullRequest.reviews?.length ?? 0) === 0) return true;
  return Array.from(latestActionableReviewsByReviewer(pullRequest).values())
    .some((review) =>
      normalize(review.state) === 'changes_requested'
      && (review.commitId === undefined || pullRequest.headSha === undefined || review.commitId === pullRequest.headSha)
    );
}

function hasCurrentCheckFailure(pullRequest: PullRequestReviewTarget): boolean {
  return pullRequest.statusCheckRollup.some(isFailingCheck);
}

function isPassingCheck(check: PullRequestCheck): boolean {
  const status = normalize(check.status ?? check.state);
  const conclusion = normalize(check.conclusion);
  return (status === 'completed' || status === 'success')
    && (conclusion === '' || conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped');
}

function isFailingCheck(check: PullRequestCheck): boolean {
  const status = normalize(check.status ?? check.state);
  const conclusion = normalize(check.conclusion);
  if (status === 'completed') return !['', 'success', 'neutral', 'skipped'].includes(conclusion);
  return ['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required'].includes(status);
}

function latestActionableReviewsByReviewer(pullRequest: PullRequestReviewTarget): Map<string, PullRequestReview> {
  const latestByReviewer = new Map<string, PullRequestReview>();
  for (const review of pullRequest.reviews ?? []) {
    const reviewer = normalize(review.authorLogin);
    const state = normalize(review.state);
    const previousState = normalize(latestByReviewer.get(reviewer)?.state);
    if (state === 'commented' && ['approved', 'changes_requested'].includes(previousState)) continue;
    latestByReviewer.set(reviewer, review);
  }
  return latestByReviewer;
}

function isConflicted(pullRequest: PullRequestReviewTarget): boolean {
  return normalize(pullRequest.mergeStateStatus) === 'dirty' || normalize(pullRequest.mergeStateStatus) === 'conflicting';
}

function isMergeabilityPending(pullRequest: PullRequestReviewTarget): boolean {
  const mergeable = normalize(pullRequest.mergeable);
  return mergeable === '' || mergeable === 'unknown' || normalize(pullRequest.mergeStateStatus) === 'unknown';
}

function isAutoMergeable(pullRequest: PullRequestReviewTarget): boolean {
  if (normalize(pullRequest.mergeable) !== 'mergeable') return false;
  const mergeStateStatus = normalize(pullRequest.mergeStateStatus);
  return mergeStateStatus === '' || ['clean', 'has_hooks', 'unstable'].includes(mergeStateStatus);
}

async function removePendingReviewRequest(
  pullRequests: GitHubPullRequestProvider,
  pullRequest: PullRequestReviewTarget,
  reviewRequest: ReviewRequestRemovalOptions | undefined,
  context: PluginRuntimeContext | undefined,
): Promise<boolean> {
  if (
    reviewRequest === undefined
    || reviewRequest.enabled === false
    || pullRequests.removeReviewRequest === undefined
    || !pullRequest.reviewRequests.some((login) => sameLogin(login, reviewRequest.reviewerLogin))
  ) {
    return false;
  }
  await pullRequests.removeReviewRequest({
    repository: pullRequest.repository,
    number: pullRequest.number,
    reviewerLogin: reviewRequest.reviewerLogin,
  }, taskContext(context));
  return true;
}

function shouldIgnoreTask(task: AgentTask): string | undefined {
  if (normalize(task.issue?.state) === 'closed') return 'issue is closed';
  if (task.claim?.projectItemId === undefined) return 'agent task has no Project claim';
  return undefined;
}

function repositoryMismatchReason(task: AgentTask, repository: string): string | undefined {
  return task.issue?.repository !== undefined && normalize(task.issue.repository) !== normalize(repository)
    ? 'matched agent task belongs to another repository'
    : undefined;
}

function targetRepositoryAllowed(targets: readonly string[], repository: string, allowEmpty = false): boolean {
  return (allowEmpty && targets.length === 0) || targets.some((target) => normalize(target) === normalize(repository));
}

function repositoryName(payload: Record<string, unknown>): string | undefined {
  return stringValue(recordValue(payload.repository).fullName);
}

function eventAction(event: RainrailEventEnvelope): string | undefined {
  return stringValue(recordValue(event.payload).action);
}

function commitStatusState(payload: Record<string, unknown>): string {
  const resource = recordValue(payload.resource);
  return normalize(payload.state ?? resource.state ?? resource.status ?? resource.conclusion);
}

function headCandidateFromStatus(payload: Record<string, unknown>): { repository: string; headSha?: string } | undefined {
  const repository = repositoryName(payload);
  const resource = recordValue(payload.resource);
  if (repository === undefined) return undefined;
  return {
    repository,
    ...optionalString('headSha', stringValue(resource.headSha ?? resource.id)),
  };
}

function pullRequestUrl(task: AgentTask, number: number): string {
  return task.issue?.repository === undefined ? `PR #${number}` : `https://github.com/${task.issue.repository}/pull/${number}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sameLogin(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && normalize(left) === normalize(right);
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function optionalString<TKey extends string>(key: TKey, value: string | undefined): { [K in TKey]?: string } {
  return value === undefined ? {} : { [key]: value } as { [K in TKey]?: string };
}

function optionalNumber<TKey extends string>(key: TKey, value: number | undefined): { [K in TKey]?: number } {
  return value === undefined ? {} : { [key]: value } as { [K in TKey]?: number };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 14)}\n...[truncated]`;
}

function indent(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createTaskProviderPullRequestCommentHandoff(
  tasks: TaskProvider,
  queue?: Pick<TaskQueueProvider, 'releaseProjectIssue'>,
): Pick<AgentTaskHandoffClient, 'returnTaskToTodo'> {
  return {
    async returnTaskToTodo(input, context) {
      if (input.task.claim?.projectItemId === undefined) {
        throw new Error('agent task has no Project claim');
      }
      const issue = input.task.issue;
      const comment = input.commentBody === undefined || issue?.number === undefined || issue.repository === undefined
        ? undefined
        : await tasks.createComment({
            target: {
              provider: 'github',
              repository: issue.repository,
              number: issue.number,
            },
            body: input.commentBody,
          }, context === undefined ? undefined : { signal: context.signal });
      if (queue?.releaseProjectIssue !== undefined) {
        await queue.releaseProjectIssue({
          issue: agentTaskProjectIssue(input.task),
          claim: input.task.claim,
          agentSessionId: input.task.agentSessionId,
          branchName: input.task.branchName,
          reason: input.reason,
        });
      }
      return {
        projectItemId: input.task.claim.projectItemId,
        status: queue?.releaseProjectIssue === undefined ? 'Commented' : 'Todo',
        ...(comment?.url === undefined ? {} : { commentUrl: comment.url }),
      };
    },
  };
}

function agentTaskProjectIssue(task: AgentTask): {
  id: string;
  title: string;
  provider: 'github';
  assigneeLogins: readonly string[];
  contentId?: string;
  contentType?: string;
  repository?: string;
  number?: number;
  state?: string;
  url?: string;
  status?: string | null;
} {
  const issue = task.issue;
  return {
    id: task.claim?.projectItemId ?? `${issue?.repository ?? 'unknown'}#${issue?.number ?? 'unknown'}`,
    title: issue?.number === undefined ? task.branchName : `Issue #${issue.number}`,
    provider: 'github',
    assigneeLogins: [],
    ...(issue?.contentId === undefined ? {} : { contentId: issue.contentId }),
    ...(issue?.contentType === undefined ? {} : { contentType: issue.contentType }),
    ...(issue?.repository === undefined ? {} : { repository: issue.repository }),
    ...(issue?.number === undefined ? {} : { number: issue.number }),
    ...(issue?.state === undefined ? {} : { state: issue.state }),
    ...(issue?.url === undefined ? {} : { url: issue.url }),
    ...(task.claim?.originalStatus === undefined ? {} : { status: task.claim.originalStatus }),
  };
}
