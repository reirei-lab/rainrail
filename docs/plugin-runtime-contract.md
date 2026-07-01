# 中立イベントモデルと plugin runtime contract

Rainrail は Source plugin が外部イベントを中立 envelope に正規化し、
Workflow plugin が provider/runtime capability を使って処理する境界を持つ。
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
spawn し、stdout log path、stderr log path、pid、agent session、branch を run metadata に残す。
completion 解析は JSON stdout log を対象にし、Gateway/plugin/fallback diagnostics などの
stderr は別 log に保存する。`startRun(request, { signal })` の signal が abort 済みなら
spawn せず、spawn 後に abort された場合は child process へ `SIGTERM` を送る。spawn 後に
Node が `error` を emit しても未処理例外で Rainrail を落とさないよう listener を置き、
provider 利用側が `onSpawnError` で観測できるようにする。start run の log path は
同じ issue task を別 run で再起動しても過去ログを切り詰めないよう、agent session id
由来の一意な名前にする。resume run も session id を attempt id に含め、同じ issue
task の別 session が同じ resume log に追記されないようにする。初回実行が gateway
fallback session へ移った場合は、前回 completion metadata から fallback session key を、
または embedded fallback marker から fallback session id を検出して resume
対象にする。OpenClaw の raw stdout/stderr log は redaction 前の credential を含み得るため、
log directory は `0700`、start/resume の stdout/stderr log file は `0600` で作成する。

completion/resume/timeline は provider 境界の情報として扱う。completion parser は
Codex/OpenClaw の JSON completion と transcript compaction failure を区別し、
`Outcome: implemented | updated_issue | needs_human | split_recommended` を
取り出せる。`Outcome: needs_human` / `Outcome: split_recommended` は成功終了 JSON に
含まれていても runtime status に反映する。ただし explicit な error/failed/timed_out などの
失敗 status は Outcome より優先し、failed/canceled/stopped/timed_out などの
canonical status も completion として読める。banner 付き log から JSON completion を拾う時は
top-level completion object を優先し、payload 内の nested JSON を run completion と誤認しない。
JSON completion として解析できる場合は、本文に `CLI transcript compaction failed` という文字列が
含まれていても JSON の status を優先し、実エラー行だけを compaction_failed とする。
resume helper は running pid を確認し、
安定した resume attempt id を生成する。timeline reader は OpenClaw trajectory jsonl を読み、Codex activity 表示に
必要な時刻、分類済み phase、redacted summary、status、redacted excerpt を返す。
redaction は shell 風の `token=...` や `curl -u user:password` だけでなく JSON の `"token": "..."` /
`"apiKey": "..."` / `"password": "..."`、`"webhookSecret"` / `"clientSecret"` /
`"apiToken"` のような compound key、quoted shell assignment、`github_pat_...`、
HTTP Authorization header 全体、Bearer credential も対象にする。timeline status は最後の lifecycle/event row を見て
ended を更新し、resume 後に追記された session を古い ended のまま扱わない。trajectory の既定 path は
`agentId` ごとの `~/.openclaw/agents/<agentId>/sessions` を使い、`main` 以外の
OpenClaw agent でも呼び出し側が毎回 sessionsDirectory を上書きしなくてよい。

secret や provider 固有 token は runtime provider の実装が保持し、
contract には含めない。

## Workflow plugin

Workflow plugin は `accepts(event)` で対象イベントを絞り込み、
`handle(event, context)` で処理する。`context` は `providers.tasks` と
`runtime` を受け取り、必要なら既存の `capabilities` も使える。

Workflow plugin は event に反応し、Task provider と Runtime provider を
組み合わせるだけにする。GitHub/Forgejo の API 呼び出しや OpenClaw/devteam/Codex
の起動詳細は、それぞれの provider/runtime 実装に閉じ込める。

mock task provider と mock runtime provider を `createRuntimeDispatcher` に渡せば、
workflow test は外部 API なしで書ける。互換性のため dispatcher runtime context は
provider/runtime 未指定でも構成できるが、その場合 handler に渡る provider/runtime は
呼び出し時に明示的な unavailable error を返す。

Workflow plugin は任意で `capabilities` と `timeoutMs` を宣言できる。
`capabilities` は危険操作を呼ぶための宣言であり、宣言されていない plugin は
merge、runtime start、secret access を実行できない。dispatcher は handler 起動前に
capability 宣言を snapshot し、handler 実行中に plugin object や capability 配列が
mutate されても、その dispatch の権限境界は変えない。

provider 名や agent dispatch などの低レベル runtime 情報は
`context.capabilities` に残す。一方で merge、runtime start、secret access は
`context.actions` の gated action として渡す。secret 値は audit log に含めず、
runtime action の戻り値を handler 内だけで扱う。互換 API の
`context.capabilities.dispatchAgent` も runtime start と同等に扱い、
`runtime:start` capability、audit、lifecycle signal を通す。dispatcher は
capabilities object 全体を plain object にコピーせず、`dispatchAgent` だけを wrapper で
差し替えるため、provider 固有の prototype method や non-enumerable helper を保持する。

## Plugin loader と local handler

`createPluginLoader` は packaged Workflow plugin と local handler を同じ
workflow 配列に登録する。

- `register(plugin)`: packaged Workflow plugin を登録する。
- `on(eventName, handler, options)`: local handler を登録する。内部では
  `event.name === eventName` を満たす Workflow plugin に変換する。
- `dispatch(event)`: 登録順に workflow を評価し、dispatcher と同じ
  `WorkflowPluginResult[]` を返す。

local handler も packaged plugin と同じ `PluginRuntimeContext` を受け取るため、
event/context API は共通になる。名前を省略した local handler は
`local:${eventName}:${n}` の id を持つ。
`PluginRuntimeContext` には `signal` も含まれる。handler timeout や親 runtime の
abort が発生した場合、この signal は abort される。

## Route workflow migration

reirei-harness の matcher / router / actions は Rainrail では
`createRouteWorkflow()` または `createRouteLocalHandler()` で plugin dispatch 上に載せる。
どちらも同じ `routeRainrailEvent()` を呼ぶため、packaged workflow と local handler は
同じ route decision を返す。

route matcher は harness の tree 表現を引き継ぐ。

- `{ source }`: `event.source.type` または `event.source.name` に一致する。
- `{ eventName }`: `event.name` に一致する。
- `{ and }`、`{ or }`、`{ not }`: 子 matcher を合成する。
- `{ path, equals }`、`{ path, notEquals }`、`{ path, exists }`、`{ path, includes }`:
  route context 上の dot path を評価する。

route context は中立 event envelope から作る。

- `sourceId`: `event.source.type`
- `sourceName`: `event.source.name`
- `eventName`: `event.name`
- `messageId`: `event.id`
- `message`: event envelope 全体
- `event`: normalized `event.payload`
- `source`、`subject`、`delivery`、`rawPayload`: envelope の各 field

このため、既存 harness の `event.action` や
`event.changes.field_value.field_name` のような payload path はそのまま移せる。
envelope 自体を見たい場合は `message.delivery.id`、`subject.type`、
`source.repository` などを使う。

初期 action は harness と同じ `noop` のみを移植する。既定 routes は
`baseline-noop` で全 event に match し、Rainrail の初期状態では event を drop するだけの
deterministic な workflow として振る舞う。実際に agent 起動、GitHub 操作、secret 参照などを
行う action は、今後 `context.actions` や Task/Runtime provider の capability gate を通す
workflow として追加する。

## Capability gate と audit log

危険操作は次の capability で gate する。

- `mergePullRequest`: `merge`
- `startRuntime`: `runtime:start`
- `readSecret`: `secret:access`

capability がない handler が呼び出した場合、runtime action は実行せず
`CapabilityDeniedError` を投げる。plugin failure は dispatcher が
その plugin の rejected result として隔離し、daemon 全体や後続 plugin を
落とさない。
handler timeout 後に handler 本体が遅れて処理を続けた場合でも、gated action は
`signal.aborted` を確認して実行前に拒否する。これにより、呼び出し側が timeout として
失敗処理や retry を開始した後に merge や runtime start が遅れて実行されることを防ぐ。
handler が fulfilled/rejected で settle した後も同じ signal を abort し、handler が
残した timer や未awaitの処理から後続 action が実行されないようにする。
さらに runtime 側の action implementation には第2引数で同じ `AbortSignal` を渡す。
すでに開始済みの merge、runtime start、secret access も、この signal を見て中断や
冪等化を行えるようにする。dispatcher は action implementation を runtime `actions`
object を receiver として呼ぶため、`this.client` などに依存する object method も
そのまま利用できる。
`context.runtime.startRun` も handler へ直接 provider を渡さず gated wrapper にする。
`runtime:start` capability がない handler は runtime provider 経由でも起動できない。
handler が `context.runtime.startRun(request, { signal })` として caller signal を渡した
場合、dispatcher は plugin lifecycle signal と caller signal を合成して provider へ渡す。
互換 API の `context.capabilities.dispatchAgent` も同じ `runtime:start` gate を通し、
未宣言 handler から agent/run 起動経路を迂回できないようにする。handler が
`dispatchAgent` に独自の abort signal を渡した場合でも、dispatcher は plugin lifecycle
signal と合成して provider へ渡し、timeout や親 abort が必ず agent/run 起動へ伝播する。
親 runtime signal が abort された場合は handler promise や timeout を待たず、
plugin の rejected result として dispatch を完了する。dispatch 開始時点で親 signal が
すでに abort 済みの場合は、handler を起動せずに rejected result として扱う。
timeout 発火時は timeout result を先に確定してから signal を abort し、abort cleanup が
handler を resolve/reject しても audit result は `timeout` のままにする。親 abort 用の
race promise は handler 起動前に登録し、handler 側の abort cleanup が先に settle しても
shutdown/cancel の rejected result を維持する。

`context.providers.tasks` も handler lifecycle の signal で guard する。timeout、親 abort、
または handler settle 後に遅れて続行した handler が `createComment`、`setStatus`、
`createProposal` などの task provider 操作を呼んでも、provider 実装は実行せず rejected
side effect として拒否する。開始済みの provider 操作にも第2引数で同じ
`AbortSignal` を渡すため、network 待ちの `createComment`、`setStatus`、
`createProposal` なども provider 実装側で中断や冪等化を行える。handler が task provider
呼び出しに caller signal を渡した場合も、dispatcher は lifecycle signal と caller signal
を合成して provider へ渡す。provider method も tasks object を receiver として呼ぶため、
`this.name` や `this.client` を使う実装を壊さない。

`audit.record(entry)` を渡すと、plugin id、event id、run id、action、
result、発生時刻が記録される。action result は `fulfilled`、`rejected`、
`denied`、`timeout` のいずれか。secret action の audit entry は secret の
値を含めない。`readSecret` の失敗 reason は固定文に redaction し、secret manager の
例外 message を audit に保存しない。ただし plugin へ返す例外は元の Error を維持し、
recovery や retry 判断に使えるようにする。`secret:access` を持つ handler の
`plugin.handle` 失敗 reason も固定文に redaction し、handler が secret 値を含む
例外を投げても audit に保存しない。さらに secret-capable handler の action failure
reason も固定文に redaction し、secret を別 action の request に含めた後の失敗経路でも
audit に secret 断片を保存しない。audit sink は observability dependency として扱い、
書き込み失敗や長時間の未解決 Promise は plugin result や action result を変えず、
dispatcher の結果返却も止めない。audit sink が未設定の場合、dispatcher は audit entry
自体を作らず `runtime.now()` も呼ばない。

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
`accepts` が false の workflow は処理対象外なので、capability metadata は読まない。
capability metadata の読み取りや snapshot が失敗した場合も同じ plugin 単位の
rejected result に隔離し、`Promise.all` 全体を reject しない。
handler が `timeoutMs` または loader/dispatcher の `defaultTimeoutMs` を超えた場合も、
その plugin の rejected result と audit result `timeout` に隔離する。
親 abort listener は context 構築が失敗した場合も cleanup し、長寿命 shutdown signal に
listener/controller を蓄積しない。`timeoutMs` metadata の読み取りが context 構築後に
失敗した場合も同じ cleanup を行う。
最小 contract では retry や並列度制御は持たせない。これらは orchestration policy
として後続 issue で追加する。

## reirei-harness matcher/router 移行の見通し

reirei-harness 側の matcher は GitHub webhook payload を直接読む代わりに、
Source plugin で `github.issue` や `github.pull_request` に正規化する。
既存 router は `event.name`、`event.subject`、`event.source.repository` を見る
Workflow plugin に移せる。実際の Codex/OpenClaw 起動は runtime capability として
Workflow plugin へ注入するため、routing 条件と provider 実行を分離できる。
