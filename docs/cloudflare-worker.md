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
Worker entrypoint は Core app と EEP Bridge bundle を composition する。bundle は
`createGitHubWebhookIntakeAdapter` と `createCloudflareTailIntakeAdapter` を
`createRainrailHttpApp` に登録し、Core は provider 固有 route / tail payload を直接持たない。
Node server も同じ `createRainrailEepBridgeIntakeAdapters` API で GitHub webhook と
Cloudflare tail ingress を構成するため、local Node / Worker の差は transport だけに閉じる。
ただし Node server で独自 `tail` intake adapter を渡した場合は、既存の custom tail 経路を
壊さないように bundled Cloudflare tail を登録しない。

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

## CI Deployability Check

Rainrail 本体の PR CI は production deploy を行わない。代わりに `pnpm cf:deploy:check`
で `wrangler deploy --dry-run` を実行し、Worker bundle / wrangler config の deployability
と smoke template の副作用なし条件を検証する。結果は GitHub Actions の step summary に
`Worker bundle dry run`、`Wrangler deploy dry run`、`Smoke template guard`、
`Required deploy inputs` として出る。

## Self-host Deploy Workflow Template

自分の Cloudflare account / fork / repository から deploy する場合は
`docs/templates/cloudflare-self-host-deploy.yml` を `.github/workflows/deploy-rainrail-worker.yml`
としてコピーして使う。

GitHub 側に次の Secrets / Vars を登録する。

- Secret `CLOUDFLARE_API_TOKEN`: Worker deploy と secret list ができる Cloudflare API token。
- Secret `CLOUDFLARE_ACCOUNT_ID`: deploy 対象の Cloudflare account id。
- Variable `RAINRAIL_WORKER_URL`: deploy 後の Worker URL。例:
  `https://rainrail.<your-subdomain>.workers.dev`。

Cloudflare Workers Secrets には、この文書の Secrets 節にある
`GITHUB_WEBHOOK_SECRET`、`RAINRAIL_PUBLISH_TOKEN`、`SSE_BEARER_TOKEN` を事前登録する。
template は `pnpm cf:deploy:check` で dry-run と不足入力検出を行ってから `pnpm cf:deploy`、
最後に `RAINRAIL_WORKER_URL` を使って `pnpm cf:smoke` を実行する。

## 最小経路

Cloudflare 上での GitHub webhook から downstream consumer までの最小経路は次の通り。

1. GitHub webhook は production Worker の `POST /webhooks/github` に delivery する。
2. Worker の GitHub intake adapter は `GITHUB_WEBHOOK_SECRET` で `x-hub-signature-256` を検証する。
3. 署名検証後、GitHub payload は Rainrail event に正規化され、`BRIDGE_ROOM` Durable Object
   の replay buffer に保存される。
4. downstream consumer は `GET /events` に `Authorization: Bearer <SSE_BEARER_TOKEN>` を付けて接続し、
   replay buffer と live broadcast から同じ Rainrail event を SSE として受け取る。

この経路の smoke は production event を作らない。実 event の end-to-end 確認を行う場合は、
対象 repository / workflow が処理してよい webhook delivery だけを使い、dummy issue を
production replay stream に混ぜない。

## Smoke

deploy 後、health endpoint と webhook endpoint を smoke する。

```sh
RAINRAIL_WORKER_URL=https://<worker-host> pnpm cf:smoke
```

smoke script は `GET /healthz` が successful response を返すことを確認する。
`POST /webhooks/github` は `ping` event と意図的な署名不一致で `401 signature_mismatch`
になることだけを確認し、production の Durable Object / SSE replay stream には publish しない。
