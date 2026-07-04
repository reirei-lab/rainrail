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
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
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

  it('runs typecheck, test, and build as separate labeled steps', () => {
    expect(workflow).toMatch(/^ {6}- name: Run typecheck\n {8}run: pnpm typecheck$/m);
    expect(workflow).toMatch(/^ {6}- name: Run tests\n {8}run: pnpm test$/m);
    expect(workflow).toMatch(/^ {6}- name: Run build\n {8}env:\n {10}PUBLIC_RAINRAIL_OPERATIONAL_API_URL: \$\{\{ vars\.RAINRAIL_OPERATIONAL_API_URL \}\}\n {8}run: pnpm build$/m);
  });

  it('uploads the product site build artifact for trusted preview deploys without secrets', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
    expect(workflow).toContain('name: rainrail-pages-dist');
    expect(workflow).toContain('path: apps/www/dist');
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });
});
