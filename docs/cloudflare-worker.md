# Cloudflare Worker 運用

Rainrail bridge は `src/worker.ts` を Cloudflare Worker entrypoint として deploy する。
`wrangler.jsonc` は `BRIDGE_ROOM` Durable Object binding と production 用の非秘密値だけを持つ。

## Secrets

secret 値は repository や `wrangler.jsonc` に含めない。production では Cloudflare
Workers Secrets に登録する。

```sh
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put RAINRAIL_PUBLISH_TOKEN
pnpm exec wrangler secret put SSE_BEARER_TOKEN
```

- `GITHUB_WEBHOOK_SECRET`: GitHub webhook の HMAC 検証に使う secret。
- `RAINRAIL_PUBLISH_TOKEN`: Worker と `RainrailBridgeRoomDurableObject` の内部 publish 認可 token。
- `SSE_BEARER_TOKEN`: `GET /events` の購読用 bearer token。未設定の場合は event stream を公開せず `503` を返す。

local dev では `.dev.vars` に同じ名前を置く。`.dev.vars` は gitignore 済みなので値は commit しない。

```sh
GITHUB_WEBHOOK_SECRET=replace-with-local-secret
RAINRAIL_PUBLISH_TOKEN=replace-with-local-publish-token
SSE_BEARER_TOKEN=replace-with-local-events-token
```

## Local Dev

```sh
pnpm install --frozen-lockfile
pnpm cf:dev
```

`wrangler dev --local` は `wrangler.jsonc` と `.dev.vars` を使って local Worker を起動する。
GitHub webhook の URL は `/webhooks/github`、health check は `/healthz`。

## Production Deploy

deploy 前に secrets が登録済みであることを確認する。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm cf:deploy
```

GitHub webhook の delivery URL は production Worker の
`https://<worker-host>/webhooks/github` を使う。GitHub 側の webhook secret は
`GITHUB_WEBHOOK_SECRET` と同じ値にする。

## Smoke

deploy 後、health endpoint と webhook endpoint を smoke する。

```sh
RAINRAIL_WORKER_URL=https://<worker-host> \
GITHUB_WEBHOOK_SECRET=<same-placeholder-secret-used-in-cloudflare> \
pnpm cf:smoke
```

smoke script は `GET /healthz` が successful response を返すことと、署名済みの
sample GitHub issue webhook が `POST /webhooks/github` で `202` になることを確認する。
