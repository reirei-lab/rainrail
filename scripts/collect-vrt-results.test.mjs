import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectVrtResults } from './collect-vrt-results.mjs';

describe('collectVrtResults', () => {
  it('copies Playwright screenshot comparison triplets into stable VRT result cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const failureDir = join(resultsDir, 'dashboard-smoke-matches-dashboard-route-visual-baselines');
    const outputDir = join(root, 'vrt-results');
    mkdirSync(failureDir, { recursive: true });
    writeFileSync(join(failureDir, 'overview-demo-summary-desktop-expected.png'), 'before');
    writeFileSync(join(failureDir, 'overview-demo-summary-desktop-actual.png'), 'after');
    writeFileSync(join(failureDir, 'overview-demo-summary-desktop-diff.png'), 'diff');

    const summary = await collectVrtResults({ resultsDir, outputDir });

    expect(summary).toEqual({
      changed: true,
      totalChanged: 1,
      cases: [
        {
          id: 'overview-demo-summary-desktop',
          title: 'Overview Demo Summary Desktop',
          before: 'vrt-results/overview-demo-summary-desktop/before.png',
          after: 'vrt-results/overview-demo-summary-desktop/after.png',
          diff: 'vrt-results/overview-demo-summary-desktop/diff.png',
        },
      ],
    });
    expect(JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))).toEqual(summary);
    expect(readFileSync(join(outputDir, 'overview-demo-summary-desktop', 'before.png'), 'utf8')).toBe('before');
    expect(readFileSync(join(outputDir, 'overview-demo-summary-desktop', 'after.png'), 'utf8')).toBe('after');
    expect(readFileSync(join(outputDir, 'overview-demo-summary-desktop', 'diff.png'), 'utf8')).toBe('diff');
  });

  it('writes an empty summary when there are no visual diffs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    mkdirSync(resultsDir, { recursive: true });

    await expect(collectVrtResults({ resultsDir, outputDir })).resolves.toEqual({
      changed: false,
      totalChanged: 0,
      cases: [],
    });
    expect(JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))).toEqual({
      changed: false,
      totalChanged: 0,
      cases: [],
    });
  });
});
