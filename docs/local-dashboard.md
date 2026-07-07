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
serves read-only dashboard collections today; operator/admin mutation routes
are still outside the local startup MVP.

- `readOnlyToken`: can read overview, event, workflow, task, source, queue, and
  settings resources.
- `operatorToken`: reserved for local operator actions when those routes are
  wired into the local startup server.
- `adminToken`: reserved for local admin mutations when those routes are wired
  into the local startup server.

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
- HTTP `404` or an unavailable-action state for a local operator/admin command
  means the route is not part of the current `rainrail start` local server yet.

Do not put real tokens in screenshots, issue comments, docs, or copied logs.

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
- local operator/admin mutation routes
- hosted multi-tenant operations

Those follow-up auth and operator UX items are tracked separately from this
startup guide.

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
