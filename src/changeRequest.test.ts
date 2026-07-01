import { describe, expect, it } from 'vitest';

import { handleChangeRequestEvent } from './pr-lifecycle.js';
import { handoffRecorder, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleChangeRequestEvent', () => {
  it('returns the matching agent task to Todo when a PR review requests changes', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const statusRecords: string[] = [];

    const result = await handleChangeRequestEvent(reviewEvent({ state: 'changes_requested' }), {
      tasks: handoffRecorder({ updates, statusRecords }),
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'change-requested pull request returned to Todo',
      pullRequestNumber: 44,
      branchName: 'agent/test-pr',
      taskId: 'agent_task_1',
      projectItemId: 'PVTI_item',
      status: 'Todo',
    });
    expect(updates[0]?.commentBody).toContain('reply directly on that GitHub review discussion');
    expect(updates[0]?.commentBody).toContain('Outcome: changes_requested');
    expect(statusRecords).toEqual(['change_requested:Todo']);
  });

  it('ignores non-change-request reviews', async () => {
    const result = await handleChangeRequestEvent(reviewEvent({ state: 'approved' }), {
      tasks: handoffRecorder(),
    });

    expect(result.reason).toBe('event is not a pull request change request');
  });
});
