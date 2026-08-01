import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/pr-ci.yml', import.meta.url),
  'utf8',
);
const dashboardVrtCommentWorkflow = readFileSync(
  new URL('../.github/workflows/dashboard-vrt-comment.yml', import.meta.url),
  'utf8',
);
const localDashboardDocs = readFileSync(
  new URL('../docs/local-dashboard.md', import.meta.url),
  'utf8',
);

describe('pull request CI workflow', () => {
  it('runs on pull request changes without using pull_request_target', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}types:\n {6}- opened\n {6}- synchronize\n {6}- reopened\n {6}- ready_for_review/m);
    expect(workflow).toMatch(/^concurrency:\n {2}group: pr-ci-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('issues:');
  });

  it('uses read-only GitHub token permissions for the VRT comment job', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/^ {2}issues: write$/m);
    expect(workflow).not.toContain('dashboard-vrt-comment:');
    expect(workflow).not.toMatch(/^ {6}pull-requests: write$/m);
    expect(workflow).not.toContain('CML_COMMENT_TOKEN');
    expect(workflow).not.toContain('REPO_TOKEN:');
    expect(workflow).not.toContain('cml comment update');
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
    expect(workflow).toMatch(/^ {6}- name: Upload dashboard E2E artifacts\n {8}if: \$\{\{ always\(\) \}\}\n {8}uses: actions\/upload-artifact@v7/m);
    expect(workflow).toContain('name: dashboard-e2e-artifacts');
    expect(workflow).toContain('playwright-report/dashboard/');
    expect(workflow).toContain('test-results/dashboard/');
    expect(workflow).toContain('test-results/dashboard/playwright-report.json');
    expect(workflow).toContain('test-results/dashboard/screenshots/');
    expect(workflow).toContain('test-results/dashboard/screenshots/dashboard-demo-screenshot-manifest.json');
    expect(workflow).toContain('e2e/dashboard/dashboard-smoke.spec.ts-snapshots/');
    expect(workflow).not.toContain('vrt-results/');
    expect(workflow).not.toContain('vrt-comment.md');
    expect(workflow).toContain('retention-days: 7');
  });

  it('publishes dashboard VRT comments from trusted workflow_run tooling', () => {
    expect(dashboardVrtCommentWorkflow).toMatch(/^on:\n {2}workflow_run:\n {4}workflows:\n {6}- Pull Request CI\n {4}types:\n {6}- completed$/m);
    expect(dashboardVrtCommentWorkflow).toMatch(/^concurrency:\n {2}group: dashboard-vrt-comment-\$\{\{ github\.event\.workflow_run\.id \}\}\n {2}cancel-in-progress: true$/m);
    expect(dashboardVrtCommentWorkflow).toMatch(/^permissions:\n {2}actions: read\n {2}contents: read\n {2}pull-requests: read$/m);
    expect(dashboardVrtCommentWorkflow).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(dashboardVrtCommentWorkflow).toContain('github.event.workflow_run.pull_requests[0].head.repo.full_name == github.repository');
    expect(dashboardVrtCommentWorkflow).toMatch(/^ {6}- name: Check out trusted tooling\n {8}uses: actions\/checkout@v7\n {8}with:\n {10}fetch-depth: 1\n {10}persist-credentials: false$/m);
    expect(dashboardVrtCommentWorkflow).toMatch(/^ {6}- name: Verify workflow run is the latest PR head\n {8}id: latest-pr-head\n {8}run: \|/m);
    expect(dashboardVrtCommentWorkflow).toContain('current_head_sha="$(gh api "repos/$GITHUB_REPOSITORY/pulls/${{ github.event.workflow_run.pull_requests[0].number }}" --jq \'.head.sha\')"');
    expect(dashboardVrtCommentWorkflow).toContain('if [ "$current_head_sha" = "${{ github.event.workflow_run.head_sha }}" ]; then');
    expect(dashboardVrtCommentWorkflow).toContain('Skipping dashboard VRT PR comment because workflow_run head SHA is not the current PR head.');
    expect(dashboardVrtCommentWorkflow).toContain('gh run download "${{ github.event.workflow_run.id }}" --repo "$GITHUB_REPOSITORY" --name dashboard-e2e-artifacts --dir dashboard-vrt-artifacts');
    expect(dashboardVrtCommentWorkflow).toContain('echo "comment_available=true" >> "$GITHUB_OUTPUT"');
    expect(dashboardVrtCommentWorkflow).toContain('VRT は実行されませんでした、または結果 artifact を取得できませんでした。');
    expect(dashboardVrtCommentWorkflow).toContain('node scripts/collect-vrt-results.mjs --results-dir dashboard-vrt-artifacts/test-results/dashboard --report dashboard-vrt-artifacts/test-results/dashboard/playwright-report.json --artifact-root dashboard-vrt-artifacts --output-dir dashboard-vrt-comment/vrt-results');
    expect(dashboardVrtCommentWorkflow).toContain('node scripts/generate-vrt-comment.mjs --summary dashboard-vrt-comment/vrt-results/summary.json --output dashboard-vrt-comment/vrt-comment.md --max-cases 10');
    expect(dashboardVrtCommentWorkflow).toMatch(/^ {6}- name: Remove downloaded PR artifact before CML publish\n {8}if: \$\{\{ steps\.latest-pr-head\.outputs\.current == 'true' && steps\.vrt-artifact\.outputs\.available == 'true' \}\}\n {8}run: rm -rf dashboard-vrt-artifacts$/m);
    expect(dashboardVrtCommentWorkflow).toMatch(/^ {6}- name: Publish dashboard VRT PR comment\n {8}if: \$\{\{ steps\.latest-pr-head\.outputs\.current == 'true' && steps\.vrt-artifact\.outputs\.comment_available == 'true' && steps\.cml-token\.outputs\.available == 'true' \}\}\n {8}run: \|/m);
    expect(dashboardVrtCommentWorkflow).toContain('pre_publish_head_sha="$(gh api "repos/$GITHUB_REPOSITORY/pulls/${{ github.event.workflow_run.pull_requests[0].number }}" --jq \'.head.sha\')"');
    expect(dashboardVrtCommentWorkflow).toContain('if [ "$pre_publish_head_sha" != "${{ github.event.workflow_run.head_sha }}" ]; then');
    expect(dashboardVrtCommentWorkflow).toContain('Skipping dashboard VRT PR comment because PR head changed before CML publish.');
    expect(dashboardVrtCommentWorkflow).toContain('cml comment update --repo="$GITHUB_REPOSITORY" --target="pr/${{ github.event.workflow_run.pull_requests[0].number }}" --watermark-title="Rainrail dashboard VRT" dashboard-vrt-comment/vrt-comment.md');
    expect(dashboardVrtCommentWorkflow).toMatch(/^ {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {10}REPO_TOKEN: \$\{\{ secrets\.CML_COMMENT_TOKEN \}\}$/m);
    expect(dashboardVrtCommentWorkflow).toContain('Skipping dashboard VRT PR comment because CML_COMMENT_TOKEN is not configured.');
    expect(dashboardVrtCommentWorkflow).toContain('Skipping dashboard VRT PR comment because dashboard-e2e-artifacts was not uploaded.');
    expect(dashboardVrtCommentWorkflow).not.toContain('pull-requests: write');
    expect(dashboardVrtCommentWorkflow).not.toContain('REPO_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('documents the PAT secret required for dashboard VRT comments', () => {
    expect(localDashboardDocs).toContain('CML_COMMENT_TOKEN');
    expect(localDashboardDocs).toContain('fine-grained GitHub PAT');
    expect(localDashboardDocs).toContain('Pull requests: Read and write');
    expect(localDashboardDocs).toContain('Contents: Read-only');
    expect(localDashboardDocs).toContain('Do not store the token value in docs');
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
