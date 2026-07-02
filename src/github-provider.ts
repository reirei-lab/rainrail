import type { GitHubAuthToken } from './github-auth.js';
import {
  getGitHubAuthToken,
  getGitHubFallbackAuthToken,
  isGitHubAuthFallbackEligibleError,
  type GitHubAuthConfig,
} from './github-auth.js';
import { recordGitHubRateLimit } from './github-rate-limit.js';
import type {
  GitHubPullRequestProvider,
  PullRequestCheck,
  PullRequestReviewComment,
  PullRequestReviewTarget,
} from './pr-lifecycle.js';
import type {
  TaskComment,
  TaskCommentInput,
  TaskIssue,
  TaskIssueCreateInput,
  TaskIssueRef,
  TaskIssueSearchInput,
  TaskProvider,
  TaskProviderContext,
} from './task-provider.js';

export interface GitHubAuthTokenProvider {
  getAuthToken(context?: TaskProviderContext): Promise<GitHubAuthToken | undefined>;
}

export interface GitHubTaskProviderOptions {
  auth?: GitHubAuthTokenProvider;
  config?: GitHubAuthConfig;
  fetch?: typeof fetch;
}

interface GitHubIssueResponse {
  node_id?: unknown;
  id?: unknown;
  number?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  html_url?: unknown;
}

interface GitHubCommentResponse {
  node_id?: unknown;
  id?: unknown;
  html_url?: unknown;
}

interface GitHubSearchIssuesResponse {
  items?: unknown;
}

interface GitHubPullRequestResponse {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  user?: { login?: unknown };
  head?: { ref?: unknown; repo?: { full_name?: unknown }; sha?: unknown };
  draft?: unknown;
  state?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  requested_reviewers?: unknown;
  requested_teams?: unknown;
}

interface GitHubReviewResponse {
  user?: { login?: unknown };
  state?: unknown;
  commit_id?: unknown;
}

interface GitHubStatusResponse {
  state?: unknown;
  total_count?: unknown;
  statuses?: unknown;
}

interface GitHubChecksResponse {
  check_runs?: unknown;
}

type GitHubCheckRunResponse = Record<string, unknown>;

interface GitHubReviewCommentResponse {
  id?: unknown;
  pull_request_review_id?: unknown;
  path?: unknown;
  body?: unknown;
  html_url?: unknown;
  line?: unknown;
  original_line?: unknown;
  start_line?: unknown;
  original_start_line?: unknown;
  commit_id?: unknown;
}

export function createGitHubTaskProvider(options: GitHubTaskProviderOptions = {}): TaskProvider {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth ?? {
    getAuthToken: (context?: TaskProviderContext) => getDefaultGitHubAuthToken(options.config ?? {}, fetchImpl, context?.signal),
  };

  return {
    name: 'github',
    kind: 'task-provider',
    async getIssue(ref: TaskIssueRef, context?: TaskProviderContext): Promise<TaskIssue> {
      const repository = requireRepository(ref);
      const number = requireIssueNumber(ref);
      throwIfAborted(context?.signal);
      const authToken = await auth.getAuthToken(context);
      throwIfAborted(context?.signal);
      const headers = requestHeaders(authToken);
      const init: RequestInit = { headers };
      if (context?.signal !== undefined) {
        init.signal = context.signal;
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues/${number}`,
        init,
      );
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub issue request failed with HTTP ${response.status}`);
      }

      return mapGitHubIssue(repository, await response.json() as GitHubIssueResponse);
    },
    async createIssue(input: TaskIssueCreateInput, context?: TaskProviderContext): Promise<TaskIssue> {
      const repository = requireRepository(input);
      throwIfAborted(context?.signal);
      const authToken = await auth.getAuthToken(context);
      throwIfAborted(context?.signal);
      const init: RequestInit = {
        method: 'POST',
        headers: requestHeaders(authToken),
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          ...(input.labels === undefined ? {} : { labels: input.labels }),
        }),
      };
      if (context?.signal !== undefined) {
        init.signal = context.signal;
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues`,
        init,
      );
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub issue create request failed with HTTP ${response.status}`);
      }

      return mapGitHubIssue(repository, await response.json() as GitHubIssueResponse);
    },
    async searchIssues(input: TaskIssueSearchInput, context?: TaskProviderContext): Promise<TaskIssue[]> {
      const repository = requireRepository(input);
      throwIfAborted(context?.signal);
      const authToken = await auth.getAuthToken(context);
      throwIfAborted(context?.signal);
      const query = [
        `repo:${repository}`,
        'is:issue',
        input.state === undefined || input.state === 'all' ? undefined : `is:${input.state}`,
        input.query,
      ].filter((part): part is string => part !== undefined && part.length > 0).join(' ');
      const url = new URL('https://api.github.com/search/issues');
      url.searchParams.set('q', query);
      const init: RequestInit = { headers: requestHeaders(authToken) };
      if (context?.signal !== undefined) {
        init.signal = context.signal;
      }
      const response = await fetchImpl(url, init);
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub issue search request failed with HTTP ${response.status}`);
      }

      const payload = await response.json() as GitHubSearchIssuesResponse;
      return Array.isArray(payload.items)
        ? payload.items.map((item) => mapGitHubIssue(repository, item as GitHubIssueResponse))
        : [];
    },
    async createComment(input: TaskCommentInput, context?: TaskProviderContext): Promise<TaskComment> {
      const repository = requireRepository(input.target);
      const number = requireIssueNumber(input.target);
      throwIfAborted(context?.signal);
      const authToken = await auth.getAuthToken(context);
      throwIfAborted(context?.signal);
      const init: RequestInit = {
        method: 'POST',
        headers: requestHeaders(authToken),
        body: JSON.stringify({ body: input.body }),
      };
      if (context?.signal !== undefined) {
        init.signal = context.signal;
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues/${number}/comments`,
        init,
      );
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub comment request failed with HTTP ${response.status}`);
      }

      return mapGitHubComment(await response.json() as GitHubCommentResponse);
    },
  };
}

export function createGitHubPullRequestProvider(options: GitHubTaskProviderOptions = {}): GitHubPullRequestProvider {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth ?? {
    getAuthToken: (context?: TaskProviderContext) => getDefaultGitHubAuthToken(options.config ?? {}, fetchImpl, context?.signal),
  };

  const request = async (path: string, init: RequestInit = {}, context?: TaskProviderContext): Promise<Response> => {
    throwIfAborted(context?.signal);
    const authToken = await auth.getAuthToken(context);
    throwIfAborted(context?.signal);
    const requestInit: RequestInit = {
      ...init,
      headers: {
        ...requestHeaders(authToken),
        ...(init.headers as Record<string, string> | undefined),
      },
    };
    if (context?.signal !== undefined) {
      requestInit.signal = context.signal;
    }
    const response = await fetchImpl(`https://api.github.com/${path}`, requestInit);
    recordGitHubRateLimit('rest', response.headers, authToken === undefined
      ? undefined
      : { authProvider: authToken.provider, fallback: authToken.fallback });
    return response;
  };

  const findPullRequestsByHead = async (
    input: { repository: string; headRefName?: string; headSha?: string },
    context?: TaskProviderContext,
  ): Promise<PullRequestReviewTarget[]> => {
    const url = new URL(`https://api.github.com/repos/${input.repository}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', '100');
    if (input.headSha === undefined && input.headRefName !== undefined) {
      const owner = input.repository.split('/')[0];
      url.searchParams.set('head', `${owner}:${input.headRefName}`);
    }
    const candidates = await listPagedArray<GitHubPullRequestResponse>(request, url.pathname.slice(1) + url.search, 'GitHub pull request list request', context);
    const payloads = candidates.filter((candidate) => input.headSha !== undefined
      ? stringValue(candidate.head?.sha) === input.headSha
      : input.headRefName !== undefined && stringValue(candidate.head?.ref) === input.headRefName);
    return Promise.all(payloads.flatMap((payload) => {
      const number = numberValue(payload.number);
      return number === undefined ? [] : [loadPullRequest(request, input.repository, number, context)];
    }));
  };

  return {
    name: 'github-pull-requests',
    kind: 'pull-request-provider',
    async getPullRequest(input, context) {
      const pullRequest = await getPullRequestPayload(request, input.repository, input.number, context);
      return pullRequestFromPayload(input.repository, pullRequest, {
        reviews: await listReviews(request, input.repository, input.number, context),
        checks: await listChecks(request, input.repository, pullRequest, context),
      });
    },
    async findOpenPullRequestsByBase(input, context) {
      const url = new URL(`https://api.github.com/repos/${input.repository}/pulls`);
      url.searchParams.set('state', 'open');
      url.searchParams.set('base', input.baseRefName);
      url.searchParams.set('per_page', '100');
      const payload = await listPagedArray<GitHubPullRequestResponse>(request, url.pathname.slice(1) + url.search, 'GitHub pull request list request', context);
      return Promise.all(payload.map(async (pullRequest) => {
        const number = numberValue(pullRequest.number);
        if (number === undefined) {
          throw new Error('GitHub pull request response is missing required PR fields');
        }
        return loadPullRequest(request, input.repository, number, context);
      }));
    },
    async findPullRequestByHead(input, context) {
      return (await findPullRequestsByHead(input, context))[0];
    },
    findPullRequestsByHead,
    async requestReview(input, context) {
      const response = await request(`repos/${input.repository}/pulls/${input.number}/requested_reviewers`, {
        method: 'POST',
        body: JSON.stringify({ reviewers: [input.reviewerLogin] }),
      }, context);
      if (!response.ok) {
        throw new Error(`GitHub review request failed with HTTP ${response.status}`);
      }
    },
    async removeReviewRequest(input, context) {
      const response = await request(`repos/${input.repository}/pulls/${input.number}/requested_reviewers`, {
        method: 'DELETE',
        body: JSON.stringify({ reviewers: [input.reviewerLogin] }),
      }, context);
      if (!response.ok) {
        throw new Error(`GitHub review request removal failed with HTTP ${response.status}`);
      }
    },
    async listReviewComments(input, context) {
      const comments: PullRequestReviewComment[] = [];
      let page = 1;
      while (true) {
        const response = await request(
          `repos/${input.repository}/pulls/${input.number}/comments?per_page=100&page=${page}`,
          {},
          context,
        );
        if (!response.ok) {
          throw new Error(`GitHub review comments request failed with HTTP ${response.status}`);
        }
        const rawPageComments = arrayValue(await response.json());
        const pageComments = rawPageComments
          .flatMap((value) => reviewCommentFromPayload(value as GitHubReviewCommentResponse));
        comments.push(...pageComments);
        if (rawPageComments.length < 100) {
          return comments;
        }
        page += 1;
      }
    },
  };
}

type GitHubRequest = (path: string, init?: RequestInit, context?: TaskProviderContext) => Promise<Response>;

async function getPullRequestPayload(
  request: GitHubRequest,
  repository: string,
  number: number,
  context?: TaskProviderContext,
): Promise<GitHubPullRequestResponse> {
  const response = await request(`repos/${repository}/pulls/${number}`, {}, context);
  if (!response.ok) {
    throw new Error(`GitHub pull request request failed with HTTP ${response.status}`);
  }
  return await response.json() as GitHubPullRequestResponse;
}

async function loadPullRequest(
  request: GitHubRequest,
  repository: string,
  number: number,
  context?: TaskProviderContext,
): Promise<PullRequestReviewTarget> {
  const pullRequest = await getPullRequestPayload(request, repository, number, context);
  return pullRequestFromPayload(repository, pullRequest, {
    reviews: await listReviews(request, repository, number, context),
    checks: await listChecks(request, repository, pullRequest, context),
  });
}

async function listReviews(
  request: GitHubRequest,
  repository: string,
  number: number,
  context?: TaskProviderContext,
): Promise<GitHubReviewResponse[]> {
  return listPagedArray<GitHubReviewResponse>(
    request,
    `repos/${repository}/pulls/${number}/reviews?per_page=100`,
    'GitHub pull request reviews request',
    context,
  );
}

async function listChecks(
  request: GitHubRequest,
  repository: string,
  pullRequest: GitHubPullRequestResponse,
  context?: TaskProviderContext,
): Promise<PullRequestCheck[]> {
  const sha = stringValue(pullRequest.head?.sha);
  if (sha === undefined) {
    return [];
  }
  const statuses = await request(`repos/${repository}/commits/${sha}/status`, {}, context);
  if (!statuses.ok) {
    throw new Error(`GitHub commit statuses request failed with HTTP ${statuses.status}`);
  }
  const checkRuns = await listPagedResource<GitHubCheckRunResponse>(
    request,
    `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
    'check_runs',
    'GitHub check runs request',
    context,
  );
  const statusPayload = await statuses.json() as GitHubStatusResponse;
  return [
    ...optionalStatusRollup(statusPayload),
    ...arrayValue(statusPayload.statuses).map((status) => {
      const value = recordValue(status);
      return {
        type: 'StatusContext',
        ...optionalString('name', stringValue(value.context)),
        ...optionalString('state', stringValue(value.state)),
      };
    }),
    ...checkRuns.map((check) => {
      const value = recordValue(check);
      return {
        type: 'CheckRun',
        ...optionalString('name', stringValue(value.name)),
        ...optionalString('status', stringValue(value.status)),
        ...optionalString('conclusion', stringValue(value.conclusion)),
      };
    }),
  ];
}

function pullRequestFromPayload(
  repository: string,
  payload: GitHubPullRequestResponse,
  related: { reviews: GitHubReviewResponse[]; checks: PullRequestCheck[] },
): PullRequestReviewTarget {
  const number = numberValue(payload.number);
  const title = stringValue(payload.title);
  const url = stringValue(payload.html_url);
  const authorLogin = stringValue(payload.user?.login);
  const headRefName = stringValue(payload.head?.ref);
  const headRepository = stringValue(payload.head?.repo?.full_name);
  const headSha = stringValue(payload.head?.sha);
  if (number === undefined || title === undefined || url === undefined || authorLogin === undefined || headRefName === undefined) {
    throw new Error('GitHub pull request response is missing required PR fields');
  }
  return {
    repository,
    number,
    title,
    url,
    authorLogin,
    headRefName,
    ...optionalString('headRepository', headRepository),
    ...optionalString('headSha', headSha),
    isDraft: payload.draft === true,
    statusCheckRollup: related.checks,
    reviewRequests: arrayValue(payload.requested_reviewers).flatMap((reviewer) => {
      const login = stringValue(recordValue(reviewer).login);
      return login === undefined ? [] : [login];
    }),
    reviews: related.reviews.flatMap((review) => {
      const login = stringValue(review.user?.login);
      const state = stringValue(review.state);
      return login === undefined || state === undefined
        ? []
        : [{
            authorLogin: login,
            state,
            ...optionalString('commitId', stringValue(review.commit_id)),
          }];
    }),
    ...optionalString('state', stringValue(payload.state)),
    ...optionalString('mergeable', mergeableValue(payload)),
    ...optionalString('mergeStateStatus', stringValue(payload.mergeable_state)),
  };
}

function optionalStatusRollup(statusPayload: GitHubStatusResponse): PullRequestCheck[] {
  const state = stringValue(statusPayload.state);
  const statuses = arrayValue(statusPayload.statuses);
  const totalCount = numberValue(statusPayload.total_count);
  if (state === undefined || (state === 'pending' && statuses.length === 0 && (totalCount === undefined || totalCount === 0))) {
    return [];
  }
  return [{ type: 'StatusRollup', name: 'combined-status', state }];
}

async function listPagedArray<T>(
  request: GitHubRequest,
  firstPath: string,
  errorLabel: string,
  context?: TaskProviderContext,
): Promise<T[]> {
  const values: T[] = [];
  let page = 1;
  while (true) {
    const path = pagePath(firstPath, page);
    const response = await request(path, {}, context);
    if (!response.ok) {
      throw new Error(`${errorLabel} failed with HTTP ${response.status}`);
    }
    const pageValues = arrayValue(await response.json()) as T[];
    values.push(...pageValues);
    if (pageValues.length < 100) return values;
    page += 1;
  }
}

async function listPagedResource<T>(
  request: GitHubRequest,
  firstPath: string,
  key: string,
  errorLabel: string,
  context?: TaskProviderContext,
): Promise<T[]> {
  const values: T[] = [];
  let page = 1;
  while (true) {
    const path = pagePath(firstPath, page);
    const response = await request(path, {}, context);
    if (!response.ok) {
      throw new Error(`${errorLabel} failed with HTTP ${response.status}`);
    }
    const pageValues = arrayValue(recordValue(await response.json())[key]) as T[];
    values.push(...pageValues);
    if (pageValues.length < 100) return values;
    page += 1;
  }
}

function pagePath(firstPath: string, page: number): string {
  if (page === 1) return firstPath;
  const separator = firstPath.includes('?') ? '&' : '?';
  return `${firstPath}${separator}page=${page}`;
}

function mergeableValue(payload: GitHubPullRequestResponse): string | undefined {
  const mergeableState = stringValue(payload.mergeable_state);
  if (payload.mergeable === true) return 'MERGEABLE';
  if (payload.mergeable === false) return mergeableState?.toUpperCase();
  return stringValue(payload.mergeable);
}

function reviewCommentFromPayload(value: GitHubReviewCommentResponse): PullRequestReviewComment[] {
  const id = numberValue(value.id);
  const reviewId = numberValue(value.pull_request_review_id);
  const path = stringValue(value.path);
  const body = stringValue(value.body);
  if (id === undefined || reviewId === undefined || path === undefined || body === undefined) {
    return [];
  }
  return [{
    id,
    reviewId,
    path,
    body,
    ...optionalString('url', stringValue(value.html_url)),
    ...optionalNumber('line', numberValue(value.line)),
    ...optionalNumber('originalLine', numberValue(value.original_line)),
    ...optionalNumber('startLine', numberValue(value.start_line) ?? numberValue(value.original_start_line)),
    ...optionalString('commitId', stringValue(value.commit_id)),
  }];
}

async function getDefaultGitHubAuthToken(
  config: GitHubAuthConfig,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<GitHubAuthToken | undefined> {
  try {
    throwIfAborted(signal);
    return await getGitHubAuthToken(config, fetchImpl, signal);
  } catch (error) {
    if (!isGitHubAuthFallbackEligibleError(error)) {
      throw error;
    }
    throwIfAborted(signal);
    const fallbackToken = await getGitHubFallbackAuthToken(config, undefined, signal);
    if (fallbackToken === undefined) {
      throw error;
    }
    return fallbackToken;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('GitHub task provider operation aborted');
  }
}

function requestHeaders(authToken: GitHubAuthToken | undefined): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(authToken === undefined ? {} : { Authorization: `Bearer ${authToken.token}` }),
  };
}

function mapGitHubIssue(repository: string, payload: GitHubIssueResponse): TaskIssue {
  const number = typeof payload.number === 'number' ? payload.number : undefined;
  const title = typeof payload.title === 'string' ? payload.title : undefined;
  const id = typeof payload.node_id === 'string'
    ? payload.node_id
    : typeof payload.id === 'number'
      ? String(payload.id)
      : undefined;
  if (id === undefined || number === undefined || title === undefined) {
    throw new Error('GitHub issue response is missing required issue fields');
  }

  return {
    id,
    provider: 'github',
    repository,
    number,
    title,
    ...(typeof payload.state === 'string' ? { state: payload.state } : {}),
    ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
    ...(typeof payload.html_url === 'string' ? { url: payload.html_url } : {}),
  };
}

function mapGitHubComment(payload: GitHubCommentResponse): TaskComment {
  const id = typeof payload.node_id === 'string'
    ? payload.node_id
    : typeof payload.id === 'number'
      ? String(payload.id)
      : undefined;
  if (id === undefined) {
    throw new Error('GitHub comment response is missing required comment fields');
  }

  return {
    id,
    ...(typeof payload.html_url === 'string' ? { url: payload.html_url } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString<TKey extends string>(key: TKey, value: string | undefined): { [K in TKey]?: string } {
  return value === undefined ? {} : { [key]: value } as { [K in TKey]?: string };
}

function optionalNumber<TKey extends string>(key: TKey, value: number | undefined): { [K in TKey]?: number } {
  return value === undefined ? {} : { [key]: value } as { [K in TKey]?: number };
}

function requireRepository(ref: TaskIssueRef): string {
  if (ref.repository === undefined || ref.repository.length === 0) {
    throw new Error('GitHub task issue ref requires a repository');
  }
  return ref.repository;
}

function requireIssueNumber(ref: TaskIssueRef): number {
  if (ref.number === undefined) {
    throw new Error('GitHub task issue ref requires an issue number');
  }
  return ref.number;
}
