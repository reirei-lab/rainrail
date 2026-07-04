# AGENTS.md - GitHub providers

This directory owns GitHub-specific provider code. Keep GitHub REST and GraphQL
shapes behind provider interfaces, and expose stable Rainrail types to the
workflow, assignment, and runtime layers.

## GitHub Project task queue

- Treat `project-task-queue.ts` as the GitHub Project v2 adapter for the
  neutral `TaskQueueProvider` contract. Do not leak Project v2 field ids,
  option ids, node shapes, or mutations into `agent-assignment.ts`,
  `project-issues.ts`, or workflow code.
- Preserve the two-step claim lifecycle. `claimProjectIssue` obtains the
  exclusive starting lock before dispatch; `finalizeProjectIssueClaim` marks
  the lock as dispatched and then updates the Project item. Do not move the
  item to `In Progress` until dispatch is durable.
- If dispatch fails before durable start, release or roll back the starting lock
  through `releaseProjectIssue`. A dispatch failure must not leave an issue
  permanently claimed or make a later run skip a ready task.
- Keep claim ownership deterministic. The starting lock metadata must identify
  the agent session, branch, Project item, original Status field value, and
  repository ref context needed to reconcile interrupted updates.
- Treat a dispatched lock as protective state. Do not automatically reclaim it
  as stale just because its TTL has passed; use it to prevent duplicate agent
  starts and to restore Project fields when finalization was interrupted.

## Status, Drafts, And Assignees

- Resolve the configured Status field and option ids by name, and fail loudly
  when the Project field lookup is ambiguous or missing. Do not hard-code field
  ids from a live Project into source or tests.
- Preserve Todo, Backlog, and In Progress semantics from configuration. Status
  comparisons should remain normalized, but updates must write the intended
  Project option rather than a display string.
- Keep draft issue handling separate from GitHub Issue close-state handling.
  A draft issue has no GitHub issue `state`; do not treat it as closed, and do
  not overwrite existing mention draft items when the same source comment can be
  reused.
- Respect child issue and assignee rules in `project-issues.ts`. A child issue
  with no assignee can run under an assigned parent, but an explicitly assigned
  child issue belongs to that assignee. Parent and sibling `In Progress` checks
  must continue to prevent duplicate work.
- Preserve existing assignee data when mapping Project items. Provider code may
  filter by the configured agent login, but it must not invent assignment or
  drop other assignees from neutral issue data.

## GraphQL Review Checks

- Check GraphQL pagination whenever a query lists Project items, fields,
  sub-issues, blockers, assignees, labels, or related content. Follow
  `pageInfo.hasNextPage` and pass the returned cursor until the collection is
  exhausted.
- Keep field lookup idempotent and cache-safe. Metadata reuse is fine, but code
  must still distinguish the Status field, Agent session ID field, and Branch
  field by configured names.
- Make create/update paths idempotent. Before creating a mention draft item or
  claim lock, look for an existing matching item or lock and reuse it when it
  represents the same source comment, agent session, or branch.
- When retries are possible, design mutations so a repeated attempt converges
  on the same Project state. Updating Status, Agent session ID, Branch, and
  lock metadata should be safe after partial success.
- Add focused tests before changing GraphQL pagination, field lookup,
  idempotency, claim recovery, `releaseProjectIssue`, draft issue reuse, child
  issue selection, or assignee-sensitive selection.
