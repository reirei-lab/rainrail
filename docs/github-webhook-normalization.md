# GitHub webhook normalization

Rainrail の GitHub webhook source は、GitHub の webhook payload をそのまま workflow plugin に渡さない。
workflow plugin が受け取る `event.payload` は Rainrail 側で安定させた要約形にする。

## 方針

- `event.name` は Rainrail のイベントファミリを表す。例: `github.issue`, `github.pull_request`, `github.check_run`, `github.review`。
- `event.payload.provider`, `event.payload.event`, `event.payload.action` で、元の provider と webhook event/action を識別できるようにする。
- repository metadata は `event.payload.repository`、organization metadata は `event.payload.organization`、actor metadata は `event.payload.actor` に集約する。
- issue / pull request / review / check / workflow / project item などの主対象は `event.payload.resource` に集約する。
- `issues.labeled` / `issues.unlabeled` では、対象 label を `event.payload.label` に集約する。
- `issues.assigned` / `pull_request.assigned` では、対象 assignee を `event.payload.assignee` に集約する。
- `pull_request.review_requested` / `pull_request.review_request_removed` では、対象 reviewer/team を `event.payload.requestedReviewer` / `event.payload.requestedTeam` に集約する。
- `issue_comment` が pull request conversation comment の場合は、`payload.issue.pull_request` marker を見て `event.payload.resource.type` と `event.subject.type` を `pull_request` にする。
- `pull_request.closed` では、通常 close と merge を区別できるように `event.payload.resource.merged` を残す。draft 状態と synchronize の before/after SHA も pull request resource に残す。
- `pull_request_review` は `pull_request` より `review` を優先して `event.payload.resource` にし、関連 PR を `event.payload.pullRequest` に残す。
- `pull_request_review_thread` は `thread.node_id` を resource id とし、解決状態や `thread.comments` 由来の対象位置を残す。関連 PR は `event.payload.pullRequest` に残す。
- `check_run` / `check_suite` / `workflow_run` に紐づく PR は `event.payload.pullRequests` に残す。
- `projects_v2_item.edited` の field changes は `field_node_id` とともに `event.payload.changes` に集約する。
- `projects_v2_item` では REST id だけでなく GraphQL の `node_id` / `project_node_id` も resource に残す。
- classic `project` / `project_card` / `project_column` と `projects_v2` は project 系 resource として正規化する。
- `projects_v2_status_update` は status update 本体と status/date metadata を `event.payload.resource` にする。
- `push` は ref / before sha / head sha / created/deleted/forced / head commit summary を `event.payload.resource` に集約する。
- `create` / `delete` は branch/tag の ref と ref type を `event.payload.resource` に集約する。
- `release` は tag/name/url/draft/prerelease を release resource として正規化する。
- `status` は commit SHA / state / context / target URL を commit status resource として正規化する。
- `deployment` / `deployment_status` は deployment id/ref/environment と status state を deployment resource として正規化する。
- `deployment_protection_rule` は environment/ref/sha/callback URL を deployment protection rule resource として正規化し、関連 PR は `event.payload.pullRequests` に残す。
- `deployment_review` は environment / nested reviewers / approver / string comment を deployment review resource として正規化する。
- `merge_group` は merge queue の head SHA/ref と base ref を resource に残す。
- `workflow_job` は job id/run id/status/conclusion/labels と deployment environment/ref/sha を workflow job resource として正規化する。
- `branch_protection_rule` は rule id/name と changes を branch protection rule resource として正規化する。
- branch protection などの changes では string 配列も JSON 文字列として `from` / `to` に残す。
- `milestone` webhook は top-level milestone を milestone resource と `event.payload.milestone` に残す。
- `repository_ruleset` / `fork` / `deploy_key` は対象 ruleset / fork repository / deploy key を resource として正規化する。
- `personal_access_token_request` は request id/owner/permissions と対象 repositories を正規化する。
- `member` / `membership` / `team` / `team_add` は対象 user/team principal を resource として正規化する。
- `page_build` / `repository_import` / `secret_scanning_scan` は build/import/scan 結果を resource として正規化する。repository import は URL なしでも status を保持し、secret scan は空の secret types でも scan resource にする。
- `package` / `registry_package` は package name/type/version/url を package resource として正規化する。
- `installation` / `installation_repositories` の対象 repository 配列は `event.payload.repositories` に残す。
- `gollum` は変更された wiki page を wiki page resource と `event.payload.pages` に残す。
- security alert 系 webhook は top-level `alert` の id/state/severity/ref/url を security alert resource として正規化する。
- `code_scanning_alert` の top-level ref/commit SHA、rule severity、most recent instance location と `secret_scanning_alert_location` の location details は security alert resource に残す。
- `security_advisory` / `repository_advisory` は advisory id/summary/severity/url を advisory resource として正規化する。
- `repository_dispatch` / `workflow_dispatch` は `client_payload` / `inputs`、対象 ref/branch、workflow 名を `event.payload.dispatch` に残す。
- `discussion` / `discussion_comment` は discussion number/url/category と answer 情報を discussion resource として正規化する。
- `commit_comment` は commit id/path/position を commit comment resource と comment metadata に残す。
- `issue_dependencies` / `sub_issues` は関係対象の issue 番号と URL を issue relation resource として正規化する。
- milestone 変更では issue/PR の milestone id/number/title/due date を `event.payload.milestone` に集約する。
- issue comment や review comment は、主対象と別に `event.payload.comment` に集約する。review comment では対象ファイルや diff 位置も残す。
- `check_run.requested_action` では、押された action button を `event.payload.requestedAction` に集約する。
- GitHub の raw payload は `event.payload` には入れず、`event.rawPayload` の参照と digest から必要時に追えるようにする。

この境界により、workflow plugin は GitHub webhook の巨大で変わりやすい payload shape に直結せず、Rainrail の中立 event contract を使って routing できる。
