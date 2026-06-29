# Rainrail

Rainrail routes development events into agent workflows.

This repository is starting with the same issue intake automation used by
DelegateNative: newly opened GitHub issues are assigned to `reirei-agent` and
added to the reirei-lab `Reirei` project.

## Pull Request CI

Every pull request runs the `Pull Request CI` GitHub Actions workflow on the
organization self-hosted runner. The workflow uses read-only repository
permissions, installs dependencies with `pnpm install --frozen-lockfile`, caches
pnpm dependencies from `pnpm-lock.yaml`, and runs these checks as separate steps
so failures identify the command that failed:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
