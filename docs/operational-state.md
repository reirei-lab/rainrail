# Rainrail operational state

Rainrail operational state は event delivery とは別に、dashboard/API や retry/reconcile が読む
SQLite-backed な運用状態を扱う。Source provider や runtime provider の生 payload に依存せず、
正規化済み event、activity、agent task、handler retry を保存する。

## Store

`RainrailOperationalStore` は `RainrailOperationalStoreOptions` で `databasePath`、
`eventLimit`、任意の clock を受け取る。store は `StoredOperationalEvent`、
`StoredActivityEvent`、`StoredAgentTask`、`StoredEventHandlerRetry` を永続化し、
`OperationalStoreSnapshot` として recent state と counts を返す。
activity id の採番は SQLite の atomic upsert / returning で進め、同じ databasePath を
複数 process が共有しても同じ id を返さない。

record input は `RecordActivityEventInput`、`RecordAgentTaskInput`、
`RecordEventHandlerRetryInput` を使う。`recordAgentTask` は同じ task id の再記録で
未指定 optional field を既存値で保持し、status/result だけの更新で session、log path、
issue、claim、pid などの runtime metadata を消さない。

## Retry and Reconcile

handler retry は `EventHandlerRetryHandler` として event envelope と retry row を受ける。
`processDueEventHandlerRetries` は `ProcessDueEventHandlerRetriesOptions` に従って due retry を
読み、`prioritizeEventHandlerRetriesForProcessing` で conflict check を優先してから batch
`limit` を適用する。handler 実行前には retry row を条件付き delete で claim し、
同じ store を複数 runner が処理しても同じ handler side effect が二重に走らないようにする。
結果は `ProcessDueEventHandlerRetryResult` として返す。

`isRetryableOperationalError` は rate limit、HTTP 429/5xx、fetch failure、GitHub の
mergeability / checks / draft state / reviews の反映待ちを一時エラーとして扱う。
`retryDelayMs` は bounded exponential backoff を返す。

agent task reconcile は `reconcileOperationalAgentTasks` と
`ReconcileOperationalAgentTasksOptions` で行う。runtime が terminal state を返した場合、
`OperationalRuntimeStatus` の status、completedAt、summary を store に反映する。

## Codex Activity

`summarizeCodexActivity` は `SummarizeCodexActivityOptions` の `CodexActivityTask` から
runtime timeline を読み、dashboard-safe な `CodexActivitySummary` に変換する。
task の `resumeAttempts` は timeline reader に渡し、resume 後の最新 trajectory を表示できるようにする。
