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
    expect(docs).toContain('pnpm pages:deploy:preview');
    expect(docs).toContain('pnpm pages:deploy:production');
    expect(docs).toContain('GitHub Actions は secrets が未設定の場合でも build まで実行し、deploy だけを skip する');
    expect(docs).toContain('RAINRAIL_PAGES_URL=https://<pages-host> pnpm pages:smoke');
  });

  it('ships a smoke script that validates product routes without mutating production', () => {
    expect(packageJson.scripts['pages:smoke']).toBe(
      'node scripts/smoke-cloudflare-pages.mjs',
    );
    expect(existsSync(new URL('./smoke-cloudflare-pages.mjs', import.meta.url))).toBe(true);

    const smokeScript = readFileSync(new URL('./smoke-cloudflare-pages.mjs', import.meta.url), 'utf8');
    expect(smokeScript).toContain('RAINRAIL_PAGES_URL');
    expect(smokeScript).toContain('/docs');
    expect(smokeScript).toContain('/how-it-works');
  });

  it('deploys pull request previews and main branch production from GitHub Actions', () => {
    expect(workflow).toMatch(/^name: Cloudflare Pages Deploy$/m);
    expect(workflow).toMatch(/^ {2}pull_request:/m);
    expect(workflow).toMatch(/^ {2}push:\n {4}branches:\n {6}- main$/m);
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('RAINRAIL_PAGES_BRANCH: ${{ github.head_ref }}');
    expect(workflow).toContain('pnpm pages:build');
    expect(workflow).toContain("if: env.CLOUDFLARE_ACCOUNT_ID != '' && env.CLOUDFLARE_API_TOKEN != ''");
    expect(workflow).toContain("if: env.CLOUDFLARE_ACCOUNT_ID == '' || env.CLOUDFLARE_API_TOKEN == ''");
    expect(workflow).toContain('wrangler pages deploy apps/www/dist --project-name rainrail-www --branch "${RAINRAIL_PAGES_BRANCH}"');
    expect(workflow).toContain('wrangler pages deploy apps/www/dist --project-name rainrail-www --branch main');
  });
});
