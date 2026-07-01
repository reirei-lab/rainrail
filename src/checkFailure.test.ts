import { describe, expect, it } from 'vitest';

import { handleCheckFailureEvent } from './pr-lifecycle.js';
import { checkRunEvent, handoffRecorder, pullRequest } from './pr-lifecycle-test-helpers.js';

describe('handleCheckFailureEvent', () => {
  it('comments on the issue and returns it to Todo when an agent PR check fails', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest();
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'failed PR checks returned issue to Todo',
      taskId: 'agent_task_1',
    });
    expect(updates[0]?.commentBody).toContain('- Check: Typecheck, Test, Build');
    expect(updates[0]?.commentBody).toContain('Outcome: checks_failed');
  });

  it('ignores successful checks', async () => {
    const result = await handleCheckFailureEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder(),
    });

    expect(result.reason).toBe('event is not a completed failed check for a pull request');
  });
});
