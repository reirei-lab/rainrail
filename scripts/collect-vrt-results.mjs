import { access, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   status?: 'missing-baseline' | 'missing-diff' | 'screenshot-timeout' | 'vrt-test-failed';
 *   before?: string;
 *   after?: string;
 *   diff?: string;
 * }} VrtSummaryCase
 *
 * @typedef {{
 *   key: string;
 *   idHint: string;
 *   status?: 'missing-baseline' | 'screenshot-timeout' | 'vrt-test-failed';
 *   actualPath?: string;
 *   expectedPath?: string;
 *   diffPath?: string;
 * }} VrtCandidate
 *
 * @typedef {{
 *   changed: boolean;
 *   totalChanged: number;
 *   cases: VrtSummaryCase[];
 * }} VrtSummary
 */

/**
 * @param {{ resultsDir: string; outputDir: string; reportPath?: string; artifactRoot?: string }} input
 * @returns {Promise<VrtSummary>}
 */
export async function collectVrtResults(input) {
  const resultsDir = resolve(input.resultsDir);
  const outputDir = resolve(input.outputDir);
  const artifactRoot = input.artifactRoot === undefined ? undefined : resolve(input.artifactRoot);
  const summaryPath = join(outputDir, 'summary.json');
  const candidates = await candidatesForCollection({
    resultsDir,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
    ...(input.reportPath === undefined ? {} : { reportPath: resolve(input.reportPath) }),
  });

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  /** @type {VrtSummaryCase[]} */
  const cases = [];
  for (const candidate of candidates) {
    const id = uniqueCaseId(cases, slugify(candidate.idHint));
    if (candidate.actualPath === undefined) {
      cases.push({
        id,
        title: titleFromId(id),
        status: candidate.status ?? 'missing-baseline',
      });
      continue;
    }

    const actual = candidate.actualPath;
    const base = actual.slice(0, -'-actual.png'.length);
    const expected = candidate.expectedPath ?? `${base}-expected.png`;
    const diff = candidate.diffPath ?? `${base}-diff.png`;

    const caseDir = join(outputDir, id);
    const hasExpected = await fileExists(expected);
    const hasDiff = await fileExists(diff);
    await mkdir(caseDir, { recursive: true });
    await copyRegularFile(actual, join(caseDir, 'after.png'));
    if (hasExpected) {
      await copyRegularFile(expected, join(caseDir, 'before.png'));
    }
    if (hasDiff) {
      await copyRegularFile(diff, join(caseDir, 'diff.png'));
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
 * @param {{ resultsDir: string; reportPath?: string; artifactRoot?: string }} input
 * @returns {Promise<VrtCandidate[]>}
 */
async function candidatesForCollection(input) {
  if (input.reportPath !== undefined) {
    if (!(await fileExists(input.reportPath))) {
      throw new Error(`Playwright JSON report was not found: ${input.reportPath}`);
    }
    return unexpectedCandidatesFromReport(input.reportPath, input.artifactRoot);
  }

  const actualFiles = (await findFiles(input.resultsDir))
    .filter((file) => basename(file).endsWith('-actual.png'))
    .sort();
  return actualFiles.map((actualPath) => {
    const base = actualPath.slice(0, -'-actual.png'.length);
    return {
      key: actualPath,
      idHint: basename(base),
      actualPath,
    };
  });
}

/**
 * @param {string} reportPath
 * @param {string | undefined} artifactRoot
 * @returns {Promise<VrtCandidate[]>}
 */
async function unexpectedCandidatesFromReport(reportPath, artifactRoot) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  /** @type {Map<string, VrtCandidate>} */
  const candidatesBySnapshot = new Map();

  for (const entry of collectReportTestEntries(report)) {
    if (!isRecord(entry.test) || entry.test.status !== 'unexpected' || !Array.isArray(entry.test.results)) {
      continue;
    }

    const result = entry.test.results.findLast(isRecord);
    if (result === undefined) {
      continue;
    }

    let actualAttachmentCount = 0;
    const attachments = Array.isArray(result.attachments) ? result.attachments : [];
    /** @type {Map<string, VrtCandidate>} */
    const resultCandidates = new Map();
    for (const attachment of attachments) {
      if (!isRecord(attachment) || typeof attachment.path !== 'string') {
        continue;
      }

      const attachmentPath = resolveAttachmentPath(reportPath, attachment.path, artifactRoot);
      if (artifactRoot !== undefined && !isWithinRoot(artifactRoot, attachmentPath)) {
        continue;
      }
      if (!(await fileExists(attachmentPath))) {
        continue;
      }

      const kind = attachmentKind(attachment, attachmentPath);
      if (kind === undefined) {
        continue;
      }

      const key = snapshotKey(entry.identity, attachment, attachmentPath);
      const candidate = resultCandidates.get(key) ?? {
        key,
        idHint: snapshotIdHint(attachment, attachmentPath),
      };
      if (kind === 'actual') {
        actualAttachmentCount += 1;
        candidate.actualPath = attachmentPath;
      } else if (kind === 'expected') {
        candidate.expectedPath = attachmentPath;
      } else {
        candidate.diffPath = attachmentPath;
      }
      resultCandidates.set(key, candidate);
    }

    for (const [key, candidate] of resultCandidates) {
      if (candidate.actualPath !== undefined) {
        candidatesBySnapshot.set(key, candidate);
      }
    }

    if (actualAttachmentCount === 0 && hasMissingBaselineError(result)) {
      const idHint = missingBaselineIdHint(result) ?? entry.identity.at(-1) ?? 'missing-baseline';
      const key = [...entry.identity, idHint, 'missing-baseline'].join('\u0000');
      candidatesBySnapshot.set(key, {
        key,
        idHint,
        status: 'missing-baseline',
      });
    } else if (actualAttachmentCount === 0 && hasScreenshotComparisonError(result)) {
      const idHint = screenshotErrorIdHint(result) ?? entry.identity.at(-1) ?? 'screenshot-timeout';
      const key = [...entry.identity, idHint, 'screenshot-timeout'].join('\u0000');
      candidatesBySnapshot.set(key, {
        key,
        idHint,
        status: 'screenshot-timeout',
      });
    } else if (actualAttachmentCount === 0) {
      const idHint = entry.identity.at(-1) ?? 'vrt-test-failed';
      const key = [...entry.identity, idHint, 'vrt-test-failed'].join('\u0000');
      candidatesBySnapshot.set(key, {
        key,
        idHint,
        status: 'vrt-test-failed',
      });
    }
  }

  return [...candidatesBySnapshot.values()];
}

/**
 * @param {string[]} testIdentity
 * @param {Record<string, unknown>} attachment
 * @param {string} actualPath
 * @returns {string}
 */
function snapshotKey(testIdentity, attachment, actualPath) {
  return [
    ...testIdentity,
    snapshotIdHint(attachment, actualPath),
  ].join('\u0000');
}

/**
 * @param {Record<string, unknown>} attachment
 * @param {string} attachmentPath
 * @returns {string}
 */
function snapshotIdHint(attachment, attachmentPath) {
  const attachmentName = typeof attachment.name === 'string' && !['actual', 'expected', 'diff'].includes(attachment.name.toLowerCase())
    ? attachment.name
    : basename(attachmentPath);
  return attachmentName
    .replace(/\.png$/u, '')
    .replace(/-(actual|expected|diff)$/u, '');
}

/**
 * @param {Record<string, unknown>} attachment
 * @param {string} attachmentPath
 * @returns {'actual' | 'expected' | 'diff' | undefined}
 */
function attachmentKind(attachment, attachmentPath) {
  const attachmentName = typeof attachment.name === 'string' ? attachment.name.toLowerCase() : '';
  const filename = basename(attachmentPath).toLowerCase();
  if (attachmentName === 'actual' || attachmentName.endsWith('-actual') || filename.endsWith('-actual.png')) {
    return 'actual';
  }
  if (attachmentName === 'expected' || attachmentName.endsWith('-expected') || filename.endsWith('-expected.png')) {
    return 'expected';
  }
  if (attachmentName === 'diff' || attachmentName.endsWith('-diff') || filename.endsWith('-diff.png')) {
    return 'diff';
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} result
 * @returns {boolean}
 */
function hasMissingBaselineError(result) {
  return errorMessages(result).some((message) => /snapshot(?:\s+file)?(?: doesn't| does not| to be) exist|snapshot.*missing|is missing in snapshots/u.test(message));
}

/**
 * @param {Record<string, unknown>} result
 * @returns {boolean}
 */
function hasScreenshotComparisonError(result) {
  return errorMessages(result).some((message) => /toHaveScreenshot|toMatchSnapshot|screenshot|snapshot/u.test(message) && /timed?\s*out|timeout|exceeded|failed/u.test(message));
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string | undefined}
 */
function missingBaselineIdHint(result) {
  return screenshotErrorIdHint(result);
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string | undefined}
 */
function screenshotErrorIdHint(result) {
  for (const message of errorMessages(result)) {
    const matches = [...message.matchAll(/([A-Za-z0-9_.-]+)\.png\b/gu)];
    const snapshotName = matches.at(-1)?.[1];
    if (snapshotName !== undefined) {
      return snapshotName.replace(/-(actual|expected|diff)$/u, '');
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function errorMessages(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => errorMessages(entry));
  }
  if (!isRecord(value)) {
    return [];
  }

  return ['message', 'error', 'errors']
    .flatMap((key) => errorMessages(value[key]));
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
 * @param {string | undefined} artifactRoot
 * @returns {string}
 */
function resolveAttachmentPath(reportPath, attachmentPath, artifactRoot) {
  if (artifactRoot !== undefined) {
    const artifactRelativePath = artifactRelativeAttachmentPath(attachmentPath);
    if (artifactRelativePath !== undefined) {
      return resolve(artifactRoot, artifactRelativePath);
    }
  }

  if (!isAbsolute(attachmentPath)) {
    return resolve(dirname(reportPath), attachmentPath);
  }

  return attachmentPath;
}

/**
 * @param {string} attachmentPath
 * @returns {string | undefined}
 */
function artifactRelativeAttachmentPath(attachmentPath) {
  const normalized = `/${posixPath(attachmentPath)}`;
  for (const segment of ['/test-results/', '/e2e/']) {
    const index = normalized.indexOf(segment);
    if (index !== -1) {
      return normalized.slice(index + 1);
    }
  }
  return undefined;
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
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
function isWithinRoot(root, path) {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function copyRegularFile(source, destination) {
  const stat = await lstat(source);
  if (!stat.isFile()) {
    throw new Error(`VRT artifact is not a regular file: ${source}`);
  }
  await copyFile(source, destination);
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
 * @returns {{ resultsDir: string; outputDir: string; reportPath?: string; artifactRoot?: string }}
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  const reportPath = args.get('--report');
  const artifactRoot = args.get('--artifact-root');
  return {
    resultsDir: args.get('--results-dir') ?? 'test-results/dashboard',
    outputDir: args.get('--output-dir') ?? 'vrt-results',
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectVrtResults(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
