# TaskQueue provider と Project issue selection

Rainrail の Project issue selection は、GitHub Project v2 固有の GraphQL
構造を `TaskQueueProvider` の背後に閉じ込める。

## 境界

- `ProjectIssue` は TaskQueue が扱う中立的な issue 表現。
- `getNextProjectIssueToStart` は provider 非依存の純粋な selector。
- `assignNextProjectIssueToAgent` は `claimProjectIssue` で短命の starting
  lock を取得し、runtime の agent dispatch が durable に開始した後で
  `finalizeProjectIssueClaim` により Project item を `In Progress` に確定する。
- GitHub Project v2 の pagination、field ID、status option、`Branch`、
  `Agent session ID` field は `createGitHubProjectTaskQueueProvider` が解決する。

## claim と starting lock

`In Progress`、`Agent session ID`、`Branch` の組は「agent が実際に起動済み」
であることを表す。dispatch 前の排他には GitHub ref の starting lock を使い、
Project item は Todo/Backlog のままにする。starting lock には作成時刻、owner
相当の session/branch、元 Status を含め、TTL を過ぎた未確定 lock は次回の
claim/list 時に安全に回収する。

## closed issue handling

`contentType: "Issue"` かつ `state: "CLOSED"` の item は selector で開始対象にも
in-progress blocker にも含めない。Draft issue は GitHub Issue の close state を
持たないため、この closed issue 判定からは除外する。

## 将来の provider 差し替え

Forgejo など別の queue backend は、GitHub Project v2 の field/mutation 仕様を
公開せずに `TaskQueueProvider` を実装する。agent assignment 側は
`listProjectIssues`、`claimProjectIssue`、必要に応じて
`finalizeProjectIssueClaim` / `releaseProjectIssue` に依存する。
