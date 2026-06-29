# Rainrail

Rainrail routes development events into agent workflows.

This repository is starting with the same issue intake automation used by
DelegateNative: newly opened GitHub issues are assigned to `reirei-agent` and
added to the reirei-lab `Reirei` project.

## Plugin runtime contract

Rainrail's first runtime boundary is documented in
`docs/plugin-runtime-contract.md` and exported from `src/index.ts`.
Source plugins normalize provider-specific inputs into `RainrailEventEnvelope`;
workflow plugins consume those neutral events through `createRuntimeDispatcher`.
