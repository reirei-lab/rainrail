import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const matrix = readFileSync(
  new URL('../docs/repo-test-coverage-matrix.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** @param {RegExp} pattern */
const extractBacktickPaths = (pattern) => [...matrix.matchAll(pattern)].flatMap((match) => {
  const path = match[1];
  return path === undefined ? [] : [path];
});

const rainrailTestPaths = extractBacktickPaths(/`((?:src|scripts)\/[^`]+\.test\.(?:ts|mjs))`/g);

const rainrailSourcePaths = extractBacktickPaths(/`(src\/[^`]+\.ts)`/g)
  .filter((path) => !path.endsWith('.test.ts'));

describe('source repository test coverage matrix', () => {
  it('records the source repositories and current Rainrail verification command', () => {
    expect(matrix).toContain('# Source repository test coverage matrix');
    expect(matrix).toContain('github-eep-bridge');
    expect(matrix).toContain('eep-bridge-worker');
    expect(matrix).toContain('reirei-harness');
    expect(matrix).toContain('`pnpm test`');
  });

  it('maps each original test file to a Rainrail test or a documented alternate check', () => {
    for (const originalTest of [
      'github-eep-bridge/test/server.test.js',
      'github-eep-bridge/test/bridge-room.test.js',
      'github-eep-bridge/test/github-normalize.test.js',
      'github-eep-bridge/test/github-signature-worker.test.js',
      'github-eep-bridge/test/github-signature.test.js',
      'eep-bridge-worker/test/bridge-room.test.js',
      'eep-bridge-worker/test/cloudflare-tail.test.js',
      'eep-bridge-worker/test/events-auth.test.js',
      'eep-bridge-worker/test/github-normalize.test.js',
      'eep-bridge-worker/test/github-signature.test.js',
      'eep-bridge-worker/test/sse.test.js',
      'reirei-harness/test/agentAssignment.test.ts',
      'reirei-harness/test/agentRunner.test.ts',
      'reirei-harness/test/agentTaskCompletion.test.ts',
      'reirei-harness/test/agentTimeline.test.ts',
      'reirei-harness/test/autoMerge.test.ts',
      'reirei-harness/test/changeRequest.test.ts',
      'reirei-harness/test/checkFailure.test.ts',
      'reirei-harness/test/cloudflareIssueReporter.test.ts',
      'reirei-harness/test/codexCleanAutoMerge.test.ts',
      'reirei-harness/test/codexReview.test.ts',
      'reirei-harness/test/config.test.ts',
      'reirei-harness/test/conflictCheck.test.ts',
      'reirei-harness/test/dashboard.test.ts',
      'reirei-harness/test/githubAuth.test.ts',
      'reirei-harness/test/githubProject.test.ts',
      'reirei-harness/test/githubPullRequest.test.ts',
      'reirei-harness/test/matcher.test.ts',
      'reirei-harness/test/mentionDraft.test.ts',
      'reirei-harness/test/projectIssues.test.ts',
      'reirei-harness/test/reviewRequest.test.ts',
      'reirei-harness/test/router.test.ts',
      'reirei-harness/test/runner.test.ts',
      'reirei-harness/test/store.test.ts',
    ]) {
      expect(matrix, originalTest).toContain(`\`${originalTest}\``);
    }

    for (const rainrailTest of rainrailTestPaths) {
      expect(matrix, rainrailTest).toContain(`\`${rainrailTest}\``);
      expect(existsSync(new URL(`../${rainrailTest}`, import.meta.url)), rainrailTest).toBe(true);
    }

    expect(matrix).toContain('Not ported as a separate Rainrail workflow');
  });

  it('points Rainrail module references at files that exist in this repository', () => {
    expect(rainrailSourcePaths.length).toBeGreaterThan(0);

    for (const rainrailSource of rainrailSourcePaths) {
      expect(existsSync(new URL(`../${rainrailSource}`, import.meta.url)), rainrailSource).toBe(true);
    }
  });

  it('links the matrix from the README', () => {
    expect(readme).toContain('[docs/repo-test-coverage-matrix.md](docs/repo-test-coverage-matrix.md)');
  });
});
