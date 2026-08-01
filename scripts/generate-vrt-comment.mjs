import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   before: string;
 *   after: string;
 *   diff: string;
 * }} VrtSummaryCase
 *
 * @typedef {{
 *   changed: boolean;
 *   totalChanged: number;
 *   cases: VrtSummaryCase[];
 * }} VrtSummary
 */

/**
 * @param {VrtSummary} summary
 * @param {{ maxCases?: number }} [options]
 * @returns {string}
 */
export function generateVrtComment(summary, options = {}) {
  const maxCases = options.maxCases ?? 10;

  if (!summary.changed || summary.totalChanged === 0) {
    return [
      '## VRT 差分',
      '',
      'visual regression は検出されませんでした。',
      '',
      '全結果は GitHub Actions artifact を参照してください。',
      '',
    ].join('\n');
  }

  const cases = summary.cases.slice(0, maxCases);
  const hiddenCount = Math.max(0, summary.totalChanged - cases.length);
  const lines = [
    '## VRT 差分',
    '',
    `${summary.totalChanged}件の visual regression を検出しました。`,
    '',
  ];

  for (const caseItem of cases) {
    lines.push(
      `### ${caseItem.title}`,
      '',
      '| before | after | diff |',
      '| --- | --- | --- |',
      `| ![](${markdownPath(caseItem.before)}) | ![](${markdownPath(caseItem.after)}) | ![](${markdownPath(caseItem.diff)}) |`,
      '',
    );
  }

  if (hiddenCount > 0) {
    lines.push(`ほか ${hiddenCount} 件は GitHub Actions artifact を参照してください。`, '');
  }

  lines.push('全結果は GitHub Actions artifact を参照してください。', '');
  return lines.join('\n');
}

/**
 * @param {{ summaryPath: string; outputPath: string; maxCases?: number }} input
 * @returns {Promise<void>}
 */
export async function writeVrtComment(input) {
  const summary = JSON.parse(await readFile(input.summaryPath, 'utf8'));
  const options = input.maxCases === undefined ? {} : { maxCases: input.maxCases };
  await writeFile(input.outputPath, generateVrtComment(summary, options));
}

/**
 * @param {string} path
 * @returns {string}
 */
function markdownPath(path) {
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * @param {string[]} argv
 * @returns {{ summaryPath: string; outputPath: string; maxCases: number }}
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  const maxCases = Number.parseInt(args.get('--max-cases') ?? '10', 10);
  return {
    summaryPath: args.get('--summary') ?? 'vrt-results/summary.json',
    outputPath: args.get('--output') ?? 'vrt-comment.md',
    maxCases: Number.isFinite(maxCases) && maxCases > 0 ? maxCases : 10,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeVrtComment(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
