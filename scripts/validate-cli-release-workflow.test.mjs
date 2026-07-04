import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/release-cli.yml', import.meta.url),
  'utf8',
);

describe('CLI release workflow', () => {
  it('fails release uploads when the release tag does not match the CLI package version', () => {
    expect(workflow).toContain('Verify release tag matches CLI version');
    expect(workflow).toContain("cli_version=\"$(node -p \"require('./packages/cli/package.json').version\")\"");
    expect(workflow).toContain('release_tag="${{ github.event.release.tag_name }}"');
    expect(workflow).toContain('[ "${release_tag}" != "v${cli_version}" ]');
    expect(workflow.indexOf('Verify release tag matches CLI version')).toBeLessThan(
      workflow.indexOf('Upload release asset'),
    );
  });
});
