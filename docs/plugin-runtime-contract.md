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

## Workflow plugin

Workflow plugin は `accepts(event)` で対象イベントを絞り込み、
`handle(event, context)` で処理する。`context` は runtime が持つ
capability を含む。

Workflow plugin は任意で `capabilities` と `timeoutMs` を宣言できる。
`capabilities` は危険操作を呼ぶための宣言であり、宣言されていない plugin は
merge、runtime start、secret access を実行できない。

provider 名や agent dispatch などの低レベル runtime 情報は
`context.capabilities` に残す。一方で merge、runtime start、secret access は
`context.actions` の gated action として渡す。secret 値は audit log に含めず、
runtime action の戻り値を handler 内だけで扱う。

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
冪等化を行えるようにする。

`audit.record(entry)` を渡すと、plugin id、event id、run id、action、
result、発生時刻が記録される。action result は `fulfilled`、`rejected`、
`denied`、`timeout` のいずれか。secret action の audit entry は secret の
値を含めない。`readSecret` の失敗 reason は固定文に redaction し、secret manager の
例外 message を audit に保存しない。ただし plugin へ返す例外は元の Error を維持し、
recovery や retry 判断に使えるようにする。`secret:access` を持つ handler の
`plugin.handle` 失敗 reason も固定文に redaction し、handler が secret 値を含む
例外を投げても audit に保存しない。audit sink は observability dependency として扱い、
書き込み失敗や長時間の未解決 Promise は plugin result や action result を変えず、
dispatcher の結果返却も止めない。

## Dispatcher

`createRuntimeDispatcher` は workflow plugin 配列と runtime context を受け取る。
`dispatch(event)` は `accepts` が true の workflow だけを呼び、
plugin ごとに fulfilled/rejected の結果を返す。`accepts` が例外を投げた場合も
その plugin の rejected result として隔離し、後続 workflow の評価は続ける。
handler が `timeoutMs` または loader/dispatcher の `defaultTimeoutMs` を超えた場合も、
その plugin の rejected result と audit result `timeout` に隔離する。
最小 contract では retry や並列度制御は持たせない。これらは orchestration policy
として後続 issue で追加する。

## reirei-harness matcher/router 移行の見通し

reirei-harness 側の matcher は GitHub webhook payload を直接読む代わりに、
Source plugin で `github.issue` や `github.pull_request` に正規化する。
既存 router は `event.name`、`event.subject`、`event.source.repository` を見る
Workflow plugin に移せる。実際の Codex/OpenClaw 起動は runtime capability として
Workflow plugin へ注入するため、routing 条件と provider 実行を分離できる。
