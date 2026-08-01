import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
 * @param {{ resultsDir: string; outputDir: string; reportPath?: string }} input
 * @returns {Promise<VrtSummary>}
 */
export async function collectVrtResults(input) {
  const resultsDir = resolve(input.resultsDir);
  const outputDir = resolve(input.outputDir);
  const summaryPath = join(outputDir, 'summary.json');
  const actualFiles = await actualFilesForCollection({
    resultsDir,
    ...(input.reportPath === undefined ? {} : { reportPath: resolve(input.reportPath) }),
  });

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const cases = [];
  for (const actual of actualFiles) {
    const base = actual.slice(0, -'-actual.png'.length);
    const expected = `${base}-expected.png`;
    const diff = `${base}-diff.png`;

    if (!(await fileExists(expected)) || !(await fileExists(diff))) {
      continue;
    }

    const id = uniqueCaseId(cases, slugify(basename(base)));
    const caseDir = join(outputDir, id);
    await mkdir(caseDir, { recursive: true });
    await copyFile(expected, join(caseDir, 'before.png'));
    await copyFile(actual, join(caseDir, 'after.png'));
    await copyFile(diff, join(caseDir, 'diff.png'));

    cases.push({
      id,
      title: titleFromId(id),
      before: posixPath(relative(dirname(outputDir), join(caseDir, 'before.png'))),
      after: posixPath(relative(dirname(outputDir), join(caseDir, 'after.png'))),
      diff: posixPath(relative(dirname(outputDir), join(caseDir, 'diff.png'))),
    });
  }

  const summary = {
    changed: cases.length > 0,
    totalChanged: cases.length,
    cases,
  };

  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/**
 * @param {{ resultsDir: string; reportPath?: string }} input
 * @returns {Promise<string[]>}
 */
async function actualFilesForCollection(input) {
  if (input.reportPath !== undefined) {
    return await fileExists(input.reportPath)
      ? unexpectedActualFilesFromReport(input.reportPath)
      : [];
  }

  return (await findFiles(input.resultsDir))
    .filter((file) => basename(file).endsWith('-actual.png'))
    .sort();
}

/**
 * @param {string} reportPath
 * @returns {Promise<string[]>}
 */
async function unexpectedActualFilesFromReport(reportPath) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const files = new Set();

  for (const test of collectReportTests(report)) {
    if (!isRecord(test) || test.status !== 'unexpected' || !Array.isArray(test.results)) {
      continue;
    }

    for (const result of test.results) {
      if (!isRecord(result) || !Array.isArray(result.attachments)) {
        continue;
      }

      for (const attachment of result.attachments) {
        if (!isRecord(attachment) || typeof attachment.path !== 'string') {
          continue;
        }

        const attachmentPath = resolveAttachmentPath(reportPath, attachment.path);
        if (basename(attachmentPath).endsWith('-actual.png') && await fileExists(attachmentPath)) {
          files.add(attachmentPath);
        }
      }
    }
  }

  return [...files].sort();
}

/**
 * @param {unknown} node
 * @returns {unknown[]}
 */
function collectReportTests(node) {
  if (!isRecord(node)) {
    return [];
  }

  const ownTests = Array.isArray(node.tests) ? node.tests : [];
  const childNodes = ['suites', 'specs'].flatMap((key) => Array.isArray(node[key]) ? node[key] : []);
  return [
    ...ownTests,
    ...childNodes.flatMap((child) => collectReportTests(child)),
  ];
}

/**
 * @param {string} reportPath
 * @param {string} attachmentPath
 * @returns {string}
 */
function resolveAttachmentPath(reportPath, attachmentPath) {
  return isAbsolute(attachmentPath)
    ? attachmentPath
    : resolve(dirname(reportPath), attachmentPath);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function findFiles(root) {
  if (!(await fileExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return findFiles(path);
    }
    return entry.isFile() ? [path] : [];
  }));
  return files.flat();
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'case';
}

/**
 * @param {VrtSummaryCase[]} cases
 * @param {string} baseId
 * @returns {string}
 */
function uniqueCaseId(cases, baseId) {
  if (!cases.some((caseItem) => caseItem.id === baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (cases.some((caseItem) => caseItem.id === `${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

/**
 * @param {string} id
 * @returns {string}
 */
function titleFromId(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/**
 * @param {string} path
 * @returns {string}
 */
function posixPath(path) {
  return path.split('\\').join('/');
}

/**
 * @param {string[]} argv
 * @returns {{ resultsDir: string; outputDir: string; reportPath?: string }}
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  const reportPath = args.get('--report');
  return {
    resultsDir: args.get('--results-dir') ?? 'test-results/dashboard',
    outputDir: args.get('--output-dir') ?? 'vrt-results',
    ...(reportPath === undefined ? {} : { reportPath }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectVrtResults(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
