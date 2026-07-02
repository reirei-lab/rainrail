# Rainrail

Rainrail routes development events into agent workflows.

This repository is starting with the same issue intake automation used by
DelegateNative: newly opened GitHub issues are assigned to `reirei-agent` and
added to the reirei-lab `Reirei` project.

## Plugin runtime contract

Rainrail's first runtime boundary is documented in
`docs/plugin-runtime-contract.md` and exported from `src/index.ts`.
Source plugins normalize provider-specific inputs into `RainrailEventEnvelope`;
workflow plugins consume those neutral events through `createRuntimeDispatcher`.

## Pull Request CI

Every pull request runs the `Pull Request CI` GitHub Actions workflow with
read-only repository permissions. Same-repository PRs and PRs opened by GitHub
actors with `OWNER`, `MEMBER`, or `COLLABORATOR` association run on the
organization self-hosted runner. Other fork PRs run on `ubuntu-latest` so
untrusted pull request code is not executed on the self-hosted runner.

The workflow installs dependencies with `pnpm install --frozen-lockfile`,
caches pnpm dependencies from `pnpm-lock.yaml`, and runs these checks as
separate steps so failures identify the command that failed:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Cloudflare Worker

Cloudflare Worker として deploy する手順、required secrets、local dev と
production smoke は `docs/cloudflare-worker.md` にまとめている。

## Mention Draft And Cloudflare Issue Reporter

Rainrail exports workflow plugins for two automation paths that were first
proven in reirei-harness:

- `createMentionDraftWorkflow` turns GitHub issue comments and pull request
  review comments that mention the configured agent into Project draft items.
- `createCloudflareIssueReporterWorkflow` turns `cloudflare.error` envelopes
  with stack traces into GitHub issues, stores `fingerprint -> issue` records in
  Rainrail storage, and searches GitHub for an existing fingerprint marker before
  creating a duplicate issue.

GitHub issue comments, issue creation, and issue search are exposed through the
generic task provider contract. Cloudflare fingerprint persistence can use the
same key-value storage shape as `RainrailBridgeRoom`.

## Source repository test coverage

The original test viewpoints from `github-eep-bridge`, `eep-bridge-worker`,
and `reirei-harness` are inventoried in
`docs/repo-test-coverage-matrix.md`, including the Rainrail test files that
cover each migrated behavior and the alternate checks for behavior that is no
longer a separate Rainrail workflow.

## Product site and docs boundary

Product-facing content for the future `apps/www` site and engineering-facing
contract/spec docs have separate responsibilities. The initial sitemap,
documentation boundary, and README / docs / examples / website roles are
documented in `docs/product-site-information-architecture.md`.

The product site is an Astro workspace package. Run these commands from the
repository root:

- `pnpm --filter www dev`
- `pnpm --filter www typecheck`
- `pnpm --filter www build`
