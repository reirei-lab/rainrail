# AGENTS.md - GitHub webhook normalization

This directory owns GitHub webhook ingestion, signature checks, payload parsing,
and conversion into Rainrail's neutral event envelope. Keep GitHub webhook
payload details inside this boundary unless a stable normalized field is needed
by workflow code.

## Normalization Rules

- Preserve event contracts. `event.payload` must remain a normalized Rainrail
  summary, not a pass-through copy of the raw GitHub payload.
- Prefer a single primary `resource` for routing and keep related entities in
  named fields such as `pullRequest`, `pullRequests`, `comment`, `review`,
  `label`, `milestone`, `installation`, `organization`, and `repositories`.
- For review payload families, prefer the review payload as the primary
  resource over the pull request when GitHub sends both. Keep the related pull
  request separately so review workflows do not lose PR context.
- For `issue_comment`, use the `payload.issue.pull_request` marker to keep pull
  request conversation comments distinct from regular issue comments.
- For `workflow_run`, `check_suite`, and `check_run`, preserve the check or
  workflow subject as the primary resource and keep linked pull requests in
  `pullRequests`.
- For `installation`, `organization`, repository, and principal-oriented
  deliveries, keep the target resource even when the delivery has no repository.
- For `projects_v2_item`, keep both REST ids and GraphQL `node_id` /
  `project_node_id`; preserve edited field changes, including `field_node_id`.
- Do not include secrets, tokens, private payload bodies, or raw webhook payloads
  in normalized output. Use `rawPayload` references and digests for traceability.

## Tests And Docs

- Add focused tests for each new webhook family, action, or routing edge case.
- Update `docs/github-webhook-normalization.md` when a normalized field,
  resource priority, or payload-family rule changes.
- Keep `docs/contracts.manifest.json` pointed at `src/github-webhook/index.ts`
  for the implementation source and at the focused webhook tests/docs.
