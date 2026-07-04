# Rainrail project-local layout

`rainrail new <projectName>` creates a project directory that keeps Rainrail
CLI state local to the project. The CLI itself is still installed outside the
project; generated plugin state is not global.

## Generated files

- `rainrail.config.json`: the project config marker and minimal config scaffold.
  It is valid JSON so the existing `loadConfig()` / `parseConfigJson()` path can
  read a newly scaffolded project without a TypeScript config loader.
- `rainrail.lock`: a deterministic lockfile with `lockfileVersion: 1`, the
  project name, and an initially empty `plugins` array.
- `.rainrail/plugins/`: the project-local plugin installation directory.

## Re-run behavior

Scaffolding is idempotent when generated files already contain the expected
content. If a generated file exists with different content, `rainrail new`
stops instead of overwriting it.

Config discovery walks upward from the current path until it finds
`rainrail.config.json`; that directory is the project root. The lockfile and
plugin directory are resolved relative to that root.

## CLI public API

The `@rainrail/cli` entrypoint exposes the command metadata and parser helpers
used by tests and future embedding code:

- Types: `BuiltInCommandName`, `BuiltInCommand`, `SharedOptions`,
  `ParsedRainrailArguments`, `RainrailCliResult`, `RainrailCliEnvironment`,
  `PluginAliasResolver`, and `RainrailProject`.
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
