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
  ProjectIssueReleaseInput,
  TaskQueueProvider,
} from './task-queue.js';

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
  agentSessionIdFieldId: string;
  branchFieldId: string;
}

interface ProjectItemStatus {
  status?: string;
  agentSessionId?: string;
  branchName?: string;
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
    issues.push(...items.nodes.flatMap((item) => mapProjectIssueItem(item, config)));
    after = items?.pageInfo?.hasNextPage === true && typeof items.pageInfo.endCursor === 'string'
      ? items.pageInfo.endCursor
      : undefined;
  } while (after !== undefined);

  return issues;
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
  assertClaimable(before, config);
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
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
  assertClaimMatches(after, input, config);

  const comment = await runGraphql<{ addComment?: { commentEdge?: { node?: { url?: unknown } } } }>(
    fetchImpl,
    auth,
    addCommentMutation,
    { subjectId: input.issue.contentId, body: input.commentBody },
  );

  return {
    projectId: metadata.projectId,
    projectItemId: input.issue.id,
    statusFieldId: metadata.statusFieldId,
    statusOptionId: metadata.statusOptionId,
    agentSessionIdFieldId: metadata.agentSessionIdFieldId,
    branchFieldId: metadata.branchFieldId,
    ...(typeof comment.addComment?.commentEdge?.node?.url === 'string'
      ? { commentUrl: comment.addComment.commentEdge.node.url }
      : {}),
  };
}

async function releaseProjectIssue(
  config: GitHubProjectTaskQueueConfig,
  input: ProjectIssueReleaseInput,
  fetchImpl: typeof fetch,
  auth: GitHubProjectAuthTokenProvider,
): Promise<void> {
  const metadata = await loadProjectMetadata(config, fetchImpl, auth);
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.statusFieldId, {
    singleSelectOptionId: metadata.todoStatusOptionId,
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.agentSessionIdFieldId, {
    text: '',
  });
  await updateProjectField(fetchImpl, auth, metadata.projectId, input.issue.id, metadata.branchFieldId, {
    text: '',
  });
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
  const statusFieldId = fieldId(statusField, config.statusFieldName);

  return {
    projectId,
    statusFieldId,
    statusOptionId,
    todoStatusOptionId,
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
  const status = fieldValueByName(payload.node, config.statusFieldName);
  const agentSessionId = fieldValueByName(payload.node, config.agentSessionIdFieldName);
  const branchName = fieldValueByName(payload.node, config.branchFieldName);
  return {
    ...(status === undefined ? {} : { status }),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(branchName === undefined ? {} : { branchName }),
  };
}

function assertClaimable(status: ProjectItemStatus, config: GitHubProjectTaskQueueConfig): void {
  if (
    normalizeToken(status.status ?? '') !== normalizeToken(config.todoStatus)
    || hasText(status.agentSessionId)
    || hasText(status.branchName)
  ) {
    throw new Error('GitHub Project item is no longer claimable');
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
  const directValue = fieldValueByName(item, name);
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
  const direct = item[camelCaseFieldName(name)];
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
  const blockers = blockedByIssues.nodes.flatMap((node) => {
    if (!isRecord(node)) {
      return [];
    }
    const reference = issueReference(node);
    return reference === undefined ? [] : [reference];
  });
  if (
    typeof blockedByIssues.totalCount === 'number'
    && blockedByIssues.totalCount > blockers.length
    && !blockers.some((blocker) => blocker.state?.trim().toLowerCase() !== 'closed')
  ) {
    blockers.push({ state: 'OPEN' });
  }
  return blockers;
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

function camelCaseFieldName(name: string): string {
  const words = name.trim().split(/[\s_-]+/u).filter((word) => word.length > 0);
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : `${lower[0]?.toUpperCase() ?? ''}${lower.slice(1)}`;
  }).join('');
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

const addCommentMutation = `
  mutation RainrailAddIssueComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge { node { id url } }
    }
  }
`;
