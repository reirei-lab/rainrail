import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = 'docs/contracts.manifest.json';

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * @param {string} path
 */
const toPosix = (path) => path.split('\\').join('/');

/**
 * @param {string} root
 * @param {string} path
 */
const relativePath = (root, path) => toPosix(relative(root, path));

/**
 * @param {string} root
 * @param {string} path
 */
const readText = (root, path) => readFileSync(join(root, path), 'utf8');

/**
 * @param {string} value
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} sourceText
 * @param {string} publicExport
 */
const hasExportedDeclaration = (sourceText, publicExport) => {
  const escaped = escapeRegExp(publicExport);
  const declarationPattern = new RegExp(
    String.raw`\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|function|const|let|var|enum)\s+${escaped}\b`,
    'u',
  );
  const namedExportPattern = new RegExp(
    String.raw`\bexport\s*\{[^}]*\b${escaped}\b(?:\s+as\s+\w+)?[^}]*\}`,
    'u',
  );

  return declarationPattern.test(sourceText) || namedExportPattern.test(sourceText);
};

/**
 * @param {string} root
 * @param {string} dir
 * @param {Set<string>} extensions
 * @returns {string[]}
 */
const walkFiles = (root, dir, extensions) => {
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir)) {
    return [];
  }

  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry.name);
    const projectPath = relativePath(root, absolutePath);

    if (entry.isDirectory()) {
      return walkFiles(root, projectPath, extensions);
    }

    return extensions.has(extname(entry.name)) ? [projectPath] : [];
  });
};

/**
 * @param {string} root
 * @param {string} path
 */
const projectPathExists = (root, path) => {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, path);

  return (
    (absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`)) &&
    existsSync(absolutePath)
  );
};

/**
 * @param {string} root
 * @returns {Array<{
 *   id?: string;
 *   sources?: string[];
 *   docs?: string[];
 *   tests?: string[];
 *   publicExports?: string[];
 * }>}
 */
const readManifest = (root) => {
  const raw = readText(root, manifestPath);
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.contracts)) {
    throw new Error(`${manifestPath} must contain a contracts array`);
  }

  return parsed.contracts;
};

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export const validateMarkdownLinks = (root = repoRoot) => {
  const errors = [];
  const markdownFiles = ['README.md', ...walkFiles(root, 'docs', new Set(['.md']))].filter(
    (path, index, files) => files.indexOf(path) === index && projectPathExists(root, path),
  );
  const linkPattern = /(?<!!)\[[^\]]+\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const file of markdownFiles) {
    const content = readText(root, file);
    const baseDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';

    for (const match of content.matchAll(linkPattern)) {
      const target = match.groups?.target;
      if (!target || target.startsWith('#')) {
        continue;
      }

      if (/^(https?:|mailto:|github:|cloudflare:)/.test(target)) {
        continue;
      }

      const targetPath = decodeURI(target.split('#')[0]?.split('?')[0] ?? '');
      if (!targetPath) {
        continue;
      }

      const resolved = normalize(join(baseDir, targetPath));
      if (!projectPathExists(root, resolved)) {
        errors.push(`${file} links to missing path ${toPosix(resolved)}`);
      }
    }
  }

  return errors;
};

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export const validateContractsManifest = (root = repoRoot) => {
  const errors = [];
  const contracts = readManifest(root);
  const indexSource = projectPathExists(root, 'src/index.ts')
    ? readText(root, 'src/index.ts')
    : '';

  for (const contract of contracts) {
    const id = contract.id ?? '<missing id>';
    const sources = contract.sources ?? [];
    const docs = contract.docs ?? [];
    const tests = contract.tests ?? [];
    const publicExports = contract.publicExports ?? [];

    if (!id || typeof id !== 'string') {
      errors.push('contract is missing a string id');
    }

    for (const [field, paths] of [
      ['sources', sources],
      ['docs', docs],
      ['tests', tests],
    ]) {
      if (!Array.isArray(paths) || paths.length === 0) {
        errors.push(`${id} must list at least one ${field} path`);
        continue;
      }

      for (const path of paths) {
        if (!projectPathExists(root, path)) {
          errors.push(`${id} ${field} path does not exist: ${path}`);
        }
      }
    }

    const docsText = docs
      .filter((path) => projectPathExists(root, path))
      .map((path) => readText(root, path))
      .join('\n');
    const sourceText = sources
      .filter((path) => projectPathExists(root, path))
      .map((path) => readText(root, path))
      .join('\n');

    for (const source of sources) {
      if (!source.startsWith('src/') || !source.endsWith('.ts')) {
        continue;
      }

      const exportPath = `./${source.slice('src/'.length, -'.ts'.length)}.js`;
      if (!indexSource.includes(`'${exportPath}'`) && !indexSource.includes(`"${exportPath}"`)) {
        errors.push(`${id} source is not exported from src/index.ts: ${source}`);
      }
    }

    for (const publicExport of publicExports) {
      if (!hasExportedDeclaration(sourceText, publicExport)) {
        errors.push(`${id} public export ${publicExport} is not exported by its sources`);
      }

      if (!docsText.includes(publicExport)) {
        errors.push(`${id} public export ${publicExport} is not mentioned by its docs`);
      }
    }
  }

  return errors;
};

/**
 * @param {string} [root]
 * @param {string[]} [changedFiles]
 * @returns {string[]}
 */
export const validateChangedFiles = (root = repoRoot, changedFiles = []) => {
  const errors = [];
  const contracts = readManifest(root);
  const changed = new Set(changedFiles.map(toPosix));

  for (const contract of contracts) {
    const sources = contract.sources ?? [];
    const docs = contract.docs ?? [];
    const tests = contract.tests ?? [];
    const changedSources = sources.filter((path) => changed.has(path));

    if (changedSources.length === 0) {
      continue;
    }

    const hasMatchingDocsOrTests = [...docs, ...tests].some((path) => changed.has(path));
    if (!hasMatchingDocsOrTests) {
      errors.push(
        `${contract.id} source changed without matching docs or tests: ${changedSources.join(', ')}`,
      );
    }
  }

  return errors;
};

/**
 * @param {string} baseRef
 * @returns {string[]}
 */
const changedFilesFromGit = (baseRef) => {
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output.split('\n').filter(Boolean);
};

const main = () => {
  const changedFromIndex = process.argv.indexOf('--changed-from');
  const changedFrom =
    changedFromIndex === -1 ? process.env.DOCS_DRIFT_CHANGED_FROM : process.argv[changedFromIndex + 1];
  const errors = [
    ...validateMarkdownLinks(repoRoot),
    ...validateContractsManifest(repoRoot),
    ...(changedFrom ? validateChangedFiles(repoRoot, changedFilesFromGit(changedFrom)) : []),
  ];

  if (errors.length > 0) {
    console.error('Docs drift check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Docs drift check passed.');
};

if (isCli) {
  main();
}
