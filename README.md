# Rainrail

Rainrail routes development events into agent workflows.

## Start here

- Product site: [rainrail.dev](https://rainrail.dev) explains what Rainrail is
  and how development events become agent workflows.
- Product docs gateway: [rainrail.dev/docs](https://rainrail.dev/docs) links
  concepts, guides, examples, and the engineering contracts in this repository.
- Engineering docs index: [docs/README.md](docs/README.md) is the GitHub entry
  point for contracts, operations, deploy notes, and coverage references.
- End-to-end example: [rainrail.dev/examples](https://rainrail.dev/examples)
  traces a GitHub issue through the project queue, agent run, review, and merge.

Use the product site for the narrative overview. Use `docs/` when you need the
durable contracts and operational decisions that implementation work depends on.

## Repository structure

- `apps/www`: Astro product site for product narrative, docs gateway pages,
  concepts, guides, and examples.
- `docs/`: engineering contracts, source normalization specs, operations notes,
  deployment procedures, and coverage references.
- `docs/examples/`: small code samples that support the engineering docs.
- `scripts/`: deterministic validation, docs drift, deployability, and smoke
  checks used by local development and CI.
- `src/`: TypeScript event contracts, source adapters, workflow plugins,
  runtime helpers, task providers, and orchestration modules.
- `.github/workflows/`: pull request CI, issue intake automation, and trusted
  Cloudflare Pages deployment workflows.

## Plugin runtime contract

Rainrail's first runtime boundary is documented in
[docs/plugin-runtime-contract.md](docs/plugin-runtime-contract.md) and exported
from `src/index.ts`.
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
production smoke は [docs/cloudflare-worker.md](docs/cloudflare-worker.md) にまとめている。

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
Issue queue selection and project status semantics are documented in
[docs/task-queue-project-issues.md](docs/task-queue-project-issues.md).

## Source repository test coverage

The original test viewpoints from `github-eep-bridge`, `eep-bridge-worker`,
and `reirei-harness` are inventoried in
[docs/repo-test-coverage-matrix.md](docs/repo-test-coverage-matrix.md),
including the Rainrail test files that cover each migrated behavior and the
alternate checks for behavior that is no longer a separate Rainrail workflow.

## Cloudflare Pages

Rainrail product site の preview / production deploy は Cloudflare Pages project
`rainrail-www` を使う。GitHub Actions secrets、repeatable deploy command、smoke
check は [docs/cloudflare-pages.md](docs/cloudflare-pages.md) にまとめている。

## Product site and docs boundary

Product-facing content for the future `apps/www` site and engineering-facing
contract/spec docs have separate responsibilities. The initial sitemap,
documentation boundary, and README / docs / examples / website roles are
documented in
[docs/product-site-information-architecture.md](docs/product-site-information-architecture.md).

The product site is an Astro workspace package. Run these commands from the
repository root:

- `pnpm --filter www dev`
- `pnpm --filter www typecheck`
- `pnpm --filter www build`
