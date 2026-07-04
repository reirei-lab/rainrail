# AGENTS.md - event delivery core

This directory owns Rainrail core event delivery: the bridge room, in-memory
event bus, replay buffer, durable storage handoff, and SSE framing. Keep this
boundary provider-neutral. GitHub, Cloudflare, dashboard, and runtime adapters
may call into event delivery, but provider payload parsing and workflow
decisions belong outside this directory.

## Storage And Publish Rules

- Treat each `RainrailBridgeRoom` storage key as a single writer / single live
  fan-out lane. Do not add multi-writer behavior unless the storage contract
  gains a tested CAS, append, or pub/sub primitive.
- Use persist before broadcast ordering. A publish must store the normalized replay snapshot
  successfully before live subscribers receive the event.
- Serialize and validate before mutating replay state. A serialization failure,
  unsafe SSE field, invalid envelope, or rejected storage value must not enter
  the replay buffer and must not be delivered.
- Keep duplicate id handling idempotent. A duplicate id returns the saved event
  as a successful no-op and must not rewrite storage, rebroadcast, or trigger
  downstream workflows.
- Queue initial storage load, subscribe refresh, and publish persistence through
  the same ordering boundary so an older snapshot cannot erase a newer event.

## Replay And SSE Rules

- `Last-Event-ID` replay sends only events after the last matching id. If the id
  is absent, replay the retained buffer so consumers can detect a gap.
- `replayLimit=0` is valid and means no retained replay events. It must not
  disable live delivery or connected comments.
- Clone replay events when storing and returning snapshots. External mutation
  must not rewrite durable or in-memory replay history.
- SSE framing must reject CR/LF in `id`, `event`, and comments, and reject NUL in
  `id`. Do not let untrusted event names, ids, or comments create extra SSE
  fields.
- Keep shared SSE headers Fetch-safe. Hop-by-hop headers belong in an adapter
  that specifically owns HTTP/1.1 behavior.

## Lifecycle Rules

- Abort before storage persistence means no durable event and no live broadcast;
  abort after successful persistence still completes live delivery and the
  success response boundary.
- Cleanup subscribers on write failure, stream cancel, failed initial comment,
  failed replay write, and abort signals. Do not leave timers or subscriber
  references after disconnect.
- Treat storage restore and persistence failures as generic external errors.
  Never expose connection strings, backend endpoints, tokens, raw payloads, or
  private provider bodies in event delivery responses.
- Keep raw provider payloads outside storage. Store sanitized
  `RainrailEventEnvelope` data and bounded, allowlisted metadata only.

## Tests And Docs

- Add focused tests before changing publish ordering, storage replay merge,
  duplicate id behavior, abort handling, cleanup, `replayLimit=0`, SSE framing,
  serialization failure, or `Last-Event-ID` replay.
- Update `docs/event-delivery.md`, `docs/repo-test-coverage-matrix.md`, and
  `docs/contracts.manifest.json` when public event delivery behavior, file
  locations, or replay/storage/SSE semantics change.
- Keep root files such as `src/bridge-room.ts`, `src/event-bus.ts`, and
  `src/sse.ts` as compatibility shims unless a release note and migration plan
  remove that public import path.
