import type { RainrailEventSourceType } from './events.js';
import type { TaskQueueProvider } from './task-queue.js';

export type TaskProviderName = 'github' | 'forgejo' | 'openclaw' | (string & {});

export interface TaskIssueRef {
  provider: RainrailEventSourceType | TaskProviderName;
  repository?: string;
  id?: string;
  number?: number;
  url?: string;
}

export interface TaskIssue extends TaskIssueRef {
  id: string;
  title: string;
  state?: 'open' | 'closed' | (string & {});
  body?: string;
}

export interface TaskComment {
  id: string;
  url?: string;
}

export interface TaskCommentInput {
  target: TaskIssueRef;
  body: string;
}

export interface TaskProjectItemInput {
  target: TaskIssueRef;
  project: string;
  fields?: Record<string, string | number | boolean>;
}

export interface TaskStatusInput {
  target: TaskIssueRef;
  state: 'pending' | 'success' | 'failure' | 'error' | (string & {});
  description?: string;
  url?: string;
}

export interface TaskProposalInput {
  target: TaskIssueRef;
  title: string;
  body: string;
  branch?: string;
}

export interface TaskProposal {
  id: string;
  url?: string;
}

export interface TaskProvider {
  name: string;
  kind: 'task-provider';
  getIssue(ref: TaskIssueRef): TaskIssue | Promise<TaskIssue>;
  createComment(input: TaskCommentInput): TaskComment | Promise<TaskComment>;
  addToProject?: (input: TaskProjectItemInput) => unknown | Promise<unknown>;
  setStatus?: (input: TaskStatusInput) => unknown | Promise<unknown>;
  createProposal?: (input: TaskProposalInput) => TaskProposal | Promise<TaskProposal>;
}

export interface TaskProviderRegistry {
  tasks: TaskProvider;
  queue?: TaskQueueProvider;
  [provider: string]: unknown;
}
