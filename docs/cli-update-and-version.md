# CLI update check and version commands

Rainrail CLI exposes two version-oriented user flows:

- `rainrail version` prints the installed CLI package version.
- `rainrail update check` checks GitHub Releases for a newer installable CLI
  package.

The binary entrypoint also starts a best-effort update notice for ordinary
successful commands. The notice is intentionally advisory: it must not block
normal command output and it must not turn network or cache failures into CLI
failures.

## `rainrail version`

`rainrail version` accepts no command arguments.

Text output is a single line:

```text
rainrail 0.2.1
```

The version value comes from the `@rainrail/cli` package manifest bundled with
the installed CLI. Passing any extra argument exits with code `1` and prints:

```text
Usage: rainrail version
```

The command is excluded from the asynchronous update notice path so scripts can
read its output without a concurrent GitHub Releases check.

## `rainrail update check`

`rainrail update check` accepts no command arguments. It compares the installed
CLI version with the latest stable GitHub Release from:

```text
https://api.github.com/repos/reirei-lab/rainrail/releases/latest
```

A release is considered installable only when all of these are true:

- `tag_name` is a semantic version tag, optionally prefixed by `v` or
  `release/`.
- The release is not marked as a prerelease.
- The normalized version is not itself a prerelease version.
- The release assets include an uploaded, non-empty
  `rainrail-cli-v<version>.tgz` asset.

When an installable newer release exists, text output is:

```text
Rainrail 0.2.1 is available. Run `rainrail update --version release/0.2.1` to update.
```

The generated command preserves `release/` and `v` tag prefixes. Unprefixed
semantic version tags are passed to `rainrail update --version` as the normalized
version.

When the latest installable release is not newer, text output is:

```text
Rainrail is up to date (0.2.1).
```

When the check cannot establish a usable latest release because GitHub Releases
is unavailable, the response is invalid, the release is a prerelease, the tag is
not semantic, or the CLI asset is absent or still uploading, text output is:

```text
Unable to check Rainrail updates. Try again later.
```

These no-op checks still exit with code `0` because update discovery is
advisory.

With `--json`, output is a formatted JSON object:

```json
{
  "command": "update check",
  "checkedAt": "2026-07-05T00:00:00.000Z",
  "currentVersion": "0.2.0",
  "latestVersion": "0.2.1",
  "updateAvailable": true,
  "updateCommand": "rainrail update --version release/0.2.1",
  "cached": false
}
```

`latestVersion` and `updateCommand` are `null` when the check cannot establish a
usable latest release. `cached` indicates whether the result came from the local
cache.

## Cache semantics

Successful installability decisions are cached in `update-check.json` under the
Rainrail cache directory:

- `$XDG_CACHE_HOME/rainrail/update-check.json` when `XDG_CACHE_HOME` is set.
- Otherwise `~/.cache/rainrail/update-check.json`.

The cache is valid for the same `currentVersion` for 24 hours. Missing,
malformed, future-dated, stale, or different-version cache entries are ignored.

Only cacheable results are written:

- available update
- known no-update result for an installable latest release that is not newer

No-op checks caused by network failures, invalid responses, prereleases,
unusable tags, or missing/incomplete CLI assets are not cached. Cache read and
write failures are ignored.

## Automatic update notice

The installed `rainrail` binary starts an asynchronous update check before
running ordinary commands, then prints a notice to stderr only after the command
itself succeeds.

The notice format matches the available-update text:

```text
Rainrail 0.2.1 is available. Run `rainrail update --version release/0.2.1` to update.
```

The automatic notice is skipped for:

- parse errors
- `rainrail help`
- `rainrail --help`
- `rainrail version`
- every `rainrail update ...` command, including `rainrail update check`
- official plugin help commands such as `rainrail github help` and
  `rainrail github webhook add help`

If the command exits unsuccessfully, the update notice task is aborted and no
notice is printed. If the check is slow, it is aborted after the short notice
timeout so the CLI can return promptly. Network, response, cache, and abort
failures are suppressed.
