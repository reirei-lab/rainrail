# AGENTS.md - Rainrail Development Rules

Rainrail routes development events into agent workflows. Treat this repository
as a TypeScript monorepo, even while it is still small: keep packages, plugins,
workflow adapters, event schemas, and orchestration code in clear boundaries as
the project grows.

## Core Principles

- Preserve event contracts. Changes to payload shapes, routing decisions,
  plugin hooks, retries, or assignment behavior should be covered by tests and
  documented when they affect other agents or repositories.
- Prefer small, composable modules for event ingestion, normalization, plugin
  execution, and orchestration. Avoid coupling GitHub-specific behavior to
  generic workflow logic unless the boundary is explicit.
- Keep automation deterministic. Agent-facing workflows should be reproducible,
  observable, and easy to run locally where possible.

## TDD

- Use t-wada style TDD for implementation work.
- Write a failing test first, then implement the smallest change that makes it
  pass.
- Move in short Red-Green-Refactor cycles. Refactor only after the behavior is
  protected by tests.
- For documentation-only changes, add or update focused validation tests when
  the repository already has a practical way to enforce the rule.

## Commits

- Use Conventional Commits for every commit.
- Commit logs must be written in English.
- Keep commit messages specific to the behavior or documentation being changed.
- Examples: `docs: add Rainrail agent rules`,
  `test: cover workflow plugin routing`.

## GitHub Communication

- Issue and PR bodies and comments may be written in Japanese.
- PR descriptions should be concise and include:
  - Summary of the change
  - Verification that was run
  - Related issue, such as `Fixes #5`
- Before opening a PR, check whether the issue already has a linked PR and avoid
  duplicating active work.

## Codex Code Review Guidelines

- Write review comments in Japanese.
- Review with extra care because some changes may include code written by
  junior-level engineers or less capable AI models. Pay particular attention to:
  - security risks
  - whether tests cover edge cases

## Security

- Never commit secrets, tokens, credentials, private keys, production webhook
  payloads, or real operational credentials.
- Use placeholders in examples and document required secret names instead of
  their values.
- Treat workflow tokens and project automation credentials as sensitive even
  when they are only used in tests or documentation.

## Specification Notes

- When a specification decision is not obvious from the code or issue, capture
  it in `docs/` or `specs/` in Japanese as needed.
- Record the reason for decisions that affect plugin APIs, event normalization,
  orchestration semantics, or cross-repository automation behavior.
- Keep specs close to the implemented behavior and update them when the behavior
  changes.
