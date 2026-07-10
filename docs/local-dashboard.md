# Local dashboard startup

Rainrail has two web surfaces:

- The local operational dashboard is served by `rainrail start` from the same
  local origin as the operational API and event stream.
- The Cloudflare Pages product/docs site is built from `apps/www` and deployed
  as the public narrative and documentation site. See
  [Cloudflare Pages operations](cloudflare-pages.md) for that workflow.

Use this guide when you want to run the local dashboard on a development
machine.

## Quick start

Create or enter a Rainrail project directory, initialize the config, generate
local dashboard tokens, then start the foreground server:

```sh
mkdir -p ~/rainrail-sandbox/my-agent-ops
cd ~/rainrail-sandbox/my-agent-ops
rainrail init
rainrail setup --dashboard-auth-only --yes
rainrail start
```

`rainrail setup --dashboard-auth-only --yes` writes local-only
`dashboardAuth.readOnlyToken` and `dashboardAuth.operatorToken` values into
`rainrail.config.json` when they are missing. Existing values are preserved.
Keep these values private. To rotate concrete local values in place, run:

```sh
rainrail setup --dashboard-auth-only --rotate --yes
```

Rotation replaces concrete `dashboardAuth.readOnlyToken`,
`dashboardAuth.operatorToken`, and existing `dashboardAuth.adminToken` values in
`rainrail.config.json` without printing old or new token values. Environment
references such as `${DASHBOARD_OPERATOR_TOKEN}` are preserved instead of being
expanded into the config or command output; rotate the backing environment
secret in the system that owns it.

`rainrail start` prints the local endpoints it is serving. With the default
host and port, expect:

```text
Health: http://127.0.0.1:8787/healthz
Dashboard: http://127.0.0.1:8787/dashboard
Event Stream: http://127.0.0.1:8787/events
Dashboard API: http://127.0.0.1:8787/api/v1/overview
```

Open `http://127.0.0.1:8787/dashboard` in a browser and paste the configured
dashboard token into the dashboard auth field. API requests use
`Authorization: Bearer <token>` behind the same origin, so the local dashboard
does not need a separate API base URL.

## Seeded SQLite demo mode

Use demo mode when you want to inspect every dashboard tab without GitHub,
Cloudflare, live runner state, or a real operator token. From the repository
root, rebuild the deterministic SQLite demo DB and start the local dashboard:

```sh
pnpm demo:dashboard
```

The script first builds the product dashboard and CLI package, creates a
minimal demo config under `.tmp/dashboard-demo/`, runs
`node scripts/seed-dashboard-demo-db.mjs`, then starts `rainrail start --demo`
with `RAINRAIL_DASHBOARD_DEMO=1`. The default demo DB path is
`.tmp/dashboard-demo.sqlite`, and `rainrail start --demo` reads it as a SQLite
operational store. The CLI prints both normal and explicit demo URLs:

```text
Dashboard demo: http://127.0.0.1:8787/dashboard?demo=1
Dashboard demo API: http://127.0.0.1:8787/api/v1/overview?demo=1
```

Open the `?demo=1` dashboard URL. In demo mode, the dashboard API carries
`demo=1` on same-origin `/api/v1/*` requests, bypasses local dashboard bearer
auth only when `rainrail start --demo` is bound to localhost, and shows a
visible `Demo mode` / `デモモード` badge. Requests without `demo=1`, and demo
servers bound outside localhost, still use the configured dashboard auth rules.

If you are already inside an initialized Rainrail project and want to run the
two steps manually:

```sh
node scripts/seed-dashboard-demo-db.mjs --database .tmp/dashboard-demo.sqlite
RAINRAIL_DASHBOARD_DEMO=1 rainrail start --demo
```

Demo data is SQLite-backed, not a frontend fixture client. Demo command actions
return a demo-only accepted response and do not dispatch to GitHub, Cloudflare,
OpenClaw, or a live local runner.

Run the focused smoke/VRT baseline check before changing dashboard UI that uses
the demo DB:

```sh
pnpm demo:dashboard:smoke
```

The smoke test rebuilds the deterministic SQLite DB, exercises every dashboard
API resource, and checks the VRT scenario manifest in
`scripts/dashboard-demo-vrt-scenarios.mjs`. The manifest pins the dashboard tab
states to capture later with Playwright: overview, retrying events, failed
workflow runs, running task actions, source delivery status, blocked stale
claims, settings, default dashboard card layout, custom dashboard card layout,
plugin card failure isolation, and the mobile card layout.

## Dashboard cards

The dashboard card surface is driven by the same-origin card catalog and user
layout API:

- `GET /api/v1/dashboard/cards` returns Core and plugin card definitions with
  availability.
- `GET /api/v1/dashboard/layout` returns the default Core layout until an
  operator saves a user layout.
- `PUT /api/v1/dashboard/layout` saves a full user layout and requires an
  operator or admin dashboard token.
- `PATCH /api/v1/dashboard/layout/items/:itemId/config` saves settings for one
  visible card without dropping hidden saved plugin cards.

Core cards are Rainrail-owned dashboard surfaces such as
`core.operationalTotals`, `core.eventInbox`, `core.workflowRuns`,
`core.agentTasks`, `core.sources`, `core.queue`, `core.settings`, and
`core.operatorActions`. They render with the dashboard shell and keep the same
auth, polling, stale-data, and operator-action behavior as the older fixed
dashboard tabs. Legacy saved-layout ids `core.overview` and
`core.recentEvents` remain in the catalog for compatibility, but new default
layouts should prefer the newer Core card ids.

Plugin cards use ids like `plugin:github.queue` and appear in the same card
picker when the plugin is enabled and its declared read capabilities are
available. A plugin card can be visible in the catalog as unavailable instead
of disappearing. The catalog uses unavailable states for disabled plugins,
missing capabilities, and entry resolution failures so an operator can see why
a saved layout changed.

The card picker groups cards by category and provider/plugin name. Adding a
card creates a layout item with the card's default size. Saving the layout
persists card ids, grid positions, size, and optional per-card `config` only.
Dashboard card config must stay JSON-serializable and must not contain tokens,
secrets, passwords, or credential-looking keys. The API rejects sensitive config
keys before persistence.

Plugin card rendering stays behind the sandbox host described in
[plugin runtime contract](plugin-runtime-contract.md). The sandbox creates an
iframe with `sandbox="allow-scripts"`, no `allow-same-origin`, no referrer, and
only read-only bridge capabilities such as `dashboard:read` or `*:read`.
Workflow capabilities such as `runtime:start`, merge, or secret access are not
exposed to the iframe bridge. If one plugin card bundle fails to load, the
dashboard shell, Core cards, and other plugin cards should remain usable.

The focused smoke/VRT baseline for dashboard cards is:

```sh
pnpm demo:dashboard:smoke
```

That check verifies the seeded SQLite API data, the default layout, a saved
custom layout containing a plugin card, sandbox load failure isolation, and the
VRT capture manifest entries for default, custom, failure, and mobile card
states.

## Auth scopes

`dashboardAuth` supports three scopes. The local `rainrail start` startup flow
serves read-only dashboard collections and wires the dashboard agent-task
command routes with the same bearer-token scope checks used by the shared
operational API.

- `readOnlyToken`: can read overview, event, workflow, task, source, queue, and
  settings resources. It cannot call command mutation routes.
- `operatorToken`: includes read-only access and can call local agent-task
  command routes such as resume, reset, terminate, and terminate-all. The
  current local startup server does not attach a runtime command handler, so
  `dryRun: true` returns a `200` preview, while confirmed dispatch returns
  `503 { "error": "command_handler_not_configured" }` until a handler-backed
  local runtime is added.
- `adminToken`: includes operator access. Local admin settings mutations remain
  post-MVP.

For local compatibility, a legacy `SSE_BEARER_TOKEN` remains accepted as a
read-only dashboard token even when `dashboardAuth.readOnlyToken` is also
configured. Updating only `dashboardAuth.readOnlyToken` does not disable an
environment-provided `SSE_BEARER_TOKEN`; unset or rotate that environment value
too when you want to revoke it. New projects should prefer `dashboardAuth`
because it can distinguish read-only, operator, and admin behavior.

When `rainrail start` binds outside localhost, one of
`dashboardAuth.readOnlyToken`, `dashboardAuth.operatorToken`,
`dashboardAuth.adminToken`, or `SSE_BEARER_TOKEN` is required before startup.

## Auth failure guidance

If the dashboard stays in an auth error state, check the API response:

- HTTP `401` with `missing_bearer_token` means no bearer token reached the API.
  Paste a dashboard token into the local dashboard or send
  `Authorization: Bearer <token>` when calling the API directly.
- HTTP `403` with `invalid_bearer_token` means a token was sent but it does not
  match the configured local dashboard auth tokens. Re-run
  `rainrail setup --dashboard-auth-only --yes` or copy the current token from
  `rainrail.config.json`.
- HTTP `403` with `insufficient_scope` means a read-only token tried to call an
  operator/admin route. Use `dashboardAuth.operatorToken` or `adminToken` for
  agent-task commands.
- HTTP `409` with `action_confirmation_required` means a destructive local
  command such as reset, terminate, or terminate-all needs the returned
  confirmation token to be sent back after user confirmation.
- HTTP `503` with `command_handler_not_configured` means the local route,
  token scope, and confirmation contract are valid, but the current
  `rainrail start` server has no command handler attached to execute the
  operator action.

Do not put real tokens in screenshots, issue comments, docs, or copied logs.

## Token rotation

Use `rainrail setup --dashboard-auth-only --rotate --yes` when a local
dashboard token may have been copied into a shell history, screenshot, shared
terminal, or stale browser profile. The command only changes local
`rainrail.config.json`; restart `rainrail start` so the local server reads the
new values, then update any browser or script that was sending the old bearer
token.

Rotation is a revoke-by-replacement workflow:

- Concrete `dashboardAuth.readOnlyToken` and `dashboardAuth.operatorToken`
  values are always regenerated.
- A concrete `dashboardAuth.adminToken` is regenerated when it already exists.
  The setup command does not create a new admin token by default.
- `${ENV_VAR}` dashboard auth references are left as references. Rotate the
  referenced secret where it is defined, then restart `rainrail start`.
- If `SSE_BEARER_TOKEN` is set, rotate or unset it at the same time. Otherwise
  the old environment-provided read-only token remains valid even after
  `dashboardAuth.readOnlyToken` changes.

The CLI output lists only the affected config keys. It must not print token
values, and dashboard settings continue to report only whether bearer auth is
configured.

## Auth mode decision

Local MVP decision: keep the bearer-token field as the operator UX.
This resolves [#231](https://github.com/reirei-lab/rainrail/issues/231) for the
local dashboard MVP. When no dashboard auth token is configured and
`rainrail start` is bound to localhost, the supported local no-auth mode
remains available. For the recommended operator setup, and for any non-local
bind where auth is required, configured `dashboardAuth` bearer tokens give the
current dashboard an explicit copy/paste credential, stable API behavior, and
no browser cookie dependency. This also matches the shared operational API
contract, where `Authorization: Bearer <token>` carries the read-only,
operator, or admin scope used by both dashboard reads and command routes.

Do not add cookie/session login to `rainrail start` until Rainrail has a hosted
or multi-user dashboard mode. A session login would add CSRF protection,
logout, session expiration, cookie scope, and token storage responsibilities
without improving the single-operator local startup flow. Local bearer tokens
remain easier to rotate by editing `rainrail.config.json`, easier to diagnose
through the existing stable JSON auth errors, and less likely to blur the
boundary between local operator UX and hosted/multi-user UX.

If Rainrail later ships a hosted or multi-user dashboard, design it as a
separate auth mode rather than replacing the local startup flow in place. That
design should add tests for:

- CSRF rejection on every session-authenticated mutation route.
- Logout clearing the server session and browser cookie.
- Session expiration returning a stable auth error without accepting stale
  cookies.
- Cookie scope using `HttpOnly`, `Secure` outside localhost, `SameSite`, path,
  and domain settings that do not leak to unrelated apps.
- Token storage keeping operator/admin bearer tokens server-side or otherwise
  unavailable to dashboard JavaScript.
- Scope checks preserving the current read-only, operator, and admin behavior.

## Local dashboard and Pages boundary

The local dashboard defaults to same origin fetches such as
`/api/v1/overview`, `/api/v1/events`, `/api/v1/queue`, and
`/api/v1/settings`. `rainrail start` also serves the same-origin dashboard card
catalog/layout routes used by the card settings UI:
`/api/v1/dashboard/cards`, `/api/v1/dashboard/layout`, and
`PATCH /api/v1/dashboard/layout/items/:itemId/config`.

The Cloudflare Pages product/docs site is separate. When the static dashboard
page is built for Pages and needs to call an external operational API, set
`PUBLIC_RAINRAIL_OPERATIONAL_API_URL` for that build or enter an Operational API
URL in the dashboard for the current browser session. Pages deployment,
secrets, and smoke checks are covered in
[docs/cloudflare-pages.md](cloudflare-pages.md).

## MVP exclusions

The local dashboard MVP intentionally keeps auth simple and local. These are
out of scope for the current startup flow:

- cookie/session login
- scoped SSE token separate from dashboard API auth
- multi-user actor management
- handler-backed local runtime execution for operator/admin mutations
- hosted multi-tenant operations

Remaining follow-up auth and operator UX items are tracked separately from this
startup guide. The current split is:

- [#228](https://github.com/reirei-lab/rainrail/issues/228): resolved by
  accepting `read-only`, `operator`, and `admin` dashboard tokens for
  `/events`, while preserving legacy `SSE_BEARER_TOKEN` compatibility and SSE
  as a refresh hint rather than authoritative state.
- [#230](https://github.com/reirei-lab/rainrail/issues/230): add stable
  `actor`, `client`, and `requestId` attribution to command audit rows before
  broadening operator/admin actions.

## Validation

The documented flow is protected by focused regression coverage:

- `packages/cli/src/commands.test.ts` covers `rainrail start` endpoint output,
  packaged dashboard serving, same-origin `/api/v1/*` routes, and auth failure
  guidance.
- `scripts/validate-dashboard-shell.test.mjs` covers same-origin dashboard
  client behavior and Pages API URL injection.
- `src/dashboard-api.test.ts` covers shared HTTP app read-only, operator, and
  admin API authorization behavior.
- `scripts/validate-local-dashboard-start.test.mjs` keeps this guide linked to
  those implementation checks.
