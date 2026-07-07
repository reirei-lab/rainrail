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
      'rainrail start',
      'Dashboard: http://127.0.0.1:8787/dashboard',
      'Dashboard API: http://127.0.0.1:8787/api/v1/overview',
      'dashboardAuth.readOnlyToken',
      'dashboardAuth.operatorToken',
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
      'serves read-only dashboard collections today',
      'cookie/session login',
      'scoped SSE token',
      'token rotation UI',
      'multi-user actor management',
      'local operator/admin mutation routes',
    ]) {
      expect(localDashboardDocs).toContain(required);
    }

    expect(localDashboardDocs).not.toContain(
      'run operator actions such as agent task resume, reset, and terminate commands',
    );
  });

  it('keeps local operations separate from the Cloudflare Pages product site', () => {
    expect(localDashboardDocs).toContain('local operational dashboard');
    expect(localDashboardDocs).toContain('Cloudflare Pages product/docs site');
    expect(localDashboardDocs).toContain('same origin');
    expect(localDashboardDocs).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL');
    expect(localDashboardDocs).toContain('docs/cloudflare-pages.md');

    expect(readme).toContain('docs/local-dashboard.md');
    expect(docsIndex).toContain('local-dashboard.md');
  });

  it('maps the guide to the implementation tests that protect the documented flow', () => {
    expect(cliCommandsTest).toContain('Dashboard: http://127.0.0.1:8787/dashboard');
    expect(cliCommandsTest).toContain('Dashboard API: http://127.0.0.1:8787/api/v1/overview');
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
