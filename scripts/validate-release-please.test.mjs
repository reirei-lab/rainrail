import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/release-please.yml', import.meta.url),
  'utf8',
);
const config = JSON.parse(
  readFileSync(new URL('../release-please-config.json', import.meta.url), 'utf8'),
);
const manifest = JSON.parse(
  readFileSync(new URL('../.release-please-manifest.json', import.meta.url), 'utf8'),
);
const rootPackageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const cliPackageJson = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
);

describe('Release Please automation', () => {
  it('runs only on trusted main pushes or manual dispatch with release permissions', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches:\n {6}- main\n {2}workflow_dispatch:\n {4}inputs:\n {6}release_tag:/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toMatch(/^permissions:\n {2}contents: write\n {2}issues: write\n {2}pull-requests: write$/m);
    expect(workflow).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  });

  it('uses manifest Release Please configuration', () => {
    expect(workflow).toContain("if: ${{ github.event_name != 'workflow_dispatch' || github.event.inputs.release_tag == '' }}");
    expect(workflow).toContain('uses: googleapis/release-please-action@v5');
    expect(workflow).toContain('id: release');
    expect(workflow).toContain('token: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
    expect(workflow).not.toContain('token: ${{ github.token }}');
    expect(workflow).toContain('config-file: release-please-config.json');
    expect(workflow).toContain('manifest-file: .release-please-manifest.json');
  });

  it('configures release/x.y.z tags for the root release component', () => {
    expect(config['release-type']).toBe('node');
    expect(config['include-component-in-tag']).toBe(true);
    expect(config['include-v-in-tag']).toBe(false);
    expect(config['tag-separator']).toBe('/');
    expect(config.packages['.'].component).toBe('release');
    expect(manifest['.']).toBe(rootPackageJson.version);
  });

  it('keeps root and CLI package versions bumped by the release PR', () => {
    expect(cliPackageJson.version).toBe(rootPackageJson.version);
    expect(config.packages['.']['extra-files']).toContainEqual({
      type: 'json',
      path: 'packages/cli/package.json',
      jsonpath: '$.version',
    });
  });

  it('uploads the CLI asset in the Release Please workflow after a release is created', () => {
    const uploadCondition = "if: ${{ steps.release.outputs.release_created || (github.event_name == 'workflow_dispatch' && github.event.inputs.release_tag != '') }}";

    expect(workflow).toContain(uploadCondition);
    expect(workflow).toContain('uses: actions/checkout@v7');
    expect(workflow).toContain("ref: ${{ steps.release.outputs.sha || format('refs/tags/{0}', github.event.inputs.release_tag) }}");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('uses: actions/setup-node@v7');
    expect(workflow).toContain('node-version: 26');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('asset_path="$(pnpm --silent release:cli)"');
    expect(workflow).toContain('RELEASE_TAG: ${{ steps.release.outputs.tag_name || github.event.inputs.release_tag }}');
    expect(workflow).toContain('gh release upload "${RELEASE_TAG}"');
  });
});
