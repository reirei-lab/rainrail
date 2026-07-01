import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

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
const getExportedDeclarationKind = (sourceText, publicExport) => {
  const sourceFile = ts.createSourceFile(
    'contract.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    const kind = statementExportKind(statement, publicExport);
    if (kind !== undefined) {
      return kind;
    }
  }

  return undefined;
};

/**
 * @param {string} sourceText
 * @param {string} publicExport
 */
const hasExportedDeclaration = (sourceText, publicExport) =>
  getExportedDeclarationKind(sourceText, publicExport) !== undefined;

/**
 * @param {string} docsText
 * @param {string} publicExport
 */
const docsMentionPublicExport = (docsText, publicExport) => {
  const tokenPattern = new RegExp(
    String.raw`(^|[^A-Za-z0-9_$])${escapeRegExp(publicExport)}([^A-Za-z0-9_$]|$)`,
    'u',
  );

  for (const match of docsText.matchAll(/`([^`]+)`/gu)) {
    if (tokenPattern.test(match[1] ?? '')) {
      return true;
    }
  }

  return false;
};

/**
 * @param {string} indexSource
 * @param {string} exportPath
 */
const indexExportsModule = (indexSource, exportPath) => {
  const sourceFile = ts.createSourceFile(
    'index.ts',
    indexSource,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  return sourceFile.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === exportPath,
  );
};

/**
 * @param {string} indexSource
 * @param {string} exportPath
 * @param {string} publicExport
 * @param {'type' | 'value'} exportKind
 */
const indexReExportsPublicName = (indexSource, exportPath, publicExport, exportKind) => {
  const sourceFile = ts.createSourceFile(
    'index.ts',
    indexSource,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  return sourceFile.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== exportPath
    ) {
      return false;
    }

    if (statement.exportClause === undefined) {
      return true;
    }

    if (exportKind === 'value' && statement.isTypeOnly) {
      return false;
    }

    return (
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (specifier) =>
          specifier.name.text === publicExport &&
          !(exportKind === 'value' && specifier.isTypeOnly),
      )
    );
  });
};

/**
 * @param {import('typescript').Statement} statement
 * @param {string} publicExport
 * @returns {'type' | 'value' | undefined}
 */
const statementExportKind = (statement, publicExport) => {
  if (ts.isExportDeclaration(statement)) {
    const exportClause = statement.exportClause;
    if (exportClause === undefined || !ts.isNamedExports(exportClause)) {
      return undefined;
    }

    const specifier = exportClause.elements.find(
      (element) => element.name.text === publicExport,
    );
    if (specifier === undefined) {
      return undefined;
    }

    return statement.isTypeOnly || specifier.isTypeOnly ? 'type' : 'value';
  }

  if (!hasExportModifier(statement)) {
    return undefined;
  }

  if (hasDefaultModifier(statement)) {
    return undefined;
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === publicExport,
    )
      ? 'value'
      : undefined;
  }

  if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === publicExport ? 'value' : undefined;
  }

  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return statement.name.text === publicExport ? 'type' : undefined;
  }

  return undefined;
};

/**
 * @param {import('typescript').Node} node
 */
const hasExportModifier = (node) =>
  hasModifier(node, ts.SyntaxKind.ExportKeyword);

/**
 * @param {import('typescript').Node} node
 */
const hasDefaultModifier = (node) =>
  hasModifier(node, ts.SyntaxKind.DefaultKeyword);

/**
 * @param {import('typescript').Node} node
 * @param {import('typescript').SyntaxKind} kind
 */
const hasModifier = (node, kind) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === kind,
  ) ??
    false);

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
 * @typedef {{
 *   resolve: (...paths: string[]) => string;
 *   relative: (from: string, to: string) => string;
 *   isAbsolute: (path: string) => boolean;
 * }} PathTools
 */

/**
 * @param {string} root
 * @param {string} path
 * @param {PathTools} [pathTools]
 */
export const isPathInsideRoot = (
  root,
  path,
  pathTools = { resolve, relative, isAbsolute },
) => {
  const absoluteRoot = pathTools.resolve(root);
  const absolutePath = pathTools.resolve(root, path);
  const relativeToRoot = pathTools.relative(absoluteRoot, absolutePath);

  return (
    relativeToRoot === '' ||
    (!relativeToRoot.startsWith('..') && !pathTools.isAbsolute(relativeToRoot))
  );
};

/**
 * @param {string} root
 * @param {string} path
 */
const projectPathExists = (root, path) =>
  isPathInsideRoot(root, path) && existsSync(resolve(root, path));

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
    const sourceEntries = sources
      .filter((path) => projectPathExists(root, path))
      .map((path) => ({
        path,
        text: readText(root, path),
        exportPath:
          path.startsWith('src/') && path.endsWith('.ts')
            ? `./${path.slice('src/'.length, -'.ts'.length)}.js`
            : undefined,
      }));

    for (const source of sources) {
      if (!source.startsWith('src/') || !source.endsWith('.ts')) {
        continue;
      }

      const exportPath = `./${source.slice('src/'.length, -'.ts'.length)}.js`;
      if (!indexExportsModule(indexSource, exportPath)) {
        errors.push(`${id} source is not exported from src/index.ts: ${source}`);
      }
    }

    for (const publicExport of publicExports) {
      const exportingSources = sourceEntries.filter((source) =>
        hasExportedDeclaration(source.text, publicExport),
      ).map((source) => ({
        ...source,
        exportKind: getExportedDeclarationKind(source.text, publicExport),
      }));

      if (exportingSources.length === 0) {
        errors.push(`${id} public export ${publicExport} is not exported by its sources`);
      }

      if (
        exportingSources.length > 0 &&
        !exportingSources.some(
          (source) =>
            source.exportPath !== undefined &&
            source.exportKind !== undefined &&
            indexReExportsPublicName(indexSource, source.exportPath, publicExport, source.exportKind),
        )
      ) {
        errors.push(`${id} public export ${publicExport} is not re-exported from src/index.ts`);
      }

      if (!docsMentionPublicExport(docsText, publicExport)) {
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
