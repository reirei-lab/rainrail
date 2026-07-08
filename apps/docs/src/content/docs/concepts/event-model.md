---
title: Event model
description: How provider deliveries become neutral Rainrail event envelopes.
---

Rainrail routes normalized events, not raw provider payloads. A source adapter
accepts provider input, extracts the safe routing fields, and returns a
`RainrailEventEnvelope`.

## Envelope shape

Every event uses `schemaVersion: "rainrail.event.v1"` and carries:

- `id` for deterministic duplicate handling.
- `source` for the provider or local input surface.
- `name` such as `github.issue`, `github.pull_request`, or
  `cloudflare.error`.
- `delivery` and `occurredAt` timestamps for replay and audit.
- `subject` for the route target, such as an issue, pull request, worker, or
  conversation.
- `payload` for normalized provider-specific facts a workflow may need.
- `rawPayload` as a redacted marker or external reference, not a committed raw
  webhook body.

## Why this boundary matters

Workflow plugins should match stable event names, subjects, and normalized
payload fields. They should not depend on GitHub webhook body details or
Cloudflare tail log structure directly.

## Source spec

Full contract details live in
[docs/plugin-runtime-contract.md](https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md).
