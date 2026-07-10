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

## Getting Started

Rainrail's installer requires Node.js 20 or newer. Install the CLI from the
public installer, reload your shell, and check the built-in help:

    curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes
    exec $SHELL
    rainrail help

Run a minimal first-use smoke test in a disposable directory:

    mkdir -p ~/rainrail-sandbox
    cd ~/rainrail-sandbox
    mkdir my-agent-ops
    cd my-agent-ops
    rainrail init
    cat rainrail.config.json
    rainrail openclaw help
    rainrail openclaw session test help

`rainrail start` starts the local harness server for the dashboard API, event
stream, and any configured local intake endpoints. It does not start or manage
the Cloudflare Worker EEP Bridge; Worker deployment and always-on ingress live
under the Cloudflare Worker operations docs.
For the browser dashboard setup flow, token generation, local URL, auth failure
guidance, and the boundary between the local operational dashboard and the
Cloudflare Pages product/docs site, see
[docs/local-dashboard.md](docs/local-dashboard.md).

Check the installed CLI version and whether a newer GitHub Release is available:

    rainrail version
    rainrail update check

Update discovery is advisory and cached locally; see
[docs/cli-update-and-version.md](docs/cli-update-and-version.md) for the exact
output, cache, and automatic notice behavior.

## Dispatching events from the CLI

`rainrail dispatch` accepts one input mode at a time and sends the validated
event to a Rainrail publish endpoint when `RAINRAIL_PUBLISH_URL` and
`RAINRAIL_PUBLISH_TOKEN` are configured. Embedded callers can still pass
`RainrailCliEnvironment.dispatchRunner` to replace the standalone publish
runner.

For ad hoc manual messages, pass the text positionally, through `--message`, or
through `--stdin`:

    rainrail dispatch "please inspect issue #263"
    rainrail dispatch --message "please inspect issue #263"
    printf '%s\n' "please inspect issue #263" | rainrail dispatch --stdin

The CLI turns message-only input into a `rainrail.manual.message` event from
the manual `cli` source before handing it to event delivery. Blank messages are
rejected before dispatch.

For replaying or testing a complete event contract, provide the whole
`rainrail.event.v1` envelope as JSON:

    rainrail dispatch --json ./event.json
    cat ./event.json | rainrail dispatch --json --stdin
    rainrail dispatch --envelope-json '{"source":{"type":"manual","name":"manual-source"},"name":"rainrail.manual.message","delivery":{"id":"delivery-demo","receivedAt":"2026-07-09T00:00:00.000Z"},"occurredAt":"2026-07-09T00:00:00.000Z","subject":{"type":"conversation","id":"thread-demo"},"payload":{"provider":"rainrail","channel":"manual","action":"message","conversation":{"id":"thread-demo"},"message":{"id":"message-demo","text":"hello from JSON"}},"rawPayload":{"kind":"inline-redacted","reference":"manual://deliveries/delivery-demo"}}'

Envelope JSON is validated before event delivery and forwarded to the publish
endpoint without re-serializing the caller-provided envelope string. The first
CLI surface intentionally does not expose per-field metadata flags; use
complete JSON envelope input when you need source, delivery, subject, payload,
or raw payload metadata to be explicit. Add the shared `--json` option before
`dispatch` when you need a machine-readable delivery summary; the summary is
limited to publish status and event identity, and does not echo payload or raw
provider data. Run `rainrail dispatch help` for the current usage and error
behavior.

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

## Core and source boundaries

Core keeps provider-neutral event delivery, replay, dispatch, runtime gates, and operational state.
It accepts already-normalized `RainrailEventEnvelope` values and keeps raw
provider payloads out of durable replay.

Source bundles compose ingress adapters such as EEP Bridge, GitHub webhook, Cloudflare tail, manual input, and web chat.
The EEP Bridge bundle is the current multi-source bundle for GitHub webhook and
Cloudflare tail ingress. Manual input and web chat are source adapters outside
that legacy EEP Bridge path, but they publish through the same Core intake and
delivery contracts.

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
- `pnpm docs:check`
- `pnpm test`
- `pnpm build`
- `pnpm e2e:dashboard` in a separate Dashboard E2E job

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
