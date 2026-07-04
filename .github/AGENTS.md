# AGENTS.md - GitHub workflow rules

This directory owns repository automation configuration: CI, deploy workflows,
Dependabot settings, workflow permissions, runner selection, and token exposure
boundaries. Treat workflow YAML as executable code that may run untrusted pull
request input.

## Pull Request CI Rules

- Do not use `pull_request_target` for PR validation. Pull request code must run
  with read-only permissions and without write-capable repository tokens.
- Keep pull request workflow permissions minimal, with `contents: read` unless a
  focused test and documented workflow need prove that another permission is
  required.
- Use `persist-credentials: false` on checkouts so workflow steps do not retain
  a push-capable token by default.
- Never run fork PR code on a `self-hosted` runner. Self-hosted PR validation is
  allowed only when the PR head is a trusted same-repository branch; trusted
  author associations do not permit `self-hosted` for fork PRs. Fork PR
  validation must fall back to GitHub-hosted runners.
- Keep typecheck, `docs:check`, tests, build, and deployability checks as
  explicit labeled steps so review failures identify the broken contract.

## Runtime And Dependency Rules

- Keep workflow `node-version` values aligned with the runtime each validator
  owns: PR CI and package-script validation use Node 26, while Cloudflare Pages
  preview / production deploy workflows intentionally use Node 24 until
  `scripts/validate-cloudflare-pages.test.mjs` and the Pages workflow move
  together. When `@types/node`, Wrangler, pnpm, or package scripts change,
  review all workflows that install or run the project.
- Use pnpm with lockfile-based caching and `pnpm install --frozen-lockfile`.
  Workflow updates that change install behavior must update the matching
  validator tests.
- Keep package script names stable in workflows unless `package.json`, docs, and
  workflow validator tests change together.

## Deploy Workflow Rules

- Deploy workflows that use secrets must run trusted deploy tooling, not
  arbitrary fork PR code. For `workflow_run` previews, check out trusted default
  branch tooling and deploy only artifacts produced by the PR CI workflow.
- Keep Cloudflare secrets scoped to deploy steps and treat
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and GitHub tokens as
  sensitive. Missing secrets should skip deploys with a notice rather than
  printing values.
- Update `scripts/validate-pr-ci-workflow.test.mjs` and
  `scripts/validate-cloudflare-deploy-ci.test.mjs` whenever PR CI runner, token,
  runtime, or Worker deployability semantics change. Update
  `scripts/validate-cloudflare-pages.test.mjs` whenever Cloudflare Pages
  `workflow_run` artifact handoff, deploy conditions, Node 24 runtime, or Pages
  deploy semantics change.
