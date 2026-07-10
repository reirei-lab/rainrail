import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/pr-ci.yml', import.meta.url),
  'utf8',
);

describe('pull request CI workflow', () => {
  it('runs on pull request changes without using pull_request_target', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}types:\n {6}- opened\n {6}- synchronize\n {6}- reopened\n {6}- ready_for_review/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('issues:');
  });

  it('uses only read permissions for pull request validation', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/^ {2}issues: write$/m);
    expect(workflow).not.toMatch(/^ {2}pull-requests: write$/m);
    expect(workflow).not.toContain('deployments: write');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
  });

  it('uses self-hosted only for trusted pull requests with pnpm cached by lockfile', () => {
    expect(workflow).toContain("&& contains(fromJSON('[\"OWNER\", \"MEMBER\", \"COLLABORATOR\"]'), github.event.pull_request.author_association) && 'self-hosted' || 'ubuntu-latest'");
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(workflow).toContain('"OWNER", "MEMBER", "COLLABORATOR"');
    expect(workflow).toContain('github.event.pull_request.author_association');
    expect(workflow).not.toContain("github.event.pull_request.head.repo.full_name == github.repository || contains");
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('cache: pnpm');
    expect(workflow).toContain('cache-dependency-path: pnpm-lock.yaml');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('runs typecheck, docs checks, test, and build as separate labeled steps', () => {
    expect(workflow).toMatch(/^ {6}- name: Run typecheck\n {8}run: pnpm typecheck$/m);
    expect(workflow).toMatch(/^ {6}- name: Run docs checks\n {8}run: pnpm docs:check\n {8}env:\n {10}DOCS_DRIFT_CHANGED_FROM: origin\/\$\{\{ github\.base_ref \}\}$/m);
    expect(workflow).toMatch(/^ {6}- name: Run tests\n {8}run: pnpm test$/m);
    expect(workflow).toMatch(/^ {6}- name: Run build\n {8}env:\n {10}PUBLIC_RAINRAIL_OPERATIONAL_API_URL: \$\{\{ vars\.RAINRAIL_OPERATIONAL_API_URL \}\}\n {8}run: pnpm build$/m);
  });

  it('runs dashboard E2E in a separate job with browser setup and failure artifacts', () => {
    expect(workflow).toMatch(/^ {2}dashboard-e2e:\n {4}name: Dashboard E2E\n {4}needs: validate$/m);
    expect(workflow).toMatch(/^ {6}- name: Install Playwright browser\n {8}run: pnpm exec playwright install --with-deps chromium$/m);
    expect(workflow).toMatch(/^ {6}- name: Run dashboard E2E\n {8}run: pnpm e2e:dashboard$/m);
    expect(workflow).toMatch(/^ {6}- name: Upload dashboard E2E artifacts\n {8}if: \$\{\{ always\(\) \}\}\n {8}uses: actions\/upload-artifact@v4/m);
    expect(workflow).toContain('name: dashboard-e2e-artifacts');
    expect(workflow).toContain('playwright-report/dashboard/');
    expect(workflow).toContain('test-results/dashboard/');
    expect(workflow).toContain('retention-days: 7');
  });

  it('uploads the product site build artifact for trusted preview deploys without secrets', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
    expect(workflow).toContain('name: rainrail-pages-dist');
    expect(workflow).toContain('path: apps/www/dist');
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('uploads the docs site build artifact for trusted preview deploys without secrets', () => {
    expect(workflow).toContain('name: rainrail-docs-dist');
    expect(workflow).toContain('path: apps/docs/dist');
    expect(workflow).toMatch(/name: rainrail-docs-dist[\s\S]*if-no-files-found: error/u);
    expect(workflow).toContain('!github.event.pull_request.draft');
  });
});
