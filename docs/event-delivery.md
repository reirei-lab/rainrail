# Rainrail core event delivery

Rainrail core のイベント配信は Source plugin が作った `RainrailEventEnvelope`
をそのまま downstream consumer へ流す。provider 固有 payload は envelope の
`payload` に閉じ、SSE の `event:` 名には中立イベント名である `event.name` を使う。
Core、EEP Bridge bundle、Source adapter、transport の責務境界は
[Core / EEP Bridge / Source adapter boundary](core-eep-bridge-source-adapter-boundary.md)
で固定する。

Bridge room、event bus、SSE framing の実装本体は `src/event-delivery/` に置く。
この directory の `AGENTS.md` は storage / publish / replay / SSE framing の
review rule を持つ scoped rules である。既存 import path のために
`src/bridge-room.ts`、`src/event-bus.ts`、`src/sse.ts` は compatibility shim として残す。

## Event bus

`createRainrailEventBus` は in-memory の subscriber 集合と replay buffer を持つ。
`replayLimit` は有限な非負整数だけを受け付け、`NaN` / `Infinity` / 負数 / 小数は
設定エラーとして拒否する。
`publish(event)` は次を行う。

- event を SSE 文字列に serialize できることを先に確認する。serialize できない
  event は replay buffer に入れず、subscriber にも送らない。
- event を clone して replay buffer に追加し、`replayLimit` を超えた古い event を
  捨てる。`recentEvents` も clone を返し、外部 code が過去 event を可変参照で
  書き換えないようにする。
- publish 開始時点の subscriber snapshot へ `formatRainrailSseEvent(event)` を broadcast
  する。write 中に reentrant に追加された subscriber は replay だけを受け取り、同じ
  event の live broadcast を重複して受け取らない。
- write に失敗した subscriber は切断済みとして `close` cleanup を呼んでから削除する。

subscriber は Node `ServerResponse` のような `{ write, close }` でも、
Worker/Fetch API の `ReadableStream` でも扱える。これにより Node server と
Cloudflare Worker entrypoint は同じ core contract を共有する。接続時 comment や
初期 replay の write が失敗した場合も `close` cleanup を呼び、購読開始に失敗した
connection のリソースを残さない。
公開 API の入口は `createRainrailEventBus` と `formatRainrailSseEvent`。

初期 replay は replay buffer の snapshot から送る。replay 中に subscriber が同期的に
`publish()` して replay buffer が trim されても、接続時点で保持されていた event を
飛ばさない。`loadReplay(events)` でも replay buffer に入れる前に clone と SSE serialize
検証を行う。CR/LF 入りの `id` / `name` など、SSE として配信できない event は replay
から除外する。

## SSE

SSE response は次の header を使う。

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`

接続時には `: connected` comment を送る。`keepAliveIntervalMs` が指定された
ReadableStream subscriber は `: keep-alive` comment を周期送信する。interval を
指定しない場合、core は keepalive timer を作らない。これはテストや短命の local
consumer を不要な timer で維持しないためで、runtime/entrypoint が必要に応じて
policy を渡す。`keepAliveIntervalMs` は Node / Web timer が 1ms に丸めない安全な整数範囲
（`1` から `2147483647`）だけを有効化し、`0` / 負数 / 小数 / `NaN` / 範囲外の値では
timer を作らない。

shared Fetch header では HTTP/2/HTTP/3 で禁止される hop-by-hop header を出さない。
HTTP/1.1 の Node adapter が `Connection: keep-alive` を必要とする場合は adapter 側で
付与する。

`id:` と `event:` に入れる値は CR/LF を拒否する。`id:` は U+0000 も拒否する。
Rainrail event envelope は custom `id` / `name` を許すため、ここで改行を通すと
subscriber 側で別の SSE field として解釈され、`id:` の U+0000 は browser
`EventSource` の last event id 更新を妨げる。

再接続時に `Last-Event-ID` が渡された場合は、replay buffer のうちその id より後の
event だけを再送する。指定 id が buffer に無い場合は、consumer が欠落を検出できる
ように保持中の replay buffer 全体を送る。同じ id が buffer に複数ある場合は、最後の
出現位置を基準にする。

## Bridge room

`RainrailBridgeRoom` は Fetch API 互換の endpoint を提供する。

- `GET /healthz`: `{ ok, clients, recent }` を返す。
- `POST /publish`: request JSON を `RainrailEventEnvelope` として検証し、replay
  snapshot を storage に保存してから live subscriber へ publish する。成功 response には
  検証・正規化後の `event` を含め、adapter が追加の operational store を持つ場合も
  storage / replay と同じ envelope を保存できるようにする。同じ event id が replay に
  既にある duplicate publish では、後続 request の envelope ではなく保存済み envelope を
  response の `event` として返す。
- `GET /events`: storage から replay buffer を復元し、SSE stream を返す。

`POST /publish` と `GET /events` は capability token で保護する。adapter は
`RainrailBridgeRoom` に `publishToken` を渡し、caller は
`Authorization: Bearer <token>` または `X-Rainrail-Publish-Token` を付ける。
認証に失敗した request は body / storage を読む前に 401 として拒否し、
storage / replay / workflow 起動や subscriber 枠消費の副作用を作らない。
外側の `/events` entrypoint が eep-bridge-worker 互換の JSON error を返す必要がある場合は、
`verifyRainrailEventsBearerToken()` で `Authorization: Bearer <token>` を検証する。
missing bearer は `missing_bearer_token` の 401、token 不一致は `invalid_bearer_token`
の 403、サーバ側未設定は `events_auth_not_configured` の 503 として扱う。
HTTP entrypoint の公開入口は Fetch adapter の `createRainrailHttpApp` と Node adapter の
`createRainrailNodeServer`。
Dashboard command API を組み込む caller 向けには、scoped token の `RainrailDashboardScope`、
`RainrailDashboardAuthOptions`、handler 入力の `RainrailCommandRequest`、
`RainrailCommandActionType`、`RainrailCommandTargetType`、および handler 型の
`RainrailCommandHandler` を public contract として公開する。

`createRainrailHttpApp` は provider 固有の ingress route を直接持たない。HTTP webhook、
manual publish UI、Worker tail などの外部入力は `RainrailIntakeAdapter` として登録し、
adapter handler が `RainrailEventEnvelope` へ正規化して context の `publish()` に渡す。
intake 登録 API の public contract は `RainrailIntakeAdapter`、`RainrailIntakeRoute`、
`RainrailIntakeAdapterContext`、`RainrailIntakePublishResult`、`RainrailIntakeRegistry`、
`RainrailIntakeRouteMatch`、`RainrailIntakeRouteMethodMismatch`、
`createRainrailIntakeRegistry` である。
未登録 route は `404`、Core route や adapter 同士の method/path 衝突は app 作成時の
configuration error とする。現行の `createRainrailNodeServer` と Cloudflare Worker entrypoint
は互換性のため GitHub webhook adapter を `/webhooks/github` に登録する。

Dashboard / mobile / operator tooling 向けの public v1 operational API は次の read endpoint
を提供する。いずれも event bearer token で保護し、provider secret や raw payload 本文は
返さない。

- `GET /api/v1/overview`: store counts、warnings、recent activity、latest events/tasks を返す。
- `GET /api/v1/events`: sanitized event rows を返す。`filter[source]`、`filter[name]`、
  `limit`、`cursor` を受け付ける。
- `GET /api/v1/events/{eventId}`: sanitized envelope、human summary、matched workflow、
  retry/audit context を含む event detail を返す。
- `GET /api/v1/workflow-runs`: workflow/action audit rows を返す。`filter[status]`、
  `limit`、`cursor` を受け付ける。
- `GET /api/v1/workflow-runs/{workflowRunId}`: workflow run detail と source event context
  を返す。
- `GET /api/v1/agent-tasks`: agent task rows を返す。`filter[status]`、`limit`、`cursor`
  を受け付ける。
- `GET /api/v1/agent-tasks/{taskId}`: agent task detail と stale project claim warning を返す。
- `GET /api/v1/sources`: configured source adapter rows、source type、endpoint、auth metadata、
  last delivery を返す。`filter[source]`、`limit`、`cursor` を受け付ける。
- `GET /api/v1/queue`: queue/project rows と blocked/upcoming/in-progress/claim summary を返す。
  `filter[status]`、`limit`、`cursor` を受け付ける。
- `GET /api/v1/settings`: read-only settings metadata と update policy を返す。現時点では
  max concurrency、auto-start、retry policy、operational snapshot limit、dashboard auth、
  runtime を表示する。

HTTP app は任意で operational store を受け取り、dashboard/API 用の provider-neutral
state も同じ Fetch app から返せる。operational store が設定された場合、dashboard API は
`/events` と同じ `Authorization: Bearer <token>` を要求する。`GET /api/state` は
event / activity / agent task / handler retry の snapshot と counts を返す。`hideSkippedActivity=1` が指定された場合、
activity list は skipped outcome を除外するが、counts は全件数のままにする。
`GET /api/events/:id` は保存済み event の detail と envelope を返す。operational store
未設定の app ではどちらも `operational_store_not_configured` の 503 を返し、event が
存在しない場合は `event_not_found` の 404 を返す。不正な percent encoding の event id は
`invalid_event_id` の 400 として扱う。これらの API は Source provider や
runtime provider の具体 payload に依存せず、operational store の正規化済み snapshot を
そのまま配信する。HTTP app の webhook / tail ingress は room publish 成功後に、room が
検証・正規化した envelope を operational store へ記録する。publish 前の provider event に
任意 payload が含まれていても、store には replay / SSE と同じ sanitized envelope だけを残す。
operational store への記録が失敗しても、room publish が
成功済みの外部 delivery は失敗応答に戻さない。

`GET /api/v1/overview`、`GET /api/v1/events`、`GET /api/v1/workflow-runs`、
`GET /api/v1/agent-tasks` は dashboard / mobile 向けの分割 read API として、compact row と
pagination metadata を返す。detail は `GET /api/v1/events/:id`、
`GET /api/v1/workflow-runs/:id`、`GET /api/v1/agent-tasks/:id` で取得する。
v1 collection は `limit` と opaque `cursor` を受け取り、不正 cursor は `invalid_cursor`、
未対応 filter は `unsupported_filter`、未対応 sort は `unsupported_sort` の 400 として扱う。
legacy の `/api/state` は transitional snapshot API として残し、新しい UI は v1 resource を読む。

`GET /healthz` と `GET /events` は storage 復元失敗を generic 500 応答に変換する。
adapter/runtime の未処理例外として落とさず、呼び出し元に安定した失敗を返すため。
`GET /events` は subscribe 直前に storage refresh を行い、room 内 replay buffer を
最新化してから stream を返す。

`RainrailBridgeRoom` は storage key ごとに single writer / single live fan-out として
扱う。core storage contract は `get` / `put` だけで、CAS/append や cross-process
pub/sub を要求しないため、複数 room / process で同じ storage key を共有して multi-writer
運用してはならない。同一 process では同じ storage backend を複数 room に渡すと
constructor が拒否する。Worker/Node adapter は同じ room へ sticky routing するか、
room ごとに別 storage namespace を使う。

storage の key は `rainrail:recent-events`。保存するのは正規化済み envelope だけで、
`id` / `name` / `source.type` / `source.name` / `delivery.id` / `subject.type` /
`subject.id` は短い安全な identifier（または `owner/repo` 形式の repository id）だけを
受け付ける。任意の `source.repository` は `owner/repo` 形式だけ、
`source.account` / `source.environment` は短い安全な identifier だけ保存し、
それ以外の任意 metadata は落とす。
repository id は owner / repo の各 segment を短く制限し、数 MB の identifier を
`owner/<long repo>` 形式で持ち込ませない。`occurredAt` と `delivery.receivedAt` は
UTC ISO timestamp 形式だけを受け付ける。
object payload も allowlist された shallow metadata（`action` / `status` /
`conclusion`）のうち、短い token 文字列または `null` だけに縮約し、object でない payload は
空 object にする。任意 URL や query を
持ち込める `links` は保存しない。`subject.url` と `rawPayload.reference` は URL として
parse でき、scheme が GitHub provider URL、`github://deliveries/...`、または
`cloudflare://deliveries/...` の場合だけ、
userinfo / query / fragment を除去してから保存する。
GitHub provider URL は `https://github.com/<owner>/<repo>`、issue / pull、
check run の `runs/<id>`、Actions run の `actions/runs/<id>` だけを許可する。
delivery scheme の path は短い安全な delivery id 1 セグメントだけを許可し、
`/tokens/<secret>` や `token=...` のような値は拒否する。
URL として parse できない optional `subject.url` は保存せず、必須の
`rawPayload.reference` が parse できない、または allowlist 外 scheme の場合は publish を
400 で拒否する。
`rawPayload.kind` は `external-reference` または `inline-redacted` だけを保存する。
`rawPayload.contentType` は MIME type の type/subtype として妥当な値だけを小文字で保存し、
parameter は保持しない。
`rawPayload.sha256` は 64 桁 hex digest の場合だけ保存する。secret、token、credential、
生 webhook payload、issue/comment body のような provider object 本文は core 側では
保持しない。storage から復元する replay 要素も `RainrailEventEnvelope` と SSE field
として検証し、壊れた要素や古い schema の要素は replay buffer に入れない。

`POST /publish` は request body の読み込み開始直後に publish queue の枠を確保する。
これにより、大きい body や streaming body の parse 完了順に左右されず、`fetch`
呼び出し順に storage / replay / broadcast を処理する。body parse や envelope 検証の
失敗は queue 待機中でも即時に捕捉し、順番が来た時点で 400 応答へ変換する。
JSON parse 失敗は request body 断片を応答に含めない generic message にする。
ただし同じ `event.id` が replay buffer に既に存在する場合は、成功 no-op として扱い、
storage 保存と live broadcast を行わない。同じ source delivery の retry で downstream
workflow が重複起動することを避けるため。

初回 storage 復元、subscribe refresh、publish 永続化は room 内で直列化する。これにより、複数の
`POST /publish` が同時に来ても古い snapshot で replay buffer や storage を
上書きしない。publish 直前にも storage の最新 snapshot を読み、room 内 replay buffer
を id で merge してから保存する。subscribe refresh も同じ queue に入れ、refresh が
古い snapshot で publish 済み replay を巻き戻さないようにする。storage への保存に
失敗した event は subscriber へ broadcast せず、
HTTP 結果と live 配信済み副作用が食い違わないようにする。500 応答は generic な
文言にし、storage backend の接続文字列や内部 endpoint などを呼び出し元へ返さない。

queue 待機中または storage 永続化中に `request.signal` が abort 済みになった publish
は、storage 保存前なら live broadcast の前に 499 として破棄する。storage 保存に成功
した後は durable replay に event が含まれるため、abort 済みでも live broadcast と
成功応答の生成まで完了する。durable replay、live delivery、HTTP 結果の境界を
storage 保存成功時点に揃え、rollback race で別 room が破棄予定 event を復元することを
避けるため。
