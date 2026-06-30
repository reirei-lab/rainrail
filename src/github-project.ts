import type { GitHubAuthToken } from './github-auth.js';
import {
  getGitHubAuthToken,
  getGitHubFallbackAuthToken,
  isGitHubAuthFallbackEligibleError,
  type GitHubAuthConfig,
} from './github-auth.js';
import { recordGitHubRateLimit } from './github-rate-limit.js';
import type { ProjectIssue, ProjectIssueReference } from './project-issues.js';
import type {
  ProjectIssueClaim,
  ProjectIssueClaimInput,
  ProjectIssueFinalizeInput,
  ProjectIssueReleaseInput,
  TaskQueueProvider,
} from './task-queue.js';

const PROJECT_ISSUE_CLAIM_LOCK_TTL_MS = 15 * 60 * 1000;
const PROJECT_ISSUE_CLAIM_LOCK_DISPATCH_MARK_ATTEMPTS = 3;
const PROJECT_ISSUE_CLAIM_LOCK_COMMIT_PREFIX = 'Rainrail project issue claim lock';

export interface GitHubProjectTaskQueueConfig {
  organization: string;
  projectNumber: number;
  assigneeLogin: string;
  todoStatus: string;
  backlogStatus: string;
  inProgressStatus: string;
  statusFieldName: string;
  agentSessionIdFieldName: string;
  branchFieldName: string;
  maxConcurrentAgentTasks?: number;
}

export interface GitHubProjectTaskQueueOptions {
  config: GitHubProjectTaskQueueConfig;
  auth?: GitHubProjectAuthTokenProvider;
  githubAuth?: GitHubAuthConfig;
  fetch?: typeof fetch;
}

export interface GitHubProjectAuthTokenProvider {
  getAuthToken(): Promise<GitHubAuthToken | undefined>;
}

interface GraphqlResponse<TData = unknown> {
  data?: TData;
  errors?: Array<{ message?: string }>;
}

interface ProjectItemsData {
  organization?: {
    projectV2?: {
      items?: {
        nodes?: unknown[];
        pageInfo?: {
          hasNextPage?: unknown;
          endCursor?: unknown;
        };
      };
    };
  };
}

interface ProjectMetadata {
  projectId: string;
  statusFieldId: string;
  statusOptionId: string;
  todoStatusOptionId: string;
  backlogStatusOptionId: string;
  agentSessionIdFieldId: string;
  branchFieldId: string;
}

interface ProjectItemStatus {
  status?: string;
  agentSessionId?: string;
  branchName?: string;
  repositoryId?: string;
  repositoryNameWithOwner?: string;
  defaultBranchOid?: string;
  defaultBranchTreeOid?: string;
  assigneeLogins: readonly string[];
}

interface ProjectIssueClaimLock {
  id: string;
  startingLockRefId?: string;
  createdAt: string;
  dispatchedAt?: string;
  agentSessionId?: string;
  branchName?: string;
  projectItemId?: string;
  originalStatus?: string;
}

interface ProjectIssueClaimLockCommitContext {
  repositoryNameWithOwner?: string;
  defaultBranchOid?: string;
  defaultBranchTreeOid?: string;
}

interface ProjectMetadataData {
  organization?: {
    projectV2?: {
      id?: unknown;
      fields?: {
        nodes?: unknown[];
        pageInfo?: {
          hasNextPage?: unknown;
          endCursor?: unknown;
        };
      };
    };
  };
}

export function createGitHubProjectTaskQueueProvider(
  options: GitHubProjectTaskQueueOptions,
): TaskQueueProvider {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth ?? {
    getAuthToken: () => getDefaultGitHubAuthToken(options.githubAuth ?? {}, fetchImpl),
  };
  const selection = {
    assigneeLogin: options.config.assigneeLogin,
    todoStatus: options.config.todoStatus,
    backlogStatus: options.config.backlogStatus,
    inProgressStatus: options.config.inProgressStatus,
    ...(options.config.maxConcurrentAgentTasks === undefined
      ? {}
      : { maxConcurrentAgentTasks: options.config.maxConcurrentAgentTasks }),
  };

  return {
    name: 'github-project',
    kind: 'task-queue-provider',
    selection,
    listProjectIssues: async () => fetchProjectIssues(options.config, fetchImpl, auth),
    claimProjectIssue: async (input) => claimProjectIssue(options.config, input, fetchImpl, auth),
    finalizeProjectIssueClaim: async (input) => finalizeProjectIssueClaim(options.config, input, fetchImpl, auth),
    releaseProjectIssue: async (input) => releaseProjectIssue(options.config, input, fetchImpl, auth),
  };
}

async function fetchProjectIssues(
  config: GitHubProjectTaskQueueConfig,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssue[]> {
  const issues: ProjectIssue[] = [];
  let after: string | undefined;

  do {
    const payload = await runGraphql<ProjectItemsData>(fetchImpl, auth, projectIssuesQuery, {
      organization: config.organization,
      projectNumber: config.projectNumber,
      after,
      statusFieldName: config.statusFieldName,
    });
    const items = payload.organization?.projectV2?.items;
    if (items === undefined || !Array.isArray(items.nodes)) {
      throw new Error('GitHub Project items response is missing project items');
    }
    const pageIssues = items.nodes.flatMap((item) => mapProjectIssueItem(item, config));
    for (const issue of pageIssues) {
      issues.push(await reconcileProjectIssueClaimState(config, issue, fetchImpl, auth));
    }
    after = items?.pageInfo?.hasNextPage === true && typeof items.pageInfo.endCursor === 'string'
      ? items.pageInfo.endCursor
      : undefined;
  } while (after !== undefined);

  return issues;
}

async function reconcileProjectIssueClaimState(
  config: GitHubProjectTaskQueueConfig,
  issue: ProjectIssue,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssue> {
  const normalizedStatus = normalizeToken(issue.status ?? '');
  if (
    normalizedStatus === normalizeToken(config.todoStatus)
    || normalizedStatus === normalizeToken(config.backlogStatus)
  ) {
    const lock = await loadProjectIssueClaimLockForIssue(issue, fetchImpl, auth);
    if (lock?.dispatchedAt !== undefined && lock.projectItemId === issue.id) {
      const current = await loadProjectItemStatus(issue.id, fetchImpl, auth, config);
      if (isFinalizedProjectIssueClaim(current, lock, issue)) {
        await deleteProjectIssueClaimLocks(dispatchedLockClaim(issue, lock), fetchImpl, auth).catch(() => undefined);
        return issue;
      }
      return restoreDispatchedProjectIssueClaim(config, issue, lock, fetchImpl, auth);
    }
    if (lock !== undefined && lock.projectItemId === issue.id && !isRecoverableStaleLock(lock, { issue })) {
      return { ...issue, status: config.inProgressStatus };
    }
    return issue;
  }
  if (normalizedStatus !== normalizeToken(config.inProgressStatus)) {
    await cleanupDispatchedProjectIssueLocksForIssue(config, issue, fetchImpl, auth);
    return issue;
  }
  const current = await loadProjectItemStatus(issue.id, fetchImpl, auth, config);
  if (
    normalizeToken(current.status ?? '') !== normalizeToken(config.inProgressStatus)
    || current.repositoryId === undefined
  ) {
    return issue;
  }
  const hasAgentSessionId = hasText(current.agentSessionId);
  const hasBranchName = hasText(current.branchName);
  if (hasAgentSessionId && hasBranchName) {
    await cleanupDispatchedProjectIssueLocks(config, issue, current.repositoryId, fetchImpl, auth);
    return issue;
  }
  const lock = await loadProjectIssueClaimLockPair(current.repositoryId, issue, fetchImpl, auth);
  if (lock?.dispatchedAt !== undefined && lock.projectItemId === issue.id) {
    return restoreDispatchedProjectIssueClaim(config, issue, lock, fetchImpl, auth);
  }
  if (hasAgentSessionId || hasBranchName) {
    return issue;
  }
  if (lock === undefined || !isRecoverableStaleLock(lock, { issue })) {
    return issue;
  }
  const releaseStatus = recoverableOriginalStatus(lock.originalStatus, config);
  if (releaseStatus === undefined) {
    return issue;
  }
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
  const releaseStatusOptionId = normalizeToken(releaseStatus) === normalizeToken(config.backlogStatus)
    ? metadata.backlogStatusOptionId
    : metadata.todoStatusOptionId;
  await updateProjectField(fetchImpl, auth, metadata.projectId, issue.id, metadata.statusFieldId, {
    singleSelectOptionId: releaseStatusOptionId,
  });
  await deleteProjectIssueClaimLock({ projectItemId: issue.id, lockRefId: lock.id }, fetchImpl, auth);
  return { ...issue, status: releaseStatus };
}

async function restoreDispatchedProjectIssueClaim(
  config: GitHubProjectTaskQueueConfig,
  issue: ProjectIssue,
  lock: ProjectIssueClaimLock,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssue> {
  if (lock.agentSessionId === undefined || lock.branchName === undefined) {
    return { ...issue, status: config.inProgressStatus };
  }
  try {
    const metadata = await loadProjectMetadata(config, fetchImpl, auth);
    if (normalizeToken(issue.status ?? '') !== normalizeToken(config.inProgressStatus)) {
      await updateProjectField(fetchImpl, auth, metadata.projectId, issue.id, metadata.statusFieldId, {
        singleSelectOptionId: metadata.statusOptionId,
      });
    }
    await updateProjectField(fetchImpl, auth, metadata.projectId, issue.id, metadata.agentSessionIdFieldId, {
      text: lock.agentSessionId,
    });
    await updateProjectField(fetchImpl, auth, metadata.projectId, issue.id, metadata.branchFieldId, {
      text: lock.branchName,
    });
    await deleteProjectIssueClaimLocks(dispatchedLockClaim(issue, lock), fetchImpl, auth)
      .catch(() => undefined);
  } catch {
    return { ...issue, status: config.inProgressStatus };
  }
  return { ...issue, status: config.inProgressStatus };
}

async function cleanupDispatchedProjectIssueLocks(
  config: GitHubProjectTaskQueueConfig,
  issue: ProjectIssue,
  repositoryId: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  const lock = await loadProjectIssueClaimLock(repositoryId, projectIssueLockRefName(issue), fetchImpl, auth).catch(() => undefined);
  const dispatchedLock = await loadProjectIssueClaimLock(repositoryId, projectIssueDispatchedLockRefName(issue), fetchImpl, auth).catch(() => undefined);
  if (dispatchedLock?.dispatchedAt !== undefined && dispatchedLock.projectItemId === issue.id) {
    const current = await loadProjectItemStatus(issue.id, fetchImpl, auth, config);
    if (!isFinalizedProjectIssueClaim(current, dispatchedLock, issue)) {
      return;
    }
    await deleteProjectIssueClaimLocks({
      projectItemId: issue.id,
      lockRefId: lock?.id ?? dispatchedLock.id,
      ...(lock === undefined ? {} : { dispatchedLockRefId: dispatchedLock.id }),
    }, fetchImpl, auth).catch(() => undefined);
    return;
  }
  if (lock?.dispatchedAt !== undefined && lock.projectItemId === issue.id) {
    const current = await loadProjectItemStatus(issue.id, fetchImpl, auth, config);
    if (!isFinalizedProjectIssueClaim(current, lock, issue)) {
      return;
    }
    await deleteProjectIssueClaimLocks(dispatchedLockClaim(issue, lock), fetchImpl, auth).catch(() => undefined);
  }
}

async function cleanupDispatchedProjectIssueLocksForIssue(
  config: GitHubProjectTaskQueueConfig,
  issue: ProjectIssue,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  const lock = await loadProjectIssueClaimLockForIssue(issue, fetchImpl, auth);
  if (lock?.dispatchedAt === undefined || lock.projectItemId !== issue.id) {
    return;
  }
  const current = await loadProjectItemStatus(issue.id, fetchImpl, auth, config);
  if (!isFinalizedProjectIssueClaim(current, lock, issue)) {
    return;
  }
  await deleteProjectIssueClaimLocks(dispatchedLockClaim(issue, lock), fetchImpl, auth).catch(() => undefined);
}

async function claimProjectIssue(
  config: GitHubProjectTaskQueueConfig,
  input: ProjectIssueClaimInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaim> {
  if (input.issue.contentId === undefined) {
    throw new Error('GitHub Project issue claim requires a content id');
  }

  const before = await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config);
  assertClaimable(before, input, config);
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
  let claim: ProjectIssueClaim | undefined;
  try {
    const lockRefId = await acquireProjectIssueClaimLock(before, input, config, fetchImpl, auth);
    claim = {
      projectId: metadata.projectId,
      projectItemId: input.issue.id,
      statusFieldId: metadata.statusFieldId,
      statusOptionId: metadata.statusOptionId,
      agentSessionIdFieldId: metadata.agentSessionIdFieldId,
      branchFieldId: metadata.branchFieldId,
      contentId: input.issue.contentId,
      commentBody: input.commentBody,
      lockRefId,
      ...(before.repositoryId === undefined ? {} : { lockRepositoryId: before.repositoryId }),
      ...(before.repositoryNameWithOwner === undefined ? {} : { lockRepositoryNameWithOwner: before.repositoryNameWithOwner }),
      ...(before.defaultBranchOid === undefined ? {} : { lockDefaultBranchOid: before.defaultBranchOid }),
      ...(before.defaultBranchTreeOid === undefined ? {} : { lockDefaultBranchTreeOid: before.defaultBranchTreeOid }),
      ...(input.issue.status === undefined ? {} : { originalStatus: input.issue.status }),
    };
    assertClaimable(await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config), input, config);
  } catch (error) {
    if (claim !== undefined) {
      await deleteProjectIssueClaimLock(claim, fetchImpl, auth);
    }
    throw error;
  }

  return claim;
}

async function finalizeProjectIssueClaim(
  config: GitHubProjectTaskQueueConfig,
  input: ProjectIssueFinalizeInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  await markProjectIssueClaimDispatched(input, fetchImpl, auth);
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
  const before = await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config);
  assertClaimable(before, {
    issue: input.issue,
    agentSessionId: input.agentSessionId,
    branchName: input.branchName,
    commentBody: input.claim.commentBody ?? '',
  }, config);
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.statusFieldId, {
    singleSelectOptionId: metadata.statusOptionId,
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.agentSessionIdFieldId, {
    text: input.agentSessionId,
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.branchFieldId, {
    text: input.branchName,
  });
  const after = await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config);
  assertClaimMatches(after, {
    issue: input.issue,
    agentSessionId: input.agentSessionId,
    branchName: input.branchName,
    commentBody: input.claim.commentBody ?? '',
  }, config);
  try {
    if (input.claim.contentId !== undefined && input.claim.commentBody !== undefined) {
      await runGraphql<{ addComment?: { commentEdge?: { node?: { url?: unknown } } } }>(
        fetchImpl,
        auth,
        addCommentMutation,
        { subjectId: input.claim.contentId, body: input.claim.commentBody },
      ).catch(() => undefined);
    }
  } finally {
    await deleteProjectIssueClaimLocks(input.claim, fetchImpl, auth);
  }
}

async function releaseProjectIssue(
  config: GitHubProjectTaskQueueConfig,
  input: ProjectIssueReleaseInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  const current = await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config);
  if (!shouldReleaseCurrentClaim(current, input, config)) {
    await deleteProjectIssueClaimLocksIfOwned(current.repositoryId, input, fetchImpl, auth);
    return;
  }
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
  const releaseStatusOptionId = normalizeToken(input.issue.status ?? config.todoStatus) === normalizeToken(config.backlogStatus)
    ? metadata.backlogStatusOptionId
    : metadata.todoStatusOptionId;
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.agentSessionIdFieldId, {
    text: '',
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.branchFieldId, {
    text: '',
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.statusFieldId, {
    singleSelectOptionId: releaseStatusOptionId,
  });
  await deleteProjectIssueClaimLocks(input.claim, fetchImpl, auth);
}

async function acquireProjectIssueClaimLock(
  status: ProjectItemStatus,
  input: ProjectIssueClaimInput,
  config: GitHubProjectTaskQueueConfig,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<string> {
  if (status.repositoryId === undefined || status.defaultBranchOid === undefined) {
    throw new Error('GitHub Project issue claim requires repository lock metadata');
  }
  const name = projectIssueLockRefName(input.issue);
  await assertNoDispatchedClaimMarker(status.repositoryId, input.issue, fetchImpl, auth);
  const lockOid = await createProjectIssueClaimLockCommit(status, input, fetchImpl, auth);
  try {
    return await createProjectIssueClaimLock(status.repositoryId, name, lockOid, fetchImpl, auth);
  } catch (error) {
    if (!isReferenceAlreadyExistsError(error)) {
      throw error;
    }
    const existingLock = await loadProjectIssueClaimLock(status.repositoryId, name, fetchImpl, auth).catch(() => undefined);
    const dispatchedLock = await loadProjectIssueClaimLockIfExists(
      status.repositoryId,
      projectIssueDispatchedLockRefName(input.issue),
      fetchImpl,
      auth,
    );
    if (dispatchedLock?.dispatchedAt !== undefined && dispatchedLock.projectItemId === input.issue.id) {
      throw error;
    }
    if (existingLock === undefined || !isRecoverableStaleLock(existingLock, input)) {
      throw error;
    }
    assertClaimable(await loadProjectItemStatus(input.issue.id, fetchImpl, auth, config), input, config);
    const currentLock = await loadProjectIssueClaimLockIfExists(status.repositoryId, name, fetchImpl, auth);
    if (
      currentLock === undefined
      || !isSameProjectIssueClaimLock(existingLock, currentLock)
      || !isRecoverableStaleLock(currentLock, input)
    ) {
      throw error;
    }
    await deleteProjectIssueClaimLock({ projectItemId: input.issue.id, lockRefId: existingLock.id }, fetchImpl, auth);
    const retryLockOid = await createProjectIssueClaimLockCommit(status, input, fetchImpl, auth);
    return createProjectIssueClaimLock(status.repositoryId, name, retryLockOid, fetchImpl, auth);
  }
}

async function assertNoDispatchedClaimMarker(
  repositoryId: string,
  issue: ProjectIssue,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  const dispatchedLock = await loadProjectIssueClaimLockIfExists(
    repositoryId,
    projectIssueDispatchedLockRefName(issue),
    fetchImpl,
    auth,
  );
  if (dispatchedLock?.dispatchedAt !== undefined && dispatchedLock.projectItemId === issue.id) {
    throw new Error('GitHub Project issue already has a dispatched claim marker');
  }
}

async function markProjectIssueClaimDispatched(
  input: ProjectIssueFinalizeInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  if (input.claim.lockRefId === undefined) {
    return;
  }
  if (
    input.claim.lockRepositoryId === undefined
    || input.claim.lockRepositoryNameWithOwner === undefined
    || input.claim.lockDefaultBranchOid === undefined
    || input.claim.lockDefaultBranchTreeOid === undefined
  ) {
    throw new Error('GitHub Project issue claim is missing lock commit metadata');
  }
  const context = {
    repositoryNameWithOwner: input.claim.lockRepositoryNameWithOwner,
    defaultBranchOid: input.claim.lockDefaultBranchOid,
    defaultBranchTreeOid: input.claim.lockDefaultBranchTreeOid,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < PROJECT_ISSUE_CLAIM_LOCK_DISPATCH_MARK_ATTEMPTS; attempt += 1) {
    try {
      const lockOid = await createProjectIssueClaimLockCommit(context, {
        issue: input.issue,
        agentSessionId: input.agentSessionId,
        branchName: input.branchName,
        commentBody: input.claim.commentBody ?? '',
      }, fetchImpl, auth, { dispatchedAt: new Date().toISOString() });
      await updateProjectIssueClaimLock(input.claim.lockRefId, lockOid, fetchImpl, auth);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const lockOid = await createProjectIssueClaimLockCommit(context, {
      issue: input.issue,
      agentSessionId: input.agentSessionId,
      branchName: input.branchName,
      commentBody: input.claim.commentBody ?? '',
    }, fetchImpl, auth, { dispatchedAt: new Date().toISOString() });
    input.claim.dispatchedLockRefId = await createProjectIssueClaimLock(
      input.claim.lockRepositoryId,
      projectIssueDispatchedLockRefName(input.issue),
      lockOid,
      fetchImpl,
      auth,
    );
    return;
  } catch {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

async function createProjectIssueClaimLockCommit(
  status: ProjectIssueClaimLockCommitContext,
  input: ProjectIssueClaimInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
  options: { dispatchedAt?: string } = {},
): Promise<string> {
  if (
    status.repositoryNameWithOwner === undefined
    || status.defaultBranchOid === undefined
    || status.defaultBranchTreeOid === undefined
  ) {
    throw new Error('GitHub Project issue claim requires repository commit metadata');
  }
  const [owner, repo] = splitRepositoryNameWithOwner(status.repositoryNameWithOwner);
  const createdAt = new Date().toISOString();
  const payload = await runGitHubRest<{ sha?: unknown }>(
    fetchImpl,
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      message: claimLockCommitMessage({
        createdAt,
        agentSessionId: input.agentSessionId,
        branchName: input.branchName,
        projectItemId: input.issue.id,
        originalStatus: input.issue.status ?? '',
        ...(options.dispatchedAt === undefined ? {} : { dispatchedAt: options.dispatchedAt }),
      }),
      tree: status.defaultBranchTreeOid,
      parents: [status.defaultBranchOid],
    },
  );
  if (typeof payload.sha !== 'string') {
    throw new Error('GitHub Project issue claim lock commit response is missing sha');
  }
  return payload.sha;
}

async function createProjectIssueClaimLock(
  repositoryId: string,
  name: string,
  oid: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<string> {
  const payload = await runGraphql<{ createRef?: { ref?: { id?: unknown } } }>(
    fetchImpl,
    auth,
    createProjectIssueClaimLockMutation,
    {
      repositoryId,
      name,
      oid,
    },
  );
  const refId = payload.createRef?.ref?.id;
  if (typeof refId !== 'string') {
    throw new Error('GitHub Project issue claim lock response is missing ref id');
  }
  return refId;
}

async function updateProjectIssueClaimLock(
  refId: string,
  oid: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  await runGraphql(fetchImpl, auth, updateProjectIssueClaimLockMutation, {
    refId,
    oid,
  });
}

async function loadProjectIssueClaimLock(
  repositoryId: string,
  name: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaimLock> {
  const payload = await runGraphql<{ node?: unknown }>(
    fetchImpl,
    auth,
    projectIssueClaimLockQuery,
    {
      repositoryId,
      qualifiedName: qualifiedRefName(name),
    },
  );
  return parseProjectIssueClaimLockRef(isRecord(payload.node) ? payload.node.ref : undefined);
}

async function loadProjectIssueClaimLockIfExists(
  repositoryId: string,
  name: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaimLock | undefined> {
  try {
    return await loadProjectIssueClaimLock(repositoryId, name, fetchImpl, auth);
  } catch (error) {
    if (error instanceof Error && error.message.includes('missing existing ref')) {
      return undefined;
    }
    throw error;
  }
}

async function loadProjectIssueClaimLockPair(
  repositoryId: string,
  issue: ProjectIssue,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaimLock | undefined> {
  const lock = await loadProjectIssueClaimLock(repositoryId, projectIssueLockRefName(issue), fetchImpl, auth)
    .catch(() => undefined);
  if (lock?.dispatchedAt !== undefined) {
    return lock;
  }
  const dispatchedLock = await loadProjectIssueClaimLock(repositoryId, projectIssueDispatchedLockRefName(issue), fetchImpl, auth)
    .catch(() => undefined);
  if (dispatchedLock?.dispatchedAt !== undefined && dispatchedLock.projectItemId === issue.id) {
    return { ...dispatchedLock, ...(lock === undefined ? {} : { startingLockRefId: lock.id }) };
  }
  return lock;
}

async function loadProjectIssueClaimLockForIssue(
  issue: ProjectIssue,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaimLock | undefined> {
  if (issue.repository === undefined) {
    return undefined;
  }
  let owner: string;
  let repo: string;
  try {
    [owner, repo] = splitRepositoryNameWithOwner(issue.repository);
  } catch {
    return undefined;
  }
  const lock = await loadProjectIssueClaimLockByRepositoryName(owner, repo, projectIssueLockRefName(issue), fetchImpl, auth)
    .catch(() => undefined);
  if (lock?.dispatchedAt !== undefined) {
    return lock;
  }
  const dispatchedLock = await loadProjectIssueClaimLockByRepositoryName(owner, repo, projectIssueDispatchedLockRefName(issue), fetchImpl, auth)
    .catch(() => undefined);
  if (dispatchedLock?.dispatchedAt !== undefined && dispatchedLock.projectItemId === issue.id) {
    return { ...dispatchedLock, ...(lock === undefined ? {} : { startingLockRefId: lock.id }) };
  }
  return lock;
}

async function loadProjectIssueClaimLockByRepositoryName(
  owner: string,
  repo: string,
  name: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectIssueClaimLock> {
  const payload = await runGraphql<{ repository?: unknown }>(
    fetchImpl,
    auth,
    projectIssueClaimLockByRepositoryQuery,
    {
      owner,
      repo,
      qualifiedName: qualifiedRefName(name),
    },
  );
  return parseProjectIssueClaimLockRef(isRecord(payload.repository) ? payload.repository.ref : undefined);
}

function parseProjectIssueClaimLockRef(refValue: unknown): ProjectIssueClaimLock {
  const ref = isRecord(refValue) ? refValue : undefined;
  const target = isRecord(ref?.target) ? ref.target : undefined;
  if (!isRecord(ref) || typeof ref.id !== 'string' || !isRecord(target)) {
    throw new Error('GitHub Project issue claim lock response is missing existing ref');
  }
  const message = typeof target.message === 'string' ? target.message : '';
  const metadata = parseClaimLockCommitMessage(message);
  const createdAt = typeof target.committedDate === 'string' ? target.committedDate : metadata?.createdAt;
  if (metadata === undefined || createdAt === undefined) {
    throw new Error('GitHub Project issue claim lock is missing Rainrail metadata');
  }
  return {
    id: ref.id,
    createdAt,
    ...(metadata.dispatchedAt === undefined ? {} : { dispatchedAt: metadata.dispatchedAt }),
    ...(metadata.agentSessionId === undefined ? {} : { agentSessionId: metadata.agentSessionId }),
    ...(metadata.branchName === undefined ? {} : { branchName: metadata.branchName }),
    ...(metadata.projectItemId === undefined ? {} : { projectItemId: metadata.projectItemId }),
    ...(metadata.originalStatus === undefined ? {} : { originalStatus: metadata.originalStatus }),
  };
}

async function deleteProjectIssueClaimLock(
  claim: ProjectIssueClaim,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  if (claim.lockRefId === undefined) {
    return;
  }
  await runGraphql(fetchImpl, auth, deleteProjectIssueClaimLockMutation, {
    refId: claim.lockRefId,
  });
}

async function deleteProjectIssueClaimLocks(
  claim: ProjectIssueClaim,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  await deleteProjectIssueClaimLock(claim, fetchImpl, auth);
  if (claim.dispatchedLockRefId !== undefined) {
    await deleteProjectIssueClaimLock({ ...claim, lockRefId: claim.dispatchedLockRefId }, fetchImpl, auth);
  }
}

async function deleteProjectIssueClaimLocksIfOwned(
  repositoryId: string | undefined,
  input: ProjectIssueReleaseInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  if (repositoryId === undefined || input.claim.lockRefId === undefined) {
    return;
  }
  const lock = await loadProjectIssueClaimLockIfExists(repositoryId, projectIssueLockRefName(input.issue), fetchImpl, auth)
    .catch(() => undefined);
  if (
    lock?.projectItemId !== input.issue.id
    || lock.agentSessionId !== input.agentSessionId
    || lock.branchName !== input.branchName
  ) {
    return;
  }
  let dispatchedLockRefId: string | undefined;
  if (input.claim.dispatchedLockRefId !== undefined) {
    const dispatchedLock = await loadProjectIssueClaimLockIfExists(
      repositoryId,
      projectIssueDispatchedLockRefName(input.issue),
      fetchImpl,
      auth,
    ).catch(() => undefined);
    if (
      dispatchedLock?.projectItemId === input.issue.id
      && dispatchedLock.agentSessionId === input.agentSessionId
      && dispatchedLock.branchName === input.branchName
    ) {
      dispatchedLockRefId = dispatchedLock.id;
    }
  }
  await deleteProjectIssueClaimLocks({
    ...input.claim,
    lockRefId: lock.id,
    ...(dispatchedLockRefId === undefined ? {} : { dispatchedLockRefId }),
  }, fetchImpl, auth);
}

function dispatchedLockClaim(issue: ProjectIssue, lock: ProjectIssueClaimLock): ProjectIssueClaim {
  if (lock.startingLockRefId !== undefined) {
    return {
      projectItemId: issue.id,
      lockRefId: lock.startingLockRefId,
      dispatchedLockRefId: lock.id,
    };
  }
  return {
    projectItemId: issue.id,
    lockRefId: lock.id,
  };
}

async function loadProjectMetadata(
  config: GitHubProjectTaskQueueConfig,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<ProjectMetadata> {
  const fields: unknown[] = [];
  let projectId: string | undefined;
  let fieldsAfter: string | undefined;

  do {
    const payload = await runGraphql<ProjectMetadataData>(fetchImpl, auth, projectMetadataQuery, {
      organization: config.organization,
      projectNumber: config.projectNumber,
      fieldsAfter,
    });
    const project = payload.organization?.projectV2;
    if (typeof project?.id !== 'string') {
      throw new Error('GitHub Project metadata response is missing project id');
    }
    projectId = project.id;
    fields.push(...(project.fields?.nodes ?? []));
    fieldsAfter = project.fields?.pageInfo?.hasNextPage === true
      && typeof project.fields.pageInfo.endCursor === 'string'
      ? project.fields.pageInfo.endCursor
      : undefined;
  } while (fieldsAfter !== undefined);

  const statusField = fields.find((field) => fieldName(field) === config.statusFieldName);
  const agentSessionIdField = fields.find((field) => fieldName(field) === config.agentSessionIdFieldName);
  const branchField = fields.find((field) => fieldName(field) === config.branchFieldName);
  const statusOptionId = singleSelectOptionId(statusField, config.inProgressStatus);
  const todoStatusOptionId = singleSelectOptionId(statusField, config.todoStatus);
  const backlogStatusOptionId = singleSelectOptionId(statusField, config.backlogStatus);
  const statusFieldId = fieldId(statusField, config.statusFieldName);

  return {
    projectId,
    statusFieldId,
    statusOptionId,
    todoStatusOptionId,
    backlogStatusOptionId,
    agentSessionIdFieldId: fieldId(agentSessionIdField, config.agentSessionIdFieldName),
    branchFieldId: fieldId(branchField, config.branchFieldName),
  };
}

async function loadProjectItemStatus(
  itemId: string,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
  config: GitHubProjectTaskQueueConfig,
): Promise<ProjectItemStatus> {
  const payload = await runGraphql<{ node?: unknown }>(fetchImpl, auth, projectItemStatusQuery, {
    itemId,
    statusFieldName: config.statusFieldName,
    agentSessionIdFieldName: config.agentSessionIdFieldName,
    branchFieldName: config.branchFieldName,
  });
  if (!isRecord(payload.node)) {
    throw new Error('GitHub Project item status response is missing project item');
  }
  const status = fixedAliasFieldValue(payload.node, 'status')
    ?? fieldValueByName(payload.node, config.statusFieldName);
  const agentSessionId = fixedAliasFieldValue(payload.node, 'agentSessionId')
    ?? fieldValueByName(payload.node, config.agentSessionIdFieldName);
  const branchName = fixedAliasFieldValue(payload.node, 'branch')
    ?? fieldValueByName(payload.node, config.branchFieldName);
  const repository = projectItemRepository(payload.node);
  return {
    ...(status === undefined ? {} : { status }),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(branchName === undefined ? {} : { branchName }),
    ...(repository?.id === undefined ? {} : { repositoryId: repository.id }),
    ...(repository?.nameWithOwner === undefined ? {} : { repositoryNameWithOwner: repository.nameWithOwner }),
    ...(repository?.defaultBranchOid === undefined ? {} : { defaultBranchOid: repository.defaultBranchOid }),
    ...(repository?.defaultBranchTreeOid === undefined ? {} : { defaultBranchTreeOid: repository.defaultBranchTreeOid }),
    assigneeLogins: projectItemAssigneeLogins(payload.node),
  };
}

function assertClaimable(
  status: ProjectItemStatus,
  input: ProjectIssueClaimInput,
  config: GitHubProjectTaskQueueConfig,
): void {
  const currentStatus = normalizeToken(status.status ?? '');
  const expectedStatus = normalizeToken(input.issue.status ?? config.todoStatus);
  const allowedQueueStatus = currentStatus === normalizeToken(config.todoStatus)
    || currentStatus === normalizeToken(config.backlogStatus);
  if (
    currentStatus !== expectedStatus
    || !allowedQueueStatus
    || hasText(status.agentSessionId)
    || hasText(status.branchName)
  ) {
    throw new Error('GitHub Project item is no longer claimable');
  }
  if (!isStillOwnedByAgent(status.assigneeLogins, input.issue.assigneeLogins, config.assigneeLogin)) {
    throw new Error('GitHub Project item is no longer assigned to this agent');
  }
}

function assertClaimMatches(
  status: ProjectItemStatus,
  input: ProjectIssueClaimInput,
  config: GitHubProjectTaskQueueConfig,
): void {
  if (
    normalizeToken(status.status ?? '') !== normalizeToken(config.inProgressStatus)
    || status.agentSessionId !== input.agentSessionId
    || status.branchName !== input.branchName
  ) {
    throw new Error('GitHub Project item claim was overwritten by another assignment');
  }
}

function shouldReleaseCurrentClaim(
  status: ProjectItemStatus,
  input: ProjectIssueReleaseInput,
  config: GitHubProjectTaskQueueConfig,
): boolean {
  if (normalizeToken(status.status ?? '') !== normalizeToken(config.inProgressStatus)) {
    return false;
  }
  const session = status.agentSessionId?.trim() ?? '';
  const branch = status.branchName?.trim() ?? '';
  return session === input.agentSessionId && branch === input.branchName;
}

async function updateProjectField(
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
  projectId: string,
  itemId: string,
  fieldId: string,
  value: { singleSelectOptionId: string } | { text: string },
): Promise<void> {
  await runGraphql(fetchImpl, auth, updateProjectFieldMutation, {
    projectId,
    itemId,
    fieldId,
    value,
  });
}

async function runGraphql<TData>(
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
  query: string,
  variables: Record<string, unknown>,
): Promise<TData> {
  const authToken = await auth.getAuthToken();
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(authToken === undefined ? {} : { Authorization: `Bearer ${authToken.token}` }),
    },
    body: JSON.stringify({ query, variables }),
  });
  recordGitHubRateLimit('graphql', response.headers, authToken === undefined
    ? undefined
    : { authProvider: authToken.provider, fallback: authToken.fallback });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as GraphqlResponse<TData>;
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL request failed: ${payload.errors.map((error) => error.message ?? 'unknown error').join('; ')}`);
  }
  if (payload.data === undefined) {
    throw new Error('GitHub GraphQL response is missing data');
  }
  return payload.data;
}

async function runGitHubRest<TData>(
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
  path: string,
  body: unknown,
): Promise<TData> {
  const authToken = await auth.getAuthToken();
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(authToken === undefined ? {} : { Authorization: `Bearer ${authToken.token}` }),
    },
    body: JSON.stringify(body),
  });
  recordGitHubRateLimit('rest', response.headers, authToken === undefined
    ? undefined
    : { authProvider: authToken.provider, fallback: authToken.fallback });
  if (!response.ok) {
    throw new Error(`GitHub REST request failed with HTTP ${response.status}`);
  }
  return await response.json() as TData;
}

function mapProjectIssueItem(item: unknown, config: GitHubProjectTaskQueueConfig): ProjectIssue[] {
  if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.content)) {
    return [];
  }
  const content = item.content;
  const contentType = typeof content.__typename === 'string' ? content.__typename : undefined;
  if (contentType !== 'Issue' && contentType !== 'DraftIssue') {
    return [];
  }
  const title = typeof content.title === 'string' ? content.title : undefined;
  if (title === undefined) {
    return [];
  }

  const repository = repositoryName(content);
  const subIssueCount = typeof content.subIssuesSummary === 'object' && content.subIssuesSummary !== null
    && typeof (content.subIssuesSummary as { total?: unknown }).total === 'number'
    ? (content.subIssuesSummary as { total: number }).total
    : undefined;
  const issue: ProjectIssue = {
    id: item.id,
    ...(typeof content.id === 'string' ? { contentId: content.id } : {}),
    contentType,
    title,
    assigneeLogins: assigneeLogins(content),
    ...(typeof content.state === 'string' ? { state: content.state } : {}),
    ...(typeof content.number === 'number' ? { number: content.number } : {}),
    ...(typeof content.url === 'string' ? { url: content.url } : {}),
    ...(repository === undefined ? {} : { repository }),
    ...(subIssueCount === undefined ? {} : { subIssueCount }),
  };
  const status = fieldValue(item, config.statusFieldName);
  if (status !== undefined) {
    issue.status = status;
  }
  const parent = parentReference(content);
  if (parent !== undefined) {
    issue.parent = parent;
  }
  const blockers = blockedBy(content);
  if (blockers.length > 0) {
    issue.blockedBy = blockers;
  }

  return [issue];
}

function assigneeLogins(content: Record<string, unknown>): string[] {
  const assignees = content.assignees;
  if (!isRecord(assignees) || !Array.isArray(assignees.nodes)) {
    return [];
  }
  return assignees.nodes.flatMap((assignee) =>
    isRecord(assignee) && typeof assignee.login === 'string' ? [assignee.login] : []
  );
}

function fieldValue(item: Record<string, unknown>, name: string): string | undefined {
  const directValue = fixedAliasFieldValue(item, 'status') ?? fieldValueByName(item, name);
  if (directValue !== undefined) {
    return directValue;
  }
  const fieldValues = item.fieldValues;
  if (!isRecord(fieldValues) || !Array.isArray(fieldValues.nodes)) {
    return undefined;
  }
  for (const value of fieldValues.nodes) {
    if (!isRecord(value) || !isRecord(value.field) || value.field.name !== name) {
      continue;
    }
    if (typeof value.name === 'string') {
      return value.name;
    }
    if (typeof value.text === 'string') {
      return value.text;
    }
  }
  return undefined;
}

function fieldValueByName(item: Record<string, unknown>, name: string): string | undefined {
  return fixedAliasFieldValue(item, camelCaseFieldName(name));
}

function fixedAliasFieldValue(item: Record<string, unknown>, alias: string): string | undefined {
  const direct = item[alias];
  if (!isRecord(direct)) {
    return undefined;
  }
  if (typeof direct.name === 'string') {
    return direct.name;
  }
  if (typeof direct.text === 'string') {
    return direct.text;
  }
  return undefined;
}

function projectItemAssigneeLogins(item: Record<string, unknown>): string[] {
  if (!isRecord(item.content)) {
    return [];
  }
  return assigneeLogins(item.content);
}

function projectItemRepository(item: Record<string, unknown>): {
  id?: string;
  nameWithOwner?: string;
  defaultBranchOid?: string;
  defaultBranchTreeOid?: string;
} | undefined {
  if (!isRecord(item.content) || !isRecord(item.content.repository)) {
    return undefined;
  }
  const repository = item.content.repository;
  const defaultBranchRef = isRecord(repository.defaultBranchRef) ? repository.defaultBranchRef : undefined;
  const target = isRecord(defaultBranchRef?.target) ? defaultBranchRef.target : undefined;
  return {
    ...(typeof repository.id === 'string' ? { id: repository.id } : {}),
    ...(typeof repository.nameWithOwner === 'string' ? { nameWithOwner: repository.nameWithOwner } : {}),
    ...(typeof target?.oid === 'string' ? { defaultBranchOid: target.oid } : {}),
    ...(isRecord(target?.tree) && typeof target.tree.oid === 'string' ? { defaultBranchTreeOid: target.tree.oid } : {}),
  };
}

function repositoryName(content: Record<string, unknown>): string | undefined {
  return isRecord(content.repository) && typeof content.repository.nameWithOwner === 'string'
    ? content.repository.nameWithOwner
    : undefined;
}

function parentReference(content: Record<string, unknown>): ProjectIssueReference | undefined {
  const parent = content.parent;
  if (!isRecord(parent)) {
    return undefined;
  }
  return issueReference(parent);
}

function blockedBy(content: Record<string, unknown>): ProjectIssueReference[] {
  const blockedByIssues = content.blockedBy;
  if (!isRecord(blockedByIssues) || !Array.isArray(blockedByIssues.nodes)) {
    return [];
  }
  const openBlockerCount = openBlockedByCount(content);
  const blockers = blockedByIssues.nodes.flatMap((node) => {
    if (!isRecord(node)) {
      return [];
    }
    const reference = issueReference(node);
    return reference === undefined ? [] : [reference];
  });
  const openBlockers = blockers.filter((blocker) => blocker.state?.trim().toLowerCase() !== 'closed');
  if (openBlockerCount === undefined) {
    return openBlockers;
  }
  if (openBlockerCount <= 0) {
    return [];
  }
  if (openBlockers.length >= openBlockerCount) {
    return openBlockers;
  }
  return [...openBlockers, { state: 'OPEN' }];
}

function openBlockedByCount(content: Record<string, unknown>): number | undefined {
  const summary = content.issueDependenciesSummary;
  if (!isRecord(summary) || typeof summary.blockedBy !== 'number') {
    return undefined;
  }
  return summary.blockedBy;
}

function issueReference(issue: Record<string, unknown>): ProjectIssueReference | undefined {
  const reference: ProjectIssueReference = {};
  if (typeof issue.number === 'number') {
    reference.number = issue.number;
  }
  if (typeof issue.title === 'string') {
    reference.title = issue.title;
  }
  if (typeof issue.state === 'string') {
    reference.state = issue.state;
  }
  if (typeof issue.url === 'string') {
    reference.url = issue.url;
  }
  const repository = repositoryName(issue);
  if (repository !== undefined) {
    reference.repository = repository;
  }
  return Object.keys(reference).length === 0 ? undefined : reference;
}

async function getDefaultGitHubAuthToken(
  config: GitHubAuthConfig,
  fetchImpl: typeof fetch,
): Promise<GitHubAuthToken | undefined> {
  try {
    return await getGitHubAuthToken(config, fetchImpl);
  } catch (error) {
    if (!isGitHubAuthFallbackEligibleError(error)) {
      throw error;
    }
    const fallbackToken = await getGitHubFallbackAuthToken(config);
    if (fallbackToken === undefined) {
      throw error;
    }
    return fallbackToken;
  }
}

function fieldId(field: unknown, name: string): string {
  if (!isRecord(field) || typeof field.id !== 'string') {
    throw new Error(`GitHub Project field ${name} was not found`);
  }
  return field.id;
}

function fieldName(field: unknown): string | undefined {
  return isRecord(field) && typeof field.name === 'string' ? field.name : undefined;
}

function singleSelectOptionId(field: unknown, name: string): string {
  if (!isRecord(field) || !Array.isArray(field.options)) {
    throw new Error(`GitHub Project status field ${name} was not found`);
  }
  const normalized = normalizeToken(name);
  const option = field.options.find((candidate) =>
    isRecord(candidate)
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && normalizeToken(candidate.name) === normalized
  );
  if (!isRecord(option) || typeof option.id !== 'string') {
    throw new Error(`GitHub Project status option ${name} was not found`);
  }
  return option.id;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/gu, '');
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function isStillOwnedByAgent(
  currentAssignees: readonly string[],
  selectedAssignees: readonly string[],
  assigneeLogin: string,
): boolean {
  if (selectedAssignees.length === 0) {
    return currentAssignees.length === 0 || currentAssignees.some((login) => sameLogin(login, assigneeLogin));
  }
  return currentAssignees.some((login) => sameLogin(login, assigneeLogin));
}

function sameLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function projectIssueLockRefName(issue: ProjectIssue): string {
  const repo = slug(issue.repository ?? 'repo');
  const issueId = issue.number === undefined ? slug(issue.id) : String(issue.number);
  return `refs/notes/rainrail/locks/${repo}-${issueId}-${slug(issue.id)}`;
}

function projectIssueDispatchedLockRefName(issue: ProjectIssue): string {
  const repo = slug(issue.repository ?? 'repo');
  const issueId = issue.number === undefined ? slug(issue.id) : String(issue.number);
  return `refs/notes/rainrail/dispatched-locks/${repo}-${issueId}-${slug(issue.id)}`;
}

function isRecoverableStaleLock(lock: ProjectIssueClaimLock, input: Pick<ProjectIssueClaimInput, 'issue'>): boolean {
  if (lock.projectItemId !== input.issue.id) {
    return false;
  }
  if (lock.dispatchedAt !== undefined) {
    return false;
  }
  const createdAt = Date.parse(lock.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt >= PROJECT_ISSUE_CLAIM_LOCK_TTL_MS;
}

function isFinalizedProjectIssueClaim(
  status: ProjectItemStatus,
  lock: ProjectIssueClaimLock,
  issue: ProjectIssue,
): boolean {
  return lock.projectItemId === issue.id
    && lock.agentSessionId !== undefined
    && lock.branchName !== undefined
    && status.agentSessionId === lock.agentSessionId
    && status.branchName === lock.branchName;
}

function isSameProjectIssueClaimLock(left: ProjectIssueClaimLock, right: ProjectIssueClaimLock): boolean {
  return left.id === right.id
    && left.createdAt === right.createdAt
    && left.dispatchedAt === right.dispatchedAt
    && left.agentSessionId === right.agentSessionId
    && left.branchName === right.branchName
    && left.projectItemId === right.projectItemId
    && left.originalStatus === right.originalStatus;
}

function recoverableOriginalStatus(
  originalStatus: string | undefined,
  config: GitHubProjectTaskQueueConfig,
): string | undefined {
  const normalized = normalizeToken(originalStatus ?? '');
  if (normalized === normalizeToken(config.todoStatus)) {
    return config.todoStatus;
  }
  if (normalized === normalizeToken(config.backlogStatus)) {
    return config.backlogStatus;
  }
  return undefined;
}

function claimLockCommitMessage(input: {
  createdAt: string;
  agentSessionId: string;
  branchName: string;
  projectItemId: string;
  originalStatus: string;
  dispatchedAt?: string;
}): string {
  return [
    PROJECT_ISSUE_CLAIM_LOCK_COMMIT_PREFIX,
    '',
    JSON.stringify({
      version: 1,
      createdAt: input.createdAt,
      agentSessionId: input.agentSessionId,
      branchName: input.branchName,
      projectItemId: input.projectItemId,
      originalStatus: input.originalStatus,
      ...(input.dispatchedAt === undefined ? {} : { dispatchedAt: input.dispatchedAt }),
    }),
  ].join('\n');
}

function parseClaimLockCommitMessage(message: string): {
  createdAt: string;
  agentSessionId?: string;
  branchName?: string;
  projectItemId?: string;
  originalStatus?: string;
  dispatchedAt?: string;
} | undefined {
  if (!message.startsWith(PROJECT_ISSUE_CLAIM_LOCK_COMMIT_PREFIX)) {
    return undefined;
  }
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    if (!isRecord(parsed) || typeof parsed.createdAt !== 'string') {
      return undefined;
    }
    return {
      createdAt: parsed.createdAt,
      ...(typeof parsed.agentSessionId === 'string' ? { agentSessionId: parsed.agentSessionId } : {}),
      ...(typeof parsed.branchName === 'string' ? { branchName: parsed.branchName } : {}),
      ...(typeof parsed.projectItemId === 'string' ? { projectItemId: parsed.projectItemId } : {}),
      ...(typeof parsed.originalStatus === 'string' ? { originalStatus: parsed.originalStatus } : {}),
      ...(typeof parsed.dispatchedAt === 'string' ? { dispatchedAt: parsed.dispatchedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function splitRepositoryNameWithOwner(nameWithOwner: string): [string, string] {
  const [owner, repo, ...rest] = nameWithOwner.split('/');
  if (owner === undefined || repo === undefined || rest.length > 0 || owner.length === 0 || repo.length === 0) {
    throw new Error('GitHub Project issue claim lock repository name is invalid');
  }
  return [owner, repo];
}

function qualifiedRefName(name: string): string {
  return name.startsWith('refs/') ? name.slice('refs/'.length) : name;
}

function isReferenceAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Reference already exists');
}

function camelCaseFieldName(name: string): string {
  const words = name.trim().split(/[\s_-]+/u).filter((word) => word.length > 0);
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : `${lower[0]?.toUpperCase() ?? ''}${lower.slice(1)}`;
  }).join('');
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return normalized.length === 0 ? 'item' : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const projectIssuesQuery = `
  query RainrailProjectIssues($organization: String!, $projectNumber: Int!, $after: String, $statusFieldName: String!) {
    organization(login: $organization) {
      projectV2(number: $projectNumber) {
        items(first: 100, after: $after) {
          nodes {
            id
            content {
              __typename
              ... on Issue {
                id
                title
                state
                number
                url
                repository { nameWithOwner }
                assignees(first: 20) { nodes { login } }
                parent { number title state url repository { nameWithOwner } }
                subIssuesSummary { total }
                issueDependenciesSummary { blockedBy }
                blockedBy(first: 100) { totalCount nodes { number title state url repository { nameWithOwner } } }
              }
              ... on DraftIssue {
                id
                title
              }
            }
            fieldValues(first: 40) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              }
            }
            status: fieldValueByName(name: $statusFieldName) {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
              ... on ProjectV2ItemFieldTextValue { text }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const projectMetadataQuery = `
  query RainrailProjectMetadata($organization: String!, $projectNumber: Int!, $fieldsAfter: String) {
    organization(login: $organization) {
      projectV2(number: $projectNumber) {
        id
        fields(first: 50, after: $fieldsAfter) {
          nodes {
            __typename
            ... on ProjectV2Field { id name dataType }
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const projectItemStatusQuery = `
  query RainrailProjectItemStatus(
    $itemId: ID!
    $statusFieldName: String!
    $agentSessionIdFieldName: String!
    $branchFieldName: String!
  ) {
    node(id: $itemId) {
      __typename
      ... on ProjectV2Item {
        content {
          __typename
          ... on Issue {
            repository {
              id
              nameWithOwner
              defaultBranchRef {
                target {
                  ... on Commit {
                    oid
                    tree { oid }
                  }
                }
              }
            }
            assignees(first: 20) { nodes { login } }
          }
        }
        status: fieldValueByName(name: $statusFieldName) {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
          ... on ProjectV2ItemFieldTextValue { text }
        }
        agentSessionId: fieldValueByName(name: $agentSessionIdFieldName) {
          ... on ProjectV2ItemFieldTextValue { text }
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
        branch: fieldValueByName(name: $branchFieldName) {
          ... on ProjectV2ItemFieldTextValue { text }
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
      }
    }
  }
`;

const updateProjectFieldMutation = `
  mutation RainrailUpdateProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: $value
    }) {
      projectV2Item { id }
    }
  }
`;

const createProjectIssueClaimLockMutation = `
  mutation RainrailCreateProjectIssueClaimLock($repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
    createRef(input: { repositoryId: $repositoryId, name: $name, oid: $oid }) {
      ref { id }
    }
  }
`;

const updateProjectIssueClaimLockMutation = `
  mutation RainrailUpdateProjectIssueClaimLock($refId: ID!, $oid: GitObjectID!) {
    updateRef(input: { refId: $refId, oid: $oid, force: true }) {
      ref { id }
    }
  }
`;

const projectIssueClaimLockQuery = `
  query RainrailProjectIssueClaimLock($repositoryId: ID!, $qualifiedName: String!) {
    node(id: $repositoryId) {
      ... on Repository {
        ref(qualifiedName: $qualifiedName) {
          id
          target {
            oid
            ... on Commit {
              committedDate
              message
            }
          }
        }
      }
    }
  }
`;

const projectIssueClaimLockByRepositoryQuery = `
  query RainrailProjectIssueClaimLockByRepository($owner: String!, $repo: String!, $qualifiedName: String!) {
    repository(owner: $owner, name: $repo) {
      ref(qualifiedName: $qualifiedName) {
        id
        target {
          oid
          ... on Commit {
            committedDate
            message
          }
        }
      }
    }
  }
`;

const deleteProjectIssueClaimLockMutation = `
  mutation RainrailDeleteProjectIssueClaimLock($refId: ID!) {
    deleteRef(input: { refId: $refId }) {
      clientMutationId
    }
  }
`;

const addCommentMutation = `
  mutation RainrailAddIssueComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge { node { id url } }
    }
  }
`;
