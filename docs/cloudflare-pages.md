# Cloudflare Pages 運用

Rainrail product site は `apps/www` の Astro static site を Cloudflare Pages に deploy する。
Pages project は Worker project と衝突しないように `rainrail-www` とし、build output は
`apps/www/dist` を使う。

## Secrets

GitHub Actions と手元の Wrangler deploy には Cloudflare API credential が必要。値は repository
に含めず、GitHub Actions secrets または local shell environment にだけ置く。

- `CLOUDFLARE_ACCOUNT_ID`: `rainrail-www` を所有する Cloudflare account ID。
- `CLOUDFLARE_API_TOKEN`: Cloudflare Pages deploy 権限を持つ API token。

GitHub Actions は secrets が未設定の場合でも build または artifact download まで実行し、
deploy だけを skip する。これにより preview / production の buildability は PR 上で確認できる。
実際に Cloudflare Pages へ公開するには、上記 2 つの secrets を repository に設定する。
PR workflow では Cloudflare secrets を扱わない。pull request 側では `apps/www/dist` artifact
だけを作り、default branch の trusted `workflow_run` が repository の trusted dependency から
Wrangler を起動して preview deploy する。

deploy workflow は Cloudflare Pages branch ごとに直列化し、新しい run が始まったら同じ branch
向けの古い run を cancel する。

## Preview Deploy

pull request preview は `.github/workflows/pr-ci.yml` が作った `rainrail-pages-dist` artifact を、
`.github/workflows/cloudflare-pages.yml` の trusted `workflow_run` が deploy する。同一 repository
の non-draft PR だけを preview deploy 対象にする。
`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` が設定されている場合だけ Wrangler deploy を実行し、
未設定の場合は artifact download までを検証して job を成功させる。

手動で preview deploy を再現する場合:

```sh
pnpm install --frozen-lockfile
pnpm pages:deploy:preview
```

この command は `pnpm --filter www build` の後に
`wrangler pages deploy apps/www/dist --project-name rainrail-www --branch "${RAINRAIL_PAGES_BRANCH:-preview}"`
を実行する。GitHub Actions では `RAINRAIL_PAGES_BRANCH` に pull request の head branch を渡し、
PR ごとの preview deployment を分ける。手動実行では未指定なら `preview` branch として deploy する。

## Production Deploy

`main` への push は `.github/workflows/cloudflare-pages.yml` の `Deploy production` job で
production deploy する。Cloudflare Pages project 側の production branch も `main` に揃える。
`workflow_dispatch` で `main` から手動実行した場合も production deploy path を使う。feature branch
から手動実行しても production deploy しない。preview と同じく、secrets が未設定の場合は build
のみ実行し、deploy は skip する。

手動 deploy:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pages:deploy:production
```

この command は `pnpm --filter www build` の後に
`wrangler pages deploy apps/www/dist --project-name rainrail-www --branch main` を実行する。

## Smoke

deploy 後は公開 URL を指定して product site の主要 route が HTML を返すことを確認する。

```sh
RAINRAIL_PAGES_URL=https://<pages-host> pnpm pages:smoke
```

smoke script は `/`, `/docs`, `/how-it-works` を GET し、`text/html` と route 固有の hero 文言を確認する。
