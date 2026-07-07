import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDistRoot = join(repoRoot, 'apps/www/dist');
const defaultSiteOrigin = 'https://rainrail.dev';
const i18nSourcePath = join(repoRoot, 'apps/www/src/lib/i18n.ts');
const pagesRoot = join(repoRoot, 'apps/www/src/pages');

/**
 * @param {string} locale
 * @param {string} path
 * @returns {string}
 */
const routePath = (locale, path) => {
  const suffix = path ? `/${path}` : '/';
  return `/${locale}${suffix}`;
};

/**
 * @param {string} distRoot
 * @param {string} route
 * @returns {string}
 */
const routeFile = (distRoot, route) => {
  const routeWithoutLeadingSlash = route.replace(/^\//, '');
  return route.endsWith('/')
    ? join(distRoot, routeWithoutLeadingSlash, 'index.html')
    : join(distRoot, routeWithoutLeadingSlash, 'index.html');
};

/**
 * @param {string} html
 * @param {RegExp} pattern
 * @returns {boolean}
 */
const hasTag = (html, pattern) => pattern.test(html);

/**
 * @param {string} html
 * @returns {string[]}
 */
const anchorHrefs = (html) =>
  [...html.matchAll(/<a\b[^>]*\shref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .filter((href) => href !== undefined);

/**
 * @param {string} value
 * @param {string[]} locales
 * @returns {boolean}
 */
const isUnlocalizedInternalUrl = (value, locales) => {
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('mailto:') ||
    value.startsWith('tel:') ||
    value.startsWith('data:')
  ) {
    return false;
  }

  let pathname;
  try {
    const url = new URL(value, defaultSiteOrigin);

    if (url.origin !== defaultSiteOrigin) {
      return false;
    }

    pathname = url.pathname;
  } catch {
    return false;
  }

  if (pathname === '/' || pathname === '/sitemap.xml' || pathname === '/install.sh') {
    return false;
  }

  return !locales.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
};

/**
 * @param {{ html: string; route: string; locales: string[]; errors: string[] }} options
 */
const requireMetadata = ({ html, route, locales, errors }) => {
  /** @type {[string, RegExp][]} */
  const requiredPatterns = [
    ['<title>', /<title>[^<]+<\/title>/i],
    ['meta description', /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['canonical link', /<link\b(?=[^>]*\brel=["']canonical["'])(?=[^>]*\bhref=["'][^"']+["'])[^>]*>/i],
    ['og:title', /<meta\b(?=[^>]*\bproperty=["']og:title["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['og:description', /<meta\b(?=[^>]*\bproperty=["']og:description["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['og:url', /<meta\b(?=[^>]*\bproperty=["']og:url["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['og:locale', /<meta\b(?=[^>]*\bproperty=["']og:locale["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
  ];

  for (const [label, pattern] of requiredPatterns) {
    if (!hasTag(html, pattern)) {
      errors.push(`Missing ${label} for ${route}`);
    }
  }

  for (const hreflang of [...locales, 'x-default']) {
    const pattern = new RegExp(
      `<link\\b(?=[^>]*\\brel=["']alternate["'])(?=[^>]*\\bhreflang=["']${hreflang}["'])(?=[^>]*\\bhref=["'][^"']+["'])[^>]*>`,
      'i',
    );

    if (!hasTag(html, pattern)) {
      errors.push(`Missing hreflang ${hreflang} for ${route}`);
    }
  }
};

/**
 * @param {string} source
 * @returns {{ locales: string[]; localizedPaths: string[] }}
 */
export const parseWwwI18nSource = (source) => {
  const localesMatch = source.match(/supportedLocales\s*=\s*\[([^\]]+)\]/m);
  const slugsMatch = source.match(/pageSlugs\s*=\s*\{([\s\S]*?)\}\s*as const/m);

  if (!localesMatch || !slugsMatch) {
    throw new Error('Could not read supportedLocales or pageSlugs from i18n.ts');
  }

  const localeSource = localesMatch[1] ?? '';
  const slugSource = slugsMatch[1] ?? '';
  const locales = [...localeSource.matchAll(/["']([^"']+)["']/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
  const localizedPaths = [...slugSource.matchAll(/:\s*["']([^"']*)["']/g)].flatMap(
    (match) => (match[1] !== undefined ? [match[1]] : []),
  );

  return {
    locales,
    localizedPaths: [...localizedPaths, 'dashboard'],
  };
};

/**
 * @param {string} root
 * @returns {string[]}
 */
export const collectTopLevelPublicPagePaths = (root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.astro'))
    .map((entry) => entry.name.replace(/\.astro$/, ''))
    .filter((page) => !page.startsWith('['))
    .map((page) => (page === 'index' ? '' : page))
    .sort();

/**
 * @param {{
 *   distRoot: string;
 *   locales: string[];
 *   localizedPaths: string[];
 *   publicPagePaths?: string[];
 *   siteOrigin?: string;
 * }} options
 * @returns {string[]}
 */
export const validateBuiltWwwI18n = ({
  distRoot,
  locales,
  localizedPaths,
  publicPagePaths = [],
  siteOrigin = defaultSiteOrigin,
}) => {
  const errors = [];
  const sitemapFile = join(distRoot, 'sitemap.xml');
  const sitemap = existsSync(sitemapFile) ? readFileSync(sitemapFile, 'utf8') : '';
  const localizedPathSet = new Set(localizedPaths);

  for (const publicPath of publicPagePaths) {
    if (!localizedPathSet.has(publicPath)) {
      const displayPath = publicPath ? `/${publicPath}` : '/';
      errors.push(
        `Public page ${displayPath} is missing from the localized page collection`,
      );
    }
  }

  if (!sitemap) {
    errors.push('Missing sitemap.xml');
  }

  for (const path of localizedPaths) {
    for (const locale of locales) {
      const route = routePath(locale, path);
      const file = routeFile(distRoot, route);

      if (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') {
        errors.push(`Missing built HTML for ${route}`);
        continue;
      }

      const html = readFileSync(file, 'utf8');
      requireMetadata({ html, route, locales, errors });

      for (const href of anchorHrefs(html)) {
        if (isUnlocalizedInternalUrl(href, locales)) {
          errors.push(`Locale page ${route} links to unlocalized internal URL ${href}`);
        }
      }

      const expectedUrl = new URL(route, siteOrigin).toString();
      if (sitemap && !sitemap.includes(`<loc>${expectedUrl}</loc>`)) {
        errors.push(`Missing sitemap URL ${expectedUrl}`);
      }
    }
  }

  return errors;
};

export const validateDefaultBuiltWwwI18n = () => {
  const { locales, localizedPaths } = parseWwwI18nSource(
    readFileSync(i18nSourcePath, 'utf8'),
  );

  return validateBuiltWwwI18n({
    distRoot: defaultDistRoot,
    locales,
    localizedPaths,
    publicPagePaths: collectTopLevelPublicPagePaths(pagesRoot),
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = validateDefaultBuiltWwwI18n();

  if (errors.length > 0) {
    console.error(`www i18n regression check failed with ${errors.length} issue(s):`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  }
}
