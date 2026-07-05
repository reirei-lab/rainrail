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
 * @param {(moduleSpecifier: string, publicExport: string) => 'type' | 'value' | undefined | null} [resolveModuleExportKind]
 */
const getExportedDeclarationKind = (
  sourceText,
  publicExport,
  resolveModuleExportKind = () => null,
) => {
  const sourceFile = ts.createSourceFile(
    'contract.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    const kind = statementExportKind(sourceFile, statement, publicExport, resolveModuleExportKind);
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

    if (exportKind === 'value' && statement.isTypeOnly) {
      return false;
    }

    if (statement.exportClause === undefined) {
      return true;
    }

    return (
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (specifier) =>
          specifier.name.text === publicExport &&
          (specifier.propertyName?.text ?? specifier.name.text) === publicExport &&
          !(exportKind === 'value' && specifier.isTypeOnly),
      )
    );
  });
};

/**
 * @param {import('typescript').SourceFile} sourceFile
 * @param {import('typescript').Statement} statement
 * @param {string} publicExport
 * @param {(moduleSpecifier: string, publicExport: string) => 'type' | 'value' | undefined | null} resolveModuleExportKind
 * @returns {'type' | 'value' | undefined}
 */
const statementExportKind = (sourceFile, statement, publicExport, resolveModuleExportKind) => {
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

    if (statement.isTypeOnly || specifier.isTypeOnly) {
      return 'type';
    }

    if (statement.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) {
        return undefined;
      }

      const resolvedKind = resolveModuleExportKind(
        statement.moduleSpecifier.text,
        specifier.propertyName?.text ?? specifier.name.text,
      );
      return resolvedKind === null ? 'value' : resolvedKind;
    }

    return localBindingKind(
      sourceFile,
      specifier.propertyName?.text ?? specifier.name.text,
    );
  }

  if (!hasExportModifier(statement)) {
    return undefined;
  }

  if (hasDefaultModifier(statement)) {
    return undefined;
  }

  return directDeclarationKind(statement, publicExport);
};

/**
 * @param {import('typescript').SourceFile} sourceFile
 * @param {string} localName
 * @returns {'type' | 'value' | undefined}
 */
const localBindingKind = (sourceFile, localName) => {
  for (const statement of sourceFile.statements) {
    const kind = localImportKind(statement, localName) ?? directDeclarationKind(statement, localName);
    if (kind !== undefined) {
      return kind;
    }
  }

  return undefined;
};

/**
 * @param {import('typescript').Statement} statement
 * @param {string} localName
 * @returns {'type' | 'value' | undefined}
 */
const localImportKind = (statement, localName) => {
  if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) {
    return undefined;
  }

  if (statement.importClause.name?.text === localName) {
    return statement.importClause.isTypeOnly ? 'type' : 'value';
  }

  const namedBindings = statement.importClause.namedBindings;
  if (namedBindings === undefined) {
    return undefined;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    return namedBindings.name.text === localName && !statement.importClause.isTypeOnly
      ? 'value'
      : undefined;
  }

  const specifier = namedBindings.elements.find(
    (element) => element.name.text === localName,
  );
  if (specifier === undefined) {
    return undefined;
  }

  return statement.importClause.isTypeOnly || specifier.isTypeOnly ? 'type' : 'value';
};

/**
 * @param {import('typescript').Statement} statement
 * @param {string} publicExport
 * @returns {'type' | 'value' | undefined}
 */
const directDeclarationKind = (statement, publicExport) => {
  const isDeclared = hasDeclareModifier(statement);
  const isConst = hasConstModifier(statement);

  if (ts.isVariableStatement(statement)) {
    return !isDeclared && statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === publicExport,
    )
      ? 'value'
      : undefined;
  }

  if (ts.isEnumDeclaration(statement)) {
    return !isDeclared && !isConst && statement.name.text === publicExport ? 'value' : undefined;
  }

  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
    return !isDeclared && statement.name?.text === publicExport ? 'value' : undefined;
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
 */
const hasDeclareModifier = (node) =>
  hasModifier(node, ts.SyntaxKind.DeclareKeyword);

/**
 * @param {import('typescript').Node} node
 */
const hasConstModifier = (node) =>
  hasModifier(node, ts.SyntaxKind.ConstKeyword);

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
 * @param {string} raw
 * @returns {Array<{
 *   id?: string;
 *   sources?: string[];
 *   docs?: string[];
 *   tests?: string[];
 *   publicExports?: string[];
 *   publicExportKinds?: Record<string, string>;
 * }>}
 */
const parseManifestContracts = (raw) => {
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.contracts)) {
    throw new Error(`${manifestPath} must contain a contracts array`);
  }

  return parsed.contracts;
};

/**
 * @param {string} root
 * @returns {Array<{
 *   id?: string;
 *   sources?: string[];
 *   docs?: string[];
 *   tests?: string[];
 *   publicExports?: string[];
 *   publicExportKinds?: Record<string, string>;
 * }>}
 */
const readManifest = (root) => parseManifestContracts(readText(root, manifestPath));

/**
 * @param {string} baseRef
 */
const readManifestFromGit = (baseRef) => {
  try {
    return parseManifestContracts(
      execFileSync('git', ['show', `${baseRef}:${manifestPath}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return [];
  }
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
    const publicExportKinds = contract.publicExportKinds ?? {};

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
    /**
     * @param {string} sourcePath
     * @param {string} moduleSpecifier
     */
    const resolveRelativeModulePath = (sourcePath, moduleSpecifier) => {
      if (!moduleSpecifier.startsWith('.')) {
        return undefined;
      }

      const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '.';
      const modulePath = toPosix(normalize(join(sourceDir, moduleSpecifier)));
      const candidate = modulePath.endsWith('.js')
        ? `${modulePath.slice(0, -'.js'.length)}.ts`
        : modulePath;

      return projectPathExists(root, candidate) ? candidate : undefined;
    };
    /**
     * @param {string} sourcePath
     * @param {string} exportedName
     * @param {Set<string>} [seen]
     * @returns {'type' | 'value' | undefined}
     */
    const getSourceExportedDeclarationKind = (sourcePath, exportedName, seen = new Set()) => {
      const seenKey = `${sourcePath}:${exportedName}`;
      if (seen.has(seenKey) || !projectPathExists(root, sourcePath)) {
        return undefined;
      }
      seen.add(seenKey);

      return getExportedDeclarationKind(
        readText(root, sourcePath),
        exportedName,
        (moduleSpecifier, moduleExport) => {
          const modulePath = resolveRelativeModulePath(sourcePath, moduleSpecifier);
          if (modulePath === undefined) {
            return moduleSpecifier.startsWith('.') ? undefined : null;
          }

          return getSourceExportedDeclarationKind(modulePath, moduleExport, seen);
        },
      );
    };

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
      const expectedKind = publicExportKinds[publicExport];
      if (expectedKind !== 'type' && expectedKind !== 'value') {
        errors.push(`${id} public export ${publicExport} must declare kind type or value`);
        continue;
      }

      const declaredSources = sourceEntries
        .map((source) => ({
          ...source,
          exportKind: getSourceExportedDeclarationKind(source.path, publicExport),
        }))
        .filter((source) => source.exportKind !== undefined);
      const exportingSources = declaredSources.filter(
        (source) => source.exportKind === expectedKind,
      );

      if (declaredSources.length === 0) {
        errors.push(`${id} public export ${publicExport} is not exported by its sources`);
      } else if (exportingSources.length === 0) {
        errors.push(`${id} public export ${publicExport} is not exported as ${expectedKind} by its sources`);
      }

      const indexExportingSources = exportingSources.filter(
        (source) => source.exportPath !== undefined,
      );
      if (
        indexExportingSources.length > 0 &&
        !indexExportingSources.some(
          (source) => {
            const exportPath = source.exportPath;
            return exportPath !== undefined &&
              source.exportKind !== undefined &&
              indexReExportsPublicName(indexSource, exportPath, publicExport, source.exportKind);
          },
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
 * @param {ReturnType<typeof readManifest>} [baseContracts]
 * @returns {string[]}
 */
export const validateChangedFiles = (root = repoRoot, changedFiles = [], baseContracts = []) => {
  const errors = [];
  const contracts = readManifest(root);
  const changed = new Set(changedFiles.map(toPosix));
  const manifestChanged = changed.has(manifestPath);
  const currentContractsById = new Map(
    contracts
      .filter((contract) => typeof contract.id === 'string')
      .map((contract) => [contract.id, contract]),
  );

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

  for (const baseContract of baseContracts) {
    const id = baseContract.id ?? '<missing id>';
    const currentContract = typeof baseContract.id === 'string'
      ? currentContractsById.get(baseContract.id)
      : undefined;
    const docsAndTests = new Set([
      ...(baseContract.docs ?? []),
      ...(baseContract.tests ?? []),
      ...(currentContract?.docs ?? []),
      ...(currentContract?.tests ?? []),
    ]);
    const hasMatchingDocsOrTests = [...docsAndTests].some((path) => changed.has(path));
    const currentSources = new Set(currentContract?.sources ?? []);
    const removedSources = (baseContract.sources ?? []).filter((path) => !currentSources.has(path));
    const changedRemovedSources = removedSources.filter((path) => manifestChanged || changed.has(path));

    if (changedRemovedSources.length > 0 && !hasMatchingDocsOrTests) {
      errors.push(
        `${id} source removed from manifest without matching docs or tests: ${changedRemovedSources.join(', ')}`,
      );
    }

    if (!manifestChanged) {
      continue;
    }

    const currentPublicExports = new Set(currentContract?.publicExports ?? []);
    const removedPublicExports = (baseContract.publicExports ?? []).filter(
      (publicExport) => !currentPublicExports.has(publicExport),
    );
    if (removedPublicExports.length > 0 && !hasMatchingDocsOrTests) {
      errors.push(
        `${id} public export removed from manifest without matching docs or tests: ${removedPublicExports.join(', ')}`,
      );
    }

    const currentPublicExportKinds = currentContract?.publicExportKinds ?? {};
    const basePublicExportKinds = baseContract.publicExportKinds ?? {};
    const changedPublicExportKinds = (baseContract.publicExports ?? [])
      .filter((publicExport) => currentPublicExports.has(publicExport))
      .map((publicExport) => ({
        publicExport,
        baseKind: basePublicExportKinds[publicExport],
        currentKind: currentPublicExportKinds[publicExport],
      }))
      .filter(({ baseKind, currentKind }) => baseKind !== currentKind)
      .map(({ publicExport, baseKind, currentKind }) =>
        `${publicExport} ${baseKind ?? '<missing>'} -> ${currentKind ?? '<missing>'}`);

    if (changedPublicExportKinds.length > 0 && !hasMatchingDocsOrTests) {
      errors.push(
        `${id} public export kind changed without matching docs or tests: ${changedPublicExportKinds.join(', ')}`,
      );
    }
  }

  return errors;
};

const dependencyOnlyPackageJsonFields = [
  'version',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'pnpm',
];

/**
 * @param {unknown} value
 */
const stripDependencyOnlyPackageJsonFields = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  /** @type {Record<string, unknown>} */
  const copy = { ...value };
  for (const field of dependencyOnlyPackageJsonFields) {
    delete copy[field];
  }

  return copy;
};

/**
 * @param {string} root
 * @param {string[]} changedFiles
 * @param {(path: string) => string} readBaseText
 * @returns {string[]}
 */
export const filterDependencyOnlyPackageJsonChanges = (root, changedFiles, readBaseText) =>
  changedFiles.filter((path) => {
    if (!path.endsWith('package.json')) {
      return true;
    }

    try {
      const basePackageJson = stripDependencyOnlyPackageJsonFields(JSON.parse(readBaseText(path)));
      const currentPackageJson = stripDependencyOnlyPackageJsonFields(JSON.parse(readText(root, path)));

      return JSON.stringify(basePackageJson) !== JSON.stringify(currentPackageJson);
    } catch {
      return true;
    }
  });

/**
 * @param {string} baseRef
 * @returns {string[]}
 */
const changedFilesFromGit = (baseRef) => {
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return filterDependencyOnlyPackageJsonChanges(repoRoot, output.split('\n').filter(Boolean), (path) =>
    execFileSync('git', ['show', `${baseRef}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
};

const main = () => {
  const changedFromIndex = process.argv.indexOf('--changed-from');
  const changedFrom =
    changedFromIndex === -1 ? process.env.DOCS_DRIFT_CHANGED_FROM : process.argv[changedFromIndex + 1];
  const errors = [
    ...validateMarkdownLinks(repoRoot),
    ...validateContractsManifest(repoRoot),
    ...(changedFrom
      ? validateChangedFiles(
        repoRoot,
        changedFilesFromGit(changedFrom),
        readManifestFromGit(changedFrom),
      )
      : []),
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
