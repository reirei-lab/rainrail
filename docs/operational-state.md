# Rainrail operational state

Rainrail operational state は event delivery とは別に、dashboard/API や retry/reconcile が読む
file-backed な運用状態を扱う。Source provider や runtime provider の生 payload に依存せず、
正規化済み event、activity、agent task、handler retry を保存する。

## Store

`RainrailOperationalStore` は `RainrailOperationalStoreOptions` で `databasePath`、
`eventLimit`、任意の clock を受け取る。store は `StoredOperationalEvent`、
`StoredActivityEvent`、`StoredAgentTask`、`StoredEventHandlerRetry` を永続化し、
`OperationalStoreSnapshot` として recent state と counts を返す。
activity id の採番は store data 内の sequence で進め、同じ process 内で同じ
`databasePath` を共有する store instance 間でも同じ id を返さない。`:memory:` は
instance-local な一時 store として扱う。

record input は `RecordActivityEventInput`、`RecordAgentTaskInput`、
`RecordEventHandlerRetryInput` を使う。`recordAgentTask` は同じ task id の再記録で
未指定 optional field を既存値で保持し、status/result だけの更新で session、log path、
issue、claim、pid、`resumeAttempts` などの runtime metadata を消さない。

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
