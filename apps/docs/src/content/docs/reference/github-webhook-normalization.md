---
title: GitHub webhook normalization
description: How GitHub webhook deliveries become Rainrail events.
---

GitHub webhook payloads enter Rainrail through source adapters. Workflows should
consume normalized Rainrail events instead of depending on raw webhook bodies.

## Normalized areas

- Issues, pull requests, check runs, and reviews become neutral event names.
- Repository, actor, subject, action, status, and conclusion fields are shaped
  into dashboard-safe routing metadata.
- Raw provider payloads stay behind references or redacted markers.

## Source spec

The full normalization rules live in
[docs/github-webhook-normalization.md](https://github.com/reirei-lab/rainrail/blob/main/docs/github-webhook-normalization.md).
