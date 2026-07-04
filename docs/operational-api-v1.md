# Operational API v1

Operational API v1 は Web dashboard と将来の mobile app が同じ contract を読むための
provider-neutral API surface とする。既存の `GET /api/state` は store snapshot をそのまま
返す transitional API であり、v1 は UI が `RainrailOperationalStore` の内部形に直接
依存しないように compact row、detail record、action scope を明示する。

## Goals

- Web dashboard と mobile app は同じ `/api/v1` resource を使う。
- 一覧は compact row を返し、detail endpoint だけが full record と重い metadata を返す。
- provider 固有 payload、secret、token、raw webhook body は v1 response に含めない。
- pagination、filtering、sorting、auth scope、action audit は resource 間で同じ規則にする。
- `/api/state` から段階移行できるよう、v1 は最初は read API として追加し、dashboard の読み替え後に
  action endpoint を増やす。

## Resources

v1 resource は operational workflow を観察・操作する単位に合わせる。初期版では read API を先に
実装し、mutation は action audit と scope check を共通化してから追加する。

| Resource | Endpoint | Purpose | Minimum scope |
| --- | --- | --- | --- |
| Overview | `GET /api/v1/overview` | counts、warnings、直近 activity、runner health をまとめた landing state。 | `read-only` |
| Events | `GET /api/v1/events` | 正規化済み event の compact row 一覧。 | `read-only` |
| Event detail | `GET /api/v1/events/{eventId}` | envelope、delivery、subject、source、関連 activity/retry を含む event detail record。 | `read-only` |
| Workflow runs | `GET /api/v1/workflow-runs` | event handler / workflow execution の行。最初は activity event から projection する。 | `read-only` |
| Agent tasks | `GET /api/v1/agent-tasks` | agent session、branch、runtime status、Project claim warning の一覧と detail。 | `read-only` |
| Sources | `GET /api/v1/sources` | configured source、health、last delivery、auth status summary。 | `read-only` |
| Queue | `GET /api/v1/queue` | assignable Project issues、claimed item、stale claim warning。 | `read-only` |
| Settings | `GET /api/v1/settings` | operator-visible runtime/source settings metadata。secret value は返さない。 | `read-only` |

Action endpoints は resource ごとの `actions` subresource として追加する。初期 command API は
handler 注入で実操作に接続し、HTTP layer は endpoint、scope check、confirmation、audit/result
recording を保証する。

| Action | Endpoint | Minimum scope | Confirmation |
| --- | --- | --- | --- |
| Resume task | `POST /api/v1/agent-tasks/{taskId}/actions/resume` | `operator` | 不要。`dryRun: true` で preview 可能。 |
| Reset task | `POST /api/v1/agent-tasks/{taskId}/actions/reset` | `operator` | 必須。 |
| Terminate task | `POST /api/v1/agent-tasks/{taskId}/actions/terminate` | `operator` | 必須。 |
| Terminate all tasks | `POST /api/v1/agent-tasks/actions/terminate-all` | `operator` | 必須。 |
| Assign next queue item | `POST /api/v1/queue/actions/assign-next` | `operator` | 不要。 |
| Update settings | `POST /api/v1/settings/actions/update` | `admin` | 必須。 |

Destructive action で confirmation が不足している場合は
`409 { "error": "action_confirmation_required", "data": { "confirmationToken": "..." } }` を返す。
`commandHandler` が未設定の構成では、dry-run preview 以外の command は dispatch 済みとして扱わず
`503 { "error": "command_handler_not_configured" }` を返す。
settings mutation や token/source 管理は `admin` のみとする。

## Compact rows and detail records

一覧 endpoint は `data` に compact row、`page` に pagination metadata を返す。
compact row は UI の table/list/card を描くための安定した最小情報だけを持つ。

```json
{
  "data": [
    {
      "id": "github-webhook:delivery-25:github.issue",
      "type": "event",
      "name": "github.issue",
      "status": "received",
      "summary": "github.issue reirei-lab/rainrail#25",
      "deliveryId": "delivery-25",
      "rawPayloadReference": "github://deliveries/delivery-25",
      "workflowRunCount": 1,
      "handlerRetryCount": 0,
      "latestOutcome": "success",
      "source": { "type": "github", "name": "github-webhook" },
      "subject": { "type": "issue", "id": "25", "url": "https://github.com/reirei-lab/rainrail/issues/25" },
      "occurredAt": "2026-07-02T00:00:00.000Z",
      "receivedAt": "2026-07-02T00:00:00.000Z",
      "links": { "self": "/api/v1/events/github-webhook%3Adelivery-25%3Agithub.issue" }
    }
  ],
  "page": { "limit": 50, "nextCursor": null }
}
```

Detail endpoint は compact row に加えて、resource-specific な `record` を返す。
event detail record の `envelope` は dashboard-safe な sanitized projection とし、normalized
`payload` 本体は含めない。raw provider payload は `rawPayload.reference` だけを表示用に返し、
secret-like metadata、operator token、log の全文は v1 detail でも返さない。必要な場合は別の
scoped download API を設計する。

```json
{
  "data": {
    "id": "github-webhook:delivery-25:github.issue",
    "type": "event",
    "compact": { "summary": "github.issue reirei-lab/rainrail#25" },
    "record": {
      "name": "github.issue",
      "humanSummary": "github.issue reirei-lab/rainrail#25",
      "source": { "type": "github", "name": "github-webhook", "repository": "reirei-lab/rainrail" },
      "delivery": { "id": "delivery-25", "receivedAt": "2026-07-02T00:00:00.000Z" },
      "subject": { "type": "issue", "id": "25", "url": "https://github.com/reirei-lab/rainrail/issues/25" },
      "envelope": {
        "schemaVersion": "rainrail.event.v1",
        "rawPayload": { "kind": "external-reference", "reference": "github://deliveries/delivery-25" }
      },
      "activityEvents": [],
      "handlerRetries": []
    }
  }
}
```

The same split applies to workflow runs, agent tasks, queue items, and settings:
compact row fields stay stable for list rendering; detail record fields may grow behind resource-specific
versioned tests.

## Pagination, filtering, and sorting

Collection endpoints accept the same query shape:

- `limit`: integer from 1 to 100. Default is 50.
- `cursor`: opaque cursor returned as `page.nextCursor` / `nextCursor`.
- `sort`: one of the endpoint's documented sort keys. Default is newest first.
- `filter[status]`, `filter[source]`, `filter[name]`, `filter[subjectType]`, `filter[repository]`, and resource-specific
  filters may be added without changing the response envelope.

Cursor values are opaque and must not encode public API promises beyond stable pagination.
Initial implementation can derive cursor from `(timestamp, id)` pairs already sorted by store helpers.
Clients must preserve all active filters and sort when sending the next `cursor`. If a cursor cannot be
decoded or does not match the collection, the API returns `400 { "error": "invalid_cursor" }`.

Sorting must be deterministic. When two rows share the same primary sort value, `id` is the tie-breaker.
Unsupported sort/filter keys return `400` instead of being ignored, so dashboard and mobile bugs fail
obviously during development.

## Mobile client contract

Mobile app は Web dashboard と同じ `/api/v1` contract を使うが、狭い画面、短い foreground
session、不安定な回線を前提に compact list と detail fetch を明確に分ける。

- 一覧画面は collection endpoint の compact row だけで描画する。初期取得は `limit=25` を推奨し、
  user action で `page.nextCursor` を使って追加読み込みする。auto prefetch は active filters と
  `sort` を必ず引き継ぐ。
- Detail 画面は row tap 後に detail endpoint を取得する。現行 detail endpoint は
  `/api/v1/events/{eventId}`、`/api/v1/workflow-runs/{runId}`、`/api/v1/agent-tasks/{taskId}` に限る。
  Sources、queue、settings の row は collection response の compact row で描画し、detail route を前提にしない。
  list response にない activity、retry、log summary、command result へ依存する UI は detail fetch 完了後に表示する。
- Mobile は foreground 復帰時に先頭 page から再取得し、`page.nextCursor` は再利用せず差分を確認する。
  `ETag` / `If-None-Match` / `304` は未実装の future optimization であり、現行 client は
  conditional GET を前提にしない。
- Offline cache は read-only snapshot として扱う。cache 由来の row には last synced time を持たせ、
  operator action button は online detail fetch と scope check が成功するまで disabled にする。
- HTTP error はすべて stable JSON error shape として扱う。mobile は `error` code、任意の
  `message`、任意の `data` object、存在する場合の `requestId` を表示/診断用に保持し、未知の field は
  無視する。
- すべての request は `X-Request-ID` を送る。現行 action endpoint は idempotency dedupe を保証しない
  (does not guarantee)。そのため、mobile は network timeout 後に action `POST` を自動 retry しない。
  Destructive action だけでなく、resume や queue assignment などの non-destructive action も user intent を
  再確認してから再送する。client generated idempotency
  key や future `Idempotency-Key` header は、保存済み結果の再利用を実装するまで advisory metadata とする。
- Destructive action は local confirmation UI、server confirmation token、`operator` 以上の scope の
  3点が揃うまで送らない。`read-only` token の mobile client は action endpoint を discovery しても
  control を表示しないか disabled にする。

Typed client は `src/operational-api/` または将来の `packages/operational-api-client/` に置き、
dashboard と mobile が同じ response schema、error code、action request/response type を import
できる形を優先する。OpenAPI 生成を採用する場合も、source of truth は v1 projection tests と
TypeScript schema に置き、generated client は commit 前の drift check 対象にする。

## Realtime delivery strategy

MVP の live update は polling を標準にする。Web dashboard と mobile app は同じ collection/detail
endpoint を再取得し、SSE と push notification は latency と wake-up のための補助 channel として
扱う。

| Channel | Role | Client behavior |
| --- | --- | --- |
| Polling | Authoritative refresh path。list/detail cache を `/api/v1` response で更新する。 | Foreground 中は 15-30 秒間隔を既定にし、operator action 後は対象 detail と関連 list を即時再取得する。 |
| SSE | Foreground session の low-latency hint。event body を authoritative state として保存しない。 | 現行 `/events` は `SSE_BEARER_TOKEN` 用の別 bearer token が必要。`Last-Event-ID` を送って reconnect し、named event listener で受け取った event id/source/subject から該当 collection を再取得する。 |
| Push notification | Background wake-up と user visible alert。秘密情報や raw payload は含めない。 | notification tap で対象 detail を fetch する。payload は `notificationHint`、resource type/id、redacted summary だけにする。 |

SSE message は operational API response と同じ schema ではなく、更新があったことを知らせる hint とする。
Mobile は OS background 制約により SSE 常時接続を期待しない。foreground では SSE が使える場合だけ
polling interval を延ばしてよいが、SSE disconnect、tab/app sleep、network change の後は polling に戻す。
SSE の scoped dashboard token 対応は未実装であり、`read-only` / `operator` / `admin` token を
`/events` に流用できる契約にはしない。
SSE frame は `event: ${event.name}` を使うため、browser-compatible client は default `onmessage` だけではなく、
`github.issue` など必要な event name の named event listener を登録する。

Push notification payload は operator token、webhook secret、raw provider payload、full log、
confirmation token を含めない。通知から action を直接実行せず、app 起動後に detail fetch、
scope check、confirmation を通す。

## Authentication and authorization

v1 replaces the single dashboard bearer-token behavior with explicit token scopes:

- `read-only`: can call all `GET /api/v1/*` endpoints. Cannot trigger retries, resume tasks, release queue
  claims, or edit settings.
- `operator`: includes `read-only`; can call operational action endpoints such as retry, resume, stop,
  release, and requeue.
- `admin`: includes `operator`; can change source/runtime/settings metadata, manage operator tokens, and
  perform future destructive maintenance actions.

Token verification should return a principal object containing `actor`, `scopes`, and optional `client`.
The existing `Authorization: Bearer <token>` transport remains valid, but the implementation should move
from `eventsBearerToken` equality to a scoped verifier before adding mutation endpoints. Missing/invalid
credentials continue to use stable JSON errors such as `missing_bearer_token` and `invalid_bearer_token`.
Insufficient scope returns `403 { "error": "insufficient_scope", "requiredScope": "operator" }`.
The compatibility `eventsBearerToken` remains a `read-only` dashboard token. New command API callers should
configure `dashboardAuth.operatorToken` and, for settings mutations, `dashboardAuth.adminToken`.

## Action audit

Every mutation must reserve a command result row before dispatching the handler. Post-dispatch accepted /
failed command result rows and command activity events should be persisted before responding when storage is
available; if that write fails after dispatch, the response keeps the handler outcome and includes an
`auditWarning` rather than reporting the already executed command as a transport failure. Audit data must include:

- `actor`: stable principal id derived from the token, not a display-only label.
- `client`: dashboard, mobile, CLI, or automation caller id when available.
- `requestId`: incoming `X-Request-ID` if present, otherwise generated per request and echoed in response
  headers.
- `actionType`: stable verb such as `agent_task_resumed`, `queue_item_released`, or `workflow_run_retried`.
- `targetType` and `targetId`: resource being changed.
- `outcome`: `success`, `failed`, or `skipped`.
- `summary`: human-readable dashboard text.

`dryRun: true` records a `preview` command result and a skipped command activity without dispatching the
injected command handler. Accepted actions record the handler result in `commandResults`; failed handler
calls record a failed command result and failed command activity.
Before the accepted handler result is returned or persisted, secret-like keys such as token, secret,
password, key, session, code, authorization, and confirmation fields are recursively redacted.

Audit metadata must not contain bearer tokens, webhook secrets, raw provider payloads, or full runtime logs.
If an action calls an external provider, provider request ids may be stored as metadata only after redaction.

## Migration from `/api/state`

`GET /api/state` remains as a compatibility endpoint while the dashboard moves to `/api/v1`.
The migration should happen in four steps:

1. Add read-only `/api/v1/overview`, `/api/v1/events`, and `/api/v1/events/{eventId}` projections backed by
   `RainrailOperationalStore.snapshot()` and `getEvent()`.
2. Switch the dashboard read path from `/api/state` to `/api/v1/overview` plus collection/detail calls.
3. Add scoped auth verifier and action audit helpers, then introduce operator action endpoints.
4. Deprecate `/api/state` in docs after both Web dashboard and mobile app no longer depend on snapshot shape.

During the overlap, `/api/state` may keep returning the current full `OperationalStoreSnapshot`.
No new UI should add dependencies on `/api/state` fields that are absent from the corresponding v1 resource.

## Validation plan

Implementation should add focused contract tests in `src/dashboard-api.test.ts` as each endpoint lands:

- v1 list endpoints return `{ data, page }` with compact row fields and omit raw provider payloads.
- detail endpoints return full detail records for authorized `read-only` tokens and `404` for unknown ids.
- cursor pagination is deterministic and rejects invalid cursors.
- unsupported filters/sorts return `400`.
- `read-only`, `operator`, and `admin` scope checks distinguish read requests from actions.
- action endpoints write audit data with `actor`, `client`, and `requestId`.

Documentation-level drift is protected by `scripts/validate-operational-api-v1.test.mjs`, which keeps this
design note linked from the docs index and checks that the required resource, schema, auth, audit, migration,
and test-policy sections remain present.
