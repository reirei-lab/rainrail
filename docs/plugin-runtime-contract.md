# 中立イベントモデルと plugin runtime contract

Rainrail は Source plugin が外部イベントを中立 envelope に正規化し、
Workflow plugin が provider/runtime capability を使って処理する境界を持つ。
GitHub webhook や Cloudflare tail の payload は Source plugin の入力であり、
Workflow plugin の routing API には直接漏らさない。
Core、EEP Bridge bundle、Source adapter、transport の package/module 境界は
[Core / EEP Bridge / Source adapter boundary](core-eep-bridge-source-adapter-boundary.md)
を正とする。

この contract で扱う source bundle は、Source plugin / Source adapter と HTTP、tail、
manual/chat などの ingress を Core intake に接続する composition 単位である。
EEP Bridge bundle is one source bundle: 現行実装では GitHub webhook と Cloudflare tail を
同じ publish-to-core 経路へ束ねる。manual/chat source は EEP Bridge 由来ではないが、
同じ `RainrailEventEnvelope`、`RainrailIntakeAdapter`、Workflow plugin contract を使う。

公開 export inventory は `WorkflowPlugin` `PluginRuntimeContext`
`RuntimeDispatcher` `createRuntimeDispatcher` `defineWorkflowPlugin`
`createPluginLoader` `createRouteWorkflow` `createRouteLocalHandler`
`routeRainrailEvent` `PullRequestCheck` `PullRequestReview`
`PullRequestReviewTarget` `PullRequestReviewComment` `PullRequestMergeMethod`
`GitHubPullRequestProvider` `AgentTaskIssue` `AgentTaskClaim` `AgentTask`
`AgentTaskHandoffClient` `ReviewRequestWorkflowOptions`
`TodoHandoffWorkflowOptions` `ChangeRequestWorkflowOptions`
`CodexReviewWorkflowOptions` `CheckFailureWorkflowOptions`
`ConflictCheckWorkflowOptions` `AutoMergeWorkflowOptions` `WorkflowResult`
`createReviewRequestWorkflow` `createChangeRequestWorkflow`
`createCodexReviewWorkflow` `createCheckFailureWorkflow`
`createConflictCheckWorkflow` `createAutoMergeWorkflow`
`handleReviewRequestEvent` `handleChangeRequestEvent` `handleCodexReviewEvent`
`handleCheckFailureEvent` `handleConflictCheckEvent` `handleAutoMergeEvent`
`allChecksPassed` `createTaskProviderPullRequestCommentHandoff`
`GitHubAuthToken` `createGitHubTaskProvider` `createGitHubPullRequestProvider`
`recordGitHubRateLimit` をこの contract で扱う。

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
公開 API は `SourcePlugin` と `defineSourcePlugin` を入口にする。
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
実装の入口は `createCloudflareTailSourcePlugin` で、入力 payload は
`CloudflareTailEvent` として扱う。

## Manual / Web chat source

Manual trigger や Web chat UI からの user input は EEP Bridge 固有の webhook ではなく、
Rainrail が直接持つ非 webhook source として扱う。最小 contract は
`createManualInputEvent` と `createManualInputIntakeAdapter` で提供する。
型は `ManualInputChannel`、`ManualInputPayload`、`ManualInputActor`、
`ManualInputAttachment`、`ManualInputReplyTarget`、`ManualInputHttpBody`、
`ManualInputRainrailEvent`、`ManualInputIntakeAdapterOptions`、
`CreateManualInputEventInput` を公開 API とする。

event name は channel ごとに固定する。

- manual trigger: `rainrail.manual.message`
- Web chat message: `rainrail.chat.message`

`source.type` は `manual` または `chat`、`source.name` は既定で
`manual-input` または `web-chat` とする。`subject` はどちらも
`type: "conversation"` とし、`subject.id` には conversation id を置く。
`conversationUrl` は provider URL の allowlist が Core subject URL と一致しない場合があるため、
`subject.url` ではなく `payload.conversation.url` にだけ保持する。
payload は provider 固有 raw body ではなく、次の正規化済み shape にする。

- `provider: "rainrail"`
- `channel: "manual" | "chat"`
- `action: "message"`
- `conversation.id`
- `message.id` と `message.text`
- 任意の `actor`、`attachments`、`replyTarget`

`message.text` は workflow が runtime start prompt などに使う正規化済み user content
として envelope に載せる。一方で HTTP request body や Web chat provider の extra field は
Core storage / durable replay に残さない。`rawPayload` は `inline-redacted` とし、
`manual://deliveries/<delivery-id>` または `chat://deliveries/<delivery-id>` の参照と
digest だけを保持する。manual/chat の raw payload reference は既存 provider と同じく
port なしの `deliveries` host と安全な 1 path segment の delivery id だけを許可し、delivery id
生成時に `:` など reference に使えない文字は `-` へ正規化する。長い conversation id や message id は
末尾の一意要素と短い hash を残し、Bridge room の 128 文字 id 制限を超える場合は top-level
event id も短い明示 id にする。`sourceName` は `source.name` と event id に使う前に
安全な identifier へ正規化する。credential-looking な conversation id / message id /
delivery id / source name は元値も元値由来の安定 hash も永続化せず、fallback 名だけを残す。対象は
standalone GitHub token 形式だけでなく、`token=...` や `session: ...` などの
credential key/value 形式も含む。先頭記号へ fallback prefix を足す場合も、元から
prefix 付きだった identifier と衝突しないよう短い hash を残す。
URL 形式の identifier は fallback 名と安定 hash へ縮約し、任意の host/path は Core storage に
残さない。ただし URL userinfo や credential らしい path segment を含む URL は
credential-looking identifier と同じく fallback 名だけを残す。
空文字または空白だけの `messageId` は未指定として扱い、UUID fallback で delivery id の
一意性を保つ。明示された `deliveryId` が空文字または空白だけの場合も未指定として扱い、
conversation/message 由来の delivery id 生成へ戻す。空文字または空白だけの `conversationId` /
`message` は、HTTP intake と同じく `createManualInputEvent` でも event 作成前に拒否する。
`attachments` は先頭 20 件だけを
正規化し、空白だけの attachment id から fallback id は作らない。
token、secret、password、API key、Bearer credential 形式は `key=value`、
JSON/YAML 風の `key: value`、quoted JSON field のいずれも source adapter 側で短く
redaction する。redaction は credential key の大小文字差、structured object / array 値、
standalone GitHub access token 形式、非 HTTPS credential URL、URL userinfo の credential、
URL path 内の credential らしい segment も対象にする。`conversationUrl`、attachment URL、`replyTarget.url` も
query / fragment / userinfo を落とし、credential らしい path segment を redaction したうえで
8KB 以内に縮約する。

HTTP intake の既定 route は `/intake/manual` と `/intake/chat` で、adapter は JSON body から
`conversationId`、`message`、任意の `messageId`、`actor`、`attachments`、`replyTarget`
を読み、正規化済み envelope を `RainrailIntakeAdapterContext.publish()` へ渡す。`message` が
object の場合は `message.text` を本文、`message.id` を top-level `messageId` がない場合の
message id として扱い、retry 時に同じ delivery id を再生成できるようにする。`replyTarget`
を保存する場合は `id` を必須とし、`url` だけの reply target は contract payload として
扱わない。`actor` の各 field と `replyTarget.id` は trim 後に空でない文字列だけを
保存し、空白だけの入力から fallback id や user type を作らない。
adapter は `/api/v1/sources` で初回 delivery 前から `manual` / `chat` source として見えるよう、
`source.type` と `authStatus: "configured"` を宣言する。HTTP `Content-Type` header は
raw payload へ入れる前に media type だけへ正規化し、parameter は保存しない。
`createManualInputIntakeAdapter` は `ManualInputIntakeAdapterOptions.bearerToken` を必須とし、
body を読む前に `Authorization: Bearer <token>` を検証する。manual/chat input は
`runtime:start` へ接続され得るため、Core の generic intake route ではなく adapter 境界で
source-specific auth を持つ。Node server や Fetch app が adapter の前で request body を
buffer 化しないよう、manual/chat route は handle 前 body read を無効にし、認証後に adapter 内で
`maxBodyBytes` を適用する。
Workflow plugin は通常の event と同じく `rainrail.chat.message` や
`rainrail.manual.message` に `accepts` / local handler を設定し、
`runtime:start` capability を宣言したうえで `context.actions.startRuntime()` を呼べる。

## Task provider

Task provider は forge/task system の操作面を表す。初期 contract は
GitHub と Forgejo の issue 操作を同じ workflow から使えるように、
`getIssue`、`createComment`、`addToProject`、`setStatus`、`createProposal`
を持つ。
公開 contract は `TaskProvider` として提供する。

`TaskIssueRef` は provider、repository、id、number、url を持てる。
Workflow plugin は GitHub webhook payload ではなく、中立 event の
`source` と `subject` から `TaskIssueRef` を作る。これにより、issue、
project、comment、status、proposal の操作は provider 実装に閉じ込められる。
GitHub の実 API adapter は core contract ではなく `src/providers/github/*` に置く。
root の `src/github-provider.ts`、`src/github-project.ts`、`src/github-auth.ts`、
`src/github-rate-limit.ts` は既存 import 互換の re-export shim として扱う。

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
spawn しない。detached process が `running` として返った後は runtime へ所有権が移るため、
handler lifecycle cleanup の abort では child process を停止しない。spawn 後に
Node が `error` を emit しても未処理例外で Rainrail を落とさないよう listener を置き、
provider 利用側が `onSpawnError` で観測できるようにする。start run の log path は
同じ issue task を別 run で再起動しても過去ログを切り詰めないよう、agent session id
由来の短い正規化 prefix と短い hash を含む一意な名前にし、長い session key でも一般的な
filesystem filename limit に収める。resume run も attempt id 由来の
正規化名と短い hash を含め、同じ issue task の別 session が同じ resume log に
追記されないようにする。resume attempt id も raw session key の短い hash を含め、
正規化後に同名になる session key の attempt log が衝突しないようにしつつ、長い task/session でも
一般的な filesystem filename limit に収まるよう prefix を短く保つ。OpenClaw agent 起動には
start/resume とも delivery/task/attempt 由来の安定した `--run-id` を渡し、再配送や timeout retry が
同一 run として冪等に扱われるようにする。start retry は同じ stdout/stderr log を切り詰めず、
前回 completion metadata や fallback marker を保持する。`task.agentSessionId` が無い場合に生成する
session key は workflow 名も含め、同じ delivery/task を別 workflow から起動しても transcript/log が混ざらないようにする。
初回実行が gateway
fallback session へ移った場合は、前回 completion metadata の top-level または
`result` 配下の `meta.agentMeta.fallbackSessionKey` から fallback session key を、
または `meta.agentMeta.sessionId` が `gateway-fallback-*` の場合は explicit fallback session key を、
または stdout/stderr log の embedded fallback marker から fallback session id を検出して resume
対象にする。marker 由来の fallback session id は `agent:<agent>:explicit:<session-id>` の
session key として再開し、JSON completion として解析できた stdout 内の引用 marker は
resume 対象にしない。banner/footer 付き completion でも抽出できた JSON metadata を優先する。
Task と resume attempt には stdout `logPath` と対応する `stderrLogPath` を保持し、
stderr 側にしか fallback diagnostics が残らない timeout でも fallback transcript を引き継ぐ。
stderr diagnostics に JSON status 行と embedded fallback marker が同居する場合も marker を採用する。
同一 log に複数の fallback metadata または marker が追記されている場合は、最後のものを最新として採用する。
OpenClaw の raw stdout/stderr log は redaction 前の credential を含み得るため、
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
completion text/status は top-level と `result` の両方から解決し、`result` が metadata だけを
持つ場合でも top-level の Outcome を落とさない。top-level の terminal runtime status は
`result.status` より優先し、`error` / `timeout` alias も top-level にあれば失敗扱いとして採用する。
top-level final text は payload text より優先して Outcome を解決し、同じ text に複数の Outcome がある場合は
最後の Outcome を採用する。
resume helper は running pid を確認し、
安定した resume attempt id を生成する。timeline reader は OpenClaw trajectory jsonl を読み、Codex activity 表示に
必要な時刻、分類済み phase、redacted summary、status、redacted excerpt を返す。
root package は OpenClaw runtime/timeline helper として `OpenClawRuntimeProviderOptions`、
`OpenClawSpawnErrorEvent`、`RuntimeRunCompletion`、`RuntimeTimelinePhase`、
`RuntimeTimelineEntry`、`RuntimeTimelineResult`、`RuntimeTimelineStatus`、
`createAgentAssignmentRuntimeFromProvider`、`createOpenClawRuntimeProvider`、
`startOpenClawRun`、`readRuntimeRunCompletionFromLog`、`runningRuntimeTaskPid`、
`nextRuntimeResumeAttemptId`、`readRuntimeTimeline`、`readRuntimeTimelineStatus`、
`readRuntimeJsonl`、`extractRuntimeSessionId`、`extractRuntimeFallbackSessionId`、
`runtimeTrajectoryPathForSessionId`、`parseRuntimeTrajectoryTimeline`、
`classifyRuntimeToolCall` を公開 API として re-export する。
runtime / timeline の実体は `src/agent-runtime/AGENTS.md` の scoped rules が適用される
`src/agent-runtime/index.ts` と `src/agent-runtime/timeline.ts` に置く。既存の
`src/agent-runtime.ts` と `src/agent-timeline.ts` は runtime compatibility shim として残し、
root package の re-export と既存 import path を壊さない。
timeline/status/jsonl の session 解決は resume attempts を新しい順に読んだうえで、
stdout `logPath` と対応する `stderrLogPath` または `.stderr.log` の embedded fallback marker も参照する。
fallbackSessionKey metadata と fallback marker は種類で後から優先順位を変えず、log 探索順で最初に
見つかった fallback を元の agentSessionId mapping より優先する。banner/footer 付き completion JSON 内の
引用 marker は timeline/status/jsonl の fallback 判定にも使わない。fallback marker は
`agent:<agent>:explicit:<session-id>` の `sessions.json` mapping を先に解決して relocated session file を
見失わないようにする。redaction は shell 風の
`token=...` や `curl -u user:password` / `curl -uuser:password` /
`curl --proxy-user user:password` /
`curl --oauth2-bearer token` / `curl --pass phrase` / `curl --tlspassword string` /
`curl -E client.pem:password` / `curl --cert client.pem:password` /
`curl --proxy-cert proxy.pem:password` / `curl -b session=value` / `curl --cookie session=value` /
`curl -sHAuthorization: ...` / `curl -sHCookie: ...` / `curl -su user:password` / `curl -sb session=value` /
`curl -suuser:password` / `curl -sbsession=value` / `curl -sEclient.pem:password`
だけでなく JSON の `"token": "..."` /
`"apiKey": "..."` / `"password": "..."`、`"webhookSecret"` / `"clientSecret"` /
`"apiToken"` のような compound key、quoted shell assignment、`github_pat_...`、
HTTP Authorization/Cookie/Set-Cookie header 全体、standalone `Bearer <token>` credential も対象にする。
header 値内の quote は header 終端とみなさず、次 header または改行までを redaction する。
timeline status は最後の lifecycle/event row を見て
ended を更新し、resume 後に追記された session を古い ended のまま扱わない。trajectory の既定 path は
`agentId` ごとの `~/.openclaw/agents/<agentId>/sessions` を使い、`main` 以外の
OpenClaw agent でも呼び出し側が毎回 sessionsDirectory を上書きしなくてよい。

secret や provider 固有 token は runtime provider の実装が保持し、
contract には含めない。
公開 contract は `RuntimeProvider` として提供する。

## Dashboard card contribution

Dashboard card は Core built-in card と plugin contribution を同じ catalog で扱う。
公開 API は `DashboardCardDefinition`、`DashboardCardProvider`、
`DashboardCardRegistry`、`createDashboardCardRegistry`、`defineDashboardCard`、
`defineDashboardCardProvider`、`DashboardCardCatalogEntry`、
`DashboardCardAvailability`、`DashboardCardEntry`、`DashboardCardSize`、
`DashboardCardSizeConstraints`、`DashboardCardSettingsSchema`、
`DashboardCardListOptions`、`DashboardLayoutItem`、
`DashboardCardRegistryError`、`DashboardCardRegistryErrorCode`、
`DashboardPluginManifest`、`DashboardPluginManifestDashboard`、
`DashboardPluginManifestCard`、`createDashboardCardProviderFromManifest`、
`DashboardCardSandboxHostOptions`、`DashboardCardSandboxFrameOptions`、
`DashboardCardSandboxBridgeHandler`、`DashboardCardBridgeAction`、
`DashboardCardBridgeRequest`、`DashboardCardSandboxBridge`、
`DashboardCardSandboxFrame`、`DashboardCardSandboxLoadResult`、
`DashboardCardSandboxHost`、`createDashboardCardSandboxHost` を入口にする。

`DashboardCardDefinition.id` は catalog 全体で一意にする。Core card は
`core.eventInbox` のように `core.` prefix を使い、plugin card は
`plugin:<pluginName>.<cardName>` のように plugin 名を含める。registry は id 衝突を
登録時に拒否するため、dashboard layout の `DashboardLayoutItem.cardId` は
Core/plugin の区別を意識せず同じ id 空間を参照できる。
`description` は任意だが、指定する場合は文字列だけを許可する。
Core card の id は `core.${entry.name}`、plugin card の id は
`plugin:${entry.pluginName}.${entry.cardName}` と完全一致させる。registry はこの
namespace 不一致を登録時に拒否し、catalog consumer が id から Core/plugin と owner を
安定して判定できるようにする。

`DashboardCardDefinition.entry` は `{ type: "core", name }` または
`{ type: "plugin", pluginName, cardName }` のどちらかに分ける。Core entry は
Rainrail 本体が解決し、plugin entry は enabled plugin catalog で plugin が有効な場合だけ
利用可能とする。無効な plugin、capability 不足、entry 解決失敗は card を catalog から
消す理由にはしない。`DashboardCardCatalogEntry.availability` を
`available` / `unavailable` で返し、`invalid_plugin`、`missing_capability`、
`entry_resolution_failed` の reason と operator 向け message を保持する。
entry 解決を実行する caller は、解決できなかった card id と理由を
`DashboardCardListOptions.entryResolutionFailures` に渡して catalog 上へ反映する。
entry 解決失敗と capability 不足が同時にある場合も、availability には
`missingCapabilities` を残す。
plugin card の availability 評価では `DashboardCardListOptions.enabledPlugins` が未指定なら
plugin 有効性は未確認として扱い、`invalid_plugin` で unavailable にする。
`DashboardCardListOptions.availableCapabilities` が未指定の場合も全許可とは扱わず、
card が宣言した `requiredCapabilities` をすべて missing として返す。
Rainrail 本体の標準 dashboard は `core` provider として
`core.operationalTotals`、`core.eventInbox`、`core.workflowRuns`、`core.agentTasks`、
`core.sources`、`core.queue`、`core.settings`、`core.operatorActions` を登録する。
保存済み layout の永続 `cardId` 互換のため、legacy id の `core.overview` と
`core.recentEvents` も catalog には残す。
これらは既存の fixed dashboard surface と同じ情報境界を保ち、card dashboard 移行中も
auth、token 入力、polling、stale data 表示、operator action の workflow を維持する。
`registerProvider()` で plugin contribution を受ける場合、plugin entry の `pluginName` は
`DashboardCardProvider.name` と一致しなければならない。別 provider の namespace を
先取りする card は登録時に拒否する。Core entry は Rainrail 本体の内部登録経路だけが扱い、
`registerProvider()` では `core` provider 名を予約名として拒否し、plugin provider 経由の
non-plugin entry も拒否する。provider 登録は all-or-nothing とし、
複数 card のうち 1 件でも invalid definition、duplicate id、namespace mismatch があれば、
その provider 由来の card は 1 件も catalog に追加しない。
provider object は `kind: "dashboard-card-provider"` と `cards` 配列を必須とし、
別 kind や非配列 cards は登録時に拒否する。provider の各 card も通常の definition として
先に検証し、非 object card から TypeError を漏らさない。plugin id の曖昧な分割を避けるため、
plugin entry の `pluginName` と `cardName` は `.` と `:` を含めない。

`requiredCapabilities` は dashboard 表示や provider 読み取りに必要な read-only
capability を宣言する。registry の `list()` は caller が渡した
`availableCapabilities` と `enabledPlugins` で availability を評価し、不足 capability は
`missingCapabilities` として返す。危険操作の capability gate は Workflow plugin の
`context.actions` に残し、Dashboard card は action 実行経路を持たない。
`requiredCapabilities` は任意だが、指定する場合は非空文字列の配列だけを許可する。
JS/JSON 経由の plugin が別 shape を渡した場合は登録時に `DashboardCardRegistryError` で
拒否し、catalog 生成中に TypeError を漏らさない。

`category` は dashboard 側の grouping 用の安定文字列とする。`size` は plain object、
`size.default` は必須で、
`size.min` / `size.max` は任意の制約として扱う。columns/rows は正の整数だけを許可し、
min/default/max の大小関係が壊れた definition は登録時に
`DashboardCardRegistryError` として拒否する。`settingsSchema` は JSON object schema
compatible な operator settings metadata で、secret value や provider credential は
含めない。Card-specific rendering payload は別 API で解決し、registry contract は
definition と layout metadata だけを持つ。
card definition と `settingsSchema` を指定する場合の schema は plain object として受ける。
`settingsSchema` は `type: "object"`、JSON-serializable な値だけを許可する。
`additionalProperties` は boolean または JSON schema plain object だけを指定できる。
`Map`、function、`undefined`、`BigInt`、循環 object など、JSON として安定保存できない
値は登録時に拒否する。
Dashboard UI は card catalog の `settingsSchema` から per-card settings form を最小描画し、
保存値は user dashboard layout item の `config` にだけ保存する。`config` は operational API の
layout validation を通り、secret / token / credential 系 key は保存前に拒否するため、
plugin card は provider credential や dashboard bearer token を settings に持ち込まない。
registry は登録時に検証済み definition を clone/freeze し、plugin 側が元 object を後から
mutate しても Map key、entry namespace、capability、size、entry resolution failure の照合が
変わらないようにする。

Plugin package manifest は `DashboardPluginManifest.dashboard.cards[]` で dashboard card
contribution を宣言できる。`createDashboardCardProviderFromManifest()` は manifest の
`name` を provider 名として使い、各 card の `name` から
`plugin:<pluginName>.<cardName>` id と `{ type: "plugin", pluginName, cardName }`
entry を生成する。manifest の `dashboard.cards` は配列だけを許可し、card object は通常の
`DashboardCardDefinition` と同じ validation を受ける。これにより sample plugin は
manifest だけで card catalog に contribution を登録でき、namespace 不一致や delimiter を含む
card name は registry 登録前に `DashboardCardRegistryError` として扱われる。

最小の plugin dashboard card contribution は次の形にする。

```ts
import {
  createDashboardCardProviderFromManifest,
  type DashboardPluginManifest,
} from 'rainrail';

const manifest: DashboardPluginManifest = {
  name: 'github',
  version: '1.0.0',
  dashboard: {
    cards: [{
      name: 'queue',
      title: 'GitHub queue',
      description: 'Open issue and pull request queue.',
      category: 'operations',
      requiredCapabilities: ['dashboard:read', 'github:read'],
      size: {
        default: { columns: 3, rows: 2 },
        min: { columns: 2, rows: 1 },
        max: { columns: 6, rows: 4 },
      },
      settingsSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
        },
        additionalProperties: false,
      },
    }],
  },
};

export const githubDashboardCards = createDashboardCardProviderFromManifest(manifest);
```

この例の card id は `plugin:github.queue` になる。Dashboard layout は
`DashboardLayoutItem.cardId` でこの id を参照し、operator が保存する card-specific
settings は layout item の `config` にだけ入る。Plugin manifest や settings schema に
provider credential、dashboard bearer token、secret 値は入れない。
実際に typecheck される sample は `docs/examples/plugin-runtime.ts` の
`issueSummaryManifest` と `issueSummaryCards` に置く。

Plugin card の描画境界は `createDashboardCardSandboxHost()` が作る
`DashboardCardSandboxFrame` を正とする。host は plugin card だけを iframe sandbox 対象にし、
`sandbox: "allow-scripts"`、`referrerPolicy: "no-referrer"`、lazy loading の descriptor を返す。
`allow-same-origin`、form、popup、top-navigation などの権限は付けない。sandbox URL は
plugin 名と card 名の path だけで解決し、`cardId` と任意の layout item id を query に渡す。
`DashboardCardSandboxBridge` は card definition の `requiredCapabilities` と host 側
`allowedCapabilities` の交差だけを公開する。bridge handler がない capability や許可されていない
capability request は card 単位で失敗し、危険操作は Workflow plugin の action gate に残す。
Structured bridge call は `DashboardCardBridgeRequest` として `cardId`、`pluginName`、
`cardName`、任意の `layoutItemId`、`capability`、`action`、JSON object `params` を渡す。
host は handler dispatch 前に card id / plugin name / card name / layout item id / capability /
action を検証し、別 card へのなりすましや capability の横取りを拒否する。
旧 `bridge.request(capability, payload)` 形式は untrusted iframe 境界では handler dispatch 前に
拒否し、structured request validation の迂回経路として残さない。
`DashboardCardBridgeAction` は `refresh`、`openDetail`、`runAction`、`showToast` に限定する。
`refresh` と `openDetail` は dashboard read capability の範囲で dashboard shell が代行し、
`runAction` は operator API と同じ scope / confirmation / audit を通る handler だけが実装する。
現行の iframe bridge は read-only capability だけを公開するため、operator capability の対応が
追加されるまでは `runAction` を handler dispatch 前に拒否する。
`showToast` は card-local feedback であり、token、store、raw payload への直接 access は提供しない。
iframe bridge に公開できる capability は `dashboard:read` または `*:read` 形式の read-only
capability だけとし、`runtime:start`、`secret:access`、`merge` などの workflow 用 capability は
host 側の `allowedCapabilities` に含まれていても公開しない。
`DashboardCardSandboxHost.load()` は load failure / timeout を throw せず
`DashboardCardSandboxLoadResult` の `{ status: "error" }` として返すため、1 つの plugin card が
落ちても dashboard shell と他カードの描画を継続できる。

## Workflow plugin

Workflow plugin は `accepts(event)` で対象イベントを絞り込み、
`handle(event, context)` で処理する。`context` は `providers.tasks` と
`runtime` を受け取り、必要なら既存の `capabilities` も使える。
公開 API は `WorkflowPlugin`、`PluginRuntimeContext`、
`defineWorkflowPlugin` を入口にする。

Workflow plugin は event に反応し、Task provider と Runtime provider を
組み合わせるだけにする。GitHub/Forgejo の API 呼び出しや OpenClaw/devteam/Codex
の起動詳細は、それぞれの provider/runtime 実装に閉じ込める。

mock task provider と mock runtime provider を `createRuntimeDispatcher` に渡せば、
workflow test は外部 API なしで書ける。互換性のため dispatcher runtime context は
provider/runtime 未指定でも構成できるが、その場合 handler に渡る provider/runtime は
呼び出し時に明示的な unavailable error を返す。

Workflow plugin と routing helper の公開 export inventory は
`WorkflowPlugin`、`PluginRuntimeContext`、`RuntimeDispatcher`、
`createRuntimeDispatcher`、`defineWorkflowPlugin`、`createPluginLoader`、
`createRouteWorkflow`、`createRouteLocalHandler`、`routeRainrailEvent` とする。

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

## PR lifecycle workflow

PR lifecycle workflow は GitHub の normalized PR/check/review/status event を
review request、change request handoff、Codex review handoff、failed check
handoff、base push conflict check、auto-merge の各 workflow に分ける。
実 GitHub API は `GitHubPullRequestProvider` に閉じ込め、handler は
`PullRequestReviewTarget`、`PullRequestCheck`、`PullRequestReview`、
`PullRequestReviewComment` の正規化済み状態だけを見る。
`GitHubPullRequestProvider` は read-only とし、merge は provider から直接公開しない。
`findPullRequestsByHead` は同じ head SHA に複数の open PR が紐づく場合も全候補を返し、
workflow 側で agent branch / head repository / task claim を評価する。
auto-merge は `PullRequestMergeMethod` を明示的に扱い、実行は capability/policy gate
付きの `context.actions.mergePullRequest` だけを通す。

agent task handoff は `AgentTaskIssue`、`AgentTaskClaim`、`AgentTask`、
`AgentTaskHandoffClient` で表す。Project item を Todo に戻す adapter は
`createTaskProviderPullRequestCommentHandoff` で、Project claim の release と
issue comment 作成を同じ handoff 境界で扱う。個別 workflow の options は
`ReviewRequestWorkflowOptions`、`TodoHandoffWorkflowOptions`、
`ChangeRequestWorkflowOptions`、`CodexReviewWorkflowOptions`、
`CheckFailureWorkflowOptions`、`ConflictCheckWorkflowOptions`、
`AutoMergeWorkflowOptions` で、handler の戻り値は `WorkflowResult` にそろえる。

packaged workflow factory は `createReviewRequestWorkflow`、
`createChangeRequestWorkflow`、`createCodexReviewWorkflow`、
`createCheckFailureWorkflow`、`createConflictCheckWorkflow`、
`createAutoMergeWorkflow` を公開する。外部 API なしの focused test では
`handleReviewRequestEvent`、`handleChangeRequestEvent`、
`handleCodexReviewEvent`、`handleCheckFailureEvent`、
`handleConflictCheckEvent`、`handleAutoMergeEvent` を直接呼べる。
workflow test は mock `TaskProvider` / `PullRequestProvider` を使う。
GitHub provider 実装の HTTP adapter behavior は `github-provider.test.ts`、`githubPullRequest.test.ts`、
`github-project.test.ts` で検証する。
check rollup 判定は `allChecksPassed` に集約し、`success` に加えて
`neutral` / `skipped` の完了も成功扱いにする。
GitHub provider helper の公開 export inventory は `GitHubAuthToken`、
`createGitHubTaskProvider`、`createGitHubPullRequestProvider`、
`recordGitHubRateLimit` とする。

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
merge、runtime start、secret access は、この signal を見て起動前の拒否や
冪等化を行えるようにする。detached runtime start/resume は `running` を返した時点で
handler lifecycle から所有権が離れる。dispatcher は action implementation を runtime `actions`
object を receiver として呼ぶため、`this.client` などに依存する object method も
そのまま利用できる。
`context.runtime.startRun` と `context.runtime.resumeRun` は handler へ直接 provider を渡さず gated wrapper にする。
underlying provider が optional `resumeRun` を持たない場合、wrapper も `resumeRun` を
`undefined` として見せ、workflow の optional chaining による feature detection を保つ。
`runtime:start` capability がない handler は runtime provider 経由でも起動できない。
handler が `context.runtime.startRun(request, { signal })` として caller signal を渡した
場合、または `context.runtime.resumeRun(request, { signal })` として caller signal を渡した
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
`runtimeProviders.openclaw` は agent runtime 起動設定を持つ。`sourceBundles` は
EEP Bridge bundle、GitHub webhook、Cloudflare tail、manual/chat source などの
組み立てを明示する。bundle source は `provider` と `runtime` に既知 provider 名を
参照として持ち、Core app / Worker は config からどの intake adapter を登録するか追える。
環境変数は `${NAME}` 形式で JSON parse 前に展開し、値は JSON string content として
エスケープする。secret 値そのものではなく、運用では環境変数や secret 名を
config に渡す。Worker の `RAINRAIL_CONFIG_JSON` では `webhookSecret` に secret 名を
書き、EEP Bridge bundle が同名 env / Workers Secret から実値を読む。

GitHub auth は `token`、GitHub App installation token、環境変数 PAT、
`gh auth` fallback を同じ `GitHubAuthToken` として扱う。環境変数 fallback は
GitHub CLI と同じく `GH_TOKEN`、`GITHUB_TOKEN` の順で最初の非空値を使う。`gh auth`
fallback は Rainrail の GitHub API URL に合わせて `github.com` host だけから
取得する。`GitHubTaskProvider` は `auth.getAuthToken()` を注入できるため、
workflow test や別 runtime では実 GitHub App/PAT 実装を差し替えられる。
実装の入口は `src/providers/github/index.ts` から公開する issue/task 操作用の
`createGitHubTaskProvider`、Project queue 用の
`createGitHubProjectTaskQueueProvider`、PR lifecycle workflow 用の
`createGitHubPullRequestProvider`。
デフォルト provider は GitHub App token 発行が GitHub API 側の auth/rate-limit
エラーで失敗したとき、設定済み env/gh fallback token があればそれを使う。

GitHub REST/GraphQL の rate limit header は `recordGitHubRateLimit()` で
snapshot として記録する。snapshot には auth provider と fallback 有無を残し、
provider 実装の観測性に使う。secret や token 値は snapshot に含めない。

## Dispatcher

`RuntimeDispatcher` の生成入口である `createRuntimeDispatcher` は
workflow plugin 配列と runtime context を受け取る。
実装本体は `src/dispatcher/index.ts` に置き、`src/dispatcher.ts` は既存 import を
壊さない compatibility shim として re-export だけを持つ。dispatcher 配下には
scoped `AGENTS.md` を置き、capability policy、lifecycle、audit、capability view の
境界を変更する開発者に近い場所で hard rule を読ませる。
次に分割する場合は、互換 shim を維持したまま capability policy、lifecycle/timeout
制御、audit recording、capability view/proxy を小さな module に切り出し、それぞれを
既存の plugin runtime test か追加 regression test で保護してから移動する。
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
