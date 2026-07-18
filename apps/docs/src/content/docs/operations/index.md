---
title: Operations
description: Deploy, smoke-check, and operate Rainrail surfaces.
---

Operations pages cover repeatable procedures for production-like Rainrail
surfaces. Secrets and account-specific values are always represented by names or
example values, never committed values.

## Deployment surfaces

- [Cloudflare Worker](/operations/cloudflare-worker/) runs the event intake and
  bridge runtime.
- [Cloudflare Pages](/operations/cloudflare-pages/) publishes product and docs
  static sites.
- [Task queue](/operations/task-queue/) covers Project issue selection, claims,
  and release semantics.

## Docs deploy

The docs site builds to `apps/docs/dist` and deploys to the Cloudflare Pages
project `rainrail-docs`.

```sh
pnpm docs:build
pnpm docs:deploy:preview
pnpm docs:deploy:production
```
