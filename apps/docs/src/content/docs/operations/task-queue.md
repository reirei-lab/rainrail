---
title: Task queue
description: Operate Project issue selection, claims, and release semantics.
---

Rainrail task queue behavior selects assignable GitHub Project issues and
protects them from duplicate agent dispatch.

## Operational model

- The provider lists candidate issues behind a neutral `TaskQueueProvider`.
- Starting locks protect dispatch before Project fields are finalized.
- In-progress metadata records session, branch, and claim ownership.
- Terminal outcomes release or finalize claims for the next assignment cycle.

## Source spec

The full task queue behavior lives in
[docs/task-queue-project-issues.md](https://github.com/reirei-lab/rainrail/blob/main/docs/task-queue-project-issues.md).
