---
title: Cloudflare Pages
description: Deploy Rainrail product and docs static sites.
---

Rainrail uses separate Cloudflare Pages projects for product and docs surfaces.

## Projects

- `rainrail-www` publishes `apps/www/dist` for `rainrail.dev`.
- `rainrail-docs` publishes `apps/docs/dist` for `docs.rainrail.dev`.

## Commands

```sh
pnpm pages:deploy:preview
pnpm pages:deploy:production
pnpm docs:deploy:preview
pnpm docs:deploy:production
```

Use preview deploys for feature branches and production deploys from `main`.

## Source spec

The full Pages operations guide lives in
[docs/cloudflare-pages.md](https://github.com/reirei-lab/rainrail/blob/main/docs/cloudflare-pages.md).
