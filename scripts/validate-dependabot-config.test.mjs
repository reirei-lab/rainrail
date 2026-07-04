import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dependabotConfig = readFileSync(
  new URL('../.github/dependabot.yml', import.meta.url),
  'utf8',
);

describe('Dependabot configuration', () => {
  it('updates npm manifests in root, apps, and packages workspaces', () => {
    expect(dependabotConfig).toMatch(/^ {2}- package-ecosystem: "npm"$/m);
    expect(dependabotConfig).toContain('      - "/"');
    expect(dependabotConfig).toContain('      - "/apps/*"');
    expect(dependabotConfig).toContain('      - "/packages/*"');
  });
});
