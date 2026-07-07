# Rainrail engineering docs

Rainrail has two documentation surfaces:

- Product overview: [rainrail.dev](https://rainrail.dev)
- Product docs gateway: [rainrail.dev/docs](https://rainrail.dev/docs)

This `docs/` directory is the engineering source of truth for contracts,
normalization rules, operations, deploy procedures, and repository coverage.
Use the product site when you need the narrative path. Use these files when
you are implementing or reviewing Rainrail behavior.

## Contracts and event delivery

- [Plugin runtime contract](plugin-runtime-contract.md): source plugin,
  manual/chat input source, workflow plugin, runtime provider, and dispatcher
  boundaries.
- [Core / EEP Bridge / Source adapter boundary](core-eep-bridge-source-adapter-boundary.md):
  package/module responsibilities between Core, provider ingress bundles,
  source adapters, and transport adapters.
- [GitHub webhook normalization](github-webhook-normalization.md): how GitHub
  webhook payloads become neutral Rainrail event envelopes.
- [Event delivery](event-delivery.md): delivery, retry, and bridge room
  behavior across event sources and runtimes.
- [Operational state](operational-state.md): persistent state used by
  workflows and runtime coordination.
- [Operational API v1](operational-api-v1.md): dashboard/mobile API resource,
  schema, pagination, auth scope, audit, and migration policy.
- [Contracts manifest](contracts.manifest.json): machine-checked links between
  public exports, implementation files, docs, and tests.

## Product and repository orientation

- [Product site information architecture](product-site-information-architecture.md):
  responsibility boundaries between `apps/www`, README, docs, and examples.
- [Repository test coverage matrix](repo-test-coverage-matrix.md): migrated
  behavior coverage from the source projects into Rainrail tests.
- [Task queue project issues](task-queue-project-issues.md): GitHub Project
  issue queue selection, locks, and status semantics.

## Operations and deployment

- [CLI update check and version commands](cli-update-and-version.md): user and
  implementation-facing behavior for `rainrail version`, `rainrail update
  check`, cache handling, and automatic update notices.
- [Local dashboard startup](local-dashboard.md): `rainrail start` local
  dashboard URL, token setup, auth failure guidance, Pages boundary, and MVP
  exclusions.
- [Cloudflare Worker operations](cloudflare-worker.md): Worker deploy, secrets,
  local dev, and production smoke checks.
- [Cloudflare Pages operations](cloudflare-pages.md): product site preview and
  production deploys for the `rainrail-www` Pages project.
- [Cloudflare self-host deploy template](templates/cloudflare-self-host-deploy.yml):
  workflow template for deploys from a self-hosted runner.

## Examples

- [Plugin runtime sample](examples/plugin-runtime.ts): compact source plugin
  and workflow plugin sample that exercises the public runtime contract.
