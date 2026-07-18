---
title: Concepts
description: The event, runtime, and operations vocabulary behind Rainrail.
---

Rainrail is easiest to work on when provider integration, routing policy, and
agent execution stay separate. These concepts describe those boundaries before
you read the exact TypeScript contracts.

## What to read

- [Event model](/concepts/event-model/) explains normalized event envelopes.
- [Runtime boundaries](/concepts/runtime-boundaries/) separates source adapters,
  source bundles, workflow plugins, and runtime providers.
- [Event delivery](/concepts/event-delivery/) covers publish, retry, replay, and
  stream behavior.
- [Operational state](/concepts/operational-state/) explains the durable records
  behind dashboards, queues, and agent timelines.

## Source specs

These concept pages summarize the public model. Exact contract decisions live in
the linked source spec pages under the Rainrail repository.
