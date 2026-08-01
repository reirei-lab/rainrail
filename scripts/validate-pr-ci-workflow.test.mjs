import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/pr-ci.yml', import.meta.url),
  'utf8',
);

describe('pull request CI workflow', () => {
  it('runs on pull request changes without using pull_request_target', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}types:\n {6}- opened\n {6}- synchronize\n {6}- reopened\n {6}- ready_for_review/m);
    expect(workflow).toMatch(/^concurrency:\n {2}group: pr-ci-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('issues:');
  });

  it('uses read permissions by default and scopes VRT comment write permission to a separate trusted job', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/^ {2}issues: write$/m);
    expect(workflow).toMatch(/^ {2}dashboard-vrt-comment:[\s\S]*?^ {4}permissions:\n {6}contents: read\n {6}pull-requests: write$/m);
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

  it('runs typecheck, docs checks, tests, Codex smoke, and build as separate labeled steps', () => {
    expect(workflow).toMatch(/^ {6}- name: Run typecheck\n {8}run: pnpm typecheck$/m);
    expect(workflow).toMatch(/^ {6}- name: Run docs checks\n {8}run: pnpm docs:check\n {8}env:\n {10}DOCS_DRIFT_CHANGED_FROM: origin\/\$\{\{ github\.base_ref \}\}$/m);
    expect(workflow).toMatch(/^ {6}- name: Run tests\n {8}run: pnpm test$/m);
    expect(workflow).toMatch(/^ {6}- name: Run Codex App Server smoke test\n {8}if: >-\n {10}github\.event\.pull_request\.head\.repo\.full_name == github\.repository &&\n {10}contains\(fromJSON\('\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)\n {8}run: pnpm exec vitest run src\/codex-app-server\/smoke\.test\.ts\n {8}env:\n {10}RAINRAIL_CODEX_APP_SERVER_SMOKE: '1'$/m);
    expect(workflow).toMatch(/^ {6}- name: Run build\n {8}env:\n {10}PUBLIC_RAINRAIL_OPERATIONAL_API_URL: \$\{\{ vars\.RAINRAIL_OPERATIONAL_API_URL \}\}\n {8}run: pnpm build$/m);
  });

  it('runs dashboard E2E in a separate job with browser setup and failure artifacts', () => {
    expect(workflow).toMatch(/^ {2}dashboard-e2e:\n {4}name: Dashboard E2E\n {4}needs: validate\n {4}runs-on: ubuntu-24\.04$/m);
    expect(workflow).toMatch(/^ {6}- name: Install Playwright browser\n {8}run: pnpm exec playwright install --with-deps chromium$/m);
    expect(workflow).toMatch(/^ {6}- name: Run dashboard E2E\n {8}run: pnpm e2e:dashboard$/m);
    expect(workflow).toMatch(/^ {6}- name: Collect dashboard VRT results\n {8}id: collect-vrt-results\n {8}if: \$\{\{ always\(\) \}\}\n {8}run: node scripts\/collect-vrt-results\.mjs --results-dir test-results\/dashboard --report test-results\/dashboard\/playwright-report\.json --output-dir vrt-results$/m);
    expect(workflow).toMatch(/^ {6}- name: Generate dashboard VRT comment\n {8}if: \$\{\{ always\(\) && steps\.collect-vrt-results\.outcome == 'success' \}\}\n {8}run: node scripts\/generate-vrt-comment\.mjs --summary vrt-results\/summary\.json --output vrt-comment\.md --max-cases 10$/m);
    expect(workflow).toMatch(/^ {6}- name: Upload dashboard E2E artifacts\n {8}if: \$\{\{ always\(\) \}\}\n {8}uses: actions\/upload-artifact@v7/m);
    expect(workflow).toContain('name: dashboard-e2e-artifacts');
    expect(workflow).toContain('playwright-report/dashboard/');
    expect(workflow).toContain('test-results/dashboard/');
    expect(workflow).toContain('test-results/dashboard/playwright-report.json');
    expect(workflow).toContain('test-results/dashboard/screenshots/');
    expect(workflow).toContain('test-results/dashboard/screenshots/dashboard-demo-screenshot-manifest.json');
    expect(workflow).toContain('vrt-results/');
    expect(workflow).toContain('vrt-comment.md');
    expect(workflow).toContain('retention-days: 7');
  });

  it('publishes dashboard VRT comments with CML only for trusted same-repository pull requests', () => {
    expect(workflow).toMatch(/^ {2}dashboard-vrt-comment:\n {4}name: Dashboard VRT PR comment\n {4}needs: dashboard-e2e\n {4}if: >-\n {6}always\(\) &&\n {6}github\.event\.pull_request\.head\.repo\.full_name == github\.repository &&\n {6}contains\(fromJSON\('\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)\n {4}runs-on: ubuntu-24\.04$/m);
    expect(workflow).toMatch(/^ {6}- name: Download dashboard VRT artifacts\n {8}uses: actions\/download-artifact@v7\n {8}continue-on-error: true\n {8}with:\n {10}name: dashboard-e2e-artifacts\n {10}path: \.$/m);
    expect(workflow).toMatch(/^ {6}- name: Check dashboard VRT comment artifact\n {8}id: vrt-comment\n {8}run: \|/m);
    expect(workflow).toMatch(/^ {6}- name: Check CML token availability\n {8}id: cml-token\n {8}env:\n {10}CML_COMMENT_TOKEN_CONFIGURED: \$\{\{ secrets\.CML_COMMENT_TOKEN != '' \}\}\n {8}run: \|/m);
    expect(workflow).toMatch(/^ {6}- name: Set up CML\n {8}if: \$\{\{ steps\.vrt-comment\.outputs\.available == 'true' && steps\.cml-token\.outputs\.available == 'true' \}\}\n {8}uses: iterative\/setup-cml@v2$/m);
    expect(workflow).toMatch(/^ {6}- name: Publish dashboard VRT PR comment\n {8}if: \$\{\{ steps\.vrt-comment\.outputs\.available == 'true' && steps\.cml-token\.outputs\.available == 'true' \}\}\n {8}run: cml comment update --watermark-title="Rainrail dashboard VRT" vrt-comment\.md\n {8}env:\n {10}REPO_TOKEN: \$\{\{ secrets\.CML_COMMENT_TOKEN \}\}$/m);
    expect(workflow).toContain('Skipping dashboard VRT PR comment because CML_COMMENT_TOKEN is not configured.');
    expect(workflow).toContain('Skipping dashboard VRT PR comment because vrt-comment.md was not generated.');
    expect(workflow).not.toContain('CML_COMMENT_TOKEN: ${{ secrets.CML_COMMENT_TOKEN }}');
    expect(workflow).not.toContain('REPO_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('uploads the product site build artifact for trusted preview deploys without secrets', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
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
