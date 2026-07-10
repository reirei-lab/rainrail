---
title: Plugin runtime sample
description: A compact source plugin and workflow plugin example.
---

The plugin runtime sample shows the smallest useful shape of a source plugin
and workflow plugin working against Rainrail's public contract.

## Use it for

- Understanding `defineSourcePlugin` and normalized envelopes.
- Seeing how workflow plugins match events and call a runtime provider.
- Copying the `codex-app-server` runtime id and `runtimeProviders.codexAppServer`
  config shape when routing chat/manual input to Codex CLI App Server.
- Copying a minimal `DashboardPluginManifest.dashboard.cards[]` contribution
  for a plugin dashboard card.
- Checking import paths when writing new examples or tests.

The Codex App Server example assumes `rainrail setup codex-app-server --yes`
has prepared the project-local plugin. Users who do not run Codex do not need
that plugin; OpenClaw and other runtime providers remain separate entries in
the same runtime provider registry.

For the dashboard card walkthrough, see
[Add dashboard cards](/guides/dashboard-cards/).

## Source spec

The example source lives in
[docs/examples/plugin-runtime.ts](https://github.com/reirei-lab/rainrail/blob/main/docs/examples/plugin-runtime.ts).
