import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const dispatcherAgents = readFileSync(new URL('../src/dispatcher/AGENTS.md', import.meta.url), 'utf8');
const dispatcherImplementation = readFileSync(new URL('../src/dispatcher/index.ts', import.meta.url), 'utf8');
const pluginRuntimeContract = readFileSync(new URL('../docs/plugin-runtime-contract.md', import.meta.url), 'utf8');
const githubWebhookAgents = readFileSync(new URL('../src/github-webhook/AGENTS.md', import.meta.url), 'utf8');
const prLifecycleAgents = readFileSync(new URL('../src/pr-lifecycle/AGENTS.md', import.meta.url), 'utf8');
/** @type {{contracts: Array<{id: string, sources: string[]}>}} */
const contractsManifest = JSON.parse(
  readFileSync(new URL('../docs/contracts.manifest.json', import.meta.url), 'utf8'),
);

/**
 * @param {string} id
 * @returns {{ sources: string[] }}
 */
const contractById = (id) => {
  const contract = contractsManifest.contracts.find(
    /** @param {{ id: string }} contract */
    (contract) => contract.id === id,
  );
  if (contract === undefined) {
    throw new Error(`Missing contract ${id}`);
  }
  return contract;
};

describe('AGENTS.md development rules', () => {
  it('documents Rainrail as a TypeScript monorepo for event orchestration work', () => {
    expect(agents).toContain('TypeScript monorepo');
    expect(agents).toContain('plugin');
    expect(agents).toContain('event');
    expect(agents).toContain('orchestration');
  });

  it('requires t-wada style TDD and Red-Green-Refactor', () => {
    expect(agents).toContain('t-wada style TDD');
    expect(agents).toContain('failing test');
    expect(agents).toContain('Red-Green-Refactor');
  });

  it('requires English Conventional Commit logs while allowing Japanese GitHub discussion', () => {
    expect(agents).toContain('Conventional Commits');
    expect(agents).toContain('Commit logs must be written in English');
    expect(agents).toContain('Issue and PR bodies and comments may be written in Japanese');
  });

  it('covers secret handling, PR contents, and Japanese docs for specification decisions', () => {
    expect(agents).toContain('Never commit secrets, tokens, credentials');
    expect(agents).toContain('Summary');
    expect(agents).toContain('Verification');
    expect(agents).toContain('Related issue');
    expect(agents).toContain('docs/');
    expect(agents).toContain('specs/');
    expect(agents).toContain('Japanese');
  });

  it('documents Codex code review expectations', () => {
    expect(agents).toContain('## Codex Code Review Guidelines');
    expect(agents).toContain('Write review comments in Japanese');
    expect(agents).toContain('security risks');
    expect(agents).toContain('edge cases');
  });

  it('keeps dispatcher capability boundary rules in a scoped AGENTS.md', () => {
    expect(dispatcherAgents).toContain('capability getter');
    expect(dispatcherAgents).toContain('context.actions');
    expect(dispatcherAgents).toContain('context.runtime');
    expect(dispatcherAgents).toContain('readSecret');
    expect(dispatcherAgents).toContain('timeout / abort');
    expect(dispatcherAgents).toContain('audit');
    expect(dispatcherAgents).toContain('raw descriptor');
    expect(dispatcherAgents).toContain('internal reason');
    expect(dispatcherAgents).toContain('this binding');
  });

  it('keeps provider-specific dispatcher guards outside the dispatcher directory', () => {
    expect(dispatcherImplementation).not.toContain('githubPullRequests');
    expect(dispatcherImplementation).not.toContain('GitHubPullRequestProvider');
    expect(dispatcherImplementation).not.toContain('pull-request-provider');
  });

  it('documents the dispatcher module split and compatibility shim decision', () => {
    expect(pluginRuntimeContract).toContain('src/dispatcher/index.ts');
    expect(pluginRuntimeContract).toContain('src/dispatcher.ts');
    expect(pluginRuntimeContract).toContain('compatibility shim');
    expect(pluginRuntimeContract).toContain('capability policy');
    expect(pluginRuntimeContract).toContain('lifecycle');
    expect(pluginRuntimeContract).toContain('capability view');
  });

  it('tracks the dispatcher implementation as a plugin runtime contract source', () => {
    const pluginRuntime = contractById('plugin-runtime');
    expect(pluginRuntime?.sources).toContain('src/dispatcher.ts');
    expect(pluginRuntime?.sources).toContain('src/dispatcher/index.ts');
  });
});

describe('GitHub webhook scoped agent rules', () => {
  it('keeps normalization ownership scoped to src/github-webhook', () => {
    expect(githubWebhookAgents).toContain('GitHub webhook normalization');
    expect(githubWebhookAgents).toContain('review payload');
    expect(githubWebhookAgents).toContain('issue_comment');
    expect(githubWebhookAgents).toContain('workflow_run');
    expect(githubWebhookAgents).toContain('check_suite');
    expect(githubWebhookAgents).toContain('installation');
    expect(githubWebhookAgents).toContain('organization');
    expect(githubWebhookAgents).toContain('projects_v2_item');
  });

  it('tracks the moved GitHub webhook implementation in the contracts manifest', () => {
    const webhookContract = contractById('github-webhook-normalization');
    const boundaryContract = contractById('core-eep-bridge-source-adapter-boundary');

    expect(webhookContract.sources).toEqual(['src/github-webhook/index.ts']);
    expect(boundaryContract.sources).toContain('src/github-webhook/index.ts');
    expect(boundaryContract.sources).not.toContain('src/github-webhook.ts');
  });
});

describe('PR lifecycle scoped agent rules', () => {
  it('documents the lifecycle boundary and staged module split decision', () => {
    expect(prLifecycleAgents).toContain('PR lifecycle');
    expect(prLifecycleAgents).toContain('src/pr-lifecycle.ts');
    expect(prLifecycleAgents).toContain('compatibility shim');
    expect(prLifecycleAgents).toContain('src/pr-lifecycle/index.ts');
    expect(prLifecycleAgents).toContain('GitHubPullRequestProvider');
    expect(prLifecycleAgents).toContain('normalized');
  });

  it('keeps review, check, and merge freshness rules near the workflow code', () => {
    expect(prLifecycleAgents).toContain('Codex review');
    expect(prLifecycleAgents).toContain('latest actionable review');
    expect(prLifecycleAgents).toContain('review comments pagination');
    expect(prLifecycleAgents).toContain('unresolved review thread');
    expect(prLifecycleAgents).toContain('stale checks');
    expect(prLifecycleAgents).toContain('headSha');
    expect(prLifecycleAgents).toContain('auto-merge blockers');
    expect(prLifecycleAgents).toContain('context.actions.mergePullRequest');
  });
});
