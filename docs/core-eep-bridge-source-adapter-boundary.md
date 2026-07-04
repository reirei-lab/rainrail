# Core / EEP Bridge bundle / Source adapter boundary

この文書は Core、EEP Bridge bundle、Source adapter、transport の責務境界を固定する。
後続の package split や HTTP app refactor では、この境界を package/module boundary
として扱う。

## Boundary summary

| 層 | 持つ責務 | 持たない責務 |
| --- | --- | --- |
| Core | event schema、Bridge room、event bus、dispatcher、runtime/action gate、operational store、durable replay sanitization | provider 固有 webhook/tail ingress、署名検証、provider payload の workflow 向け意味解釈 |
| EEP Bridge bundle | webhook/tail ingress、signature validation、provider-specific normalization、publish-to-core composition | workflow routing の判断、agent runtime の実起動詳細、provider 生 payload の durable replay |
| Source adapter | provider 入力を `RainrailEventEnvelope` へ正規化する adapter | SSE/HTTP transport、Bridge room storage、workflow dispatch policy |
| Transport / Core adapter | HTTP/Fetch/Node/Worker の request/response と Core API の接続 | GitHub/Cloudflare など provider semantics の分岐 |

この文書でいう source bundle は、1 個以上の Source adapter と ingress transport を
Core intake に接続する composition unit である。EEP Bridge bundle は GitHub webhook と
Cloudflare tail を同梱する source bundle の一つであり、source bundle 一般の同義語ではない。

Core does not own provider ingress, signature validation, or raw provider payload
normalization. Current Core also keeps narrow provider-aware durable replay sanitization
so that storage and replay stay safe while preserving the normalized fields existing
workflows need.

## Core responsibilities

Core は正規化済み `RainrailEventEnvelope` だけを扱う。Core の責務は次に限定する。

- `RainrailEventEnvelope` と中立 event schema の検証。
- `RainrailBridgeRoom` による publish、duplicate no-op、durable replay、SSE subscribe。
- `createRainrailEventBus` と `formatRainrailSseEvent` による in-memory fan-out と replay。
- `createRuntimeDispatcher` による `WorkflowPlugin` 評価、handler lifecycle、retry 可能な失敗の観測。
- runtime/action gate による `runtime:start`、merge、secret access などの capability policy。
- `RainrailOperationalStore` による provider-neutral な event、activity、agent task、retry snapshot。
- durable replay / operational store に残す envelope の allowlist sanitization。

Core が保存・再配信する payload は allowlist 済み metadata に縮約された envelope
であり、GitHub webhook body、Cloudflare tail log、secret、token、comment body などの
provider 生 payload を durable replay や operational store に保持しない。

現行の Core はこの sanitization のために `source.type` / `name` を見て、
Cloudflare error payload の `exceptions` など replay に必要な provider-aware allowlist
を適用する。また GitHub comment 由来の `mentionedLogins` のような短い安全な派生値も
storage 用に残す。これは durable replay の防御境界であり、Source adapter の
provider-specific normalization や workflow routing 用 rich payload を置き換えるものではない。

Core は event の `source.type` や `name` を routing key として使ってよい。ただし
GitHub webhook action や Cloudflare tail outcome の生構造を workflow 判断として直接扱ってはならない。
provider 固有の意味付けは Source adapter または EEP Bridge bundle の normalization に閉じ込める。

## EEP Bridge bundle responsibilities

EEP Bridge bundle は provider ingress と Core publish の組み立てを持つ。
bundle は複数 provider の adapter を同梱してよいが、Core API へ渡す境界では必ず
正規化済み envelope にする。

- GitHub webhook、Cloudflare tail、その他 EEP source の HTTP/queue/tail ingress を受ける。
- `X-Hub-Signature-256` など provider 固有の signature validation、delivery id 取得、
  retry header の扱いを行う。
- provider payload を Source adapter に渡し、provider-specific normalization を実行する。
- `RainrailBridgeRoom` の `/publish` へ envelope を渡すか、`createRainrailHttpApp` に
  `RainrailIntakeAdapter` を登録して route / `tail()` handler 経由で publish する。
- `createRainrailEepBridgeIntakeAdapters` / `createRainrailEepBridgeIntakeAdaptersFromEnv`
  を provider ingress composition の公開入口にし、Node server と Worker entrypoint の
  GitHub webhook / Cloudflare tail 登録を同じ bundle contract に揃える。
- 既存の custom tail intake adapter を持つ transport は `includeCloudflareTail: false`
  で bundled tail を外し、同一 app に複数 tail handler を登録しない。
- publish 成功後に必要な operational store 記録を行う場合も、room が返した検証済み envelope を使う。

EEP Bridge bundle は Source adapter と transport/core adapter を composition する単位であり、
workflow plugin の routing policy や runtime provider の実行詳細を直接持たない。

Manual input and web chat are source adapters, not EEP Bridge responsibilities。
それらは provider webhook や tail ingress ではなく、Rainrail 自身の manual/chat intake として
Core の `RainrailIntakeAdapter` 境界へ登録する。manual/chat が agent 起動へつながる場合も、
EEP Bridge bundle を経由せず、正規化済み `rainrail.manual.message` /
`rainrail.chat.message` envelope を Core に publish する。

既存の top-level `src/index.ts` 互換 export は移行期間だけ残す。新規の GitHub webhook /
Cloudflare tail ingress composition は source-specific helper を直接 import せず、
`createRainrailEepBridgeIntakeAdapters` を使う。後続の package split では Core package
から provider ingress helper を外し、source adapter package または eep-bridge package の
明示 export に移す。

## Source adapter responsibilities

Source adapter は provider 固有入力を `RainrailEventEnvelope` に変換する境界である。
公開 contract は `SourcePlugin` と `defineSourcePlugin` を入口にする。

- provider delivery id、receivedAt、raw payload reference、provider metadata を source context として受け取る。
- GitHub issue、pull request、check run、review、Cloudflare tail/error などを中立 event name に正規化する。
- `source`、`subject`、`payload.action`、`payload.status`、`payload.conclusion` に加え、
  GitHub の `repository`、`resource`、`comment`、`pullRequest`、Cloudflare の
  `exceptions` など、workflow が必要とする正規化済み rich payload を envelope に載せる。
- `rawPayload` には生 payload ではなく外部参照または redacted inline marker を置く。
- 同じ provider delivery の retry が同じ event id になるよう、安定 id を作る。

Source adapter output is not limited to the durable replay allowlist. shallow-only
metadata は Core の storage / replay sanitization の話であり、Source adapter が
workflow へ渡す正規化 payload の上限ではない。

Source adapter は transport ではない。HTTP header の読み書き、SSE stream、Bridge room storage、
subscriber lifecycle、dispatcher 起動順序は Core または transport/core adapter の責務とする。

## Transport and Core boundary

Transport は HTTP/Fetch/Node/Worker の入出力を Core API へ接続する薄い adapter である。
`createRainrailHttpApp`、`createRainrailNodeServer`、Worker entrypoint は、この境界に属する。

- `Authorization` や publish token のような Core endpoint auth は transport/core adapter で検証する。
- `GET /events`、`GET /healthz`、dashboard API の request/response 形式を扱う。
- dashboard API v1 は operational store snapshot と intake adapter metadata から Overview、
  Event Inbox、Workflow Runs、Sources、Queue、Settings などの provider-neutral projection を作る。
  Sources は configured adapter、last delivery、auth summary を秘密値なしで返し、Queue は agent task
  と claim / retry summary から operator が blocked reason と in-progress state を判断できる行を返す。
  Settings は runtime / retention / auth metadata を read-only で返し、mutation は admin scope と
  action audit が揃うまで transport response では `updatePolicy` として表現する。この projection は
  delivery id、workflow/audit summary、sanitized envelope、operator-visible metadata だけを返し、
  provider raw payload body、webhook secret、bearer token、normalized `payload` 本体を
  transport response に漏らさない。
- `POST /publish` は `RainrailBridgeRoom.fetch()` の room-internal endpoint として扱う。
  The public `createRainrailHttpApp` surface does not expose a generic `POST /publish` route.
  public app から provider event を受ける場合は `/webhooks/github` や Worker `tail()` を
  provider bundle 側で `RainrailIntakeAdapter` として登録するか、room の `/publish` を
  明示的に呼ぶ transport を別途 composition する。
- HTTP/1.1、Fetch `ReadableStream`、Worker binding、Node `ServerResponse` の差を吸収する。
- provider ingress を持つ場合は、provider 固有処理を EEP Bridge bundle または Source adapter に委譲し、
  `IntakeAdapter` として登録してから Core に渡す。

`createRainrailHttpApp` は provider 固有 route 名を知らない。外部入力は
`RainrailIntakeAdapter` の `routes` または `tail` handler として登録し、handler は
正規化済み `RainrailEventEnvelope` を adapter context の `publish()` に渡す。Core route
（`/healthz`、`/events`、dashboard API）との衝突、または adapter 同士の同一 method/path
衝突は app 作成時に拒否する。未登録 route は `404 not found` とする。

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
