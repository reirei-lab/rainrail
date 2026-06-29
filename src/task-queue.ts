import type { ProjectIssue, ProjectIssueSelectionOptions } from './project-issues.js';

export interface ProjectIssueClaimInput {
  issue: ProjectIssue;
  agentSessionId: string;
  branchName: string;
  commentBody: string;
}

export interface ProjectIssueReleaseInput {
  issue: ProjectIssue;
  claim: ProjectIssueClaim;
  agentSessionId: string;
  branchName: string;
  reason: string;
}

export interface ProjectIssueClaim {
  projectId?: string;
  projectItemId: string;
  statusFieldId?: string;
  statusOptionId?: string;
  agentSessionIdFieldId?: string;
  branchFieldId?: string;
  commentUrl?: string;
}

export interface TaskQueueProvider {
  name: string;
  kind: 'task-queue-provider';
  listProjectIssues(): Promise<ProjectIssue[]> | ProjectIssue[];
  claimProjectIssue(input: ProjectIssueClaimInput): Promise<ProjectIssueClaim> | ProjectIssueClaim;
  releaseProjectIssue?: (input: ProjectIssueReleaseInput) => Promise<void> | void;
  selection?: ProjectIssueSelectionOptions;
}
