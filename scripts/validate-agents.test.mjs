import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const githubWebhookAgents = readFileSync(new URL('../src/github-webhook/AGENTS.md', import.meta.url), 'utf8');
const agentRuntimeAgents = readFileSync(new URL('../src/agent-runtime/AGENTS.md', import.meta.url), 'utf8');
const contractsManifest = JSON.parse(
  readFileSync(new URL('../docs/contracts.manifest.json', import.meta.url), 'utf8'),
);

/**
 * @param {string} id
 * @returns {{ sources: string[] }}
 */
const contractById = (id) =>
  contractsManifest.contracts.find(
    /** @param {{ id: string }} contract */
    (contract) => contract.id === id,
  );

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

describe('agent runtime scoped agent rules', () => {
  it('documents runtime, timeline, resume lifecycle, and masking expectations', () => {
    expect(agentRuntimeAgents).toContain('agent runtime');
    expect(agentRuntimeAgents).toContain('timeline');
    expect(agentRuntimeAgents).toContain('resume lifecycle');
    expect(agentRuntimeAgents).toContain('secret masking');
    expect(agentRuntimeAgents).toContain('tool call summary');
    expect(agentRuntimeAgents).toContain('spawn');
    expect(agentRuntimeAgents).toContain('completion error');
    expect(agentRuntimeAgents).toContain('runtime state');
  });

  it('tracks runtime and timeline implementation files in the contracts manifest', () => {
    const runtimeContract = contractById('plugin-runtime');

    expect(runtimeContract.sources).toContain('src/agent-runtime/index.ts');
    expect(runtimeContract.sources).toContain('src/agent-runtime/timeline.ts');
    expect(runtimeContract.sources).not.toContain('src/agent-runtime.ts');
    expect(runtimeContract.sources).not.toContain('src/agent-timeline.ts');
  });
});
