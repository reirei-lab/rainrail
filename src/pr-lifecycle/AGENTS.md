# AGENTS.md - PR lifecycle workflow

This directory owns Rainrail's PR lifecycle workflows: review requests,
change-request handoff, Codex review handoff, failed-check handoff, base-branch
conflict checks, and auto-merge decisions. Keep GitHub API access behind
`GitHubPullRequestProvider`; workflow decisions should use normalized
`PullRequestReviewTarget`, `PullRequestCheck`, `PullRequestReview`, and
`PullRequestReviewComment` state instead of raw GitHub payloads.

## Module Split

- The implementation currently lives in `src/pr-lifecycle.ts`. Move behavior
  into `src/pr-lifecycle/index.ts` only with a compatibility shim at
  `src/pr-lifecycle.ts` so existing imports keep working.
- Split only when the destination modules are protected by focused tests. Keep
  review request, change-request, Codex review, check failure, conflict check,
  auto-merge, comment formatting, and shared freshness helpers in separate
  modules when that reduces coupling.
- Do not move provider HTTP, GraphQL pagination, or project-item mutation code
  into this boundary. Provider adapters may fetch pages, but this workflow
  boundary decides from normalized, complete snapshots.

## Review Freshness

- Treat Codex review comments as actionable only when the review belongs to the
  current PR head. Compare review commit ids with the live `headSha` when it is
  available, and prefer live PR state over webhook snapshots.
- For configured reviewer decisions, use the latest actionable review by that
  reviewer on the current head, not only aggregate `reviewDecision`.
- Unresolved change requests from any reviewer are blockers until a newer
  actionable review or dismissal on the same head resolves them. Pending review
  drafts must not hide unresolved change requests.
- A delayed approval, dismissal, or Codex review webhook may mean GitHub has not
  reflected review state yet. Retry instead of merging or returning a task when
  live reviews still contradict the current webhook.
- Codex review handoff should include inline review comments from the matching
  review id. Provider adapters must handle review comments pagination before
  returning the normalized comment list.
- Any unresolved review thread is a blocker for auto-merge once thread data is
  available. Do not treat missing pagination or a partial thread page as proof
  that all discussions are resolved.

## Check Freshness

- Check and status events must match the current PR `headSha` before returning a
  task to Todo or requesting review.
- Ignore stale checks from old commits. If the live check rollup for the current
  head has already passed, do not return the task because of an older failed
  check event.
- When candidates are expanded by head SHA, retry if GitHub has not reflected
  the latest check state on all matching agent PR candidates.
- Keep check success semantics in the shared check-rollup helper so check run,
  status, and future workflow events agree on pending, failed, skipped, and
  successful states.

## Auto-Merge Blockers

- Auto-merge is allowed only for configured target repositories, agent-authored
  branches, open non-draft PRs, and the configured reviewer approval on the
  current head.
- The auto-merge blockers include unresolved change requests, unresolved review
  thread discussions, stale or missing successful checks, merge conflicts,
  pending mergeability, missing runtime merge capability, repository allow-list
  mismatch, draft PR state, closed PR state, and head SHA mismatches.
- Merge execution must go through `context.actions.mergePullRequest` with an
  explicit `PullRequestMergeMethod`. Do not expose direct merge methods from
  `GitHubPullRequestProvider`.
- Never merge from aggregate `reviewDecision` alone. If live reviews are absent
  or contradictory, return a deterministic non-merge result or throw a retryable
  reflection error.

## Tests And Docs

- Add or update focused tests in `src/reviewRequest.test.ts`,
  `src/changeRequest.test.ts`, `src/codexReview.test.ts`,
  `src/checkFailure.test.ts`, `src/conflictCheck.test.ts`, or
  `src/autoMerge.test.ts` before changing lifecycle decisions.
- Cover pagination-sensitive behavior at the provider boundary and assert that
  workflow code receives complete normalized snapshots.
- Update `docs/plugin-runtime-contract.md`, `docs/repo-test-coverage-matrix.md`,
  and `docs/contracts.manifest.json` when exported PR lifecycle APIs, file
  locations, or workflow semantics change.
