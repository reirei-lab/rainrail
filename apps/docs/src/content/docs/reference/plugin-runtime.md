---
title: Plugin runtime
description: Public source plugin, workflow plugin, runtime provider, and dispatcher contract.
---

The plugin runtime contract is the main extension surface for Rainrail.

## Public model

- Source plugins normalize provider input into `RainrailEventEnvelope`.
- Workflow plugins match normalized events and choose what work to start.
- Runtime providers start agent work with scoped capabilities and observable
  completion paths.
- Dispatchers evaluate plugins against the envelope, runtime provider, and
  configured capability gates.

## Compatibility rule

Changes to event envelope fields, plugin hooks, runtime provider behavior, or
dispatcher retry semantics should ship with tests and an updated source spec.

## Source spec

The full runtime contract lives in
[docs/plugin-runtime-contract.md](https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md).
