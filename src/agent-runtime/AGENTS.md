# AGENTS.md - agent runtime lifecycle

This directory owns Rainrail's agent runtime provider, OpenClaw task spawning,
resume lifecycle, runtime completion parsing, and dashboard-safe timeline
projection. Treat runtime state as operational data: preserve enough detail to
reconcile tasks deterministically, but never expose credentials or private log
content through summaries, timeline rows, or errors.

## Runtime Boundaries

- Keep provider startup, resume, completion parsing, and timeline extraction in
  this directory. Workflow code may request a run or read a status, but should
  not parse OpenClaw logs, trajectory JSONL, or runtime command output directly.
- Preserve runtime state across spawn, resume, completion error, timeout, and
  cancellation paths. A failed spawn or resume must be observable without
  replacing the last known task state with partial metadata.
- Keep runtime ids stable and deterministic enough for reconciliation. Do not
  change session keys, attempt ids, run ids, or log filenames without updating
  the focused lifecycle tests and `docs/plugin-runtime-contract.md`.
- Do not make dashboard or API code depend on raw runtime logs. Expose typed,
  redacted summaries from here instead.

## Secret Masking

- Apply secret masking before returning completion summaries, prompt errors,
  timeout phases, timeline excerpts, timeline detail, raw JSONL, stderr tails,
  or tool call summary text to callers.
- Treat authorization headers, bearer tokens, GitHub tokens, private keys,
  environment assignments, webhook secrets, cookies, and npm tokens as
  sensitive even inside tests.
- Prefer regression fixtures with fake credentials and assert on the redacted
  placeholder, not on the original secret shape.
- Do not store raw private payloads or full logs in normalized runtime state;
  keep file paths and bounded, redacted excerpts for traceability.

## Timeline Rules

- Timeline entries should be human-readable task activity, not a raw transcript.
  Classify tool calls and lifecycle events into stable phases before exposing
  them to operational dashboards.
- Keep fallback session handling explicit. A fallback trajectory must not hide a
  non-fallback session id, and diagnostic JSON fragments must not be trusted as
  session metadata.
- Bound every log, pointer, and JSONL read by byte limits. When truncation is
  possible, keep enough trailing context to preserve the latest lifecycle event
  without reading unbounded files.

## Tests And Docs

- Add focused tests before changing spawn arguments, resume attempt metadata,
  completion status mapping, lifecycle state transitions, timeline
  classification, or redaction behavior.
- Cover spawn error, resume error, timeout, cancellation, completed, failed, and
  skipped outcomes when the behavior can affect reconciliation.
- Update `docs/plugin-runtime-contract.md`, `docs/repo-test-coverage-matrix.md`,
  and `docs/contracts.manifest.json` when exported runtime APIs, file
  locations, or lifecycle semantics change.
