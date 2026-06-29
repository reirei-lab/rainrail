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
  });

  it('runs on the documented self-hosted runner with pnpm cached by lockfile', () => {
    expect(workflow).toMatch(/^ {4}runs-on: self-hosted$/m);
    expect(workflow).toContain('uses: pnpm/action-setup@v4');
    expect(workflow).toContain('cache: pnpm');
    expect(workflow).toContain('cache-dependency-path: pnpm-lock.yaml');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('runs typecheck, test, and build as separate labeled steps', () => {
    expect(workflow).toMatch(/^ {6}- name: Run typecheck\n {8}run: pnpm typecheck$/m);
    expect(workflow).toMatch(/^ {6}- name: Run tests\n {8}run: pnpm test$/m);
    expect(workflow).toMatch(/^ {6}- name: Run build\n {8}run: pnpm build$/m);
  });
});
