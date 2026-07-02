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
環境別の `.dev.vars.<environment>` と `.env*` も secret ファイルとして扱い、同じく commit しない。

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

`wrangler.jsonc` の `secrets.required` は必要な secret 名を固定する。`pnpm cf:deploy` は
`wrangler secret list` で Cloudflare 側の登録状況を確認し、欠落があれば deploy 前に止める。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm cf:deploy:check
pnpm cf:deploy
```

`pnpm cf:deploy:check` は CI と同じ deployability dry run を実行し、template の required
inputs と `wrangler deploy --dry-run` の bundle 生成を確認する。

GitHub webhook の delivery URL は production Worker の
`https://<worker-host>/webhooks/github` を使う。GitHub 側の webhook secret は
`GITHUB_WEBHOOK_SECRET` と同じ値にする。

## Smoke

deploy 後、health endpoint と webhook endpoint を smoke する。

```sh
RAINRAIL_WORKER_URL=https://<worker-host> pnpm cf:smoke
```

smoke script は `GET /healthz` が successful response を返すことを確認する。
`POST /webhooks/github` は `ping` event と意図的な署名不一致で `401 signature_mismatch`
になることだけを確認し、production の Durable Object / SSE replay stream には publish しない。
