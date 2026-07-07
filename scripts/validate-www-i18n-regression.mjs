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
 * @param {string} tag
 * @param {string} attribute
 * @returns {string | undefined}
 */
const attributeValue = (tag, attribute) => {
  const pattern = new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i');
  return tag.match(pattern)?.[1];
};

/**
 * @param {string} html
 * @param {RegExp} pattern
 * @param {string} attribute
 * @returns {string | undefined}
 */
const tagAttributeValue = (html, pattern, attribute) => {
  const tag = html.match(pattern)?.[0];
  return tag ? attributeValue(tag, attribute) : undefined;
};

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
 * @param {string} siteOrigin
 * @returns {boolean}
 */
const isUnlocalizedInternalUrl = (value, locales, siteOrigin) => {
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
    const url = new URL(value, siteOrigin);

    if (url.origin !== new URL(siteOrigin).origin) {
      return false;
    }

    pathname = url.pathname;
  } catch {
    return false;
  }

  if (pathname === '/sitemap.xml' || pathname === '/install.sh') {
    return false;
  }

  return !locales.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
};

/**
 * @param {{
 *   html: string;
 *   route: string;
 *   path: string;
 *   locales: string[];
 *   defaultLocale: string;
 *   siteOrigin: string;
 *   errors: string[];
 * }} options
 */
const requireMetadata = ({ html, route, path, locales, defaultLocale, siteOrigin, errors }) => {
  const expectedUrl = new URL(route, siteOrigin).toString();
  const canonicalPattern =
    /<link\b(?=[^>]*\brel=["']canonical["'])(?=[^>]*\bhref=["'][^"']+["'])[^>]*>/i;
  const ogUrlPattern =
    /<meta\b(?=[^>]*\bproperty=["']og:url["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i;
  /** @type {[string, RegExp][]} */
  const requiredPatterns = [
    ['<title>', /<title>[^<]+<\/title>/i],
    ['meta description', /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['canonical link', canonicalPattern],
    ['og:title', /<meta\b(?=[^>]*\bproperty=["']og:title["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['og:description', /<meta\b(?=[^>]*\bproperty=["']og:description["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
    ['og:url', ogUrlPattern],
    ['og:locale', /<meta\b(?=[^>]*\bproperty=["']og:locale["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i],
  ];

  for (const [label, pattern] of requiredPatterns) {
    if (!hasTag(html, pattern)) {
      errors.push(`Missing ${label} for ${route}`);
    }
  }

  const canonicalHref = tagAttributeValue(html, canonicalPattern, 'href');
  if (canonicalHref && canonicalHref !== expectedUrl) {
    errors.push(`Canonical URL for ${route} must be ${expectedUrl}`);
  }

  const ogUrl = tagAttributeValue(html, ogUrlPattern, 'content');
  if (ogUrl && ogUrl !== expectedUrl) {
    errors.push(`og:url for ${route} must be ${expectedUrl}`);
  }

  for (const hreflang of [...locales, 'x-default']) {
    const pattern = new RegExp(
      `<link\\b(?=[^>]*\\brel=["']alternate["'])(?=[^>]*\\bhreflang=["']${hreflang}["'])(?=[^>]*\\bhref=["'][^"']+["'])[^>]*>`,
      'i',
    );

    if (!hasTag(html, pattern)) {
      errors.push(`Missing hreflang ${hreflang} for ${route}`);
      continue;
    }

    const expectedLocale = hreflang === 'x-default' ? defaultLocale : hreflang;
    const expectedHref = new URL(routePath(expectedLocale, path), siteOrigin).toString();
    const actualHref = tagAttributeValue(html, pattern, 'href');

    if (actualHref && actualHref !== expectedHref) {
      errors.push(`hreflang ${hreflang} for ${route} must be ${expectedHref}`);
    }
  }
};

/**
 * @param {{ distRoot: string; locales: string[]; errors: string[] }} options
 */
const requireRootLanguageEntry = ({ distRoot, locales, errors }) => {
  const rootFile = routeFile(distRoot, '/');

  if (!existsSync(rootFile) || readFileSync(rootFile, 'utf8').trim() === '') {
    errors.push('Missing built HTML for /');
    return;
  }

  const html = readFileSync(rootFile, 'utf8');

  if (
    !hasTag(
      html,
      /<meta\b(?=[^>]*\bname=["']robots["'])(?=[^>]*\bcontent=["'][^"']*\bnoindex\b[^"']*["'])[^>]*>/i,
    )
  ) {
    errors.push('Missing noindex robots meta for /');
  }

  if (!/window\.location\.replace\(/.test(html)) {
    errors.push('Missing language redirect script for /');
  }

  for (const locale of locales) {
    const href = `/${locale}/`;
    if (!html.includes(`href="${href}"`) && !html.includes(`href='${href}'`)) {
      errors.push(`Root language entrypoint is missing link to ${href}`);
    }

    const candidatePattern = new RegExp(`["']${locale}["']\\s*:\\s*["']${href}["']`);
    if (!candidatePattern.test(html)) {
      errors.push(`Root language redirect candidates are missing ${href}`);
    }
  }
};

/**
 * @param {string} source
 * @returns {{ locales: string[]; localizedPaths: string[]; defaultLocale: string }}
 */
export const parseWwwI18nSource = (source) => {
  const localesMatch = source.match(/supportedLocales\s*=\s*\[([^\]]+)\]/m);
  const slugsMatch = source.match(/pageSlugs\s*=\s*\{([\s\S]*?)\}\s*as const/m);
  const defaultLocaleMatch = source.match(/defaultLocale\s*=\s*["']([^"']+)["']/m);

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
    defaultLocale: defaultLocaleMatch?.[1] ?? locales[0] ?? '',
  };
};

/**
 * @param {string} root
 * @returns {string[]}
 */
export const collectPublicPagePaths = (root) => {
  /** @type {string[]} */
  const paths = [];

  /**
   * @param {string} directory
   * @param {string[]} segments
   */
  const visit = (directory, segments) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('[')) {
        continue;
      }

      const nextSegments = [...segments, entry.name];
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(fullPath, nextSegments);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.astro')) {
        continue;
      }

      const fileSegment = entry.name.replace(/\.astro$/, '');
      const routeSegments =
        fileSegment === 'index' ? segments : [...segments, fileSegment];

      if (routeSegments.length > 0) {
        paths.push(routeSegments.join('/'));
      }
    }
  };

  visit(root, []);

  return paths.sort();
};

/**
 * @param {{
 *   distRoot: string;
 *   locales: string[];
 *   localizedPaths: string[];
 *   defaultLocale?: string;
 *   publicPagePaths?: string[];
 *   siteOrigin?: string;
 * }} options
 * @returns {string[]}
 */
export const validateBuiltWwwI18n = ({
  distRoot,
  locales,
  localizedPaths,
  defaultLocale = locales.includes('en') ? 'en' : (locales[0] ?? ''),
  publicPagePaths = [],
  siteOrigin = defaultSiteOrigin,
}) => {
  /** @type {string[]} */
  const errors = [];
  const sitemapFile = join(distRoot, 'sitemap.xml');
  const sitemap = existsSync(sitemapFile) ? readFileSync(sitemapFile, 'utf8') : '';
  const localizedPathSet = new Set(localizedPaths);

  requireRootLanguageEntry({ distRoot, locales, errors });

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
      requireMetadata({ html, route, path, locales, defaultLocale, siteOrigin, errors });

      for (const href of anchorHrefs(html)) {
        if (isUnlocalizedInternalUrl(href, locales, siteOrigin)) {
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
  const { locales, localizedPaths, defaultLocale } = parseWwwI18nSource(
    readFileSync(i18nSourcePath, 'utf8'),
  );

  return validateBuiltWwwI18n({
    distRoot: defaultDistRoot,
    locales,
    localizedPaths,
    defaultLocale,
    publicPagePaths: collectPublicPagePaths(pagesRoot),
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
