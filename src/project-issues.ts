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
  commentUrl?: string;
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

    const projectChildren = childIssuesOf(issue, issues);
    if (projectChildren.length > 0) {
      if (hasUnfinishedBlocker(issue)) {
        continue;
      }
      if (projectChildren.some((candidate) =>
        !isClosedProjectIssue(candidate)
        && normalizeToken(candidate.status) === normalizeToken(resolved.inProgressStatus)
      )) {
        continue;
      }
      const child = projectChildren.find((candidate) =>
        isRunnableForAgent(candidate, resolved.assigneeLogin)
        && !isClosedProjectIssue(candidate)
        && !hasUnfinishedBlocker(candidate)
        && (
          normalizeToken(candidate.status) === normalizeToken(resolved.backlogStatus)
          || normalizeToken(candidate.status) === normalizeToken(resolved.todoStatus)
        )
      );
      if (child !== undefined) {
        return child;
      }
    }

    if (issue.parent !== undefined && !hasReadyParentForChild(issue, issues, resolved)) {
      continue;
    }
    if (!hasUnfinishedBlocker(issue) && !hasInProgressSibling(issue, issues, resolved)) {
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
    && childIssuesOf(issue, issues).length > 0
  );
  const assignedParents = issues.filter((issue) =>
    isProjectIssueAssignedTo(issue, resolved.assigneeLogin)
    && !isClosedProjectIssue(issue)
    && childIssuesOf(issue, issues).length > 0
  );
  const childInProgressIssues = issues.filter((issue) =>
    !isClosedProjectIssue(issue)
    && normalizeToken(issue.status) === inProgressStatus
    && isRunnableForAgent(issue, resolved.assigneeLogin)
    && assignedTodoParents.some((parent) => isChildOf(issue, parent))
  );
  const runnableChildInProgressIssues = issues.filter((issue) =>
    issue.parent !== undefined
    && !isClosedProjectIssue(issue)
    && normalizeToken(issue.status) === inProgressStatus
    && isRunnableForAgent(issue, resolved.assigneeLogin)
    && assignedParents.some((parent) => isChildOf(issue, parent))
  );

  return uniqueIssues([...assignedInProgressIssues, ...childInProgressIssues, ...runnableChildInProgressIssues]);
}

export function isProjectIssueAssignedTo(issue: ProjectIssue, assigneeLogin: string): boolean {
  const normalized = normalizeLogin(assigneeLogin);
  return issue.assigneeLogins.some((login) => normalizeLogin(login) === normalized);
}

export function isClosedProjectIssue(issue: Pick<ProjectIssue, 'contentType' | 'state'>): boolean {
  return issue.contentType === 'Issue' && issue.state?.trim().toLowerCase() === 'closed';
}

function childIssuesOf(issue: ProjectIssue, issues: readonly ProjectIssue[]): ProjectIssue[] {
  return issues.filter((candidate) => isChildOf(candidate, issue));
}

function hasReadyParentForChild(
  issue: ProjectIssue,
  issues: readonly ProjectIssue[],
  options: Required<ProjectIssueSelectionOptions>,
): boolean {
  const parent = issues.find((candidate) => isChildOf(issue, candidate));
  return parent !== undefined
    && isProjectIssueAssignedTo(parent, options.assigneeLogin)
    && !isClosedProjectIssue(parent)
    && normalizeToken(parent.status) === normalizeToken(options.todoStatus)
    && !hasUnfinishedBlocker(parent);
}

function hasInProgressSibling(
  issue: ProjectIssue,
  issues: readonly ProjectIssue[],
  options: Required<ProjectIssueSelectionOptions>,
): boolean {
  if (issue.parent === undefined) {
    return false;
  }
  const parent = issue.parent;
  return issues.some((candidate) =>
    candidate.id !== issue.id
    && isChildOf(candidate, parent)
    && !isClosedProjectIssue(candidate)
    && normalizeToken(candidate.status) === normalizeToken(options.inProgressStatus)
  );
}

function isRunnableForAgent(issue: ProjectIssue, assigneeLogin: string): boolean {
  return issue.assigneeLogins.length === 0 || isProjectIssueAssignedTo(issue, assigneeLogin);
}

function isChildOf(issue: ProjectIssue, parent: ProjectIssue | ProjectIssueReference): boolean {
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
