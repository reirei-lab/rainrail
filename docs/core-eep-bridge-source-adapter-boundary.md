# Core / EEP Bridge bundle / Source adapter boundary

この文書は Core、EEP Bridge bundle、Source adapter、transport の責務境界を固定する。
後続の package split や HTTP app refactor では、この境界を package/module boundary
として扱う。

## Boundary summary

| 層 | 持つ責務 | 持たない責務 |
| --- | --- | --- |
| Core | event schema、Bridge room、event bus、dispatcher、runtime/action gate、operational store | provider 固有 webhook/tail ingress、署名検証、provider payload の意味解釈 |
| EEP Bridge bundle | webhook/tail ingress、signature validation、provider-specific normalization、publish-to-core composition | workflow routing の判断、agent runtime の実起動詳細、provider 生 payload の durable replay |
| Source adapter | provider 入力を `RainrailEventEnvelope` へ正規化する adapter | SSE/HTTP transport、Bridge room storage、workflow dispatch policy |
| Transport / Core adapter | HTTP/Fetch/Node/Worker の request/response と Core API の接続 | GitHub/Cloudflare など provider semantics の分岐 |

Core does not import, branch on, or validate provider-specific GitHub webhook payloads or Cloudflare tail payloads.

## Core responsibilities

Core は正規化済み `RainrailEventEnvelope` だけを扱う。Core の責務は次に限定する。

- `RainrailEventEnvelope` と中立 event schema の検証。
- `RainrailBridgeRoom` による publish、duplicate no-op、durable replay、SSE subscribe。
- `createRainrailEventBus` と `formatRainrailSseEvent` による in-memory fan-out と replay。
- `createRuntimeDispatcher` による `WorkflowPlugin` 評価、handler lifecycle、retry 可能な失敗の観測。
- runtime/action gate による `runtime:start`、merge、secret access などの capability policy。
- `RainrailOperationalStore` による provider-neutral な event、activity、agent task、retry snapshot。

Core が保存・再配信する payload は allowlist 済みの shallow metadata に縮約された
envelope であり、GitHub webhook body、Cloudflare tail log、secret、token、comment body
などの provider 生 payload を durable replay や operational store に保持しない。

Core は event の `source.type` や `name` を routing key として使ってよい。ただし
GitHub webhook action や Cloudflare tail outcome の生構造を知って分岐してはならない。
provider 固有の意味付けは Source adapter または EEP Bridge bundle の normalization に閉じ込める。

## EEP Bridge bundle responsibilities

EEP Bridge bundle は provider ingress と Core publish の組み立てを持つ。
bundle は複数 provider の adapter を同梱してよいが、Core API へ渡す境界では必ず
正規化済み envelope にする。

- GitHub webhook、Cloudflare tail、その他 EEP source の HTTP/queue/tail ingress を受ける。
- `X-Hub-Signature-256` など provider 固有の signature validation、delivery id 取得、
  retry header の扱いを行う。
- provider payload を Source adapter に渡し、provider-specific normalization を実行する。
- `RainrailBridgeRoom` または `createRainrailHttpApp` の publish endpoint へ envelope を渡す。
- publish 成功後に必要な operational store 記録を行う場合も、room が返した検証済み envelope を使う。

EEP Bridge bundle は Source adapter と transport/core adapter を composition する単位であり、
workflow plugin の routing policy や runtime provider の実行詳細を直接持たない。

## Source adapter responsibilities

Source adapter は provider 固有入力を `RainrailEventEnvelope` に変換する境界である。
公開 contract は `SourcePlugin` と `defineSourcePlugin` を入口にする。

- provider delivery id、receivedAt、raw payload reference、provider metadata を source context として受け取る。
- GitHub issue、pull request、check run、review、Cloudflare tail/error などを中立 event name に正規化する。
- `source`、`subject`、`payload.action`、`payload.status`、`payload.conclusion` など、
  workflow routing に必要な shallow metadata だけを envelope に載せる。
- `rawPayload` には生 payload ではなく外部参照または redacted inline marker を置く。
- 同じ provider delivery の retry が同じ event id になるよう、安定 id を作る。

Source adapter は transport ではない。HTTP header の読み書き、SSE stream、Bridge room storage、
subscriber lifecycle、dispatcher 起動順序は Core または transport/core adapter の責務とする。

## Transport and Core boundary

Transport は HTTP/Fetch/Node/Worker の入出力を Core API へ接続する薄い adapter である。
`createRainrailHttpApp`、`createRainrailNodeServer`、Worker entrypoint は、この境界に属する。

- `Authorization` や publish token のような Core endpoint auth は transport/core adapter で検証する。
- `GET /events`、`POST /publish`、`GET /healthz`、dashboard API の request/response 形式を扱う。
- HTTP/1.1、Fetch `ReadableStream`、Worker binding、Node `ServerResponse` の差を吸収する。
- provider ingress を持つ場合は、provider 固有処理を EEP Bridge bundle または Source adapter に委譲してから Core に渡す。

Transport は Core の外側から Core API を呼ぶが、provider semantics を Core に追加する理由にはならない。
GitHub webhook と Cloudflare tail は、Core から見るとどちらも正規化済み envelope の publish 元である。

## Package split guidance

後続の分割では、少なくとも次の module/package 境界を維持する。

- core package: event schema、event bus、Bridge room、SSE formatting、dispatcher、
  runtime/action gate、operational store。
- eep-bridge package: provider ingress、signature validation、source adapter composition、
  publish-to-core wiring。
- source adapter packages: `createGitHubWebhookSourcePlugin`、`createCloudflareTailSourcePlugin`
  のような provider normalization。
- transport adapters: Node server、Fetch/Worker app、dashboard API exposure。
- workflow packages: `WorkflowPlugin` と provider/runtime contract だけを見て動く packaged workflow。

新しい provider を追加するときは、Core の型や Bridge room へ provider 生 payload を足すのではなく、
Source adapter と EEP Bridge bundle の composition を追加する。
