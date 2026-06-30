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
`scriptName` から安全な id を作る。長い Worker 名や大文字小文字の正規化で
subject が衝突し得る場合は、元の `scriptName` 由来の安定 hash を混ぜる。delivery id と
`cloudflare://deliveries/...` 参照も storage allowlist に通る短い token にし、
`cf-ray` が無い tail では source plugin context の `deliveryId` を suffix として使う。
これにより同じ delivery の retry でも event id が安定し、Bridge room の重複 no-op が効く。
delivery id は Bridge room の identifier 制限内に収まる範囲で worker 名や `cf-ray` /
fallback delivery id を保持し、短縮が必要な場合も suffix の識別性を優先する。このため、
元 tail payload の URL や例外本文は source payload にだけ置き、Bridge room の durable
replay では allowlist 済み shallow metadata に縮約される。source name が長く既定形式では
128 文字を超える場合は、同じ source/delivery/name から決定的に作る短い明示 event id を使う。
batch publish helper は入力順に 1 件ずつ publish する。`cf-ray` が無い batch では
fallback delivery id に batch index を混ぜ、同一 ms の Cron/Queue tail でも batch 内の
別 event として配信できるようにする。Cloudflare delivery reference の path segment は
`:` を含まない文字集合へ正規化する。正規化や切り詰めで別 delivery id が衝突しないよう、
大文字小文字だけが違う場合や末尾記号を落とす場合も含め、元の suffix 由来の安定 hash も混ぜる。
`eventTimestamp` が欠落または壊れている場合は
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
run status を返す。agent task runtime では stopped/timed_out/compaction_failed/
needs_human/split_recommended も status として表現できる。

OpenClaw runtime provider は実 agent 起動を `enabled: true` の capability gate の
背後に置く。通常の workflow test では `RuntimeProvider` mock を注入し、
`createAgentAssignmentRuntimeFromProvider()` 経由で agent assignment を検証する。
実起動では `openclaw agent --agent ... --session-key ... --timeout ... --json` を
spawn し、log path、pid、agent session、branch を run metadata に残す。spawn 後に
Node が `error` を emit しても未処理例外で Rainrail を落とさないよう listener を置き、
provider 利用側が `onSpawnError` で観測できるようにする。start run の log path は
同じ issue task を別 run で再起動しても過去ログを切り詰めないよう、agent session id
由来の一意な名前にする。resume run も session id を attempt id に含め、同じ issue
task の別 session が同じ resume log に追記されないようにする。初回実行が gateway
fallback session へ移った場合は、前回 log から fallback session id を検出して resume
対象にする。

completion/resume/timeline は provider 境界の情報として扱う。completion parser は
Codex/OpenClaw の JSON completion と transcript compaction failure を区別し、
`Outcome: implemented | updated_issue | needs_human | split_recommended` を
取り出せる。`Outcome: needs_human` / `Outcome: split_recommended` は成功終了 JSON に
含まれていても runtime status に反映する。ただし explicit な error/failed/timed_out などの
失敗 status は Outcome より優先し、failed/canceled/stopped/timed_out などの
canonical status も completion として読める。banner 付き log から JSON completion を拾う時は
top-level completion object を優先し、payload 内の nested JSON を run completion と誤認しない。
resume helper は running pid を確認し、
安定した resume attempt id を生成する。timeline reader は OpenClaw trajectory jsonl を読み、Codex activity 表示に
必要な時刻、分類済み phase、redacted summary、status、redacted excerpt を返す。
redaction は shell 風の `token=...` だけでなく JSON の `"token": "..."` /
`"apiKey": "..."` / `"password": "..."`、quoted shell assignment、`github_pat_...`、
Bearer credential も対象にする。timeline status は最後の lifecycle/event row を見て
ended を更新し、resume 後に追記された session を古い ended のまま扱わない。trajectory の既定 path は
`agentId` ごとの `~/.openclaw/agents/<agentId>/sessions` を使い、`main` 以外の
OpenClaw agent でも呼び出し側が毎回 sessionsDirectory を上書きしなくてよい。

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
