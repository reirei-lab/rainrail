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

Future action endpoints は resource ごとの subresource として追加する。例:
`POST /api/v1/agent-tasks/{taskId}/resume`、`POST /api/v1/queue/{itemId}/release`、
`POST /api/v1/workflow-runs/{runId}/retry`。これらは `operator` 以上を要求する。
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
      "status": "received",
      "summary": "github.issue reirei-lab/rainrail#25",
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
event detail record は `envelope` を含めてよいが、保存済み envelope は bridge validated /
sanitized 済みであることを前提にする。raw provider payload、secret-like metadata、operator token、
log の全文は v1 detail でも返さない。必要な場合は別の scoped download API を設計する。

```json
{
  "data": {
    "id": "github-webhook:delivery-25:github.issue",
    "type": "event",
    "compact": { "summary": "github.issue reirei-lab/rainrail#25" },
    "record": {
      "name": "github.issue",
      "source": { "type": "github", "name": "github-webhook", "repository": "reirei-lab/rainrail" },
      "delivery": { "id": "delivery-25", "receivedAt": "2026-07-02T00:00:00.000Z" },
      "subject": { "type": "issue", "id": "25", "url": "https://github.com/reirei-lab/rainrail/issues/25" },
      "envelope": { "schemaVersion": "rainrail.event.v1" }
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
- `filter[status]`, `filter[source]`, `filter[subjectType]`, `filter[repository]`, and resource-specific
  filters may be added without changing the response envelope.

Cursor values are opaque and must not encode public API promises beyond stable pagination.
Initial implementation can derive cursor from `(timestamp, id)` pairs already sorted by store helpers.
Clients must preserve all active filters and sort when sending the next `cursor`. If a cursor cannot be
decoded or does not match the collection, the API returns `400 { "error": "invalid_cursor" }`.

Sorting must be deterministic. When two rows share the same primary sort value, `id` is the tie-breaker.
Unsupported sort/filter keys return `400` instead of being ignored, so dashboard and mobile bugs fail
obviously during development.

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

## Action audit

Every mutation must append an activity event or dedicated audit row before returning success. Audit data
must include:

- `actor`: stable principal id derived from the token, not a display-only label.
- `client`: dashboard, mobile, CLI, or automation caller id when available.
- `requestId`: incoming `X-Request-ID` if present, otherwise generated per request and echoed in response
  headers.
- `actionType`: stable verb such as `agent_task_resumed`, `queue_item_released`, or `workflow_run_retried`.
- `targetType` and `targetId`: resource being changed.
- `outcome`: `success`, `failed`, or `skipped`.
- `summary`: human-readable dashboard text.

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
