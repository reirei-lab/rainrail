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
- `.rainrail/plugins/`: the project-local plugin installation directory.

## Re-run behavior

Scaffolding is idempotent when generated files already contain the expected
content. If a generated file exists with different content, `rainrail new`
stops instead of overwriting it.

Config discovery walks upward from the current path until it finds
`rainrail.config.json`; that directory is the project root. The lockfile and
plugin directory are resolved relative to that root.

## Project-local official plugins

`rainrail plugins list` prints installed project-local plugins from
`rainrail.lock` and verifies each lockfile entry has a matching
`.rainrail/plugins/<name>/plugin.json` manifest.

`rainrail plugins add <officialPluginName>` resolves the name or alias through
the official plugin catalog, writes the canonical lockfile entry, and creates
the matching project-local manifest. Re-adding an installed plugin is
idempotent.

`rainrail plugins remove <officialPluginName>` removes the canonical lockfile
entry and deletes the matching project-local plugin directory. Removing a plugin
that is not installed is idempotent.

These commands must be run inside a Rainrail project. Global plugin install,
third-party plugin install, and Git URL plugin install are intentionally out of
scope for this layout.

## CLI public API

The `@rainrail/cli` entrypoint exposes the command metadata and parser helpers
used by tests and future embedding code:

- Types: `BuiltInCommandName`, `BuiltInCommand`, `SharedOptions`,
  `ParsedRainrailArguments`, `RainrailCliResult`, `RainrailCliEnvironment`,
  `RainrailProject`, `RainrailLockPlugin`, and `RainrailLockfile`.
- Values: `BUILT_IN_COMMANDS`, `getBuiltInCommand`, `parseRainrailArguments`,
  `formatHelp`, `discoverRainrailProject`, and `runRainrailCli`.
