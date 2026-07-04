import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = new URL('..', import.meta.url);
const readSource = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8');

describe('GitHub provider boundary', () => {
  it('publishes GitHub task, PR, Project, auth, and rate-limit implementations from the provider namespace', () => {
    const providerModules = [
      'src/providers/github/auth.ts',
      'src/providers/github/index.ts',
      'src/providers/github/project-task-queue.ts',
      'src/providers/github/pull-request-provider.ts',
      'src/providers/github/rate-limit.ts',
      'src/providers/github/task-provider.ts',
    ];

    for (const modulePath of providerModules) {
      expect(existsSync(join(repoRoot.pathname, modulePath)), modulePath).toBe(true);
    }
  });

  it('keeps root GitHub modules as compatibility shims over provider namespace modules', () => {
    expect(readSource('src/github-auth.ts')).toBe("export * from './providers/github/auth.js';\n");
    expect(readSource('src/github-project.ts')).toBe("export * from './providers/github/project-task-queue.js';\n");
    expect(readSource('src/github-provider.ts')).toBe("export * from './providers/github/task-provider.js';\nexport * from './providers/github/pull-request-provider.js';\n");
    expect(readSource('src/github-rate-limit.ts')).toBe("export * from './providers/github/rate-limit.js';\n");
  });

  it('documents that workflow tests use mock providers while GitHub provider tests cover adapter implementations', () => {
    const contract = readSource('docs/plugin-runtime-contract.md');

    expect(contract).toContain('`src/providers/github/*`');
    expect(contract).toContain('workflow test は mock `TaskProvider` / `PullRequestProvider`');
    expect(contract).toContain('GitHub provider 実装の HTTP adapter behavior は `github-provider.test.ts`');
  });
});
