import type { GitHubAuthToken } from './github-auth.js';
import {
  getGitHubAuthToken,
  getGitHubFallbackAuthToken,
  isGitHubAuthFallbackEligibleError,
  type GitHubAuthConfig,
} from './github-auth.js';
import { recordGitHubRateLimit } from './github-rate-limit.js';
import type {
  TaskComment,
  TaskCommentInput,
  TaskIssue,
  TaskIssueCreateInput,
  TaskIssueRef,
  TaskIssueSearchInput,
  TaskProvider,
} from './task-provider.js';

export interface GitHubAuthTokenProvider {
  getAuthToken(): Promise<GitHubAuthToken | undefined>;
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

export function createGitHubTaskProvider(options: GitHubTaskProviderOptions = {}): TaskProvider {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth ?? {
    getAuthToken: () => getDefaultGitHubAuthToken(options.config ?? {}, fetchImpl),
  };

  return {
    name: 'github',
    kind: 'task-provider',
    async getIssue(ref: TaskIssueRef): Promise<TaskIssue> {
      const repository = requireRepository(ref);
      const number = requireIssueNumber(ref);
      const authToken = await auth.getAuthToken();
      const headers = requestHeaders(authToken);
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues/${number}`,
        { headers },
      );
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub issue request failed with HTTP ${response.status}`);
      }

      return mapGitHubIssue(repository, await response.json() as GitHubIssueResponse);
    },
    async createIssue(input: TaskIssueCreateInput): Promise<TaskIssue> {
      const repository = requireRepository(input);
      const authToken = await auth.getAuthToken();
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues`,
        {
          method: 'POST',
          headers: requestHeaders(authToken),
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            ...(input.labels === undefined ? {} : { labels: input.labels }),
          }),
        },
      );
      recordGitHubRateLimit('rest', response.headers, authToken === undefined
        ? undefined
        : { authProvider: authToken.provider, fallback: authToken.fallback });
      if (!response.ok) {
        throw new Error(`GitHub issue create request failed with HTTP ${response.status}`);
      }

      return mapGitHubIssue(repository, await response.json() as GitHubIssueResponse);
    },
    async searchIssues(input: TaskIssueSearchInput): Promise<TaskIssue[]> {
      const repository = requireRepository(input);
      const authToken = await auth.getAuthToken();
      const query = [
        `repo:${repository}`,
        'is:issue',
        input.state === undefined || input.state === 'all' ? undefined : `is:${input.state}`,
        input.query,
      ].filter((part): part is string => part !== undefined && part.length > 0).join(' ');
      const url = new URL('https://api.github.com/search/issues');
      url.searchParams.set('q', query);
      const response = await fetchImpl(url, { headers: requestHeaders(authToken) });
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
    async createComment(input: TaskCommentInput): Promise<TaskComment> {
      const repository = requireRepository(input.target);
      const number = requireIssueNumber(input.target);
      const authToken = await auth.getAuthToken();
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/issues/${number}/comments`,
        {
          method: 'POST',
          headers: requestHeaders(authToken),
          body: JSON.stringify({ body: input.body }),
        },
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
