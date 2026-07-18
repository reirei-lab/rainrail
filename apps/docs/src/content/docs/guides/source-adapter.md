---
title: Add a source adapter
description: Connect a new provider signal to Rainrail without leaking provider details.
---

Use a source adapter when a provider or local input surface needs to publish a
new Rainrail event.

## Steps

1. Define the provider input shape and the normalized event names it can emit.
2. Map provider delivery metadata into `delivery`, `occurredAt`, `source`, and
   `subject`.
3. Put workflow-needed facts in `payload` and keep raw provider data behind
   `rawPayload` references or redacted markers.
4. Generate deterministic event IDs for retries and duplicate deliveries.
5. Add focused tests for normalization, redaction, credential-looking values,
   and edge-case provider payloads.
6. Update the source spec and contracts manifest if public exports or contract
   docs change.

## Source spec

Adapter boundaries are defined in
[docs/core-eep-bridge-source-adapter-boundary.md](https://github.com/reirei-lab/rainrail/blob/main/docs/core-eep-bridge-source-adapter-boundary.md).
