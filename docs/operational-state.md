# Rainrail operational state

Rainrail operational state は event delivery とは別に、dashboard/API や retry/reconcile が読む
file-backed な運用状態を扱う。Source provider や runtime provider の生 payload に依存せず、
正規化済み event、activity、agent task、handler retry を保存する。

## Store

`OperationalStore` は dashboard/API、command audit、handler retry、agent task reconcile が
依存する store contract である。persistence backend はこの contract の実装詳細であり、
consumer は `OperationalStore` の method と stable record/input/snapshot type だけを見る。
`SqliteOperationalStore` は local Node runtime 向けの `node:sqlite` adapter で、
`RainrailOperationalStore` はこの SQLite-backed adapter の互換 export である。
`RainrailOperationalStoreOptions` は `databasePath`、`eventLimit`、任意の clock を受け取る。
`JsonFileOperationalStore` と `JsonFileOperationalStoreOptions` は古い JSON file-backed adapter として
残すが、新しい local runtime は SQLite store を使う。

store は `StoredOperationalEvent`、`StoredActivityEvent`、`StoredAgentTask`、
`StoredEventHandlerRetry` を永続化し、`StoredCommandResult`、
`OperationalStoreSnapshot` として recent state と counts を返す。snapshot は
`SnapshotOptions` で skipped activity の表示を制御でき、warnings は
`OperationalStoreWarnings` と `StoredStaleProjectClaimWarning` に分けて返す。
event/activity の list API は `ListOperationalStoreEventsOptions` と
`ListOperationalStoreActivityEventsOptions` を受け取る。
activity / command id の採番は `operational_sequences` table で進め、
同じ `.sqlite` path を共有する複数 connection 間でも同じ id を返さない。`:memory:` は
connection-local な一時 store として扱う。

SQLite schema は events、activity events、agent tasks、command results、
event handler retries、sequences を table として持つ。provider/runtime metadata のうち
まだ正規化する価値が薄い field は JSON column に保持する。raw provider payload は保存せず、
dashboard が表示するための安全化済み raw payload reference だけを保存する。

record input は `RecordActivityEventInput`、`RecordCommandResultInput`、`RecordAgentTaskInput`、
`RecordEventHandlerRetryInput` を使う。`recordCommandResult` は dashboard command API の
preview / dispatching / accepted / failed audit row を保存し、`requestId`、`actor`、
`dryRun`、任意の redacted `result` / `error` を `StoredCommandResult` として snapshot に返す。
`recordAgentTask` は同じ task id の再記録で
未指定 optional field を既存値で保持し、status/result だけの更新で session、log path、
issue、claim、pid、`resumeAttempts` などの runtime metadata を消さない。
status と Project claim state の部分更新 contract は `UpdateAgentTaskStatusInput` と
`UpdateAgentTaskProjectClaimInput` として分離している。

## Retry and Reconcile

handler retry は `EventHandlerRetryHandler` として event envelope と retry row を受ける。
`processDueEventHandlerRetries` は `ProcessDueEventHandlerRetriesOptions` に従って due retry を
読み、`prioritizeEventHandlerRetriesForProcessing` で conflict check を優先してから batch
`limit` を適用する。handler 実行前には retry row を lease 付きで claim し、
同じ store を複数 runner が処理しても同じ handler side effect が二重に走らないようにする。
claim は row を削除せず、lease 失効後は `listDueEventHandlerRetries` が再取得できるため、
handler 完了前に runner が終了しても retry を永久に失わない。結果は
`ProcessDueEventHandlerRetryResult` として返す。handler 完了時の clear / reschedule は
claim した attempts、retry schedule、lease に一致する row だけを対象にする。lease 失効後に
別 runner が同じ retry を再 claim して新しい retry row を作った場合、古い runner の成功や
失敗はその新しい row を消したり上書きしたりしない。

`isRetryableOperationalError` は rate limit、HTTP 429/5xx、fetch failure、GitHub の
mergeability / checks / draft state / reviews の反映待ちを一時エラーとして扱う。
`retryDelayMs` は bounded exponential backoff を返す。

agent task reconcile は `reconcileOperationalAgentTasks` と
`ReconcileOperationalAgentTasksOptions` で行う。runtime が terminal state を返した場合、
`OperationalRuntimeStatus` の status、completedAt、summary を store に反映する。
`failed`、`canceled`、`stopped`、`timed_out`、`compaction_failed` のような abnormal terminal
state で task に Project claim metadata が残っている場合、queue provider の
`releaseProjectIssue` を呼び、Project item の Status、`Agent session ID`、`Branch` を
owner 検証つきで release する。release 成功/失敗は activity event と task の
`projectClaim` state に残す。release が失敗した場合、または release provider が無いまま
terminal task と claim metadata が残る場合、`snapshot().warnings.staleProjectClaims` に
dashboard/API 用の structured warning を出す。

## Codex Activity

`summarizeCodexActivity` は `SummarizeCodexActivityOptions` の `CodexActivityTask` から
runtime timeline を読み、dashboard-safe な `CodexActivitySummary` に変換する。
task の `resumeAttempts` は timeline reader に渡し、resume 後の最新 trajectory を表示できるようにする。
