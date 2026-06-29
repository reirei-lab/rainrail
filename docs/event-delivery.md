# Rainrail core event delivery

Rainrail core のイベント配信は Source plugin が作った `RainrailEventEnvelope`
をそのまま downstream consumer へ流す。provider 固有 payload は envelope の
`payload` に閉じ、SSE の `event:` 名には中立イベント名である `event.name` を使う。

## Event bus

`createRainrailEventBus` は in-memory の subscriber 集合と replay buffer を持つ。
`publish(event)` は次を行う。

- event を SSE 文字列に serialize できることを先に確認する。serialize できない
  event は replay buffer に入れず、subscriber にも送らない。
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

`id:` と `event:` に入れる値は CR/LF を拒否する。Rainrail event envelope は
custom `id` / `name` を許すため、ここで改行を通すと subscriber 側で別の SSE field
として解釈される。

再接続時に `Last-Event-ID` が渡された場合は、replay buffer のうちその id より後の
event だけを再送する。指定 id が buffer に無い場合は、consumer が欠落を検出できる
ように保持中の replay buffer 全体を送る。

## Bridge room

`RainrailBridgeRoom` は Fetch API 互換の endpoint を提供する。

- `GET /healthz`: `{ ok, clients, recent }` を返す。
- `POST /publish`: request JSON を `RainrailEventEnvelope` として publish し、
  replay buffer を storage に保存する。
- `GET /events`: storage から replay buffer を復元し、SSE stream を返す。

storage の key は `rainrail:recent-events`。保存するのは正規化済み envelope だけで、
secret、token、credential、生 webhook payload は core 側では保持しない。

初回 storage 復元と publish 後の永続化は room 内で直列化する。これにより、複数の
`POST /publish` が同時に来ても古い snapshot で replay buffer や storage を
上書きしない。
