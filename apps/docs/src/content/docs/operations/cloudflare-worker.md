---
title: Cloudflare Worker
description: Operate the Rainrail Worker intake and bridge runtime.
---

The Cloudflare Worker hosts Rainrail intake routes, bridge room behavior, and
production event stream surfaces.

## Required secrets

Worker secrets are named in docs and configuration, but values are never
committed.

- `GITHUB_WEBHOOK_SECRET`
- `RAINRAIL_PUBLISH_TOKEN`
- `SSE_BEARER_TOKEN`
- Optional `RAINRAIL_CONFIG_JSON`

## Local and production checks

```sh
pnpm cf:dev
pnpm cf:deploy:check
pnpm cf:smoke
```

Run focused tests for any change to source bundle composition, intake auth,
tail handling, or replay-safe storage.

## Source spec

The full Worker operations guide lives in
[docs/cloudflare-worker.md](https://github.com/reirei-lab/rainrail/blob/main/docs/cloudflare-worker.md).
