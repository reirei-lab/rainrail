---
title: Run local delivery
description: Verify publish, stream, dispatch, and replay behavior locally.
---

Use local delivery checks when changing event schemas, intake adapters, retry
logic, or dashboard-visible operational state.

## Baseline checks

```sh
pnpm test
pnpm typecheck
pnpm docs:check
```

Focused tests should cover the changed adapter or workflow first. The full
baseline is the final check before opening a pull request.

## Local surfaces

- Use `pnpm cf:dev` for the Worker-shaped intake path.
- Use `pnpm pages:build` for the product site.
- Use `pnpm docs:build` for the public docs site.

## Source spec

Delivery and replay semantics are defined in
[docs/event-delivery.md](https://github.com/reirei-lab/rainrail/blob/main/docs/event-delivery.md).
