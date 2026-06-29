# Rainrail core event delivery

Rainrail core のイベント配信は Source plugin が作った `RainrailEventEnvelope`
をそのまま downstream consumer へ流す。provider 固有 payload は envelope の
`payload` に閉じ、SSE の `event:` 名には中立イベント名である `event.name` を使う。

## Event bus

`createRainrailEventBus` は in-memory の subscriber 集合と replay buffer を持つ。
`publish(event)` は次を行う。

- event を replay buffer に追加し、`replayLimit` を超えた古い event を捨てる。
- 現在の subscriber へ `formatRainrailSseEvent(event)` を broadcast する。
- write に失敗した subscriber は切断済みとして削除する。

subscriber は Node `ServerResponse` のような `{ write, close }` でも、
Worker/Fetch API の `ReadableStream` でも扱える。これにより Node server と
Cloudflare Worker entrypoint は同じ core contract を共有する。

## SSE

SSE response は次の header を使う。

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

接続時には `: connected` comment を送る。`keepAliveIntervalMs` が指定された
ReadableStream subscriber は `: keep-alive` comment を周期送信する。interval を
指定しない場合、core は keepalive timer を作らない。これはテストや短命の local
consumer を不要な timer で維持しないためで、runtime/entrypoint が必要に応じて
policy を渡す。

## Bridge room

`RainrailBridgeRoom` は Fetch API 互換の endpoint を提供する。

- `GET /healthz`: `{ ok, clients, recent }` を返す。
- `POST /publish`: request JSON を `RainrailEventEnvelope` として publish し、
  replay buffer を storage に保存する。
- `GET /events`: storage から replay buffer を復元し、SSE stream を返す。

storage の key は `rainrail:recent-events`。保存するのは正規化済み envelope だけで、
secret、token、credential、生 webhook payload は core 側では保持しない。
