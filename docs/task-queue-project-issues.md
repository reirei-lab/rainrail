# TaskQueue provider と Project issue selection

Rainrail の Project issue selection は、GitHub Project v2 固有の GraphQL
構造を `TaskQueueProvider` の背後に閉じ込める。

## 境界

- `ProjectIssue` は TaskQueue が扱う中立的な issue 表現。
- `getNextProjectIssueToStart` は provider 非依存の純粋な selector。
- `assignNextProjectIssueToAgent` は `claimProjectIssue` が成功した後に
  runtime の agent dispatch を呼ぶ。
- GitHub Project v2 の pagination、field ID、status option、`Branch`、
  `Agent session ID` field は `createGitHubProjectTaskQueueProvider` が解決する。

## closed issue handling

`contentType: "Issue"` かつ `state: "CLOSED"` の item は selector で開始対象にも
in-progress blocker にも含めない。Draft issue は GitHub Issue の close state を
持たないため、この closed issue 判定からは除外する。

## 将来の provider 差し替え

Forgejo など別の queue backend は、GitHub Project v2 の field/mutation 仕様を
公開せずに `TaskQueueProvider` を実装する。agent assignment 側は
`listProjectIssues` と `claimProjectIssue` だけに依存する。
