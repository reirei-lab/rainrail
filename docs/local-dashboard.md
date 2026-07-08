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
Keep these values private and rotate them by editing the config or generating a
fresh local project config.

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
`/api/v1/settings`. This is the path used by `rainrail start`.

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
- token rotation UI
- multi-user actor management
- handler-backed local runtime execution for operator/admin mutations
- hosted multi-tenant operations

Remaining follow-up auth and operator UX items are tracked separately from this
startup guide. The current split is:

- [#228](https://github.com/reirei-lab/rainrail/issues/228): evaluate whether
  `/events` should accept scoped dashboard auth tokens, while preserving SSE as
  a refresh hint rather than authoritative state.
- [#229](https://github.com/reirei-lab/rainrail/issues/229): design local
  token rotation UX and keep operator/admin tokens out of stdout, dashboard
  settings, logs, and docs examples.
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
