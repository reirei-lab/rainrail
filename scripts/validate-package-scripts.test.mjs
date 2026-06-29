import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const tsconfig = JSON.parse(
  readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
);

describe('package scripts used by pull request CI', () => {
  it('builds by checking every repository script through the syntax checker', () => {
    expect(packageJson.scripts.build).toBe('node scripts/check-scripts.mjs');
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
});
