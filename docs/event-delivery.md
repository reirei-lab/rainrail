# Rainrail core event delivery

Rainrail core のイベント配信は Source plugin が作った `RainrailEventEnvelope`
をそのまま downstream consumer へ流す。provider 固有 payload は envelope の
`payload` に閉じ、SSE の `event:` 名には中立イベント名である `event.name` を使う。

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
policy を渡す。`keepAliveIntervalMs` は正の有限値だけを有効化し、`0` / 負数 / `NaN`
などは timer を作らない。

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
  snapshot を storage に保存してから live subscriber へ publish する。
- `GET /events`: storage から replay buffer を復元し、SSE stream を返す。

`GET /healthz` と `GET /events` は storage 復元失敗を generic 500 応答に変換する。
adapter/runtime の未処理例外として落とさず、呼び出し元に安定した失敗を返すため。

storage の key は `rainrail:recent-events`。保存するのは正規化済み envelope だけで、
object payload も allowlist された shallow JSON scalar metadata（`action` / `status` /
`conclusion`）に縮約し、object でない payload は空 object にする。任意 URL や query を
持ち込める `links` は保存しない。secret、token、credential、生 webhook payload、
issue/comment body のような provider object 本文は core 側では保持しない。storage から
復元する replay 要素も `RainrailEventEnvelope` と SSE field として検証し、壊れた要素や
古い schema の要素は replay buffer に入れない。

`POST /publish` は request body の読み込み開始直後に publish queue の枠を確保する。
これにより、大きい body や streaming body の parse 完了順に左右されず、`fetch`
呼び出し順に storage / replay / broadcast を処理する。body parse や envelope 検証の
失敗は queue 待機中でも即時に捕捉し、順番が来た時点で 400 応答へ変換する。
ただし同じ `event.id` が replay buffer に既に存在する場合は、成功 no-op として扱い、
storage 保存と live broadcast を行わない。同じ source delivery の retry で downstream
workflow が重複起動することを避けるため。

初回 storage 復元と publish 永続化は room 内で直列化する。これにより、複数の
`POST /publish` が同時に来ても古い snapshot で replay buffer や storage を
上書きしない。storage への保存に失敗した event は subscriber へ broadcast せず、
HTTP 結果と live 配信済み副作用が食い違わないようにする。500 応答は generic な
文言にし、storage backend の接続文字列や内部 endpoint などを呼び出し元へ返さない。

queue 待機中または storage 永続化中に `request.signal` が abort 済みになった publish
は、storage 保存前なら live broadcast の前に 499 として破棄する。storage 保存に成功
した後は durable replay に event が含まれるため、abort 済みでも live broadcast と
成功応答の生成まで完了する。durable replay、live delivery、HTTP 結果の境界を
storage 保存成功時点に揃え、rollback race で別 room が破棄予定 event を復元することを
避けるため。
