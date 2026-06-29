export interface ProjectIssueReference {
  repository?: string;
  number?: number;
  title?: string;
  state?: string;
  url?: string;
}

export interface ProjectIssue {
  id: string;
  contentId?: string;
  contentType?: 'Issue' | 'DraftIssue' | (string & {});
  title: string;
  state?: string;
  status?: string | null;
  assigneeLogins: readonly string[];
  repository?: string;
  number?: number;
  url?: string;
  parent?: ProjectIssueReference;
  subIssueCount?: number;
  blockedBy?: readonly ProjectIssueReference[];
}

export interface ProjectIssueSelectionOptions {
  assigneeLogin?: string;
  todoStatus?: string;
  backlogStatus?: string;
  inProgressStatus?: string;
  maxConcurrentAgentTasks?: number;
}

const defaultOptions = {
  assigneeLogin: 'reirei-agent',
  todoStatus: 'todo',
  backlogStatus: 'backlog',
  inProgressStatus: 'in-progress',
  maxConcurrentAgentTasks: 1,
} satisfies Required<ProjectIssueSelectionOptions>;

export function getNextProjectIssueToStart(
  issues: readonly ProjectIssue[],
  options: ProjectIssueSelectionOptions = {},
): ProjectIssue | undefined {
  const resolved = { ...defaultOptions, ...options };
  if (getInProgressProjectIssues(issues, resolved).length >= resolved.maxConcurrentAgentTasks) {
    return undefined;
  }
  return getUpcomingProjectIssueCandidate(issues, resolved);
}

export function getUpcomingProjectIssueCandidate(
  issues: readonly ProjectIssue[],
  options: ProjectIssueSelectionOptions = {},
): ProjectIssue | undefined {
  const resolved = { ...defaultOptions, ...options };

  for (const issue of issues) {
    if (
      !isProjectIssueAssignedTo(issue, resolved.assigneeLogin)
      || isClosedProjectIssue(issue)
      || normalizeToken(issue.status) !== normalizeToken(resolved.todoStatus)
    ) {
      continue;
    }

    if (hasChildIssues(issue, issues)) {
      if (hasUnfinishedBlocker(issue)) {
        continue;
      }
      const child = issues.find((candidate) =>
        isChildOf(candidate, issue)
        && (candidate.assigneeLogins.length === 0 || isProjectIssueAssignedTo(candidate, resolved.assigneeLogin))
        && !isClosedProjectIssue(candidate)
        && !hasUnfinishedBlocker(candidate)
        && normalizeToken(candidate.status) === normalizeToken(resolved.backlogStatus)
      );
      if (child !== undefined) {
        return child;
      }
      continue;
    }

    if (!hasUnfinishedBlocker(issue)) {
      return issue;
    }
  }

  return undefined;
}

export function getInProgressProjectIssues(
  issues: readonly ProjectIssue[],
  options: ProjectIssueSelectionOptions = {},
): ProjectIssue[] {
  const resolved = { ...defaultOptions, ...options };
  const inProgressStatus = normalizeToken(resolved.inProgressStatus);
  const assignedInProgressIssues = issues.filter((issue) =>
    isProjectIssueAssignedTo(issue, resolved.assigneeLogin)
    && !isClosedProjectIssue(issue)
    && normalizeToken(issue.status) === inProgressStatus
  );
  const assignedTodoParents = issues.filter((issue) =>
    isProjectIssueAssignedTo(issue, resolved.assigneeLogin)
    && !isClosedProjectIssue(issue)
    && normalizeToken(issue.status) === normalizeToken(resolved.todoStatus)
    && hasChildIssues(issue, issues)
  );
  const childInProgressIssues = issues.filter((issue) =>
    !isClosedProjectIssue(issue)
    && normalizeToken(issue.status) === inProgressStatus
    && assignedTodoParents.some((parent) => isChildOf(issue, parent))
  );

  return uniqueIssues([...assignedInProgressIssues, ...childInProgressIssues]);
}

export function isProjectIssueAssignedTo(issue: ProjectIssue, assigneeLogin: string): boolean {
  const normalized = normalizeLogin(assigneeLogin);
  return issue.assigneeLogins.some((login) => normalizeLogin(login) === normalized);
}

export function isClosedProjectIssue(issue: Pick<ProjectIssue, 'contentType' | 'state'>): boolean {
  return issue.contentType === 'Issue' && issue.state?.trim().toLowerCase() === 'closed';
}

function hasChildIssues(issue: ProjectIssue, issues: readonly ProjectIssue[]): boolean {
  return (issue.subIssueCount ?? 0) > 0 || issues.some((candidate) => isChildOf(candidate, issue));
}

function isChildOf(issue: ProjectIssue, parent: ProjectIssue): boolean {
  const parentKey = issueKey(parent);
  return parentKey !== undefined && issueKey(issue.parent) === parentKey;
}

function hasUnfinishedBlocker(issue: ProjectIssue): boolean {
  return (issue.blockedBy ?? []).some((blocker) => blocker.state?.trim().toLowerCase() !== 'closed');
}

function issueKey(issue: ProjectIssue | ProjectIssueReference | undefined): string | undefined {
  if (issue?.repository === undefined || issue.number === undefined) {
    return undefined;
  }
  return `${normalizeLogin(issue.repository)}#${issue.number}`;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function normalizeToken(value: string | null | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[\s_-]+/gu, '');
}

function uniqueIssues(issues: readonly ProjectIssue[]): ProjectIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.id)) {
      return false;
    }
    seen.add(issue.id);
    return true;
  });
}
