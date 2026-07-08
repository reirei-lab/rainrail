import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const docsPackageJson = JSON.parse(
  readFileSync(new URL('../apps/docs/package.json', import.meta.url), 'utf8'),
);
const docsAstroConfig = readFileSync(
  new URL('../apps/docs/astro.config.mjs', import.meta.url),
  'utf8',
);
const cloudflarePagesDocs = readFileSync(
  new URL('../docs/cloudflare-pages.md', import.meta.url),
  'utf8',
);
const docsIndex = readFileSync(
  new URL('../apps/docs/src/content/docs/index.md', import.meta.url),
  'utf8',
);

describe('Starlight documentation app', () => {
  it('defines a workspace app for docs.rainrail.dev builds', () => {
    expect(docsPackageJson.name).toBe('@rainrail/docs');
    expect(docsPackageJson.scripts.dev).toBe('astro dev');
    expect(docsPackageJson.scripts.typecheck).toBe('astro check');
    expect(docsPackageJson.scripts.build).toBe('astro check && astro build');
    expect(docsPackageJson.dependencies.astro).toMatch(/^\^7\./);
    expect(docsPackageJson.dependencies['@astrojs/starlight']).toBeDefined();
    expect(docsPackageJson.devDependencies['@astrojs/check']).toBeDefined();
  });

  it('configures Starlight for the docs domain, sidebar, search, and Cloudflare Pages output', () => {
    expect(docsAstroConfig).toContain("site: 'https://docs.rainrail.dev'");
    expect(docsAstroConfig).toContain("title: 'Rainrail Docs'");
    expect(docsAstroConfig).toContain('social:');
    expect(docsAstroConfig).toContain('sidebar:');
    expect(docsAstroConfig).toContain("label: 'Quickstart'");
    expect(docsAstroConfig).toContain("label: 'Concepts'");
    expect(docsAstroConfig).toContain("label: 'Guides'");
    expect(docsAstroConfig).toContain("label: 'Reference'");
    expect(docsAstroConfig).toContain("label: 'Operations'");
    expect(docsAstroConfig).not.toContain('disableSearch');
  });

  it('adds root scripts that build and deploy the docs Pages project independently from www', () => {
    expect(packageJson.scripts['docs:dev']).toBe('pnpm --filter @rainrail/docs dev');
    expect(packageJson.scripts['docs:build']).toBe('pnpm --filter @rainrail/docs build');
    expect(packageJson.scripts['docs:typecheck']).toBe(
      'pnpm --filter @rainrail/docs typecheck',
    );
    expect(packageJson.scripts['docs:deploy:preview']).toBe(
      'pnpm docs:build && wrangler pages deploy apps/docs/dist --project-name rainrail-docs --branch "${RAINRAIL_PAGES_BRANCH:-preview}"',
    );
    expect(packageJson.scripts['docs:deploy:production']).toBe(
      'pnpm docs:build && wrangler pages deploy apps/docs/dist --project-name rainrail-docs --branch main',
    );
    expect(cloudflarePagesDocs).toContain('docs.rainrail.dev');
    expect(cloudflarePagesDocs).toContain('rainrail-docs');
    expect(cloudflarePagesDocs).toContain('apps/docs/dist');
    expect(cloudflarePagesDocs).toContain('pnpm docs:deploy:preview');
    expect(cloudflarePagesDocs).toContain('pnpm docs:deploy:production');
  });

  it('ships landing, section, and placeholder pages for the initial docs structure', () => {
    expect(docsIndex).toContain('Start here');
    expect(docsIndex).toContain('/quickstart/');
    expect(docsIndex).toContain('/concepts/');
    expect(docsIndex).toContain('/guides/');
    expect(docsIndex).toContain('/reference/');
    expect(docsIndex).toContain('/operations/');

    for (const section of ['quickstart', 'concepts', 'guides', 'reference', 'operations']) {
      expect(
        existsSync(new URL(`../apps/docs/src/content/docs/${section}/index.md`, import.meta.url)),
      ).toBe(true);
    }
  });
});
