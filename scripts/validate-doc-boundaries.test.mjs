import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contentPlan = readFileSync(
  new URL('../docs/product-site-information-architecture.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('product site information architecture', () => {
  it('keeps the product sitemap, docs boundary, and content priorities in one plan', () => {
    expect(contentPlan).toContain('# Product site information architecture');
    expect(contentPlan).toContain('## Product site sitemap');
    expect(contentPlan).toContain('## Documentation boundary');
    expect(contentPlan).toContain('## Surface roles');
    expect(contentPlan).toContain('## Initial page priority');

    expect(contentPlan).toContain('`apps/www`');
    expect(contentPlan).toContain('`docs/`');
    expect(contentPlan).toContain('`README.md`');
    expect(contentPlan).toContain('`examples/`');
  });

  it('links the plan from the project README', () => {
    expect(readme).toContain('docs/product-site-information-architecture.md');
  });

  it('keeps README and docs index entry points aligned with product and engineering surfaces', () => {
    for (const entry of [
      'https://rainrail.dev',
      'https://rainrail.dev/docs',
      'docs/README.md',
      'docs/plugin-runtime-contract.md',
      'docs/task-queue-project-issues.md',
      'docs/cloudflare-pages.md',
      'apps/www',
      'src/',
      'scripts/',
    ]) {
      expect(readme).toContain(entry);
    }

    for (const entry of [
      'https://rainrail.dev',
      'https://rainrail.dev/docs',
      'plugin-runtime-contract.md',
      'github-webhook-normalization.md',
      'event-delivery.md',
      'task-queue-project-issues.md',
      'cloudflare-worker.md',
      'cloudflare-pages.md',
      'repo-test-coverage-matrix.md',
    ]) {
      expect(docsIndex).toContain(entry);
    }
  });
});
