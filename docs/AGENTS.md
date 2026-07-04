# AGENTS.md - docs contract drift rules

This directory owns Rainrail's durable specifications, public contract
documentation, docs manifest, and source repository coverage matrix. Keep docs
close to the behavior they describe, and treat docs drift as a contract problem
when another agent, repository, or workflow depends on the documented shape.

## Manifest And Public API Rules

- Keep `docs/contracts.manifest.json` in sync with every documented contract.
  Each contract must list current source files, docs, focused tests,
  `publicExports`, and `publicExportKinds` when the contract has a public TypeScript
  API.
- Every manifest `sources` entry under `src/**/*.ts` must be re-exported from
  `src/index.ts` as a module export. A manifest `publicExports` entry must also
  be a real exported declaration from the listed source files and must be
  re-exported by name from `src/index.ts` when it is part of Rainrail's package
  surface.
- Do not satisfy public export coverage with comment text, string literals, or a
  commented-out export. The docs check intentionally parses TypeScript syntax
  instead of searching source text.
- Document public export names in exact Markdown code span form, such as
  `` `WorkflowPlugin` ``, so `docs:check` can distinguish API references from
  prose.
- When a public export is removed, renamed, moved, or changed from type to value
  or value to type, update the manifest plus the matching docs or tests in the
  same change.

## Coverage Matrix Rules

- Keep `docs/repo-test-coverage-matrix.md` as the source-repository coverage
  map. Every listed source-repository test must map to a Rainrail test or an
  explicit alternate / not-ported status.
- Use existing Rainrail file paths in the matrix. If a module or test moves,
  update the matrix in the same PR as the move.
- Add a coverage-matrix row or note when behavior is intentionally verified by a
  docs check, workflow validator, typecheck, or deployability dry run instead of
  a direct unit test.

## Review Checklist

- Run `pnpm docs:check` after changing Markdown, `docs/contracts.manifest.json`,
  public exports, or coverage matrix entries.
- Check that relative Markdown links still point at repository files and that
  examples avoid secrets, tokens, production webhook bodies, and real
  operational credentials.
