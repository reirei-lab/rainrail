# AGENTS.md - Cloudflare source and issue reporter

This directory owns Cloudflare tail ingestion, Cloudflare error classification,
and the workflow that reports Cloudflare errors as GitHub issues. Keep raw
Cloudflare tail payload interpretation here; bridge delivery, storage, and SSE
fan-out stay in `src/event-delivery/`, and generic workflow orchestration stays
outside this directory.

## Tail Source Rules

- Preserve the Cloudflare source contract: source type is `cloudflare`, the
  default sourceName is `cloudflare-tail`, and custom source names must stay
  stable across source plugin, intake adapter, event id, and envelope source
  fields.
- Build delivery ids from sanitized worker/script identity, normalized event
  timestamp, and `cf-ray` when present. If `cf-ray` is missing, use the adapter
  fallback delivery id with the per-batch index before using a random suffix, so
  retries can remain deterministic.
- Keep Cloudflare event ids at or below the event-envelope limit. When
  sourceName, delivery id, or event name would exceed the limit, compact the id
  deterministically and preserve enough source and delivery suffix information
  to diagnose collisions.
- Treat event id and delivery id comparisons as case-sensitive. Do not add
  case-folding, lowercasing, or display-only normalization that could collapse
  distinct Cloudflare deliveries.
- Classify `outcome=exception` and any event with normalized exceptions as
  `cloudflare.error`; also keep the explicit Cloudflare failure outcomes mapped
  to failure. Non-error tail events remain `cloudflare.tail`.
- Sanitize request URLs, worker names, exception names, messages, and stacks
  before they enter the Rainrail envelope. Never store raw Cloudflare tail
  payloads, request headers, tokens, cookies, or unbounded exception details.

## Issue Reporter Rules

- The issue reporter only handles `cloudflare.error` events with enough
  exception stack data to form a stable fingerprint. Non-error tail events and
  incomplete error payloads must be deterministic no-ops.
- Fingerprints must be derived from sanitized script, event, exception, request,
  response, and stack signature fields. Do not include secrets, raw payload
  bodies, full URLs, query strings, or delivery ids in the fingerprint.
- Deduplicate before creating GitHub issues by checking the local store first,
  then GitHub issue body fingerprints. Keep the fingerprint lock around the
  whole lookup/create/record sequence.
- Issue titles and bodies must stay bounded, sanitized, and operator-readable.
  Include traceable event id / delivery id references, but not raw Cloudflare payloads
  or sensitive request data.

## Bridge Envelope And Compatibility

- Cloudflare source code must emit normalized `RainrailEventEnvelope` values
  that can pass the bridge room validator without provider-specific exceptions.
- Keep `rawPayload.kind` as `external-reference` with a `cloudflare://` delivery
  reference. Do not persist full Cloudflare tail payloads in bridge storage.
- Root files `src/cloudflare-tail.ts` and `src/cloudflare-issue-reporter.ts`
  are public compatibility shims. Preserve them unless a release note and
  migration plan remove those import paths.

## Tests And Docs

- Add or update focused tests before changing delivery id construction,
  fallback delivery behavior, sourceName propagation, event id compaction,
  Cloudflare error classification, exception sanitization, fingerprinting,
  deduplication, issue title/body rendering, or GitHub issue creation.
- Update `docs/cloudflare-worker.md`, `docs/repo-test-coverage-matrix.md`, and
  `docs/contracts.manifest.json` when Cloudflare source/reporter contracts,
  file locations, or public exports change.
