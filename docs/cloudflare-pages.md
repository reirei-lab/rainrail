# Cloudflare Pages 運用

Rainrail product site は `apps/www` の Astro static site を Cloudflare Pages に deploy する。
Pages project は Worker project と衝突しないように `rainrail-www` とし、build output は
`apps/www/dist` を使う。

## Secrets

GitHub Actions と手元の Wrangler deploy には Cloudflare API credential が必要。値は repository
に含めず、GitHub Actions secrets または local shell environment にだけ置く。

- `CLOUDFLARE_ACCOUNT_ID`: `rainrail-www` を所有する Cloudflare account ID。
- `CLOUDFLARE_API_TOKEN`: Cloudflare Pages deploy 権限を持つ API token。

## Preview Deploy

pull request preview は `.github/workflows/cloudflare-pages.yml` の `Deploy preview` job が担当する。
fork PR には secrets を渡さないため、同一 repository の PR だけを deploy 対象にする。

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

smoke script は `/`, `/docs`, `/how-it-works` を GET し、`text/html` と期待するページ文言を確認する。
