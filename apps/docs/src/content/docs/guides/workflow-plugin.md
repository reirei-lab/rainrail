---
title: Add a workflow plugin
description: Route normalized Rainrail events into deterministic agent work.
---

Workflow plugins decide whether an event should start work and which runtime
provider should receive it.

## Steps

1. Match on normalized event names and subjects, not raw provider payloads.
2. Keep capability requirements explicit for runtime starts, comments, merges,
   secret access, and other sensitive actions.
3. Produce deterministic runtime input: repository, issue or pull request,
   branch, instructions, checks, and completion path.
4. Record enough context for operators to understand why the workflow ran.
5. Cover routing decisions, skipped events, retryable failures, and capability
   denial with focused tests.
6. Update public reference docs when plugin APIs or event contracts change.

## Source spec

Plugin runtime behavior is defined in
[docs/plugin-runtime-contract.md](https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md).
