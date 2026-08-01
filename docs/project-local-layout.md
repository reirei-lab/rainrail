# Rainrail project-local layout

`rainrail init` initializes the current directory as a Rainrail workspace that
keeps CLI state local to the project. The CLI itself is still installed outside
the project; generated plugin state is not global.

## Generated files

- `rainrail.config.json`: the project config marker and minimal config scaffold.
  It is valid JSON so the existing `loadConfig()` / `parseConfigJson()` path can
  read a newly scaffolded project without a TypeScript config loader. The
  scaffold includes an empty top-level `dashboardAuth` object for local
  dashboard bearer tokens. It also includes `server.host`, `server.port`, and
  an empty `server.allowedHosts` array so the localhost default is explicit
  while the Host allowlist slot is visible for later public bind configuration.
- `rainrail.lock`: a deterministic lockfile with `lockfileVersion: 1`, the
  project name, and a `plugins` array. Installed official plugins are recorded
  as `{ name, version, resolvedSource }`; for example
  `github@0.1.0` resolves to `official:github@0.1.0`.
  Plugin entries are treated as external input when read back: the project name
  must remain present, plugin names must be unique official canonical aliases,
  plugin versions must be valid semantic versions, and non-contract plugin entry
  fields are discarded before any manifest repair or rewrite.
- `.rainrail/plugins/`: the project-local plugin installation directory.

## Re-run behavior

Scaffolding is idempotent when generated files already contain the expected
content. If a generated file exists with different content, `rainrail init`
stops instead of overwriting it. When the current directory is non-empty and is
not already initialized, `rainrail init` asks for confirmation before writing;
`--yes` skips that prompt. Embedded callers that pass
`RainrailCliEnvironment.fileSystem` use that filesystem for scaffolding
existence checks, directory creation, and generated file writes.

Config discovery walks upward from the current path until it finds
`rainrail.config.json` as a normal file; that directory is the project root. The
lockfile and plugin directory are resolved relative to that root. When
`--config <path>` is provided, plugin management commands use that config file's
parent directory as the project root instead of discovering from the current
directory. Embedded callers that pass `RainrailCliEnvironment.fileSystem` use
that filesystem for both discovery and project-local state reads/writes.

## Project-local official plugins

`rainrail plugins list` prints installed project-local plugins from
`rainrail.lock` and verifies each lockfile entry has a matching
`.rainrail/plugins/<name>/plugin.json` manifest.

`rainrail plugins add <officialPluginName>` resolves the name or alias through
the official plugin catalog, writes the canonical lockfile entry, and creates
the matching project-local manifest. Re-adding an installed plugin is
idempotent. If lockfile update fails after creating a plugin manifest, the
command rolls back only the manifest content or plugin directory it created
during that invocation before returning the filesystem error. Existing
project-local plugin directories and unrelated files are preserved.

Plugin manifest paths are treated as untrusted project input. Plugin commands
require `.rainrail/plugins/<name>` to be a normal directory and
`.rainrail/plugins/<name>/plugin.json` to be a normal file before reading or
writing an existing manifest; symlinked manifest directories or files, including
broken symlinks, are rejected.
Plugin commands also require `rainrail.lock` to be a normal file,
`.rainrail` to be a normal directory, and `.rainrail/plugins` to be a normal
directory before project-local state is read, written, or removed.

`rainrail plugins remove <officialPluginName>` removes the canonical lockfile
entry and deletes the matching project-local plugin directory. Removing a plugin
that is not installed is idempotent. If deleting the plugin directory fails
after the lockfile was updated, the command restores the previous lockfile entry
before returning the filesystem error.

These commands must be run inside a Rainrail project. Global plugin install,
third-party plugin install, and Git URL plugin install are intentionally out of
scope for this layout.

## Setup orchestration contract

`rainrail setup` previews official bundled plugins only. Without `--yes`, it
does not mutate project state. Passing plugin names or aliases limits the
selection to those plugins; omitted plugin arguments mean every official bundled
plugin in catalog order. Text preview output follows the same selection: a
selected preview lists only the selected canonical plugins and points at the
selected setup command, while an unfiltered preview lists every official
bundled plugin.

`rainrail setup --yes [officialPluginName...]` orchestrates each selected
plugin in order. Before plugin setup starts, the core CLI ensures local
dashboard auth exists in `rainrail.config.json`: missing
`dashboardAuth.readOnlyToken` and `dashboardAuth.operatorToken` values are
generated once, then preserved on later setup runs. The generated token values
are written only to the config file; text output reports the fields that were
created without printing the secrets.

1. Install the plugin with the project-local equivalent of
   `rainrail plugins add <canonicalAlias>`.
2. Run the plugin setup command through the canonical equivalent of
   `rainrail plugin <canonicalAlias> setup`.

The core CLI owns the orchestration and project-local install step. Provider or
runtime-specific setup actions stay behind the plugin command route. Until a
plugin registers concrete setup actions, the bundled official setup route may
complete with a deterministic no-op message rather than failing through the
unimplemented plugin execution placeholder. That no-op setup route accepts only
the setup command itself; extra plugin-specific arguments are rejected so typos
are not reported as successful configuration.

`codex-app-server` is an optional official runtime provider plugin for users who
want Rainrail to start Codex CLI through the experimental Codex App Server
stdio protocol. Users who only run OpenClaw, GitHub, Cloudflare, or a different
runtime do not need it. `rainrail setup codex-app-server --yes` installs the
project-local plugin, detects the `codex` command, verifies `codex --version`,
`codex app-server --help`, and `codex login status`, then writes or updates the
matching `runtimeProviders.codexAppServer` entry in `rainrail.config.json`.
When a project already has a plugin runtime whose `runtime` is
`codex-app-server`, setup updates that entry instead of creating a duplicate
provider key.

The generated provider uses the runtime id `codex-app-server`, plugin package
`@rainrail/codex-app-server-runtime`, and executor `codex-app-server`. It may
also record `command`, `home`, and `codexHome` when those values are configured
or discovered. `home` maps to `HOME` and `codexHome` maps to `CODEX_HOME` for
doctor/session checks and later runtime execution. Keep those directories on a
dedicated runner profile when the Codex login state should not share the
operator's default shell profile. The initial session test is intentionally
stdio-only: it launches `codex app-server --listen stdio://`, performs a
non-destructive initialize/thread-start smoke check, and does not validate
future WebSocket, remote daemon, or process-pool behavior.

If any install or setup step fails, setup stops at that step and returns the
step exit code. Earlier successful install state is left in place so rerunning
the same setup command can repair or continue from the first incomplete step.
Successful step stdout is concatenated into top-level stdout, and successful
step stderr is preserved in top-level stderr for warnings or follow-up notes.

`--config <path>` and `--profile <name>` are target selectors for setup and are
forwarded into recorded step commands. Relative `--config` values are resolved
from the caller's original current directory before setup changes to the
project root, so automation can reuse JSON step commands without accidentally
targeting a different project.

With `--json`, setup writes a single JSON object to stdout. The object has
`command: "setup"`, `completed`, `plugins`, and `steps`. Each step has
`plugin`, `action`, `command`, `status`, `exitCode`, `stdout`, and `stderr`.
For example, a successful `rainrail --json --yes setup github` returns
`plugins: ["github"]` and two steps: an `install` step whose command is
`["rainrail", "plugins", "add", "github"]`, followed by a `setup` step whose
command is `["rainrail", "plugin", "github", "setup", "--yes", "--json"]`.
When target selectors are present, recorded step commands include them, for
example `["rainrail", "--config", "/abs/rainrail.config.json", "plugins",
"add", "github"]`.

Preview mode (`rainrail --json setup [officialPluginName...]`) returns
`completed: false`, an empty `steps` array, the selected canonical aliases in
`plugins`, and a `nextAction` command string. When the preview was limited to
selected plugins, `nextAction` includes those canonical aliases, for example
`rainrail setup github --yes`. When target selectors were provided,
`nextAction` also includes them, for example `rainrail --config
/abs/rainrail.config.json --profile ci setup github --yes`. `nextAction` is a
shell-oriented command string: arguments that contain whitespace or other
unsafe shell characters are single-quoted.

Setup-specific validation errors in JSON mode also return a JSON object with
`completed: false`, empty `plugins` and `steps`, and an `error` string. Shared
option parse errors, such as a missing `--config` or `--profile` value, are
reported by the shared parser before the setup command is selected and keep the
normal top-level parse-error shape.

## CLI public API

The `@rainrail/cli` entrypoint exposes the command metadata and parser helpers
used by tests and future embedding code:

- Types: `BuiltInCommandName`, `BuiltInCommand`, `SharedOptions`,
  `ParsedRainrailArguments`, `RainrailCliResult`, `RainrailCliEnvironment`,
  `RainrailDispatchMode`, `RainrailDispatchManualMessagePayload`,
  `RainrailDispatchEventEnvelope`, `RainrailDispatchRequest`,
  `RainrailDispatchRunnerResult`, `RainrailDispatchRunner`,
  `RainrailAsyncDispatchRunner`, `RainrailStandaloneDispatchFetchResult`,
  `RainrailStandaloneDispatchFetcher`,
  `RainrailStandaloneDispatchRunnerOptions`, `CommandRunnerResult`,
  `CommandRunnerOptions`, `CommandRunner`, `ReleaseFetchResult`, `ReleaseFetcher`,
  `AsyncReleaseFetcherOptions`, `AsyncReleaseFetcher`, `RainrailCliEntrypointIO`,
  `RainrailCliEntrypointEnvironment`, `RainrailCliFileSystem`,
  `PluginAliasResolver`, `RainrailProject`, `RainrailLockPlugin`, and
  `RainrailLockfile`.
- Values: `BUILT_IN_COMMANDS`, `getBuiltInCommand`, `parseRainrailArguments`,
  `formatHelp`, `discoverRainrailProject`, `runRainrailCli`,
  `createStandaloneRainrailDispatchRunner`, and `runRainrailCliEntrypoint`.

`runRainrailCli` stays synchronous for embedded callers. The installed binary
uses `runRainrailCliEntrypoint`, which starts an asynchronous update notice
check before running the synchronous CLI and prints an available-update notice
to stderr only after a successful non-help, non-version, non-update command.
The entrypoint waits only a short timeout for that notice and aborts the
background request on timeout so normal commands are not delayed by slow update
checks. Built-in help plus official plugin help routes such as `rainrail github
help`, `rainrail github webhook add help`, and their canonical
`rainrail plugin ... help` equivalents do not start the update notice check.

`rainrail dispatch` accepts either a simple manual message or a complete
Rainrail event envelope. Embedded callers can pass
`RainrailCliEnvironment.dispatchRunner` to receive a `RainrailDispatchRequest`
from the synchronous `runRainrailCli` path. Asynchronous dispatchers use
`RainrailCliEnvironment.asyncDispatchRunner` and must run through
`runRainrailCliEntrypoint`; the synchronous path rejects them before reading
dispatch input or starting publish side effects. The installed binary passes
`createStandaloneRainrailDispatchRunner` as an async dispatch runner by default,
which publishes accepted CLI input to `RAINRAIL_PUBLISH_URL` with
`RAINRAIL_PUBLISH_TOKEN`. If those variables are not configured, standalone
dispatch fails instead of reporting a no-op success, and the failure happens
before reading envelope files or stdin.

Message input can be provided as a positional argument, `--message <text>`, or
`--stdin`. Message input is rejected before dispatch when it is blank after
trimming. `--stdin` input is also rejected when it exceeds 65,536 bytes before
the CLI stores the full input in memory. The CLI converts accepted message
input into a `rainrail.manual.message` `RainrailDispatchEventEnvelope` with
`source.type: "manual"` and `source.name: "cli"`, then passes it to the runner
inside a request with `mode: "message"`. The request keeps the original
`input` string, the synthesized `event`, and the shared `config`, `profile`,
and `json` selections parsed before the dispatch command. `--message` values
that look like options are preserved as message text. The synthesized event
payload applies the same credential-looking text redaction and 8KB text bound
as manual/chat source input before writing `payload.message.text`;
`rawPayload.sha256` still hashes the original CLI input, and
`rawPayload.contentType` is normalized to `text/plain`. Each synthesized manual
event includes a per-process sequence and random entropy in `delivery.id` so
repeated dispatches, including parallel CLI processes in the same millisecond,
do not collide.

Complete envelope input can be provided as `--json <file>`, `--json --stdin`,
or `--envelope-json <json>`. File paths are resolved relative to the CLI
environment cwd. Envelope input is parsed as JSON and validated against the
core event contract before it is passed to the runner, including safe
identifiers, repository-shaped identifiers, UTC ISO timestamps, allowed raw
payload kinds, and allowed event URL references. Optional
`source.account` and `source.environment` values that are strings are accepted
without enforcing safe identifier syntax, matching core publish omission
semantics for unsafe optional metadata. Manual/chat envelopes additionally
validate the `source.type`/`name` pairing, payload shape, and matching inline
raw payload reference expected by core publish. Complete envelope JSON is
forwarded without re-serialization so caller-provided payload fields remain
byte-for-byte under the runner boundary. Accepted envelope input may omit `id`
and `schemaVersion`; the CLI inserts those defaults into the raw JSON string
without synthesizing message metadata or re-serializing payload fields. If a
dispatch runner is not configured by an embedded caller, JSON file/stdin input
is not read before the standard missing-runner error is returned.
`RainrailDispatchRunner` returns the same synchronous `RainrailCliResult` shape
as other embedded command runners. `RainrailAsyncDispatchRunner` returns a
promise for that shape when invoked through `runRainrailCliAsync` /
`runRainrailCliEntrypoint`. The synchronous `runRainrailCli` path rejects async
dispatch runners before invoking them, so a caller cannot accidentally start
publish side effects and then receive a synchronous failure result. The
standalone publish runner uses the raw validated envelope string as its request
body for complete envelope mode, so payload JSON is not re-parsed or echoed in
the CLI summary.

The first `rainrail dispatch` CLI surface intentionally avoids per-field
metadata flags such as `--source-name`, `--delivery-id`, or `--subject-id`.
Those fields belong to the event envelope contract, and exposing them as many
independent flags would create a second event-construction surface that can
drift from core validation. Operators that need explicit source, delivery,
subject, payload, or raw payload metadata should use complete envelope JSON
input; message-only mode stays a small manual trigger path.

## Plugin command resolution

Rainrail resolves command names in this order:

1. Built-in command table.
2. Plugin alias resolver.

`rainrail plugin <pluginName> <command...>` is the canonical plugin form and
uses the plugin alias resolver after the built-in `plugin` command has been
selected. `rainrail <pluginName> <command...>` is the short alias form. If a
plugin name collides with a built-in command, the built-in command wins; callers
can use `rainrail plugin <pluginName> <command...>` to reach the plugin.
