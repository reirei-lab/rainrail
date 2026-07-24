import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/release-cli.yml', import.meta.url),
  'utf8',
);

describe('CLI release workflow', () => {
  it('keeps release uploads on trusted triggers with scoped write permissions', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}release_tag:/m);
    expect(workflow).toContain('required: true');
    expect(workflow).not.toContain('release:\n');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toMatch(/^permissions:\n {2}contents: write$/m);
    expect(workflow).not.toContain('issues: write');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  });

  it('checks out code without persisted credentials and installs from the lockfile on Node 26', () => {
    expect(workflow).toContain('uses: actions/checkout@v7');
    expect(workflow).toContain("ref: ${{ format('refs/tags/{0}', github.event.inputs.release_tag) }}");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('uses: actions/setup-node@v7');
    expect(workflow).toContain('node-version: 26');
    expect(workflow).toContain('cache: pnpm');
    expect(workflow).toContain('cache-dependency-path: pnpm-lock.yaml');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('fails release uploads when the release tag does not match the CLI package version', () => {
    expect(workflow).toContain('Verify release tag matches CLI version');
    expect(workflow).toContain("cli_version=\"$(node -p \"require('./packages/cli/package.json').version\")\"");
    expect(workflow).toContain('RELEASE_TAG: ${{ github.event.inputs.release_tag }}');
    expect(workflow).toContain('[ "${RELEASE_TAG}" != "release/${cli_version}" ]');
    expect(workflow).not.toContain('github.event.release.tag_name');
    expect(workflow.indexOf('Verify release tag matches CLI version')).toBeLessThan(
      workflow.indexOf('Upload release asset'),
    );
  });

  it('passes release tag expressions through env instead of shell script interpolation', () => {
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('RELEASE_TAG: ${{ github.event.inputs.release_tag }}');
    expect(workflow).toContain('gh release upload "${RELEASE_TAG}"');
    expect(workflow).not.toContain('gh release upload "${{ github.event.inputs.release_tag }}"');
  });
});
