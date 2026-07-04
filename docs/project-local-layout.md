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
