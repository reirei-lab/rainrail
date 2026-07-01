import { createHash } from 'node:crypto';

import { getInProgressProjectIssues, getNextProjectIssueToStart, type ProjectIssue } from './project-issues.js';
import type { ProjectIssueClaim, TaskQueueProvider } from './task-queue.js';

export interface AgentAssignmentRuntime {
  runId: string;
  workflow: string;
  agentId: string;
  sessionKeyPrefix: string;
  dispatchAgent(request: {
    issue: ProjectIssue;
    task: AgentAssignmentTask;
    workflow: string;
    runId: string;
  }): Promise<unknown>;
}

export interface AgentAssignmentOptions {
  queue: TaskQueueProvider;
  runtime: AgentAssignmentRuntime;
}

export interface AgentAssignmentTask {
  id: string;
  title: string;
  agentSessionId: string;
  branchName: string;
  issue: ProjectIssue;
  claim?: ProjectIssueClaim;
  dispatchResult?: unknown;
  error?: string;
}

export interface AgentAssignmentResult {
  assigned: boolean;
  reason: 'started' | 'no_todo_issue' | 'blocked_by_in_progress' | 'failed_to_start_agent';
  issues: readonly ProjectIssue[];
  task?: AgentAssignmentTask;
}

export async function assignNextProjectIssueToAgent(
  options: AgentAssignmentOptions,
): Promise<AgentAssignmentResult> {
  const issues = await options.queue.listProjectIssues();
  const selection = options.queue.selection ?? {};
  const nextIssue = getNextProjectIssueToStart(issues, selection);

  if (nextIssue === undefined) {
    return {
      assigned: false,
      reason: getInProgressProjectIssues(issues, selection).length > 0 ? 'blocked_by_in_progress' : 'no_todo_issue',
      issues,
    };
  }

  const task = agentTaskForIssue(nextIssue, options.runtime);
  let claim: ProjectIssueClaim | undefined;
  try {
    claim = await options.queue.claimProjectIssue({
      issue: nextIssue,
      agentSessionId: task.agentSessionId,
      branchName: task.branchName,
      commentBody: issueStartComment(task),
    });
    const dispatchResult = await options.runtime.dispatchAgent({
      issue: nextIssue,
      task,
      workflow: options.runtime.workflow,
      runId: options.runtime.runId,
    });
    if (options.queue.finalizeProjectIssueClaim !== undefined) {
      try {
        await options.queue.finalizeProjectIssueClaim({
          issue: nextIssue,
          claim,
          agentSessionId: task.agentSessionId,
          branchName: task.branchName,
        });
      } catch (error) {
        return {
          assigned: false,
          reason: 'failed_to_start_agent',
          issues,
          task: {
            ...task,
            claim,
            dispatchResult,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    return {
      assigned: true,
      reason: 'started',
      issues,
      task: { ...task, claim, dispatchResult },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claim !== undefined && options.queue.releaseProjectIssue !== undefined) {
      await options.queue.releaseProjectIssue({
        issue: nextIssue,
        claim,
        agentSessionId: task.agentSessionId,
        branchName: task.branchName,
        reason: message,
      });
    }
    return {
      assigned: false,
      reason: 'failed_to_start_agent',
      issues,
      task: {
        ...task,
        ...(claim === undefined ? {} : { claim }),
        error: message,
      },
    };
  }
}

function agentTaskForIssue(issue: ProjectIssue, runtime: AgentAssignmentRuntime): AgentAssignmentTask {
  const taskIssueId = taskIssueIdentity(issue);
  const taskId = `agent_task_${slug(issue.repository ?? 'unknown')}_${taskIssueId}`;
  const runSlug = slug(runtime.runId);
  return {
    id: taskId,
    title: issue.title,
    agentSessionId: `agent:${runtime.agentId}:${runtime.sessionKeyPrefix}-${taskId}-${runSlug}`,
    branchName: branchNameForIssue(issue, runSlug),
    issue,
  };
}

function branchNameForIssue(issue: ProjectIssue, runSlug: string): string {
  const repo = slug(issue.repository ?? 'repo');
  const number = taskIssueIdentity(issue);
  const title = slug(issue.title).slice(0, 48);
  return `agent/${repo}-${number}${title.length === 0 ? '' : `-${title}`}-${runSlug}`;
}

function taskIssueIdentity(issue: ProjectIssue): string {
  const base = issue.number === undefined ? slug(issue.id) : String(issue.number);
  if (issue.contentType !== 'DraftIssue') {
    return base;
  }
  const draftSource = issue.commentUrl ?? issue.id;
  return `${base}-comment-${shortHash(draftSource)}`;
}

function issueStartComment(task: AgentAssignmentTask): string {
  return [
    'Rainrail started an agent to process this issue.',
    '',
    `- Agent session: ${task.agentSessionId}`,
    `- Branch: ${task.branchName}`,
    '',
    'The agent will inspect the issue, comments, and repository before choosing whether to implement, investigate, ask a question, or propose a split.',
  ].join('\n');
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return normalized.length === 0 ? 'item' : normalized;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
