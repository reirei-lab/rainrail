# 中立イベントモデルと plugin contract

Rainrail は Source plugin が外部イベントを中立 envelope に正規化し、
Workflow plugin が provider/runtime contract を使って処理する境界を持つ。
GitHub webhook や Cloudflare tail の payload は Source plugin の入力であり、
Workflow plugin の routing API には直接漏らさない。

## Event envelope

`RainrailEventEnvelope` は `schemaVersion: "rainrail.event.v1"` を持つ。
必須フィールドは次の通り。

- `id`: Rainrail 内のイベント識別子。指定されない場合は
  `${source.name}:${delivery.id}:${name}` で作る。
- `source`: `type` と `name` を持つイベント発生元。GitHub repository や
  Cloudflare account などの provider 固有情報は任意メタデータとして置く。
- `name`: `github.issue`、`github.pull_request`、`github.check_run`、
  `github.review`、`cloudflare.tail`、`cloudflare.error` などの中立イベント名。
- `delivery`: provider から受け取った delivery id と受信時刻。
- `occurredAt`: provider 上でイベントが発生した時刻。
- `subject`: issue、pull request、check run、review、worker など、
  routing の主対象。
- `payload`: Source plugin が正規化した payload。
- `rawPayload`: 生 payload そのものではなく、保存先や delivery への参照。

## Source plugin

Source plugin は provider 固有入力を受け取り、`RainrailEventEnvelope` を返す。
`normalize(input, context)` の `context` には delivery id、受信時刻、
plugin 名、raw payload reference、provider メタデータを渡す。

この境界により、GitHub issue/PR/check/review と Cloudflare tail/error は
同じ dispatcher に渡せる。provider 固有の webhook payload は
`payload` に閉じ込め、dispatcher は `name`、`source`、`subject` だけで
routing できる。

Cloudflare tail source は Worker tail payload の `exceptions` が空でない場合に
`cloudflare.error` に正規化する。`outcome` が `exception` の場合も、例外配列が
欠落していても error として routing できるよう `cloudflare.error` にする。
`exceededCpu`、`exceededMemory`、`scriptNotFound`、`canceled`、
`responseStreamDisconnected` などの失敗 outcome も
`cloudflare.error` とし、`payload.action` には Cloudflare outcome の camelCase 表記を
保つ。
それ以外は `cloudflare.tail` に正規化する。`subject` は `worker` で、
`scriptName` から短い安全な id を作る。delivery id と
`cloudflare://deliveries/...` 参照も storage allowlist に通る短い token にし、
`cf-ray` が無い tail では source plugin context の `deliveryId` を suffix として使う。
これにより同じ delivery の retry でも event id が安定し、Bridge room の重複 no-op が効く。
既定の `${source.name}:${delivery.id}:${name}` 形式の event id が 128 文字以内に収まるよう、
長い worker 名や fallback delivery id は delivery id 生成時に短縮する。このため、
元 tail payload の URL や例外本文は source payload にだけ置き、Bridge room の durable
replay では allowlist 済み shallow metadata に縮約される。
batch publish helper は入力順に 1 件ずつ publish する。`cf-ray` が無い batch では
fallback delivery id に batch index を混ぜ、同一 ms の Cron/Queue tail でも batch 内の
別 event として配信できるようにする。Cloudflare delivery reference の path segment は
`:` を含まない文字集合へ正規化し、`eventTimestamp` が欠落または壊れている場合は
`receivedAt` を occurredAt / delivery id の時刻要素として使う。

## Task provider

Task provider は forge/task system の操作面を表す。初期 contract は
GitHub と Forgejo の issue 操作を同じ workflow から使えるように、
`getIssue`、`createComment`、`addToProject`、`setStatus`、`createProposal`
を持つ。

`TaskIssueRef` は provider、repository、id、number、url を持てる。
Workflow plugin は GitHub webhook payload ではなく、中立 event の
`source` と `subject` から `TaskIssueRef` を作る。これにより、issue、
project、comment、status、proposal の操作は provider 実装に閉じ込められる。

## Runtime provider

Runtime provider は OpenClaw、devteam、Codex などの実行基盤を表す。
`startRun(request)` は workflow 名、event、任意の task、requestedBy、
追加 input を受け取り、queued/running/succeeded/failed/canceled などの
run status を返す。

secret や provider 固有 token は runtime provider の実装が保持し、
contract には含めない。

## Workflow plugin

Workflow plugin は `accepts(event)` で対象イベントを絞り込み、
`handle(event, context)` で処理する。`context` は `providers.tasks` と
`runtime` を必須で受け取り、必要なら既存の `capabilities` も使える。

Workflow plugin は event に反応し、Task provider と Runtime provider を
組み合わせるだけにする。GitHub/Forgejo の API 呼び出しや OpenClaw/devteam/Codex
の起動詳細は、それぞれの provider/runtime 実装に閉じ込める。

mock task provider と mock runtime provider を `createRuntimeDispatcher` に渡せば、
workflow test は外部 API なしで書ける。

## Config と GitHub auth provider

Rainrail の config は provider 境界ごとに分ける。`sources` は GitHub webhook
などの event input、`taskProviders.github` は GitHub API 用の auth、
`runtimeProviders.openclaw` は agent runtime 起動設定を持つ。環境変数は
`${NAME}` 形式で JSON parse 前に展開し、値は JSON string content として
エスケープする。secret 値そのものではなく、運用では環境変数や secret 名を
config に渡す。

GitHub auth は `token`、GitHub App installation token、環境変数 PAT、
`gh auth` fallback を同じ `GitHubAuthToken` として扱う。環境変数 fallback は
GitHub CLI と同じく `GH_TOKEN`、`GITHUB_TOKEN` の順で最初の非空値を使う。`gh auth`
fallback は Rainrail の GitHub API URL に合わせて `github.com` host だけから
取得する。`GitHubTaskProvider` は `auth.getAuthToken()` を注入できるため、
workflow test や別 runtime では実 GitHub App/PAT 実装を差し替えられる。
デフォルト provider は GitHub App token 発行が GitHub API 側の auth/rate-limit
エラーで失敗したとき、設定済み env/gh fallback token があればそれを使う。

GitHub REST/GraphQL の rate limit header は `recordGitHubRateLimit()` で
snapshot として記録する。snapshot には auth provider と fallback 有無を残し、
provider 実装の観測性に使う。secret や token 値は snapshot に含めない。

## Dispatcher

`createRuntimeDispatcher` は workflow plugin 配列と runtime context を受け取る。
`dispatch(event)` は `accepts` が true の workflow だけを呼び、
plugin ごとに fulfilled/rejected の結果を返す。`accepts` が例外を投げた場合も
その plugin の rejected result として隔離し、後続 workflow の評価は続ける。
最小 contract では retry や並列度制御は持たせない。これらは orchestration policy
として後続 issue で追加する。

## reirei-harness matcher/router 移行の見通し

reirei-harness 側の matcher は GitHub webhook payload を直接読む代わりに、
Source plugin で `github.issue` や `github.pull_request` に正規化する。
既存 router は `event.name`、`event.subject`、`event.source.repository` を見る
Workflow plugin に移せる。実際の Codex/OpenClaw 起動は runtime capability として
Workflow plugin へ注入するため、routing 条件と provider 実行を分離できる。
