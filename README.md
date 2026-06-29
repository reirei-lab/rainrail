# Rainrail

Rainrail routes development events into agent workflows.

This repository is starting with the same issue intake automation used by
DelegateNative: newly opened GitHub issues are assigned to `reirei-agent` and
added to the reirei-lab `Reirei` project.

## Pull Request CI

Every pull request runs the `Pull Request CI` GitHub Actions workflow with
read-only repository permissions. Same-repository PRs and PRs opened by GitHub
actors with `OWNER`, `MEMBER`, or `COLLABORATOR` association run on the
organization self-hosted runner. Other fork PRs run on `ubuntu-latest` so
untrusted pull request code is not executed on the self-hosted runner.

The workflow installs dependencies with `pnpm install --frozen-lockfile`,
caches pnpm dependencies from `pnpm-lock.yaml`, and runs these checks as
separate steps so failures identify the command that failed:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
