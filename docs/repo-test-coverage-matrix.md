# Source repository test coverage matrix

This inventory tracks the original test viewpoints from `github-eep-bridge`,
`eep-bridge-worker`, and `reirei-harness`, and records where the equivalent
coverage now lives in Rainrail.

Source repositories verified on 2026-07-02:

- `github-eep-bridge`: https://github.com/hiragram/github-eep-bridge
- `eep-bridge-worker`: https://github.com/reirei-lab/eep-bridge-worker
- `reirei-harness`: https://github.com/reirei-lab/reirei-harness

## Verification

Rainrail pull request CI runs `pnpm test`, which executes `vitest run scripts src`.
The Rainrail test paths listed below are therefore covered by CI whenever
they are present in `src/` or `scripts/`.

## Coverage status

- `Ported`: Rainrail has a direct package-level test for the original behavior.
- `Covered by split`: the original larger behavior was decomposed into smaller
  Rainrail workflow, provider, runtime, or storage tests.
- `Alternate check`: the original behavior is no longer a separate runtime
  responsibility, and the matrix records the replacement verification.
- `Not ported`: the original behavior does not exist as a Rainrail feature.

## EEP bridge inventory

| Original test | Original viewpoint | Rainrail package/module | Rainrail test coverage | Status and notes |
| --- | --- | --- | --- | --- |
| `github-eep-bridge/test/server.test.js` | Signed GitHub webhook acceptance and unsigned rejection through the Node server. | `src/eep-bridge-bundle.ts`, `src/http-app.ts`, `src/node-server.ts`, `src/github-webhook/index.ts` | `src/eep-bridge-bundle.test.ts`, `src/http-app.test.ts`, `src/node-server.test.ts`, `src/github-webhook.test.ts` | Ported. Rainrail separates shared Fetch app, Node transport, EEP Bridge bundle ingress composition, and GitHub webhook normalization/signature checks. |
| `github-eep-bridge/test/bridge-room.test.js` | BridgeRoom stores published events and replays them to SSE subscribers. | `src/event-delivery/bridge-room.ts`, `src/event-delivery/event-bus.ts` | `src/bridge-room.test.ts`, `src/event-bus.test.ts` | Ported and expanded. Rainrail also covers duplicate ids, storage ordering, abort cleanup, replay limits, and serialization failure handling. |
| `github-eep-bridge/test/github-normalize.test.js` | Pull request and repository webhook payloads normalize into EEP events. | `src/github-webhook/index.ts`, `src/events.ts` | `src/github-webhook.test.ts`, `src/plugin-runtime.test.ts` | Ported as Rainrail neutral event envelopes. Repository fallback is represented through source metadata and normalized resource fields instead of EEP event shape. |
| `github-eep-bridge/test/github-signature-worker.test.js` | Worker-compatible GitHub webhook HMAC verification. | `src/github-webhook/index.ts`, `src/worker.ts` | `src/github-webhook.test.ts`, `src/worker.test.ts` | Ported. The HMAC core is Web Crypto compatible and exercised through the Worker entrypoint. |
| `github-eep-bridge/test/github-signature.test.js` | Valid, invalid, missing secret, and missing signature cases for GitHub webhook HMAC. | `src/github-webhook/index.ts` | `src/github-webhook.test.ts` | Ported. Rainrail also rejects unsupported signature schemes. |

## EEP bridge worker inventory

| Original test | Original viewpoint | Rainrail package/module | Rainrail test coverage | Status and notes |
| --- | --- | --- | --- | --- |
| `eep-bridge-worker/test/bridge-room.test.js` | Worker bridge room streams only post-subscription events, sends keep-alive comments, and expires long-lived sessions. | `src/event-delivery/bridge-room.ts`, `src/event-delivery/event-bus.ts` | `src/bridge-room.test.ts`, `src/event-bus.test.ts` | Ported and expanded. Rainrail uses replay-aware bridge storage plus explicit stream abort cleanup rather than session expiration as the only cleanup path. |
| `eep-bridge-worker/test/cloudflare-tail.test.js` | Cloudflare tail events publish to the multiplex stream, ok outcomes are handled, service-specific streams stay disabled, and health lists Cloudflare. | `src/eep-bridge-bundle.ts`, `src/cloudflare-tail.ts`, `src/http-app.ts`, `src/node-server.ts`, `src/worker.ts` | `src/eep-bridge-bundle.test.ts`, `src/cloudflare-tail.test.ts`, `src/http-app.test.ts`, `src/node-server.test.ts`, `src/worker.test.ts` | Ported. Rainrail normalizes `cloudflare.tail` and `cloudflare.error` envelopes through the EEP Bridge bundle and publishes them through the same bridge room as GitHub webhooks. |
| `eep-bridge-worker/test/events-auth.test.js` | Events endpoint requires and validates bearer tokens; service-specific endpoint points to the multiplex stream. | `src/events-auth.ts`, `src/http-app.ts` | `src/events-auth.test.ts`, `src/http-app.test.ts` | Ported. Service-specific streams are not a Rainrail public contract; clients use `/events`. |
| `eep-bridge-worker/test/github-normalize.test.js` | GitHub issue webhook normalization. | `src/github-webhook/index.ts`, `src/events.ts` | `src/github-webhook.test.ts`, `src/plugin-runtime.test.ts` | Ported as `github.issue` neutral envelope coverage. |
| `eep-bridge-worker/test/github-signature.test.js` | Async GitHub adapter signature verification and invalid signature rejection. | `src/github-webhook/index.ts` | `src/github-webhook.test.ts` | Ported. |
| `eep-bridge-worker/test/sse.test.js` | Normalized events format as SSE messages. | `src/event-delivery/sse.ts`, `src/event-delivery/event-bus.ts` | `src/sse.test.ts`, `src/event-bus.test.ts` | Ported. Rainrail also rejects unsafe SSE ids, event names, and comments. |

## Reirei harness inventory

| Original test | Original viewpoint | Rainrail package/module | Rainrail test coverage | Status and notes |
| --- | --- | --- | --- | --- |
| `reirei-harness/test/agentAssignment.test.ts` | Claim the next ready Project issue and start an agent task. | `src/agent-assignment.ts`, `src/github-project.ts`, `src/agent-runtime/index.ts` | `src/agent-assignment.test.ts`, `src/github-project.test.ts`, `src/agent-runtime/index.test.ts` | Covered by split. Rainrail separates candidate selection, claim mutation, and runtime start. |
| `reirei-harness/test/agentRunner.test.ts` | Build prompts, load repository instructions, and load latest handoff comments. | `src/agent-runtime/index.ts`, `src/agent-runtime/timeline.ts` | `src/agent-runtime/index.test.ts`, `src/agent-runtime/timeline.test.ts` | Covered by split. Rainrail keeps runtime provider behavior in the generic plugin runtime instead of a harness-only runner. |
| `reirei-harness/test/agentTaskCompletion.test.ts` | Reconcile completed, failed, idle-timeout, and skipped agent tasks. | `src/agent-runtime/index.ts`, `src/operational-runner.ts`, `src/github-project.ts` | `src/agent-runtime/index.test.ts`, `src/operational-runner.test.ts`, `src/github-project.test.ts` | Covered by split. Operational reconciliation and Project status updates are tested separately. |
| `reirei-harness/test/agentTimeline.test.ts` | Parse runtime trajectories and classify visible task phases. | `src/agent-runtime/timeline.ts`, `src/codex-activity.ts` | `src/agent-runtime/timeline.test.ts`, `src/codex-activity.test.ts` | Ported. Rainrail additionally projects timeline rows into dashboard-safe activity data. |
| `reirei-harness/test/autoMerge.test.ts` | Auto-merge agent PRs only after eligible approvals, passing checks, and repository allow-list checks. | `src/pr-lifecycle.ts`, `src/dispatcher.ts` | `src/autoMerge.test.ts`, `src/plugin-runtime.test.ts` | Ported and hardened. Merge is a gated runtime action rather than a direct provider side effect. |
| `reirei-harness/test/changeRequest.test.ts` | Return matching agent tasks to Todo when PR reviews request changes. | `src/pr-lifecycle.ts`, `src/github-project.ts` | `src/changeRequest.test.ts`, `src/github-project.test.ts` | Ported and expanded for stale reviews, fork PRs, target verification, and handoff ordering. |
| `reirei-harness/test/checkFailure.test.ts` | Return agent tasks to Todo when PR checks fail. | `src/pr-lifecycle.ts` | `src/checkFailure.test.ts` | Ported. |
| `reirei-harness/test/cloudflareIssueReporter.test.ts` | Create and deduplicate GitHub issues from Cloudflare error fingerprints. | `src/cloudflare-issue-reporter.ts`, `src/cloudflare-tail.ts` | `src/cloudflare-issue-reporter.test.ts`, `src/cloudflare-tail.test.ts` | Ported. Rainrail keeps Cloudflare tail normalization and issue reporting as separate source/workflow concerns. |
| `reirei-harness/test/codexCleanAutoMerge.test.ts` | Request Codex review for clean PRs and auto-merge after Codex approval. | `src/pr-lifecycle.ts` | `src/reviewRequest.test.ts`, `src/autoMerge.test.ts`, `src/codexReview.test.ts` | Not ported as a separate Rainrail workflow. The behavior is decomposed into review request, review feedback, and approval-triggered auto-merge workflows. |
| `reirei-harness/test/codexReview.test.ts` | Return tasks to Todo after Codex or code-quality review feedback. | `src/pr-lifecycle.ts` | `src/codexReview.test.ts` | Ported. |
| `reirei-harness/test/config.test.ts` | Parse source streams, auth, dashboard, storage, and project selection config. | `src/config.ts` | `src/config.test.ts` | Ported. |
| `reirei-harness/test/conflictCheck.test.ts` | Return conflicted task issues to Todo and prioritize/retry mergeability checks. | `src/pr-lifecycle.ts`, `src/operational-runner.ts` | `src/conflictCheck.test.ts`, `src/operational-runner.test.ts` | Ported and expanded for fork PRs, same-repository target verification, branch protection, and retry prioritization. |
| `reirei-harness/test/dashboard.test.ts` | Render and serve dashboard state, logs, settings, resume/reset, and termination actions. | `src/http-app.ts`, `src/operational-store.ts`, `src/agent-runtime/timeline.ts` | `src/dashboard-api.test.ts`, `src/operational-store.test.ts`, `src/agent-runtime/timeline.test.ts` | Covered by split. Rainrail documents operational state separately in `docs/operational-state.md`. |
| `reirei-harness/test/githubAuth.test.ts` | Select GitHub token source and cache GitHub App installation tokens. | `src/github-auth.ts` | `src/github-auth.test.ts` | Ported. |
| `reirei-harness/test/githubProject.test.ts` | Fetch Project items, select next issues, claim tasks, update statuses, and cache Project metadata. | `src/github-project.ts`, `src/project-issues.ts` | `src/github-project.test.ts`, `src/project-issues.test.ts` | Ported and expanded. Rainrail also covers sub-issue queue semantics and dispatched lock recovery. |
| `reirei-harness/test/githubPullRequest.test.ts` | Cache read-only PR lookups and avoid caching writes. | `src/github-provider.ts`, `src/pr-lifecycle.ts` | `src/githubPullRequest.test.ts` | Ported. |
| `reirei-harness/test/matcher.test.ts` | Match event routes by source, event name, nested paths, boolean trees, includes, and existence checks. | `src/route-workflow.ts` | `src/route-workflow.test.ts` | Ported to Rainrail event envelopes. |
| `reirei-harness/test/mentionDraft.test.ts` | Extract agent mentions from issue comments and PR review comments, and queue Project draft items. | `src/mention-draft.ts`, `src/event-delivery/bridge-room.ts` | `src/mention-draft.test.ts`, `src/bridge-room.test.ts` | Ported and expanded for review submissions, bridge redaction, and long mention bodies. |
| `reirei-harness/test/projectIssues.test.ts` | Select Todo issues, respect blockers, normalize statuses, and handle sub-issue queues. | `src/project-issues.ts` | `src/project-issues.test.ts` | Ported. |
| `reirei-harness/test/reviewRequest.test.ts` | Request human review for agent PRs after checks pass and review blockers clear. | `src/pr-lifecycle.ts` | `src/reviewRequest.test.ts` | Ported and expanded for delayed GitHub reflection, current-head checks, status events, and multi-candidate SHA handling. |
| `reirei-harness/test/router.test.ts` | Route events through configured matchers and report unmatched routes. | `src/route-workflow.ts` | `src/route-workflow.test.ts` | Ported. |
| `reirei-harness/test/runner.test.ts` | Auto-assign next issue, classify retryable errors, retry event handlers, and reconnect streams with backoff. | `src/operational-runner.ts`, `src/agent-assignment.ts`, `src/event-delivery/event-bus.ts` | `src/operational-runner.test.ts`, `src/agent-assignment.test.ts`, `src/event-bus.test.ts` | Covered by split. Stream reconnect timing is an adapter/runtime concern; Rainrail currently verifies event bus stream behavior and operational retry scheduling. |
| `reirei-harness/test/store.test.ts` | Persist events, activity, tasks, resume attempts, settings, retry rows, and ids across store instances. | `src/operational-store.ts` | `src/operational-store.test.ts` | Ported. |

## Current gaps and alternate checks

- `reirei-harness/test/codexCleanAutoMerge.test.ts`: Not ported as a separate
  Rainrail workflow because Rainrail intentionally splits the flow into review
  request, Codex review feedback, and auto-merge workflows. Equivalent behavior
  is covered by `src/reviewRequest.test.ts`, `src/codexReview.test.ts`, and
  `src/autoMerge.test.ts`.
- EEP Bridge bundle composition is covered by `src/eep-bridge-bundle.test.ts`,
  `src/node-server.test.ts`, and `src/worker.test.ts`; Core tests only assert
  provider-neutral intake registration and envelope publish behavior.
- Service-specific SSE endpoints from `eep-bridge-worker` are not kept as a
  Rainrail public API. The alternate check is authenticated multiplex streaming
  through `/events`, covered by `src/http-app.test.ts` and `src/events-auth.test.ts`.
- GitHub webhook normalization now targets `RainrailEventEnvelope` instead of
  EEP messages. The alternate check is neutral envelope creation and plugin
  dispatch coverage in `src/github-webhook.test.ts` and `src/plugin-runtime.test.ts`.
