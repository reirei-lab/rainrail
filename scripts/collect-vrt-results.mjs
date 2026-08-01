import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   status?: 'missing-baseline' | 'missing-diff';
 *   before?: string;
 *   after: string;
 *   diff?: string;
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

  /** @type {VrtSummaryCase[]} */
  const cases = [];
  for (const actual of actualFiles) {
    const base = actual.slice(0, -'-actual.png'.length);
    const expected = `${base}-expected.png`;
    const diff = `${base}-diff.png`;

    const id = uniqueCaseId(cases, slugify(basename(base)));
    const caseDir = join(outputDir, id);
    const hasExpected = await fileExists(expected);
    const hasDiff = await fileExists(diff);
    await mkdir(caseDir, { recursive: true });
    await copyFile(actual, join(caseDir, 'after.png'));
    if (hasExpected) {
      await copyFile(expected, join(caseDir, 'before.png'));
    }
    if (hasDiff) {
      await copyFile(diff, join(caseDir, 'diff.png'));
    }

    /** @type {VrtSummaryCase} */
    const caseItem = {
      id,
      title: titleFromId(id),
      after: posixPath(relative(dirname(outputDir), join(caseDir, 'after.png'))),
    };

    if (hasExpected) {
      caseItem.before = posixPath(relative(dirname(outputDir), join(caseDir, 'before.png')));
    } else {
      caseItem.status = 'missing-baseline';
    }

    if (hasDiff) {
      caseItem.diff = posixPath(relative(dirname(outputDir), join(caseDir, 'diff.png')));
    } else if (hasExpected) {
      caseItem.status = 'missing-diff';
    }

    cases.push(caseItem);
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
    if (!(await fileExists(input.reportPath))) {
      throw new Error(`Playwright JSON report was not found: ${input.reportPath}`);
    }
    return unexpectedActualFilesFromReport(input.reportPath);
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
  const filesBySnapshot = new Map();

  for (const entry of collectReportTestEntries(report)) {
    if (!isRecord(entry.test) || entry.test.status !== 'unexpected' || !Array.isArray(entry.test.results)) {
      continue;
    }

    for (const result of entry.test.results) {
      if (!isRecord(result) || !Array.isArray(result.attachments)) {
        continue;
      }

      for (const attachment of result.attachments) {
        if (!isRecord(attachment) || typeof attachment.path !== 'string') {
          continue;
        }

        const attachmentPath = resolveAttachmentPath(reportPath, attachment.path);
        if (basename(attachmentPath).endsWith('-actual.png') && await fileExists(attachmentPath)) {
          filesBySnapshot.set(snapshotKey(entry.identity, attachment, attachmentPath), attachmentPath);
        }
      }
    }
  }

  return [...filesBySnapshot.values()];
}

/**
 * @param {string[]} testIdentity
 * @param {Record<string, unknown>} attachment
 * @param {string} actualPath
 * @returns {string}
 */
function snapshotKey(testIdentity, attachment, actualPath) {
  const attachmentName = typeof attachment.name === 'string'
    ? attachment.name
    : basename(actualPath);
  return [
    ...testIdentity,
    attachmentName.replace(/-actual$/u, '').replace(/-actual\.png$/u, ''),
  ].join('\u0000');
}

/**
 * @param {unknown} node
 * @param {string[]} [parents]
 * @returns {Array<{ test: unknown; identity: string[] }>}
 */
function collectReportTestEntries(node, parents = []) {
  if (!isRecord(node)) {
    return [];
  }

  const ownTitle = titleSegment(node);
  const nextParents = ownTitle === undefined ? parents : [...parents, ownTitle];
  const ownTests = Array.isArray(node.tests)
    ? node.tests.map((test) => ({
      test,
      identity: [...nextParents, ...testTitleSegments(test)],
    }))
    : [];
  const childNodes = ['suites', 'specs'].flatMap((key) => Array.isArray(node[key]) ? node[key] : []);
  return [
    ...ownTests,
    ...childNodes.flatMap((child) => collectReportTestEntries(child, nextParents)),
  ];
}

/**
 * @param {Record<string, unknown>} node
 * @returns {string | undefined}
 */
function titleSegment(node) {
  const file = typeof node.file === 'string' ? node.file : undefined;
  const title = typeof node.title === 'string' ? node.title : undefined;
  if (file !== undefined && title !== undefined && file !== title) {
    return `${file}: ${title}`;
  }
  return title ?? file;
}

/**
 * @param {unknown} test
 * @returns {string[]}
 */
function testTitleSegments(test) {
  if (!isRecord(test)) {
    return [];
  }
  if (typeof test.title === 'string') {
    return [test.title];
  }
  return [];
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
