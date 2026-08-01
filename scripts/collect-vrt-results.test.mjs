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

  it('fails instead of writing a no-diff summary when an explicit Playwright report is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    mkdirSync(resultsDir, { recursive: true });

    await expect(collectVrtResults({
      resultsDir,
      outputDir,
      reportPath: join(resultsDir, 'missing-report.json'),
    })).rejects.toThrow(/Playwright JSON report was not found/);
  });

  it('reports missing baselines as changed VRT cases instead of dropping them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const failureDir = join(resultsDir, 'dashboard-smoke-matches-dashboard-route-visual-baselines');
    const outputDir = join(root, 'vrt-results');
    mkdirSync(failureDir, { recursive: true });
    writeFileSync(join(failureDir, 'new-card-desktop-actual.png'), 'new-card');

    const summary = await collectVrtResults({ resultsDir, outputDir });

    expect(summary).toEqual({
      changed: true,
      totalChanged: 1,
      cases: [
        {
          id: 'new-card-desktop',
          title: 'New Card Desktop',
          status: 'missing-baseline',
          after: 'vrt-results/new-card-desktop/after.png',
        },
      ],
    });
    expect(readFileSync(join(outputDir, 'new-card-desktop', 'after.png'), 'utf8')).toBe('new-card');
  });

  it('reports missing baselines from the Playwright report even when no actual attachment exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    const reportPath = join(resultsDir, 'playwright-report.json');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          title: 'dashboard-smoke.spec.ts',
          specs: [
            {
              title: 'visual baselines',
              tests: [
                {
                  title: 'new card desktop',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      error: {
                        message: `Error: A snapshot doesn't exist at ${join(resultsDir, 'dashboard-smoke.spec.ts-snapshots', 'new-card-desktop.png')}.`,
                      },
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary).toEqual({
      changed: true,
      totalChanged: 1,
      cases: [
        {
          id: 'new-card-desktop',
          title: 'New Card Desktop',
          status: 'missing-baseline',
        },
      ],
    });
    expect(JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))).toEqual(summary);
  });

  it('reports screenshot timeouts without actual attachments instead of writing a no-diff summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    const reportPath = join(resultsDir, 'playwright-report.json');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          title: 'dashboard-smoke.spec.ts',
          specs: [
            {
              title: 'visual baselines',
              tests: [
                {
                  title: 'stable animated card',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      error: {
                        message: 'Error: expect(page).toHaveScreenshot(stable-animated-card.png) failed: Timed out 5000ms waiting for screenshot comparison.',
                      },
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary).toEqual({
      changed: true,
      totalChanged: 1,
      cases: [
        {
          id: 'stable-animated-card',
          title: 'Stable Animated Card',
          status: 'screenshot-timeout',
        },
      ],
    });
    expect(JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))).toEqual(summary);
  });

  it('uses the expected attachment as the before image for reported screenshot mismatches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const failureDir = join(resultsDir, 'dashboard-smoke-matches-dashboard-route-visual-baselines');
    const snapshotDir = join(root, 'e2e', 'dashboard', 'dashboard-smoke.spec.ts-snapshots');
    const outputDir = join(root, 'vrt-results');
    const reportPath = join(resultsDir, 'playwright-report.json');
    mkdirSync(failureDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'reported-card-desktop-dashboard-chromium.png'), 'baseline');
    writeFileSync(join(failureDir, 'reported-card-desktop-dashboard-chromium-actual.png'), 'after');
    writeFileSync(join(failureDir, 'reported-card-desktop-dashboard-chromium-diff.png'), 'diff');
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'reported-card-desktop-dashboard-chromium-expected', path: join(snapshotDir, 'reported-card-desktop-dashboard-chromium.png') },
                        { name: 'reported-card-desktop-dashboard-chromium-actual', path: join(failureDir, 'reported-card-desktop-dashboard-chromium-actual.png') },
                        { name: 'reported-card-desktop-dashboard-chromium-diff', path: join(failureDir, 'reported-card-desktop-dashboard-chromium-diff.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toEqual([
      {
        id: 'reported-card-desktop-dashboard-chromium',
        title: 'Reported Card Desktop Dashboard Chromium',
        before: 'vrt-results/reported-card-desktop-dashboard-chromium/before.png',
        after: 'vrt-results/reported-card-desktop-dashboard-chromium/after.png',
        diff: 'vrt-results/reported-card-desktop-dashboard-chromium/diff.png',
      },
    ]);
    expect(readFileSync(join(outputDir, 'reported-card-desktop-dashboard-chromium', 'before.png'), 'utf8')).toBe('baseline');
  });

  it('classifies attachment kinds by suffix when snapshot names contain actual', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const failureDir = join(resultsDir, 'dashboard-smoke-matches-dashboard-route-visual-baselines');
    const outputDir = join(root, 'vrt-results');
    const reportPath = join(resultsDir, 'playwright-report.json');
    mkdirSync(failureDir, { recursive: true });
    writeFileSync(join(failureDir, 'actual-status-card-expected.png'), 'before');
    writeFileSync(join(failureDir, 'actual-status-card-actual.png'), 'after');
    writeFileSync(join(failureDir, 'actual-status-card-diff.png'), 'diff');
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'actual-status-card-expected', path: join(failureDir, 'actual-status-card-expected.png') },
                        { name: 'actual-status-card-actual', path: join(failureDir, 'actual-status-card-actual.png') },
                        { name: 'actual-status-card-diff', path: join(failureDir, 'actual-status-card-diff.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toEqual([
      {
        id: 'actual-status-card',
        title: 'Actual Status Card',
        before: 'vrt-results/actual-status-card/before.png',
        after: 'vrt-results/actual-status-card/after.png',
        diff: 'vrt-results/actual-status-card/diff.png',
      },
    ]);
    expect(readFileSync(join(outputDir, 'actual-status-card', 'before.png'), 'utf8')).toBe('before');
    expect(readFileSync(join(outputDir, 'actual-status-card', 'after.png'), 'utf8')).toBe('after');
    expect(readFileSync(join(outputDir, 'actual-status-card', 'diff.png'), 'utf8')).toBe('diff');
  });

  it('ignores screenshot mismatches from retry attempts that finish flaky', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const failureDir = join(resultsDir, 'dashboard-smoke-matches-dashboard-route-visual-baselines');
    const outputDir = join(root, 'vrt-results');
    const reportPath = join(resultsDir, 'playwright-report.json');
    mkdirSync(failureDir, { recursive: true });
    for (const id of ['flaky-case-desktop', 'failed-case-desktop']) {
      writeFileSync(join(failureDir, `${id}-expected.png`), `${id}-before`);
      writeFileSync(join(failureDir, `${id}-actual.png`), `${id}-after`);
      writeFileSync(join(failureDir, `${id}-diff.png`), `${id}-diff`);
    }
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'flaky',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'flaky-case-desktop-actual', path: join(failureDir, 'flaky-case-desktop-actual.png') },
                      ],
                    },
                    { status: 'passed', attachments: [] },
                  ],
                },
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'failed-case-desktop-actual', path: join(failureDir, 'failed-case-desktop-actual.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.id).toBe('failed-case-desktop');
    expect(readFileSync(join(outputDir, 'failed-case-desktop', 'after.png'), 'utf8')).toBe('failed-case-desktop-after');
  });

  it('deduplicates the same unexpected screenshot across failed retry attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    const firstAttemptDir = join(resultsDir, 'attempt-1');
    const retryDir = join(resultsDir, 'attempt-2');
    const reportPath = join(resultsDir, 'playwright-report.json');
    for (const dir of [firstAttemptDir, retryDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'persistent-case-desktop-expected.png'), `${dir}-before`);
      writeFileSync(join(dir, 'persistent-case-desktop-actual.png'), `${dir}-after`);
      writeFileSync(join(dir, 'persistent-case-desktop-diff.png'), `${dir}-diff`);
    }
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'persistent-case-desktop-actual', path: join(firstAttemptDir, 'persistent-case-desktop-actual.png') },
                      ],
                    },
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'persistent-case-desktop-actual', path: join(retryDir, 'persistent-case-desktop-actual.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.id).toBe('persistent-case-desktop');
    expect(readFileSync(join(outputDir, 'persistent-case-desktop', 'after.png'), 'utf8')).toBe(`${retryDir}-after`);
  });

  it('uses only the final failed retry result so recovered snapshots are not reported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    const firstAttemptDir = join(resultsDir, 'attempt-1');
    const retryDir = join(resultsDir, 'attempt-2');
    const reportPath = join(resultsDir, 'playwright-report.json');
    for (const dir of [firstAttemptDir, retryDir]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const id of ['recovered-case-desktop', 'final-case-desktop']) {
      const dir = id.startsWith('recovered') ? firstAttemptDir : retryDir;
      writeFileSync(join(dir, `${id}-expected.png`), `${id}-before`);
      writeFileSync(join(dir, `${id}-actual.png`), `${id}-after`);
      writeFileSync(join(dir, `${id}-diff.png`), `${id}-diff`);
    }
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'recovered-case-desktop-actual', path: join(firstAttemptDir, 'recovered-case-desktop-actual.png') },
                      ],
                    },
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'final-case-desktop-actual', path: join(retryDir, 'final-case-desktop-actual.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.id).toBe('final-case-desktop');
  });

  it('keeps same-named screenshots from different tests as separate VRT cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-'));
    const resultsDir = join(root, 'test-results', 'dashboard');
    const outputDir = join(root, 'vrt-results');
    const firstDir = join(resultsDir, 'overview-spec');
    const secondDir = join(resultsDir, 'cards-spec');
    const reportPath = join(resultsDir, 'playwright-report.json');
    for (const dir of [firstDir, secondDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'card-desktop-expected.png'), `${dir}-before`);
      writeFileSync(join(dir, 'card-desktop-actual.png'), `${dir}-after`);
      writeFileSync(join(dir, 'card-desktop-diff.png'), `${dir}-diff`);
    }
    writeFileSync(reportPath, JSON.stringify({
      suites: [
        {
          title: 'overview.spec.ts',
          specs: [
            {
              title: 'overview cards',
              tests: [
                {
                  title: 'renders overview card',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'card-desktop-actual', path: join(firstDir, 'card-desktop-actual.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          title: 'cards.spec.ts',
          specs: [
            {
              title: 'dashboard cards',
              tests: [
                {
                  title: 'renders dashboard card',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        { name: 'card-desktop-actual', path: join(secondDir, 'card-desktop-actual.png') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }));

    const summary = await collectVrtResults({ resultsDir, outputDir, reportPath });

    expect(summary.cases).toHaveLength(2);
    expect(summary.cases.map((caseItem) => caseItem.id)).toEqual(['card-desktop', 'card-desktop-2']);
    expect(readFileSync(join(outputDir, 'card-desktop', 'after.png'), 'utf8')).toBe(`${firstDir}-after`);
    expect(readFileSync(join(outputDir, 'card-desktop-2', 'after.png'), 'utf8')).toBe(`${secondDir}-after`);
  });
});
