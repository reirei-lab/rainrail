import type { GitHubPullRequestProvider } from './pr-lifecycle.js';

export interface WorkflowProviderGuard<TProvider extends object = object> {
  name: string;
  requiredMethods: readonly string[];
  optionalMethods: readonly string[];
  unavailable: TProvider;
  isProvider(provider: unknown): provider is TProvider;
}

const unavailablePullRequestsProvider: GitHubPullRequestProvider = {
  name: 'unavailable-pull-requests',
  kind: 'pull-request-provider',
  async getPullRequest() {
    throw new Error('Pull request provider is not available');
  },
  async findPullRequestByHead() {
    throw new Error('Pull request provider is not available');
  },
  async requestReview() {
    throw new Error('Pull request provider is not available');
  },
};

export const workflowProviderGuards: readonly WorkflowProviderGuard[] = [
  {
    name: 'githubPullRequests',
    requiredMethods: ['getPullRequest', 'findPullRequestByHead', 'requestReview'],
    optionalMethods: ['findOpenPullRequestsByBase', 'findPullRequestsByHead', 'removeReviewRequest', 'listReviewComments'],
    unavailable: unavailablePullRequestsProvider,
    isProvider(provider): provider is GitHubPullRequestProvider {
      return (
        typeof provider === 'object' &&
        provider !== null &&
        (provider as GitHubPullRequestProvider).kind === 'pull-request-provider' &&
        typeof (provider as GitHubPullRequestProvider).getPullRequest === 'function' &&
        typeof (provider as GitHubPullRequestProvider).findPullRequestByHead === 'function' &&
        typeof (provider as GitHubPullRequestProvider).requestReview === 'function'
      );
    },
  },
];
