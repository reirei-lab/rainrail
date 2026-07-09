import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
const localDashboardDocs = readFileSync(
  new URL('../docs/local-dashboard.md', import.meta.url),
  'utf8',
);
const contractsManifest = JSON.parse(
  readFileSync(new URL('../docs/contracts.manifest.json', import.meta.url), 'utf8'),
);
const cliCommandsTest = readFileSync(
  new URL('../packages/cli/src/commands.test.ts', import.meta.url),
  'utf8',
);
const dashboardShellTest = readFileSync(
  new URL('./validate-dashboard-shell.test.mjs', import.meta.url),
  'utf8',
);

describe('local dashboard start documentation', () => {
  it('documents the setup/start/open flow for a new local operator', () => {
    for (const required of [
      '# Local dashboard startup',
      'rainrail init',
      'rainrail setup --dashboard-auth-only --yes',
      'rainrail setup --dashboard-auth-only --rotate --yes',
      'rainrail start',
      'pnpm demo:dashboard',
      'rainrail start --demo',
      'Dashboard demo: http://127.0.0.1:8787/dashboard?demo=1',
      'Dashboard demo API: http://127.0.0.1:8787/api/v1/overview?demo=1',
      'Demo mode',
      'デモモード',
      'minimal demo config',
      'bound outside localhost',
      'Dashboard: http://127.0.0.1:8787/dashboard',
      'Dashboard API: http://127.0.0.1:8787/api/v1/overview',
      'dashboardAuth.readOnlyToken',
      'dashboardAuth.operatorToken',
      'dashboardAuth.adminToken',
      'legacy `SSE_BEARER_TOKEN` remains accepted',
      'Authorization: Bearer',
    ]) {
      expect(localDashboardDocs).toContain(required);
    }

    expect(localDashboardDocs).not.toContain(
      'dashboard token when no explicit `dashboardAuth.readOnlyToken` is present',
    );
  });

  it('keeps dashboard auth failure guidance and MVP exclusions explicit', () => {
    for (const required of [
      '401',
      'missing_bearer_token',
      '403',
      'invalid_bearer_token',
      'read-only',
      'operator',
      'admin',
      'serves read-only dashboard collections and wires the dashboard agent-task',
      '`dryRun: true` returns a `200` preview',
      'command_handler_not_configured',
      'insufficient_scope',
      'action_confirmation_required',
      'cookie/session login',
      'scoped SSE token',
      'multi-user actor management',
      'handler-backed local runtime execution for operator/admin mutations',
      'demo-only accepted response',
      'https://github.com/reirei-lab/rainrail/issues/228',
      'https://github.com/reirei-lab/rainrail/issues/230',
      'https://github.com/reirei-lab/rainrail/issues/231',
      '`actor`, `client`, and `requestId` attribution',
      'session login',
      '## Auth mode decision',
      'Local MVP decision: keep the bearer-token field as the operator UX.',
      'This resolves [#231](https://github.com/reirei-lab/rainrail/issues/231)',
      'When no dashboard auth token is configured and',
      '`rainrail start` is bound to localhost',
      'the supported local no-auth mode',
      'remains available.',
      'Do not add cookie/session login to `rainrail start` until Rainrail has a hosted',
      'or multi-user dashboard mode.',
      'CSRF',
      'logout',
      'session expiration',
      'cookie scope',
      'token storage',
      'hosted/multi-user UX',
    ]) {
      expect(localDashboardDocs).toContain(required);
    }

    expect(localDashboardDocs).not.toContain(
      'run operator actions such as agent task resume, reset, and terminate commands',
    );
    expect(localDashboardDocs).not.toContain(
      'decide whether the\n  local bearer-token field should remain the UX or evolve into a session login',
    );
  });

  it('documents local dashboard token rotation without exposing token examples', () => {
    for (const required of [
      '## Token rotation',
      'replaces concrete `dashboardAuth.readOnlyToken`,',
      '`dashboardAuth.operatorToken`, and existing `dashboardAuth.adminToken` values',
      'without printing old or new token values',
      'Environment',
      'references such as `${DASHBOARD_OPERATOR_TOKEN}` are preserved',
      'restart `rainrail start`',
      'Rotation is a revoke-by-replacement workflow',
      'If `SSE_BEARER_TOKEN` is set, rotate or unset it at the same time.',
      'dashboard settings continue to report only whether bearer auth is',
    ]) {
      expect(localDashboardDocs).toContain(required);
    }

    expect(localDashboardDocs).not.toContain('old-operator-token');
    expect(localDashboardDocs).not.toContain('rr_local_operator_abc');
  });

  it('keeps local operations separate from the Cloudflare Pages product site', () => {
    expect(localDashboardDocs).toContain('local operational dashboard');
    expect(localDashboardDocs).toContain('Cloudflare Pages product/docs site');
    expect(localDashboardDocs).toContain('same origin');
    expect(localDashboardDocs).toContain('/api/v1/dashboard/cards');
    expect(localDashboardDocs).toContain('/api/v1/dashboard/layout');
    expect(localDashboardDocs).toContain('PATCH /api/v1/dashboard/layout/items/:itemId/config');
    expect(localDashboardDocs).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL');
    expect(localDashboardDocs).toContain('docs/cloudflare-pages.md');

    expect(readme).toContain('docs/local-dashboard.md');
    expect(docsIndex).toContain('local-dashboard.md');
  });

  it('maps the guide to the implementation tests that protect the documented flow', () => {
    expect(cliCommandsTest).toContain('Dashboard: http://127.0.0.1:8787/dashboard');
    expect(cliCommandsTest).toContain('Dashboard API: http://127.0.0.1:8787/api/v1/overview');
    expect(cliCommandsTest).toContain('Dashboard demo: http://127.0.0.1:8787/dashboard?demo=1');
    expect(cliCommandsTest).toContain('serves seeded SQLite dashboard demo mode without an operator token');
    expect(cliCommandsTest).toContain('missing_bearer_token');
    expect(cliCommandsTest).toContain('invalid_bearer_token');
    expect(dashboardShellTest).toContain('defaults the dashboard API client to same-origin');

    expect(contractsManifest.contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-dashboard-start',
          sources: expect.arrayContaining([
            'packages/cli/src/index.ts',
            'src/http-app.ts',
            'apps/www/src/pages/[locale]/dashboard.astro',
            'apps/www/src/lib/dashboard-client.ts',
            'apps/www/src/lib/dashboard-app.ts',
            'apps/www/src/lib/dashboard-content.ts',
          ]),
          docs: expect.arrayContaining([
            'docs/local-dashboard.md',
            'README.md',
            'docs/README.md',
          ]),
          tests: expect.arrayContaining([
            'scripts/validate-local-dashboard-start.test.mjs',
            'scripts/validate-dashboard-shell.test.mjs',
            'packages/cli/src/commands.test.ts',
            'src/dashboard-api.test.ts',
          ]),
        }),
      ]),
    );

    const localDashboardContract = contractsManifest.contracts.find(
      /** @param {{ id?: string }} contract */
      (contract) => contract.id === 'local-dashboard-start',
    );
    expect(localDashboardContract.sources).not.toContain('src/node-server.ts');
  });
});
