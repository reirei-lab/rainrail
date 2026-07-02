import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const prCiWorkflow = readFileSync(new URL('../.github/workflows/pr-ci.yml', import.meta.url), 'utf8');
const deployTemplate = readFileSync(new URL('../docs/templates/cloudflare-self-host-deploy.yml', import.meta.url), 'utf8');
const cloudflareDocs = readFileSync(new URL('../docs/cloudflare-worker.md', import.meta.url), 'utf8');
const deployabilityScript = readFileSync(new URL('./check-cloudflare-deployability.mjs', import.meta.url), 'utf8');

describe('Cloudflare deployability CI', () => {
  it('runs a side-effect-free Wrangler deploy dry run from pull request CI', () => {
    expect(packageJson.scripts['cf:deploy:check']).toBe('node scripts/check-cloudflare-deployability.mjs');
    expect(prCiWorkflow).toContain('name: Cloudflare deployability');
    expect(prCiWorkflow).toMatch(/^ {2}cloudflare-deployability:\n {4}name: Cloudflare deployability\n {4}needs: validate/m);
    expect(prCiWorkflow).toContain('run: pnpm cf:deploy:check');
    expect(deployabilityScript).toContain("'deploy'");
    expect(deployabilityScript).toContain("'--dry-run'");
    expect(deployabilityScript).toContain("'--outdir'");
    expect(deployabilityScript).not.toContain("'wrangler', ['deploy']");
  });

  it('writes bundle, dry-run, smoke-template, and missing-input results to the CI summary', () => {
    for (const summaryLabel of [
      'Worker bundle dry run',
      'Wrangler deploy dry run',
      'Smoke template guard',
      'Required deploy inputs',
    ]) {
      expect(deployabilityScript).toContain(summaryLabel);
    }
    expect(deployabilityScript).toContain('GITHUB_STEP_SUMMARY');
  });

  it('keeps the shared CI smoke guard limited to health and invalid ping signature checks', () => {
    expect(deployabilityScript).toContain("'x-github-event': 'ping'");
    expect(deployabilityScript).toContain('signature_mismatch');
    expect(deployabilityScript).not.toContain("'x-github-event': 'issues'");
    expect(deployabilityScript).not.toContain("action: 'opened'");
  });

  it('provides a self-host deploy workflow template without committing operational credentials', () => {
    expect(deployTemplate).toContain('name: Deploy Rainrail Worker');
    expect(deployTemplate).toContain('pnpm cf:deploy');
    expect(deployTemplate).toContain('pnpm cf:smoke');
    expect(deployTemplate).toContain('RAINRAIL_WORKER_URL: ${{ vars.RAINRAIL_WORKER_URL }}');
    expect(deployTemplate).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(deployTemplate).not.toMatch(/replace-with-|ghp_|cf_[A-Za-z0-9]/u);
    expect(cloudflareDocs).toContain('docs/templates/cloudflare-self-host-deploy.yml');
    expect(cloudflareDocs).toContain('CLOUDFLARE_API_TOKEN');
    expect(cloudflareDocs).toContain('RAINRAIL_WORKER_URL');
  });
});
