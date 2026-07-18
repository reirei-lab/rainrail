---
title: Runtime boundaries
description: Source adapters, source bundles, workflow plugins, and runtime providers.
---

Rainrail keeps provider input, routing decisions, and agent execution in
separate layers.

## Core responsibilities

Core owns the neutral event schema, Bridge room publish/replay, event bus,
dispatcher, runtime/action gates, and operational store. Core receives
normalized envelopes and should not parse raw provider webhooks as routing
policy.

## Source adapters and bundles

A source adapter converts one provider input into a `RainrailEventEnvelope`. A
source bundle composes one or more adapters with ingress transport. The EEP
Bridge bundle is one bundle that wires GitHub webhook and Cloudflare tail input
to Core.

## Workflow plugins and runtime providers

Workflow plugins decide what should happen for a normalized event. Runtime
providers start the chosen agent workflow with deterministic instructions and
reporting.

## Source spec

Full boundary details live in
[docs/core-eep-bridge-source-adapter-boundary.md](https://github.com/reirei-lab/rainrail/blob/main/docs/core-eep-bridge-source-adapter-boundary.md).
