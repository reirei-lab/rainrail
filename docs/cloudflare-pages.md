# Cloudflare Pages 運用

Rainrail product site は `apps/www` の Astro static site を Cloudflare Pages に deploy する。
Pages project は Worker project と衝突しないように `rainrail-www` とし、build output は
`apps/www/dist` を使う。

Rainrail documentation site は `apps/docs` の Astro Starlight static site を別 project
`rainrail-docs` に deploy する。build output は `apps/docs/dist` を使う。

## Secrets

GitHub Actions と手元の Wrangler deploy には Cloudflare API credential が必要。値は repository
に含めず、GitHub Actions secrets または local shell environment にだけ置く。

- `CLOUDFLARE_ACCOUNT_ID`: `rainrail-www` を所有する Cloudflare account ID。
- `CLOUDFLARE_API_TOKEN`: Cloudflare Pages deploy 権限を持つ API token。
- Variable `RAINRAIL_OPERATIONAL_API_URL`: `/dashboard` の静的 HTML に焼き込む operational API
  origin。GitHub Actions はこの値を `PUBLIC_RAINRAIL_OPERATIONAL_API_URL` として Astro build に渡す。
  `/api/v1/*` を提供し、operational store が構成済みの origin を指定する。未設定の場合、
  dashboard の入力欄から Operational API URL を指定して同じ session 内で利用する。既存の
  Cloudflare Worker deployment を指定する場合は、先に Worker 側で operational store を接続する。
  URL 別 dashboard route である `/en/dashboard`, `/en/dashboard/events`, `/en/dashboard/runs`,
  `/en/dashboard/tasks`, `/en/dashboard/sources`, `/en/dashboard/queue`, `/en/dashboard/settings`
  も同じ build-time value を読む。

GitHub Actions は secrets が未設定の場合でも build または artifact download まで実行し、
deploy だけを skip する。これにより preview / production の buildability は PR 上で確認できる。
実際に Cloudflare Pages へ公開するには、上記 2 つの secrets を repository に設定する。
PR workflow では Cloudflare secrets を扱わない。pull request 側では `apps/www/dist` artifact
と `apps/docs/dist` artifact だけを作り、default branch の trusted `workflow_run` が repository
の trusted dependency から Wrangler を起動して preview deploy する。

deploy workflow は Cloudflare Pages branch ごとに直列化し、新しい run が始まったら同じ branch
向けの古い run を cancel する。

## Preview Deploy

pull request preview は `.github/workflows/pr-ci.yml` が作った `rainrail-pages-dist` artifact を、
`.github/workflows/cloudflare-pages.yml` の trusted `workflow_run` が deploy する。同一 repository
の non-draft PR だけを preview deploy 対象にする。
`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` が設定されている場合だけ Wrangler deploy を実行し、
未設定の場合は artifact download までを検証して job を成功させる。
draft PR や artifact がない workflow_run は preview deploy を skip する。

docs preview は `.github/workflows/pr-ci.yml` が作った `rainrail-docs-dist` artifact を、
`.github/workflows/cloudflare-docs-pages.yml` の trusted `workflow_run` が `rainrail-docs` に deploy
する。product site と同じく同一 repository の non-draft PR だけを対象にし、Cloudflare secrets が
未設定の場合は artifact download までを検証して deploy だけを skip する。

手動で preview deploy を再現する場合:

```sh
pnpm install --frozen-lockfile
pnpm pages:deploy:preview
```

この command は `pnpm --filter www build` の後に
`wrangler pages deploy apps/www/dist --force --project-name rainrail-www --branch "${RAINRAIL_PAGES_BRANCH:-preview}"`
を実行する。GitHub Actions では `RAINRAIL_PAGES_BRANCH` に pull request の head branch を渡し、
PR ごとの preview deployment を分ける。手動実行では未指定なら `preview` branch として deploy する。

## Production Deploy

`main` への push は `.github/workflows/cloudflare-pages.yml` の `Deploy production` job で
production deploy する。production workflow は docs.rainrail.dev を rainrail.dev より先に deploy
し、product site が docs.rainrail.dev の深いリンクを公開した時点で docs app 側の該当 route も
同じ run で公開済みになるようにする。Cloudflare Pages project 側の production branch も `main` に揃える。
`workflow_dispatch` で `main` から手動実行した場合も production deploy path を使う。feature branch
から手動実行しても production deploy しない。preview と同じく、secrets が未設定の場合は build
のみ実行し、deploy は skip する。

手動 deploy:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm docs:deploy:production
pnpm pages:deploy:production
```

`docs:deploy:production` は `pnpm --filter @rainrail/docs build` の後に
`wrangler pages deploy apps/docs/dist --force --project-name rainrail-docs --branch main` を実行する。
`pages:deploy:production` は `pnpm --filter www build` の後に
`wrangler pages deploy apps/www/dist --force --project-name rainrail-www --branch main` を実行する。

## Docs Deploy

docs.rainrail.dev 用の Starlight docs app は product site と独立して build / deploy する。

```sh
pnpm docs:build
pnpm docs:deploy:preview
pnpm docs:deploy:production
```

`docs:deploy:preview` は `wrangler pages deploy apps/docs/dist --force --project-name rainrail-docs --branch "${RAINRAIL_DOCS_BRANCH:-preview}"`
を実行する。`docs:deploy:production` は同じ output directory を `rainrail-docs` project の
`main` branch として deploy する。

GitHub Actions では `.github/workflows/cloudflare-docs-pages.yml` が `rainrail-docs` 専用 deploy を
担当する。`main` への push と `workflow_dispatch` は `pnpm docs:build` の後に production deploy
を行う。PR preview は `rainrail-docs-dist` artifact を deploy するため、PR workflow 側では
Cloudflare secrets を読み込まない。

## Smoke

deploy 後は公開 URL を指定して product site の主要 route が HTML を返すことを確認する。

```sh
RAINRAIL_PAGES_URL=https://<pages-host> pnpm pages:smoke
```

smoke script は `/`, `/en/docs`, `/en/how-it-works`, `/en/dashboard`, `/en/dashboard/events`, `/en/dashboard/runs`, `/en/dashboard/tasks`, `/en/dashboard/sources`, `/en/dashboard/queue`, `/en/dashboard/settings` を GET し、`text/html` と route 固有の文言を確認する。

docs site は `HEAD` request で主要 route が HTML を返すことを確認する。

```sh
RAINRAIL_DOCS_URL=https://<docs-pages-host> pnpm docs:smoke
```

docs smoke script は `/`, `/quickstart/`, `/operations/` を HEAD し、`text/html` を確認する。
`RAINRAIL_DOCS_URL` を指定しない場合は `https://docs.rainrail.dev` を確認する。

## Release 前 checklist

release 前、または Cloudflare Pages domain activation 後に public docs route を確認する場合は、
少なくとも次を実行する。

- `pnpm docs:check`: engineering docs drift、public docs sidebar route、内部 navigation link、docs app typecheck を確認する。
- `pnpm docs:build`: `apps/docs/dist` が build できることを確認する。
- `pnpm docs:smoke`: `https://docs.rainrail.dev` の `/`, `/quickstart/`, `/operations/` が HTML を返すことを確認する。
- `RAINRAIL_PAGES_URL=https://rainrail.dev pnpm pages:smoke`: product site から docs gateway への主要 route を確認する。
