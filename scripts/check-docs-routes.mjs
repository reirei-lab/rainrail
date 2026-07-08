import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsContentDir = 'apps/docs/src/content/docs';
const docsConfigPath = 'apps/docs/astro.config.mjs';

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
const extractSidebarSlugs = (config) =>
  [...config.matchAll(/\bslug:\s*['"](?<slug>[^'"]+)['"]/gu)]
    .map((match) => match.groups?.slug)
    .filter((slug) => slug !== undefined);

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

  return errors;
};

if (isCli) {
  const errors = validateDocsRoutes();

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}
