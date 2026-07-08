---
title: Event delivery
description: Publish, duplicate handling, retry, replay, and event streams.
---

Rainrail delivery is designed to be deterministic enough for agents and
observable enough for operators.

## Delivery path

Source adapters publish normalized envelopes to Core. Core validates the
envelope, stores replay-safe data, fans out stream events, and dispatches
matching workflow plugins.

## Duplicate and retry behavior

Event IDs are deterministic for the same provider delivery. Duplicate publishes
become no-ops where possible, while retryable workflow failures remain visible
in operational state.

## Replay boundary

Durable replay uses sanitized envelope projections. Raw provider bodies,
secrets, tokens, log bodies, and comment text are not stored as replay payloads.

## Source spec

Full delivery behavior lives in
[docs/event-delivery.md](https://github.com/reirei-lab/rainrail/blob/main/docs/event-delivery.md).
