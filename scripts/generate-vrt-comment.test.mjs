import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateVrtComment, writeVrtComment } from './generate-vrt-comment.mjs';

describe('generateVrtComment', () => {
  it('renders before, after, and diff images for changed VRT cases with a display limit', () => {
    const markdown = generateVrtComment({
      changed: true,
      totalChanged: 3,
      cases: [
        {
          id: 'overview-demo-summary-desktop',
          title: 'Overview Demo Summary Desktop',
          before: 'vrt-results/overview-demo-summary-desktop/before.png',
          after: 'vrt-results/overview-demo-summary-desktop/after.png',
          diff: 'vrt-results/overview-demo-summary-desktop/diff.png',
        },
        {
          id: 'workflow-runs-failed-retry-desktop',
          title: 'Workflow Runs Failed Retry Desktop',
          before: 'vrt-results/workflow-runs-failed-retry-desktop/before.png',
          after: 'vrt-results/workflow-runs-failed-retry-desktop/after.png',
          diff: 'vrt-results/workflow-runs-failed-retry-desktop/diff.png',
        },
      ],
    }, { maxCases: 1 });

    expect(markdown).toContain('## VRT 差分');
    expect(markdown).toContain('3件の visual regression を検出しました。');
    expect(markdown).toContain('### Overview Demo Summary Desktop');
    expect(markdown).toContain('| before | after | diff |');
    expect(markdown).toContain('![](./vrt-results/overview-demo-summary-desktop/before.png)');
    expect(markdown).toContain('![](./vrt-results/overview-demo-summary-desktop/after.png)');
    expect(markdown).toContain('![](./vrt-results/overview-demo-summary-desktop/diff.png)');
    expect(markdown).toContain('ほか 2 件は GitHub Actions artifact を参照してください。');
    expect(markdown).not.toContain('Workflow Runs Failed Retry Desktop');
  });

  it('renders a stable no-diff comment', () => {
    expect(generateVrtComment({ changed: false, totalChanged: 0, cases: [] })).toBe([
      '## VRT 差分',
      '',
      'visual regression は検出されませんでした。',
      '',
      '全結果は GitHub Actions artifact を参照してください。',
      '',
    ].join('\n'));
  });

  it('renders missing baseline cases without pretending all three images exist', () => {
    const markdown = generateVrtComment({
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

    expect(markdown).toContain('### New Card Desktop');
    expect(markdown).toContain('baseline 未作成');
    expect(markdown).toContain('![](./vrt-results/new-card-desktop/after.png)');
    expect(markdown).toContain('diff 未生成');
    expect(markdown).not.toContain('undefined');
  });

  it('renders screenshot timeout cases without pretending image artifacts exist', () => {
    const markdown = generateVrtComment({
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

    expect(markdown).toContain('### Stable Animated Card');
    expect(markdown).toContain('screenshot timeout');
    expect(markdown).not.toContain('baseline 未作成');
    expect(markdown).not.toContain('undefined');
  });

  it('renders VRT test setup failures without pretending image artifacts exist', () => {
    const markdown = generateVrtComment({
      changed: true,
      totalChanged: 1,
      cases: [
        {
          id: 'overview-route-visual-baseline',
          title: 'Overview Route Visual Baseline',
          status: 'vrt-test-failed',
        },
      ],
    });

    expect(markdown).toContain('### Overview Route Visual Baseline');
    expect(markdown).toContain('VRT setup/assertion failed');
    expect(markdown).not.toContain('visual regression は検出されませんでした。');
    expect(markdown).not.toContain('undefined');
  });

  it('writes a comment from a summary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-vrt-comment-'));
    const summaryPath = join(root, 'vrt-results', 'summary.json');
    const outputPath = join(root, 'vrt-comment.md');
    await mkdir(join(root, 'vrt-results'), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify({ changed: false, totalChanged: 0, cases: [] }));

    await writeVrtComment({ summaryPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toContain('visual regression は検出されませんでした。');
  });
});
