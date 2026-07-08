import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pages.yml', import.meta.url),
  'utf8',
);
const docs = readFileSync(new URL('../docs/cloudflare-pages.md', import.meta.url), 'utf8');

describe('Cloudflare Pages product site deploys', () => {
  it('documents the Wrangler Pages project, build output, secrets, and smoke command', () => {
    expect(docs).toContain('rainrail-www');
    expect(docs).toContain('apps/www/dist');
    expect(docs).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(docs).toContain('CLOUDFLARE_API_TOKEN');
    expect(docs).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL');
    expect(docs).toContain('operational store');
    expect(docs).toContain('pnpm pages:deploy:preview');
    expect(docs).toContain('pnpm pages:deploy:production');
    expect(docs).toContain('GitHub Actions は secrets が未設定の場合でも build または artifact download まで実行し');
    expect(docs).toContain('PR workflow では Cloudflare secrets を扱わない');
    expect(docs).toContain('artifact がない workflow_run は preview deploy を skip する');
    expect(docs).toContain('workflow_run');
    expect(docs).toContain('workflow_dispatch');
    expect(docs).toContain('RAINRAIL_PAGES_URL=https://<pages-host> pnpm pages:smoke');
    expect(docs).toContain('smoke script は `/`, `/en/docs`, `/en/concepts` を GET');
  });

  it('ships a smoke script that validates product routes without mutating production', () => {
    expect(packageJson.scripts['pages:smoke']).toBe(
      'node scripts/smoke-cloudflare-pages.mjs',
    );
    expect(existsSync(new URL('./smoke-cloudflare-pages.mjs', import.meta.url))).toBe(true);

    const smokeScript = readFileSync(new URL('./smoke-cloudflare-pages.mjs', import.meta.url), 'utf8');
    expect(smokeScript).toContain('RAINRAIL_PAGES_URL');
    expect(smokeScript).toContain("path: '/'");
    expect(smokeScript).toContain('Rainrail routes development events into agent workflows.');
    expect(smokeScript).toContain("path: '/en/docs'");
    expect(smokeScript).toContain('Start with the overview, then jump into the contracts.');
    expect(smokeScript).toContain("path: '/en/concepts'");
    expect(smokeScript).toContain('The vocabulary for routing provider events into agent workflows.');
  });

  it('deploys pull request previews from a trusted workflow_run artifact', () => {
    expect(workflow).toMatch(/^name: Cloudflare Pages Deploy$/m);
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    expect(workflow).toMatch(/^ {2}workflow_run:\n {4}workflows:\n {6}- Pull Request CI/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read$/m);
    expect(workflow).not.toContain('deployments: write');
    expect(workflow).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.pull_requests[0].head.repo.full_name == github.repository");
    expect(workflow).toContain('group: cloudflare-pages-preview-${{ github.event.workflow_run.pull_requests[0].head.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/^ {4}env:\n {6}CLOUDFLARE_ACCOUNT_ID:/m);
    expect(workflow).toContain('id: pages-artifact');
    expect(workflow).toContain('shell: bash');
    expect(workflow).toContain('found=false');
    expect(workflow).toContain("if: steps.pages-artifact.outputs.found == 'true'");
    expect(workflow).toContain('gh run download "${{ github.event.workflow_run.id }}" --name rainrail-pages-dist --dir apps/www/dist');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('if [ -z "${CLOUDFLARE_ACCOUNT_ID}" ] || [ -z "${CLOUDFLARE_API_TOKEN}" ]; then');
    expect(workflow).toContain('pnpm exec wrangler pages deploy apps/www/dist --project-name rainrail-www --branch "${RAINRAIL_PAGES_BRANCH}"');
  });

  it('deploys production only from main push or main workflow_dispatch', () => {
    expect(workflow).toMatch(/^ {2}push:\n {4}branches:\n {6}- main$/m);
    expect(workflow).toContain("if: github.ref_name == 'main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
    expect(workflow).toContain('group: cloudflare-pages-production-main');
    expect(workflow).toContain('pnpm pages:build');
    expect(workflow).toContain('pnpm exec wrangler pages deploy apps/www/dist --project-name rainrail-www --branch main');
  });

  it('passes the operational API URL into static Pages builds before artifact deploys', () => {
    expect(workflow).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL: ${{ vars.RAINRAIL_OPERATIONAL_API_URL }}');
    expect(workflow).toMatch(/^ {6}- name: Build Cloudflare Pages production\n {8}env:\n {10}PUBLIC_RAINRAIL_OPERATIONAL_API_URL: \$\{\{ vars\.RAINRAIL_OPERATIONAL_API_URL \}\}\n {8}run: pnpm pages:build$/m);
  });
});
