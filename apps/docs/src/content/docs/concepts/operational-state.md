---
title: Operational state
description: Durable records for events, activity, tasks, queues, and dashboards.
---

Operational state is the durable view operators use to understand what Rainrail
received, routed, retried, assigned, and completed.

## Stored records

Rainrail tracks event records, activity records, workflow run summaries, agent
tasks, retry snapshots, source status, and task queue claims. Dashboard and API
views should depend on stable projections instead of internal store shapes.

## Safety model

Operational records must be dashboard-safe. They keep identifiers, normalized
metadata, warnings, and audit summaries, but they do not expose raw webhook
bodies, secret values, or credential-looking identifiers.

## Source spec

Full operational state behavior lives in
[docs/operational-state.md](https://github.com/reirei-lab/rainrail/blob/main/docs/operational-state.md).
