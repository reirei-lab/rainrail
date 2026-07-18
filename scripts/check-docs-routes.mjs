import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsContentDir = 'apps/docs/src/content/docs';
const docsConfigPath = 'apps/docs/astro.config.mjs';
const productSiteContentPath = 'apps/www/src/lib/site-content.ts';
const publicDocsOrigin = 'https://docs.rainrail.dev';

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * @param {string} path
 */
const toPosix = (path) => path.split('\\').join('/');

/**
 * @param {string} root
 * @param {string} path
 */
const readText = (root, path) => readFileSync(join(root, path), 'utf8');

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
    const projectPath = toPosix(relative(root, absolutePath));

    if (entry.isDirectory()) {
      return walkFiles(root, projectPath, extensions);
    }

    return extensions.has(extname(entry.name)) ? [projectPath] : [];
  });
};

/**
 * @param {string} file
 */
const docsFileToRoute = (file) => {
  const relativePath = file.slice(`${docsContentDir}/`.length).replace(/\.md$/u, '');
  const slug = relativePath.endsWith('/index')
    ? relativePath.slice(0, -'/index'.length)
    : relativePath;

  return slug.length === 0 || slug === 'index' ? '/' : `/${slug}/`;
};

/**
 * @param {string} route
 */
const normalizeDocsRoute = (route) => {
  const [withoutHash] = route.split('#');
  const [withoutQuery] = (withoutHash ?? '').split('?');
  const decoded = decodeURI(withoutQuery ?? '');

  if (decoded === '' || decoded === '/') {
    return '/';
  }

  return decoded.endsWith('/') ? decoded : `${decoded}/`;
};

/**
 * @param {string} config
 * @returns {string[]}
 */
const extractSidebarSlugs = (config) => {
  const sourceFile = ts.createSourceFile(
    'astro.config.mjs',
    config,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  /** @type {string[]} */
  const slugs = [];

  /**
   * @param {import('typescript').Node} node
   */
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === 'sidebar' &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      collectStringPropertyValues(node.initializer, 'slug', slugs);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return slugs;
};

/**
 * @param {import('typescript').PropertyName} name
 * @returns {string | undefined}
 */
const propertyNameText = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
};

/**
 * @param {import('typescript').Node} root
 * @param {string} propertyName
 * @param {string[]} values
 */
const collectStringPropertyValues = (root, propertyName, values) => {
  /**
   * @param {import('typescript').Node} node
   */
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === propertyName &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      values.push(node.initializer.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
};

/**
 * @param {string} markdown
 * @returns {string[]}
 */
const extractFrontmatterLinks = (markdown) => {
  if (!markdown.startsWith('---\n')) {
    return [];
  }

  const end = markdown.indexOf('\n---', 4);
  if (end === -1) {
    return [];
  }

  const frontmatter = markdown.slice(4, end);
  return [...frontmatter.matchAll(/^\s*link:\s*['"]?(?<target>\/[^'"\s]+)['"]?\s*$/gmu)]
    .map((match) => match.groups?.target)
    .filter((target) => target !== undefined);
};

/**
 * @param {string} source
 * @returns {string[]}
 */
const extractPublicDocsLinks = (source) => {
  const sourceFile = ts.createSourceFile(
    'site-content.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const baseIdentifiers = new Set();
  const links = new Set();

  /**
   * @param {string} value
   */
  const addPublicDocsUrl = (value) => {
    if (!value.startsWith(publicDocsOrigin)) {
      return;
    }

    links.add(new URL(value).pathname);
  };

  /**
   * @param {import('typescript').Node} node
   */
  const collectBaseIdentifiers = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (
        node.initializer !== undefined &&
        ts.isStringLiteralLike(node.initializer) &&
        node.initializer.text === publicDocsOrigin
      ) {
        baseIdentifiers.add(node.name.text);
      }
    }

    ts.forEachChild(node, collectBaseIdentifiers);
  };

  /**
   * @param {import('typescript').Node} node
   */
  const collectLinks = (node) => {
    if (ts.isStringLiteralLike(node)) {
      addPublicDocsUrl(node.text);
    }

    if (
      ts.isTemplateExpression(node) &&
      node.head.text === '' &&
      node.templateSpans.length === 1
    ) {
      const [span] = node.templateSpans;
      if (
        span !== undefined &&
        ts.isIdentifier(span.expression) &&
        baseIdentifiers.has(span.expression.text)
      ) {
        links.add(span.literal.text);
      }
    }

    ts.forEachChild(node, collectLinks);
  };

  collectBaseIdentifiers(sourceFile);
  collectLinks(sourceFile);
  return [...links];
};

/**
 * @param {string} root
 * @returns {string[]}
 */
export const validateDocsRoutes = (root = repoRoot) => {
  const errors = [];
  const markdownFiles = walkFiles(root, docsContentDir, new Set(['.md']));
  const routes = new Set(markdownFiles.map(docsFileToRoute));

  if (markdownFiles.length === 0) {
    errors.push(`${docsContentDir} must contain public docs pages`);
  }

  for (const route of ['/', '/quickstart/', '/operations/']) {
    if (!routes.has(route)) {
      errors.push(`public docs route is missing: ${route}`);
    }
  }

  if (existsSync(join(root, docsConfigPath))) {
    for (const slug of extractSidebarSlugs(readText(root, docsConfigPath))) {
      const route = normalizeDocsRoute(`/${slug}/`);
      if (!routes.has(route)) {
        errors.push(`${docsConfigPath} sidebar slug ${slug} has no docs route`);
      }
    }
  } else {
    errors.push(`${docsConfigPath} does not exist`);
  }

  const linkPattern = /(?<!!)\[[^\]]+\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/gu;

  for (const file of markdownFiles) {
    const content = readText(root, file);

    for (const target of extractFrontmatterLinks(content)) {
      const route = normalizeDocsRoute(target);
      if (!routes.has(route)) {
        errors.push(`${file} frontmatter links to missing docs route ${route}`);
      }
    }

    for (const match of content.matchAll(linkPattern)) {
      const target = match.groups?.target;
      if (
        target === undefined ||
        target.startsWith('#') ||
        /^(https?:|mailto:)/u.test(target) ||
        !target.startsWith('/')
      ) {
        continue;
      }

      const route = normalizeDocsRoute(target);
      if (!routes.has(route)) {
        errors.push(`${file} links to missing docs route ${route}`);
      }
    }
  }

  if (existsSync(join(root, productSiteContentPath))) {
    for (const target of extractPublicDocsLinks(readText(root, productSiteContentPath))) {
      const route = normalizeDocsRoute(target);
      if (!routes.has(route)) {
        errors.push(`${productSiteContentPath} links to missing public docs route ${route}`);
      }
    }
  }

  return errors;
};

if (isCli) {
  const errors = validateDocsRoutes();

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}
