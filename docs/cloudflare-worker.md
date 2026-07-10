# Cloudflare Worker 運用

Rainrail bridge は `src/worker.ts` を Cloudflare Worker entrypoint として deploy する。
`wrangler.jsonc` は `BRIDGE_ROOM` Durable Object binding と production 用の非秘密値だけを持つ。

Cloudflare tail source と Cloudflare error issue reporter の実装は
`src/cloudflare/` に集約し、同 directory の `AGENTS.md` が delivery id、`sourceName`、
error classification、event id length、issue fingerprinting の review rule を持つ。
既存 import path のために `src/cloudflare-tail.ts` と
`src/cloudflare-issue-reporter.ts` は compatibility shim として残す。

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
- 任意の `RAINRAIL_CONFIG_JSON`: Worker が source bundle / provider / runtime composition を
  config から読むための JSON。未設定の場合は従来通り `GITHUB_WEBHOOK_SECRET` から
  EEP Bridge bundle を組み立て、GitHub webhook と Cloudflare tail を両方登録する。

local dev では `.dev.vars` に同じ名前を置く。`.dev.vars` は gitignore 済みなので値は commit しない。
環境別の `.dev.vars.<environment>` と `.env*` も secret ファイルとして扱い、同じく commit しない。

```sh
GITHUB_WEBHOOK_SECRET=replace-with-local-secret
RAINRAIL_PUBLISH_TOKEN=replace-with-local-publish-token
SSE_BEARER_TOKEN=replace-with-local-events-token
```

config 経由で composition を明示する場合も、secret 値は config に直書きしない。
`webhookSecret` には env / Workers Secret の名前を置き、bundle が同名 env から値を解決する。
`RAINRAIL_CONFIG_JSON` 内の `${NAME}` は Worker env / vars / secrets から展開される。
`github-webhook.endpoint` は実際の intake route に反映されるため、GitHub 側の delivery URL も
同じ path に合わせる。
deploy 前 secret 検証は `RAINRAIL_CONFIG_JSON` の `webhookSecret` が参照する secret 名も
確認する。既定の `GITHUB_WEBHOOK_SECRET` 以外を使う場合は、その secret 名を
Cloudflare Workers Secrets に登録しておく。

```json
{
  "sourceBundles": [
    {
      "type": "eep-bridge",
      "name": "worker-ingress",
      "sources": [
        {
          "type": "github-webhook",
          "name": "github-production-webhook",
          "sourceType": "github",
          "provider": "github",
          "runtime": "openclaw",
          "webhookSecret": "GITHUB_WEBHOOK_SECRET",
          "endpoint": "/webhooks/github"
        },
        {
          "type": "cloudflare-tail",
          "name": "cloudflare-tail",
          "sourceType": "cloudflare"
        },
        {
          "type": "manual-chat",
          "name": "manual-chat",
          "sourceType": "manual",
          "runtime": "openclaw"
        },
        {
          "type": "manual-chat",
          "name": "web-chat",
          "sourceType": "chat",
          "runtime": "openclaw"
        }
      ]
    }
  ],
  "taskProviders": {
    "github": {}
  },
  "runtimeProviders": {
    "openclaw": {
      "enabled": true
    }
  }
}
```

追加 runtime provider は `runtimeProviders.<canonicalKey>` に `type: "plugin"` と
plugin runtime id を置いて登録する。たとえば `runtimeProviders.codexAppServer.runtime`
を `codex-app-server` にした場合、bundle source は `runtime: "codex-app-server"` で
参照できる。未登録の runtime id は config parse 時に拒否される。

`manual-chat` は同じ config model で source/runtime の対応を表現するための entry として
置ける。現時点の Worker EEP Bridge bundle は GitHub webhook と Cloudflare tail の
intake adapter を生成し、manual/chat の実 ingress adapter は別 source adapter が入った時点で
同じ bundle model に接続する。

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
`RAINRAIL_CONFIG_JSON` がある場合、Worker は config の `sourceBundles` から選んだ
`eep-bridge` bundle で intake adapter を作る。未設定の場合は既存 Cloudflare deploy の
互換経路として env-only の EEP Bridge bundle を使うため、既存の Secrets / webhook URL は
そのまま動く。
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
- Optional variable `RAINRAIL_GITHUB_WEBHOOK_ENDPOINT`: `RAINRAIL_CONFIG_JSON` で
  GitHub webhook endpoint を `/webhooks/github` 以外に変える場合の smoke 用 path。
  未設定の場合は smoke が `RAINRAIL_CONFIG_JSON` から endpoint を読むか、既定
  `/webhooks/github` を使う。

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
config で GitHub webhook endpoint を変更している場合、smoke は `RAINRAIL_CONFIG_JSON` の
`github-webhook.endpoint` を読む。明示的に上書きする場合は
`RAINRAIL_GITHUB_WEBHOOK_ENDPOINT=/custom-path pnpm cf:smoke` を使う。
