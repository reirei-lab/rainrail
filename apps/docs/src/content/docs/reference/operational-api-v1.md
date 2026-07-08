---
title: Operational API v1
description: Dashboard and future mobile API resources for Rainrail operations.
---

Operational API v1 gives UI clients a stable projection of Rainrail activity
without exposing internal store shapes or unsafe provider payloads.

## Resources

The API groups overview, events, workflow runs, agent tasks, sources, queue, and
settings into compact list rows and detailed records. Mutating actions use
explicit scope checks and confirmation rules.

## Safety rule

Responses must remain dashboard-safe. Raw provider payloads, secrets, tokens,
and unbounded log bodies do not belong in public API records.

## Source spec

The full API contract lives in
[docs/operational-api-v1.md](https://github.com/reirei-lab/rainrail/blob/main/docs/operational-api-v1.md).
