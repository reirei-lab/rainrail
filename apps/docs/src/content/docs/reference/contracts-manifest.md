---
title: Contracts manifest
description: How Rainrail keeps implementation, docs, tests, and public exports aligned.
---

Rainrail uses a docs drift manifest to keep public contracts tied to source
files, docs pages, tests, and exported names.

## What it checks

- Contract source files exist.
- Contract docs exist and mention expected public exports.
- Focused tests exist for each contract.
- Public exports are actually exported from the implementation entry point.

## When to update it

Update the manifest when a contract doc moves, a public export changes, or a new
contract surface becomes externally meaningful.

## Source spec

The manifest lives in
[docs/contracts.manifest.json](https://github.com/reirei-lab/rainrail/blob/main/docs/contracts.manifest.json).
