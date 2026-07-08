---
title: Development
description: Set up the Rainrail repository for contributor checks and docs preview.
---

This path is for developers evaluating or contributing to Rainrail. It keeps the
first run focused on repository checks, docs preview, and the local surfaces that
prove the event routing contracts still build.

## 1. Install the workspace

```sh
pnpm install --frozen-lockfile
```

Rainrail is a TypeScript monorepo. Root scripts orchestrate the CLI package, the
product site, the docs site, and repository validation checks.

## 2. Run the baseline checks

```sh
pnpm test
pnpm typecheck
pnpm docs:check
```

`docs:check` verifies Markdown links, contract drift, and docs TypeScript
examples. Run focused tests while developing, then run the full baseline before
opening a pull request.

## 3. Preview public docs

```sh
pnpm docs:dev
```

The public docs app is a Starlight site for `https://docs.rainrail.dev`. Use it
for external developer navigation. The repository `docs/` directory remains the
source spec library for detailed contract decisions.

## 4. Build deployable output

```sh
pnpm docs:build
pnpm build
```

`docs:build` emits `apps/docs/dist` for the `rainrail-docs` Cloudflare Pages
project. `pnpm build` verifies the broader workspace.

## Next steps

- Read [Event model](/concepts/event-model/) before changing payload shapes.
- Use [Add a source adapter](/guides/source-adapter/) when connecting a new
  provider signal.
- Check [Cloudflare Worker](/operations/cloudflare-worker/) before changing
  production intake behavior.
