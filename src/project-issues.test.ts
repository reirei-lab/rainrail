import { describe, expect, it } from 'vitest';

import {
  getInProgressProjectIssues,
  getNextProjectIssueToStart,
  getUpcomingProjectIssueCandidate,
  isProjectIssueAssignedTo,
  type ProjectIssue,
} from './project-issues.js';

describe('project issue selection', () => {
  it('returns the first assigned todo issue when no active issue exists', () => {
    const next = issue('issue_2', {
      title: 'Implement task handoff',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
    });

    expect(getNextProjectIssueToStart([
      issue('issue_1', { status: 'Backlog', assigneeLogins: ['reirei-agent'] }),
      next,
      issue('issue_3', { status: 'Todo', assigneeLogins: ['reirei-agent'] }),
    ])).toEqual(next);
  });

  it('blocks new starts while the agent already has an in-progress issue', () => {
    expect(getNextProjectIssueToStart([
      issue('issue_1', { status: 'Todo', assigneeLogins: ['reirei-agent'] }),
      issue('issue_2', { status: 'In Progress', assigneeLogins: ['reirei-agent'] }),
    ])).toBeUndefined();
  });

  it('skips closed issues and unfinished blockers', () => {
    const ready = issue('issue_3', {
      status: 'Todo',
      state: 'OPEN',
      assigneeLogins: ['reirei-agent'],
    });

    expect(getUpcomingProjectIssueCandidate([
      issue('issue_1', {
        contentType: 'Issue',
        status: 'Todo',
        state: 'CLOSED',
        assigneeLogins: ['reirei-agent'],
      }),
      issue('issue_2', {
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        blockedBy: [{ repository: 'reirei-lab/rainrail', number: 20, state: 'OPEN' }],
      }),
      ready,
    ])).toEqual(ready);
  });

  it('expands a todo parent into the first unblocked backlog child', () => {
    const child = issue('child_2', {
      status: 'Backlog',
      assigneeLogins: [],
      repository: 'reirei-lab/rainrail',
      number: 23,
      parent: { repository: 'reirei-lab/rainrail', number: 21 },
    });

    expect(getNextProjectIssueToStart([
      issue('parent', {
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 21,
        subIssueCount: 2,
      }),
      issue('child_1', {
        status: 'Backlog',
        assigneeLogins: [],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
        blockedBy: [{ repository: 'reirei-lab/rainrail', number: 20, state: 'OPEN' }],
      }),
      child,
    ])).toEqual(child);
  });

  it('does not select children assigned to another agent', () => {
    const unassignedChild = issue('child_2', {
      status: 'Backlog',
      assigneeLogins: [],
      repository: 'reirei-lab/rainrail',
      number: 23,
      parent: { repository: 'reirei-lab/rainrail', number: 21 },
    });

    expect(getNextProjectIssueToStart([
      issue('parent', {
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 21,
        subIssueCount: 2,
      }),
      issue('child_1', {
        status: 'Backlog',
        assigneeLogins: ['other-agent'],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      }),
      unassignedChild,
    ])).toEqual(unassignedChild);
  });

  it('starts a todo parent when its sub-issues are not present in the Project queue', () => {
    const parent = issue('parent', {
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
      repository: 'reirei-lab/rainrail',
      number: 21,
      subIssueCount: 2,
    });

    expect(getNextProjectIssueToStart([parent])).toEqual(parent);
  });

  it('does not count in-progress children assigned to another agent', () => {
    const next = issue('issue_30', {
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
      repository: 'reirei-lab/rainrail',
      number: 30,
    });

    expect(getNextProjectIssueToStart([
      issue('parent', {
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 21,
      }),
      issue('child', {
        status: 'In Progress',
        assigneeLogins: ['other-agent'],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      }),
      next,
    ])).toEqual(next);
  });

  it('normalizes status spellings and assignee login case', () => {
    const next = issue('issue_1', {
      status: ' To Do ',
      assigneeLogins: ['Reirei-Agent'],
    });

    expect(isProjectIssueAssignedTo(next, 'reirei-agent')).toBe(true);
    expect(getNextProjectIssueToStart([next], { todoStatus: 'to-do' })).toEqual(next);
    expect(getInProgressProjectIssues([
      issue('issue_2', { status: 'in_progress', assigneeLogins: ['reirei-agent'] }),
    ])).toHaveLength(1);
  });
});

function issue(id: string, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    id,
    contentId: `content_${id}`,
    contentType: 'Issue',
    title: 'Issue title',
    status: 'Todo',
    assigneeLogins: ['reirei-agent'],
    repository: 'reirei-lab/rainrail',
    number: 1,
    url: 'https://github.com/reirei-lab/rainrail/issues/1',
    ...overrides,
  };
}
