import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDocsRoutes } from './check-docs-routes.mjs';

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

/**
 * @param {string} slug
 */
const readDocsPage = (slug) =>
  readFileSync(new URL(`../apps/docs/src/content/docs/${slug}.md`, import.meta.url), 'utf8');

/**
 * @param {string} section
 */
const readDocsIndex = (section) =>
  readFileSync(
    new URL(`../apps/docs/src/content/docs/${section}/index.md`, import.meta.url),
    'utf8',
  );

describe('Starlight documentation app', () => {
  it('validates public docs sidebar routes and internal navigation links', () => {
    const root = mkdtempSync(join(tmpdir(), 'rainrail-docs-routes-'));
    mkdirSync(join(root, 'apps/docs/src/content/docs/quickstart'), { recursive: true });
    mkdirSync(join(root, 'apps/docs/src/content/docs/operations'), { recursive: true });
    mkdirSync(join(root, 'apps/www/src/lib'), { recursive: true });

    writeFileSync(
      join(root, 'apps/docs/astro.config.mjs'),
      [
        'export default {',
        'integrations: [starlight({',
        "sidebar: [",
        "  // { items: [{ label: 'Old page', slug: 'old-page' }] },",
        "  { items: [{ label: 'Quickstart', slug: 'quickstart' }] },",
        "  { items: [{ label: 'Operations', slug: 'operations' }] },",
        '],',
        "redirects: [{ slug: 'not-sidebar' }],",
        '})],',
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'apps/docs/src/content/docs/index.md'),
      [
        '---',
        'hero:',
        '  actions:',
        '    - text: Start here',
        '      link: /quickstart/',
        '---',
        '[Quickstart](/quickstart/) and [Operations](/operations/)',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'apps/docs/src/content/docs/quickstart/index.md'), 'Start.\n');
    writeFileSync(join(root, 'apps/docs/src/content/docs/operations/index.md'), 'Operate.\n');
    writeFileSync(
      join(root, 'apps/www/src/lib/site-content.ts'),
      [
        "const publicDocsBase = 'https://docs.rainrail.dev';",
        'export const links = [',
        '  `${publicDocsBase}/quickstart/`,',
        '  `${publicDocsBase}/operations/`,',
        '];',
        '',
      ].join('\n'),
    );

    expect(validateDocsRoutes(root)).toEqual([]);

    writeFileSync(
      join(root, 'apps/docs/src/content/docs/index.md'),
      '[Missing](/missing/)\n',
    );
    expect(validateDocsRoutes(root)).toContain(
      'apps/docs/src/content/docs/index.md links to missing docs route /missing/',
    );

    writeFileSync(
      join(root, 'apps/docs/src/content/docs/index.md'),
      [
        '---',
        'hero:',
        '  actions:',
        '    - text: Missing',
        '      link: /missing-cta/',
        '---',
        '[Quickstart](/quickstart/)',
        '',
      ].join('\n'),
    );
    expect(validateDocsRoutes(root)).toContain(
      'apps/docs/src/content/docs/index.md frontmatter links to missing docs route /missing-cta/',
    );

    writeFileSync(
      join(root, 'apps/www/src/lib/site-content.ts'),
      [
        "const publicDocsBase = 'https://docs.rainrail.dev';",
        'export const links = [`${publicDocsBase}/missing-product-link/`];',
        '',
      ].join('\n'),
    );
    expect(validateDocsRoutes(root)).toContain(
      'apps/www/src/lib/site-content.ts links to missing public docs route /missing-product-link/',
    );

    writeFileSync(
      join(root, 'apps/docs/astro.config.mjs'),
      "export default { integrations: [starlight({ sidebar: [{ items: [{ label: 'Missing', slug: 'missing' }] }] })] };\n",
    );
    expect(validateDocsRoutes(root)).toContain(
      'apps/docs/astro.config.mjs sidebar slug missing has no docs route',
    );
  });

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
    expect(docsAstroConfig).toContain("label: 'Examples'");
    for (const slug of [
      'concepts/event-model',
      'concepts/runtime-boundaries',
      'guides/source-adapter',
      'reference/plugin-runtime',
      'operations/cloudflare-worker',
      'examples/plugin-runtime',
    ]) {
      expect(docsAstroConfig).toContain(`slug: '${slug}'`);
    }
    expect(docsAstroConfig).not.toContain('disableSearch');
  });

  it('adds root scripts that build and deploy the docs Pages project independently from www', () => {
    expect(packageJson.scripts['docs:dev']).toBe('pnpm --filter @rainrail/docs dev');
    expect(packageJson.scripts['docs:check']).toBe(
      'node scripts/check-docs-drift.mjs && node scripts/check-docs-routes.mjs && tsc -p tsconfig.docs.json && pnpm docs:typecheck',
    );
    expect(packageJson.scripts['docs:build']).toBe('pnpm --filter @rainrail/docs build');
    expect(packageJson.scripts['docs:typecheck']).toBe(
      'pnpm --filter @rainrail/docs typecheck',
    );
    expect(packageJson.scripts['docs:deploy:preview']).toBe(
      'pnpm docs:build && wrangler pages deploy apps/docs/dist --force --project-name rainrail-docs --branch "${RAINRAIL_DOCS_BRANCH:-preview}"',
    );
    expect(packageJson.scripts['docs:deploy:production']).toBe(
      'pnpm docs:build && wrangler pages deploy apps/docs/dist --force --project-name rainrail-docs --branch main',
    );
    expect(cloudflarePagesDocs).toContain('docs.rainrail.dev');
    expect(cloudflarePagesDocs).toContain('rainrail-docs');
    expect(cloudflarePagesDocs).toContain('apps/docs/dist');
    expect(cloudflarePagesDocs).toContain('RAINRAIL_DOCS_BRANCH');
    expect(cloudflarePagesDocs).toContain('pnpm docs:deploy:preview');
    expect(cloudflarePagesDocs).toContain('pnpm docs:deploy:production');
  });

  it('ships landing and section pages for the external developer docs IA', () => {
    expect(docsIndex).toContain('Start here');
    expect(docsIndex).toContain('/quickstart/');
    expect(docsIndex).toContain('/concepts/');
    expect(docsIndex).toContain('/guides/');
    expect(docsIndex).toContain('/reference/');
    expect(docsIndex).toContain('/operations/');
    expect(docsIndex).toContain('/examples/plugin-runtime/');
    expect(docsIndex).toContain('source spec');
    expect(docsIndex).toContain('GitHub-only engineering notes');

    const sectionIndexes = ['quickstart', 'concepts', 'guides', 'reference', 'operations'];

    for (const section of sectionIndexes) {
      expect(
        existsSync(new URL(`../apps/docs/src/content/docs/${section}/index.md`, import.meta.url)),
      ).toBe(true);
      expect(readDocsIndex(section)).not.toMatch(/placeholder/i);
    }

    const requiredPages = [
      'concepts/event-model',
      'concepts/runtime-boundaries',
      'concepts/event-delivery',
      'concepts/operational-state',
      'guides/source-adapter',
      'guides/workflow-plugin',
      'guides/local-delivery',
      'reference/plugin-runtime',
      'reference/github-webhook-normalization',
      'reference/operational-api-v1',
      'reference/contracts-manifest',
      'operations/cloudflare-worker',
      'operations/cloudflare-pages',
      'operations/task-queue',
      'examples/plugin-runtime',
    ];

    for (const slug of requiredPages) {
      expect(existsSync(new URL(`../apps/docs/src/content/docs/${slug}.md`, import.meta.url))).toBe(
        true,
      );
      expect(readDocsPage(slug)).toContain('Source spec');
    }

    const pluginRuntimeReference = readDocsPage('reference/plugin-runtime');
    expect(pluginRuntimeReference).toContain('Codex App Server runtime');
    expect(pluginRuntimeReference).toContain('rainrail setup codex-app-server --yes');
    expect(pluginRuntimeReference).toContain('CODEX_HOME');
    expect(pluginRuntimeReference).toContain('process pooling');

    const pluginRuntimeExample = readDocsPage('examples/plugin-runtime');
    expect(pluginRuntimeExample).toContain('runtimeProviders.codexAppServer');
    expect(pluginRuntimeExample).toContain('Users who do not run Codex do not need');
  });

  it('keeps rainrail.dev/docs as a gateway to docs.rainrail.dev instead of repo-only docs', () => {
    const productSiteContent = readFileSync(
      new URL('../apps/www/src/lib/site-content.ts', import.meta.url),
      'utf8',
    );

    expect(productSiteContent).toContain("const publicDocsBase = 'https://docs.rainrail.dev'");
    expect(productSiteContent).toContain('`${publicDocsBase}/reference/plugin-runtime/`');
    expect(productSiteContent).toContain('`${publicDocsBase}/operations/cloudflare-worker/`');
    expect(productSiteContent).toContain('`${publicDocsBase}/operations/cloudflare-pages/`');
    expect(productSiteContent).toContain('GitHub-only engineering notes');
    expect(productSiteContent).toContain('`${docsBase}/product-site-information-architecture.md`');
  });
});
