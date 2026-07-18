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
- Plugin package manifests can contribute dashboard cards through
  `dashboard.cards[]`; see [Add dashboard cards](/guides/dashboard-cards/).

## Codex App Server runtime

`codex-app-server` is an optional official runtime provider plugin for users
who want Rainrail to start Codex CLI through the experimental Codex App Server
stdio protocol. It is not required for OpenClaw-only, GitHub-only, or
Cloudflare-only projects.

Run `rainrail setup codex-app-server --yes` inside a Rainrail project to add the
project-local plugin and write the `runtimeProviders.codexAppServer` config
entry. The setup and doctor checks use the configured `command`, `home`, and
`codexHome` values as the Codex process `command`, `HOME`, and `CODEX_HOME`.
The initial runtime uses one stdio app-server process and one thread per task;
remote WebSocket transport and process pooling are future runtime work.

## Compatibility rule

Changes to event envelope fields, plugin hooks, dashboard card manifests,
runtime provider behavior, or dispatcher retry semantics should ship with tests
and an updated source spec.

## Source spec

The full runtime contract lives in
[docs/plugin-runtime-contract.md](https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md).
