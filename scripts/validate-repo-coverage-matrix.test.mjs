import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const matrix = readFileSync(
  new URL('../docs/repo-test-coverage-matrix.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/**
 * @param {string} text
 * @param {RegExp} pattern
 */
const extractBacktickPathsFromText = (text, pattern) => [...text.matchAll(pattern)].flatMap((match) => {
  const path = match[1];
  return path === undefined ? [] : [path];
});

/** @param {RegExp} pattern */
const extractBacktickPaths = (pattern) => extractBacktickPathsFromText(matrix, pattern);

const rainrailTestPaths = extractBacktickPaths(/`((?:src|scripts)\/[^`]+\.test\.(?:ts|mjs))`/g);

const rainrailSourcePaths = extractBacktickPaths(/`(src\/[^`]+\.ts)`/g)
  .filter((path) => !path.endsWith('.test.ts'));

/**
 * @param {string} markdown
 */
const parseCoverageRows = (markdown) => markdown
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .flatMap((line) => {
    const columns = line.slice(1, -1).split('|').map((column) => column.trim());
    const [originalCell, , , coverageCell = '', statusCell = ''] = columns;
    const originalTest = extractBacktickPathsFromText(originalCell ?? '', /`([^`]+)`/g)[0];

    return originalTest === undefined
      ? []
      : [{ originalTest, coverageCell, statusCell }];
  });

/**
 * @param {string} markdown
 */
const validateCoverageRows = (markdown) => parseCoverageRows(markdown).flatMap((row) => {
  const coverageTests = extractBacktickPathsFromText(
    row.coverageCell,
    /`((?:src|scripts)\/[^`]+\.test\.(?:ts|mjs))`/g,
  );
  const hasAlternateStatus = /\b(?:Alternate check|Not ported)\b/.test(row.statusCell);
  const errors = [];

  if (coverageTests.length === 0 && !hasAlternateStatus) {
    errors.push(`${row.originalTest} must map to a Rainrail test or explicit alternate/not ported status`);
  }

  for (const coverageTest of coverageTests) {
    if (!existsSync(new URL(`../${coverageTest}`, import.meta.url))) {
      errors.push(`${row.originalTest} references missing Rainrail test ${coverageTest}`);
    }
  }

  return errors;
});

describe('source repository test coverage matrix', () => {
  it('records the source repositories and current Rainrail verification command', () => {
    expect(matrix).toContain('# Source repository test coverage matrix');
    expect(matrix).toContain('github-eep-bridge');
    expect(matrix).toContain('eep-bridge-worker');
    expect(matrix).toContain('reirei-harness');
    expect(matrix).toContain('Source repositories verified on 2026-07-02');
    expect(matrix).toContain('https://github.com/hiragram/github-eep-bridge');
    expect(matrix).toContain('https://github.com/reirei-lab/eep-bridge-worker');
    expect(matrix).toContain('https://github.com/reirei-lab/reirei-harness');
    expect(matrix).toContain('`pnpm test`');
  });

  it('maps each original test file to a Rainrail test or a documented alternate check', () => {
    for (const originalTest of [
      'github-eep-bridge/test/server.test.js',
      'github-eep-bridge/test/bridge-room.test.js',
      'github-eep-bridge/test/github-normalize.test.js',
      'github-eep-bridge/test/github-signature-worker.test.js',
      'github-eep-bridge/test/github-signature.test.js',
      'eep-bridge-worker/test/bridge-room.test.js',
      'eep-bridge-worker/test/cloudflare-tail.test.js',
      'eep-bridge-worker/test/events-auth.test.js',
      'eep-bridge-worker/test/github-normalize.test.js',
      'eep-bridge-worker/test/github-signature.test.js',
      'eep-bridge-worker/test/sse.test.js',
      'reirei-harness/test/agentAssignment.test.ts',
      'reirei-harness/test/agentRunner.test.ts',
      'reirei-harness/test/agentTaskCompletion.test.ts',
      'reirei-harness/test/agentTimeline.test.ts',
      'reirei-harness/test/autoMerge.test.ts',
      'reirei-harness/test/changeRequest.test.ts',
      'reirei-harness/test/checkFailure.test.ts',
      'reirei-harness/test/cloudflareIssueReporter.test.ts',
      'reirei-harness/test/codexCleanAutoMerge.test.ts',
      'reirei-harness/test/codexReview.test.ts',
      'reirei-harness/test/config.test.ts',
      'reirei-harness/test/conflictCheck.test.ts',
      'reirei-harness/test/dashboard.test.ts',
      'reirei-harness/test/githubAuth.test.ts',
      'reirei-harness/test/githubProject.test.ts',
      'reirei-harness/test/githubPullRequest.test.ts',
      'reirei-harness/test/matcher.test.ts',
      'reirei-harness/test/mentionDraft.test.ts',
      'reirei-harness/test/projectIssues.test.ts',
      'reirei-harness/test/reviewRequest.test.ts',
      'reirei-harness/test/router.test.ts',
      'reirei-harness/test/runner.test.ts',
      'reirei-harness/test/store.test.ts',
    ]) {
      expect(matrix, originalTest).toContain(`\`${originalTest}\``);
    }

    for (const rainrailTest of rainrailTestPaths) {
      expect(matrix, rainrailTest).toContain(`\`${rainrailTest}\``);
      expect(existsSync(new URL(`../${rainrailTest}`, import.meta.url)), rainrailTest).toBe(true);
    }

    expect(validateCoverageRows(matrix)).toEqual([]);
    expect(matrix).toContain('Not ported as a separate Rainrail workflow');
  });

  it('points Rainrail module references at files that exist in this repository', () => {
    expect(rainrailSourcePaths.length).toBeGreaterThan(0);

    for (const rainrailSource of rainrailSourcePaths) {
      expect(existsSync(new URL(`../${rainrailSource}`, import.meta.url)), rainrailSource).toBe(true);
    }
  });

  it('rejects coverage rows whose Rainrail coverage column has no test or alternate status', () => {
    const brokenMatrix = [
      '| Original test | Original viewpoint | Rainrail package/module | Rainrail test coverage | Status and notes |',
      '| --- | --- | --- | --- | --- |',
      '| `source/test/missing.test.ts` | Missing mapping. | `src/index.ts` |  | Ported. |',
    ].join('\n');

    expect(validateCoverageRows(brokenMatrix)).toContain(
      'source/test/missing.test.ts must map to a Rainrail test or explicit alternate/not ported status',
    );
  });

  it('links the matrix from the README', () => {
    expect(readme).toContain('[docs/repo-test-coverage-matrix.md](docs/repo-test-coverage-matrix.md)');
  });
});
