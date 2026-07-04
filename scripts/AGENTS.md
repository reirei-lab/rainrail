# AGENTS.md - validation script rules

This directory owns repository validation scripts and tests for docs drift,
workflow safety, package scripts, Cloudflare deployability, and project-level
documentation checks. Keep validators deterministic and runnable through the
package scripts used in CI.

## Docs Drift Rules

- `check-docs-drift.mjs` is the implementation behind `docs:check`. Keep it
  focused on repository-local invariants: Markdown links, the docs manifest,
  public export coverage, and changed contract source coverage.
- Use the TypeScript parser for public export detection. Do not replace it with
  broad text matching that would count comment text, string literals, or a
  commented-out export as an API declaration.
- Keep public export kind checks strict. Type-only exports must not satisfy
  value exports, and declared / const-enum-only shapes must not become runtime
  API by accident.
- When docs drift behavior changes, add focused cases to
  `check-docs-drift.test.mjs` before changing the validator.

## Workflow And CI Validator Rules

- Keep workflow rules encoded in focused validator tests such as
  `validate-pr-ci-workflow.test.mjs` and
  `validate-cloudflare-deploy-ci.test.mjs`.
- Validator tests should check runner trust boundaries, token permissions,
  checkout credential persistence, artifact handoff, `node-version`, Node runtime
  alignment, pnpm lockfile installs, and deploy-secret handling.
- Prefer assertions on the contract that matters over brittle whole-file
  snapshots. If YAML structure becomes too complex for string checks, introduce
  a parser with tests instead of widening regexes.

## Package Script Rules

- Keep package scripts and validators aligned. If `docs:check`, `test`,
  `typecheck`, build, Cloudflare, or Pages script names change, update
  `validate-package-scripts.test.mjs`, workflow validators, docs, and CI YAML
  together.
- Scripts must not require production secrets for local validation. Secret-backed
  deploy checks should fail closed or skip with a clear notice while never
  printing secret values.
