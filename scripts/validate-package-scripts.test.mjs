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

describe('package scripts used by pull request CI', () => {
  it('builds repository scripts and the product site from the root command', () => {
    expect(packageJson.scripts['build:scripts']).toBe('node scripts/check-scripts.mjs');
    expect(packageJson.scripts.build).toBe(
      'pnpm run build:scripts && pnpm --filter www build',
    );
  });

  it('matches Node type declarations to the Node 24 CI runtime', () => {
    expect(packageJson.devDependencies['@types/node']).toMatch(/^\^24\./);
  });

  it('typechecks JavaScript automation scripts through tsconfig', () => {
    expect(packageJson.scripts.typecheck).toBe('tsc --noEmit');
    expect(tsconfig.compilerOptions.allowJs).toBe(true);
    expect(tsconfig.compilerOptions.checkJs).toBe(true);
    expect(tsconfig.include).toContain('scripts/**/*.mjs');
  });

  it('treats apps as pnpm workspace packages', () => {
    expect(workspace).toMatch(/^packages:\n {2}- 'apps\/\*'/);
  });

  it('defines focused validation scripts for the Astro product site', () => {
    expect(sitePackageJson.name).toBe('www');
    expect(sitePackageJson.scripts.lint).toBe('astro check');
    expect(sitePackageJson.scripts.typecheck).toBe('astro check');
    expect(sitePackageJson.scripts.build).toBe('astro check && astro build');
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
