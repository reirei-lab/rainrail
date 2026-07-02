import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const matrix = readFileSync(
  new URL('../docs/repo-test-coverage-matrix.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

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

    for (const rainrailTest of [
      'src/http-app.test.ts',
      'src/worker.test.ts',
      'src/bridge-room.test.ts',
      'src/github-webhook.test.ts',
      'src/events-auth.test.ts',
      'src/cloudflare-tail.test.ts',
      'src/sse.test.ts',
      'src/agent-assignment.test.ts',
      'src/agent-runtime.test.ts',
      'src/agent-timeline.test.ts',
      'src/autoMerge.test.ts',
      'src/changeRequest.test.ts',
      'src/checkFailure.test.ts',
      'src/cloudflare-issue-reporter.test.ts',
      'src/codexReview.test.ts',
      'src/config.test.ts',
      'src/conflictCheck.test.ts',
      'src/dashboard-api.test.ts',
      'src/github-auth.test.ts',
      'src/github-project.test.ts',
      'src/githubPullRequest.test.ts',
      'src/mention-draft.test.ts',
      'src/project-issues.test.ts',
      'src/reviewRequest.test.ts',
      'src/route-workflow.test.ts',
      'src/operational-runner.test.ts',
      'src/operational-store.test.ts',
    ]) {
      expect(matrix, rainrailTest).toContain(`\`${rainrailTest}\``);
    }

    expect(matrix).toContain('Not ported as a separate Rainrail workflow');
  });

  it('links the matrix from the README', () => {
    expect(readme).toContain('docs/repo-test-coverage-matrix.md');
  });
});
