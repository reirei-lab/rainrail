# GitHub webhook normalization

Rainrail の GitHub webhook source は、GitHub の webhook payload をそのまま workflow plugin に渡さない。
workflow plugin が受け取る `event.payload` は Rainrail 側で安定させた要約形にする。

## 方針

- `event.name` は Rainrail のイベントファミリを表す。例: `github.issue`, `github.pull_request`, `github.check_run`, `github.review`。
- `event.payload.provider`, `event.payload.event`, `event.payload.action` で、元の provider と webhook event/action を識別できるようにする。
- repository metadata は `event.payload.repository`、organization metadata は `event.payload.organization`、actor metadata は `event.payload.actor` に集約する。
- issue / pull request / review / check / workflow / project item などの主対象は `event.payload.resource` に集約する。
- `issue_comment` が pull request conversation comment の場合は、`payload.issue.pull_request` marker を見て `event.payload.resource.type` と `event.subject.type` を `pull_request` にする。
- `pull_request_review` は `pull_request` より `review` を優先して `event.payload.resource` にする。
- `pull_request_review_thread` は `thread` を `event.payload.resource` にし、解決状態や対象位置を残す。
- issue comment や review comment は、主対象と別に `event.payload.comment` に集約する。review comment では対象ファイルや diff 位置も残す。
- `check_run.requested_action` では、押された action button を `event.payload.requestedAction` に集約する。
- GitHub の raw payload は `event.payload` には入れず、`event.rawPayload` の参照と digest から必要時に追えるようにする。

この境界により、workflow plugin は GitHub webhook の巨大で変わりやすい payload shape に直結せず、Rainrail の中立 event contract を使って routing できる。
