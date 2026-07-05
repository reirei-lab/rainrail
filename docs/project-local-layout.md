# Rainrail project-local layout

`rainrail new <projectName>` creates a project directory that keeps Rainrail
CLI state local to the project. The CLI itself is still installed outside the
project; generated plugin state is not global.

## Generated files

- `rainrail.config.json`: the project config marker and minimal config scaffold.
  It is valid JSON so the existing `loadConfig()` / `parseConfigJson()` path can
  read a newly scaffolded project without a TypeScript config loader.
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
content. If a generated file exists with different content, `rainrail new`
stops instead of overwriting it. Embedded callers that pass
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

## CLI public API

The `@rainrail/cli` entrypoint exposes the command metadata and parser helpers
used by tests and future embedding code:

- Types: `BuiltInCommandName`, `BuiltInCommand`, `SharedOptions`,
  `ParsedRainrailArguments`, `RainrailCliResult`, `RainrailCliEnvironment`,
  `RainrailCliFileSystem`, `PluginAliasResolver`, `RainrailProject`,
  `RainrailLockPlugin`, and `RainrailLockfile`.
- Values: `BUILT_IN_COMMANDS`, `getBuiltInCommand`, `parseRainrailArguments`,
  `formatHelp`, `discoverRainrailProject`, and `runRainrailCli`.

## Plugin command resolution

Rainrail resolves command names in this order:

1. Built-in command table.
2. Plugin alias resolver.

`rainrail plugin <pluginName> <command...>` is the canonical plugin form and
uses the plugin alias resolver after the built-in `plugin` command has been
selected. `rainrail <pluginName> <command...>` is the short alias form. If a
plugin name collides with a built-in command, the built-in command wins; callers
can use `rainrail plugin <pluginName> <command...>` to reach the plugin.
