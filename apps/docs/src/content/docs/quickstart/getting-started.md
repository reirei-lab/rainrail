---
title: Getting Started
description: Install Rainrail and initialize a local workspace.
---

This path is for users who want to try Rainrail from the public CLI without
working on the Rainrail source repository.

## 1. Install the CLI

Rainrail's installer requires Node.js 20 or newer.

```sh
curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes
exec $SHELL
rainrail help
```

The installer adds the `rainrail` command to your shell. `rainrail help` is the
source of truth for the commands available in your installed version.

## 2. Initialize a local workspace

Run `rainrail init` inside the directory you want Rainrail to treat as a local
workspace.

```sh
cd path/to/rainrail-workspace
rainrail init
```

If the directory already contains files, `rainrail init` asks for confirmation
before writing the project-local files. Re-running it in an initialized
workspace is safe and reports that the workspace already exists.

`rainrail init` writes the local workspace configuration that Rainrail commands
use for project-local state.

The workspace should now contain this project-local layout:

```text
rainrail.config.json
rainrail.lock
.rainrail/
  plugins/
    .gitkeep
```

The generated config uses the current directory name as the project name.

## 3. Inspect available plugin commands

Start with help output before running plugin-specific commands.

```sh
rainrail openclaw help
rainrail openclaw session test help
```

Plugin command help explains the options and required local setup for each
workflow.

## 4. Start the local harness when ready

```sh
rainrail start
```

`rainrail start` runs the local harness server for the dashboard API, event
stream, and configured local intake endpoints. It does not deploy or manage the
Cloudflare Worker EEP Bridge.

## Next steps

- Read [Event model](/concepts/event-model/) to understand Rainrail events.
- Read [Operations](/operations/) before connecting production intake.
- Use [Development](/quickstart/development/) if you want to contribute changes
  to Rainrail itself.
