---
title: Add dashboard cards
description: Create Core-aware dashboard layouts and plugin dashboard card contributions.
---

Dashboard cards let the local dashboard combine Rainrail-owned Core cards and
plugin cards in one operator layout.

## Card catalog and layout API

- `GET /api/v1/dashboard/cards` lists Core and plugin cards with availability.
- `GET /api/v1/dashboard/layout` returns the default Core layout until a user
  layout is saved.
- `PUT /api/v1/dashboard/layout` saves the full user layout and requires an
  operator or admin dashboard token.
- `PATCH /api/v1/dashboard/layout/items/:itemId/config` saves settings for one
  visible card and also requires an operator or admin dashboard token.

The local `rainrail start` CLI catalog currently exposes
`core.operationalTotals` as its Core card. The shared HTTP app contract also
has tests for the broader Core card registry used by dashboard API consumers:
`core.eventInbox`, `core.workflowRuns`, `core.agentTasks`, `core.sources`,
`core.queue`, `core.settings`, `core.operatorActions`, and legacy ids
`core.overview` and `core.recentEvents`. Plugin cards use ids such as
`plugin:github.queue`. Saved layouts reference available Core and plugin cards
through the same `cardId` field.

## Minimal plugin card

Declare plugin cards in the plugin manifest and turn the manifest into a card
provider:

```ts
import {
  createDashboardCardProviderFromManifest,
  type DashboardPluginManifest,
} from 'rainrail';

const manifest: DashboardPluginManifest = {
  name: 'github',
  version: '1.0.0',
  dashboard: {
    cards: [{
      name: 'queue',
      title: 'GitHub queue',
      category: 'operations',
      requiredCapabilities: ['dashboard:read', 'github:read'],
      size: {
        default: { columns: 3, rows: 2 },
        min: { columns: 2, rows: 1 },
        max: { columns: 6, rows: 4 },
      },
      settingsSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
        },
        additionalProperties: false,
      },
    }],
  },
};

export const githubDashboardCards = createDashboardCardProviderFromManifest(manifest);
```

This creates the card id `plugin:github.queue`. The complete typechecked sample
lives in
[docs/examples/plugin-runtime.ts](https://github.com/reirei-lab/rainrail/blob/main/docs/examples/plugin-runtime.ts).

## Sandbox and capabilities

The dashboard card sandbox host is the contract for plugin-card iframe
rendering. The current local dashboard renders card catalog/layout metadata; it
does not yet load plugin bundles into iframes. When an iframe renderer is wired,
the host must create a frame with `sandbox="allow-scripts"`, no
`allow-same-origin`, no referrer, and only read-only bridge capabilities such as
`dashboard:read` or `*:read`. Workflow capabilities such as `runtime:start`,
merge, or secret access are not exposed to plugin card frames.

If one plugin card fails to load, the sandbox reports that card as failed
without taking down the dashboard shell, Core cards, or other cards.

## Settings and secrets

Card settings are saved as the layout item's `config`. Keep config values
JSON-serializable and never store tokens, passwords, API keys, dashboard bearer
tokens, or provider credentials there. The dashboard layout API rejects
credential-looking keys before persistence.

## Smoke and VRT coverage

Run the focused dashboard demo smoke check before changing dashboard card UI:

```sh
pnpm demo:dashboard:smoke
```

The check validates seeded SQLite API data, default layout, a saved custom
layout with a plugin card through the shared HTTP app contract, plugin card
load failure isolation, and the VRT scenario manifest entries for directly
reachable desktop and mobile card states.

## Source specs

- [Local dashboard startup](https://github.com/reirei-lab/rainrail/blob/main/docs/local-dashboard.md)
- [Plugin runtime contract](https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md)
