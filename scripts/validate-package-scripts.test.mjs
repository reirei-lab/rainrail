import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const tsconfig = JSON.parse(
  readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
);
const workspace = readFileSync(
  new URL('../pnpm-workspace.yaml', import.meta.url),
  'utf8',
);
const sitePackageJson = JSON.parse(
  readFileSync(new URL('../apps/www/package.json', import.meta.url), 'utf8'),
);
const cliPackageJson = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
);
const cliTsconfig = JSON.parse(
  readFileSync(new URL('../packages/cli/tsconfig.json', import.meta.url), 'utf8'),
);
const cliBuildTsconfig = JSON.parse(
  readFileSync(new URL('../packages/cli/tsconfig.build.json', import.meta.url), 'utf8'),
);
const copyDashboardAssetsScript = readFileSync(
  new URL('./copy-dashboard-assets.mjs', import.meta.url),
  'utf8',
);

describe('package scripts used by pull request CI', () => {
  it('builds repository scripts, the product site, docs site, and CLI package from the root command', () => {
    expect(packageJson.scripts['build:scripts']).toBe('node scripts/check-scripts.mjs');
    expect(packageJson.scripts.build).toBe(
      'pnpm run build:scripts && pnpm --filter www build && pnpm docs:build && pnpm --filter @rainrail/cli build',
    );
  });

  it('matches Node type declarations to the Node 26 CI runtime', () => {
    expect(packageJson.devDependencies['@types/node']).toMatch(/^\^26\./);
  });

  it('typechecks JavaScript automation scripts through tsconfig', () => {
    expect(packageJson.scripts.typecheck).toBe(
      'tsc --noEmit && pnpm --filter @rainrail/cli typecheck',
    );
    expect(packageJson.scripts['docs:check']).toContain(
      'node scripts/check-docs-routes.mjs',
    );
    expect(packageJson.scripts['docs:check']).toContain('pnpm docs:typecheck');
    expect(tsconfig.compilerOptions.allowJs).toBe(true);
    expect(tsconfig.compilerOptions.checkJs).toBe(true);
    expect(tsconfig.include).toContain('scripts/**/*.mjs');
  });

  it('treats apps and packages as pnpm workspace packages', () => {
    expect(workspace).toMatch(/^packages:\n {2}- 'apps\/\*'/);
    expect(workspace).toContain("  - 'packages/*'");
  });

  it('defines the Rainrail CLI workspace package and binary entrypoint', () => {
    expect(packageJson.scripts.test).toBe('vitest run scripts src packages');
    expect(packageJson.scripts['release:cli']).toBe(
      'node scripts/package-cli-release.mjs',
    );
    expect(cliPackageJson.name).toBe('@rainrail/cli');
    expect(cliPackageJson.bin.rainrail).toBe('./dist/bin/rainrail.js');
    expect(cliPackageJson.scripts.build).toBe(
      'tsc -p tsconfig.build.json && node ../../scripts/copy-dashboard-assets.mjs && chmod +x dist/bin/rainrail.js',
    );
    expect(copyDashboardAssetsScript).toContain('../apps/www/dist/');
    expect(copyDashboardAssetsScript).toContain('../apps/www/dist/ja/dashboard/');
    expect(copyDashboardAssetsScript).toContain('../apps/www/dist/en/dashboard/');
    expect(copyDashboardAssetsScript).toContain('../packages/cli/dist/dashboard/');
    expect(cliPackageJson.scripts.test).toBe('vitest run src');
    expect(cliPackageJson.scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');
  });

  it('typechecks CLI tests without emitting test files in the build', () => {
    expect(cliTsconfig.include).toContain('src/**/*.test.ts');
    expect(cliTsconfig.exclude ?? []).not.toContain('src/**/*.test.ts');
    expect(cliBuildTsconfig.extends).toBe('./tsconfig.json');
    expect(cliBuildTsconfig.exclude).toContain('src/**/*.test.ts');
  });

  it('defines focused validation scripts for the Astro product site', () => {
    expect(sitePackageJson.name).toBe('www');
    expect(sitePackageJson.scripts.lint).toBe('astro check');
    expect(sitePackageJson.scripts.typecheck).toBe('astro check');
    expect(sitePackageJson.scripts.build).toBe(
      'astro check && astro build && node ../../scripts/validate-www-i18n-regression.mjs',
    );
  });

  it('defines repeatable Cloudflare Pages commands for product site deploys', () => {
    expect(packageJson.scripts['pages:build']).toBe('pnpm --filter www build');
    expect(packageJson.scripts['pages:deploy:preview']).toBe(
      'pnpm pages:build && wrangler pages deploy apps/www/dist --project-name rainrail-www --branch "${RAINRAIL_PAGES_BRANCH:-preview}"',
    );
    expect(packageJson.scripts['pages:deploy:production']).toBe(
      'pnpm pages:build && wrangler pages deploy apps/www/dist --project-name rainrail-www --branch main',
    );
    expect(packageJson.scripts['pages:smoke']).toBe(
      'node scripts/smoke-cloudflare-pages.mjs',
    );
  });

  it('ships the initial product site MVP routes', () => {
    expect(existsSync(new URL('../apps/www/src/pages/index.astro', import.meta.url))).toBe(
      true,
    );
    expect(
      existsSync(new URL('../apps/www/src/pages/how-it-works.astro', import.meta.url)),
    ).toBe(true);
    expect(existsSync(new URL('../apps/www/src/pages/docs.astro', import.meta.url))).toBe(
      true,
    );
  });
});
