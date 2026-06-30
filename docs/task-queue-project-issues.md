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
相当の session/branch、元 Status を含め、dispatch が durable に始まったら
finalize の最初に `dispatchedAt` を追記する。TTL は runner のローカル時刻ではなく
GitHub commit の `committedDate` で判定し、TTL を過ぎた未dispatch lock は次回の
claim/list 時に安全に回収するが、`dispatchedAt` つき lock は起動済み agent の保護
として自動回収しない。`dispatchedAt` 追記後に Project field 更新が途中で失敗した
場合、list 時に lock metadata から `In Progress` / session / branch を復元する。
復元が一時失敗しても selector には In Progress 相当として返し、同じ issue の
重複 dispatch を防ぐ。開始コメントの投稿失敗は agent 起動済み claim の確定を
失敗扱いせず、lock cleanup を優先する。

## closed issue handling

`contentType: "Issue"` かつ `state: "CLOSED"` の item は selector で開始対象にも
in-progress blocker にも含めない。Draft issue は GitHub Issue の close state を
持たないため、この closed issue 判定からは除外する。

## 将来の provider 差し替え

Forgejo など別の queue backend は、GitHub Project v2 の field/mutation 仕様を
公開せずに `TaskQueueProvider` を実装する。agent assignment 側は
`listProjectIssues`、`claimProjectIssue`、必要に応じて
`finalizeProjectIssueClaim` / `releaseProjectIssue` に依存する。
