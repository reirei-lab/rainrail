import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDistRoot = join(repoRoot, 'apps/www/dist');
const defaultSiteOrigin = 'https://rainrail.dev';
const defaultOgLocales = {
  ja: 'ja_JP',
  en: 'en_US',
};
const i18nSourcePath = join(repoRoot, 'apps/www/src/lib/i18n.ts');
const pagesRoot = join(repoRoot, 'apps/www/src/pages');
/** @type {Record<string, string>} */
const legacyRedirectTargets = {
  docs: 'https://docs.rainrail.dev/',
};

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
 * @param {string} value
 * @returns {string}
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} attribute
 * @param {string} valuePattern
 * @returns {string}
 */
const attributeLookahead = (attribute, valuePattern = '[^"\']+') =>
  `(?=[^>]*\\s${escapeRegExp(attribute)}\\s*=\\s*["']${valuePattern}["'])`;

/**
 * @param {string} tagName
 * @param {string[]} attributeLookaheads
 * @returns {RegExp}
 */
const tagPattern = (tagName, attributeLookaheads) =>
  new RegExp(`<${tagName}\\b${attributeLookaheads.join('')}[^>]*>`, 'i');

/**
 * @param {string} tag
 * @param {string} attribute
 * @returns {string | undefined}
 */
const attributeValue = (tag, attribute) => {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(attribute)}\\s*=\\s*["']([^"']+)["']`, 'i');
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
const anchorTags = (html) => [...html.matchAll(/<a\b[^>]*>/gi)].map((match) => match[0]);

/**
 * @param {string} html
 * @returns {string[]}
 */
const anchorHrefs = (html) =>
  anchorTags(html)
    .map((tag) => attributeValue(tag, 'href'))
    .filter((href) => href !== undefined);

/**
 * @param {string} sitemap
 * @returns {string[]}
 */
const sitemapLocs = (sitemap) =>
  [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .filter((loc) => loc !== undefined);

/**
 * @param {string} value
 * @param {string[]} locales
 * @param {string} siteOrigin
 * @param {string} baseRoute
 * @returns {boolean}
 */
const isUnlocalizedInternalUrl = (value, locales, siteOrigin, baseRoute) => {
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
    const url = new URL(value, new URL(baseRoute, siteOrigin));

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
 *   locale: string;
 *   locales: string[];
 *   defaultLocale: string;
 *   ogLocales: Record<string, string>;
 *   siteOrigin: string;
 *   errors: string[];
 * }} options
 */
const requireMetadata = ({
  html,
  route,
  path,
  locale,
  locales,
  defaultLocale,
  ogLocales,
  siteOrigin,
  errors,
}) => {
  const expectedUrl = new URL(route, siteOrigin).toString();
  const htmlPattern = /<html\b[^>]*>/i;
  const canonicalPattern = tagPattern('link', [
    attributeLookahead('rel', 'canonical'),
    attributeLookahead('href'),
  ]);
  const ogUrlPattern = tagPattern('meta', [
    attributeLookahead('property', 'og:url'),
    attributeLookahead('content'),
  ]);
  const ogLocalePattern = tagPattern('meta', [
    attributeLookahead('property', 'og:locale'),
    attributeLookahead('content'),
  ]);
  /** @type {[string, RegExp][]} */
  const requiredPatterns = [
    ['<title>', /<title>[^<]+<\/title>/i],
    ['meta description', tagPattern('meta', [
      attributeLookahead('name', 'description'),
      attributeLookahead('content'),
    ])],
    ['canonical link', canonicalPattern],
    ['og:title', tagPattern('meta', [
      attributeLookahead('property', 'og:title'),
      attributeLookahead('content'),
    ])],
    ['og:description', tagPattern('meta', [
      attributeLookahead('property', 'og:description'),
      attributeLookahead('content'),
    ])],
    ['og:url', ogUrlPattern],
    ['og:locale', ogLocalePattern],
  ];

  for (const [label, pattern] of requiredPatterns) {
    if (!hasTag(html, pattern)) {
      errors.push(`Missing ${label} for ${route}`);
    }
  }

  const htmlLang = tagAttributeValue(html, htmlPattern, 'lang');
  if (htmlLang !== locale) {
    errors.push(`html lang for ${route} must be ${locale}`);
  }

  const canonicalHref = tagAttributeValue(html, canonicalPattern, 'href');
  if (canonicalHref && canonicalHref !== expectedUrl) {
    errors.push(`Canonical URL for ${route} must be ${expectedUrl}`);
  }

  const ogUrl = tagAttributeValue(html, ogUrlPattern, 'content');
  if (ogUrl && ogUrl !== expectedUrl) {
    errors.push(`og:url for ${route} must be ${expectedUrl}`);
  }

  const expectedOgLocale = ogLocales[locale];
  const ogLocale = tagAttributeValue(html, ogLocalePattern, 'content');
  if (expectedOgLocale && ogLocale && ogLocale !== expectedOgLocale) {
    errors.push(`og:locale for ${route} must be ${expectedOgLocale}`);
  }

  for (const hreflang of [...locales, 'x-default']) {
    const pattern = tagPattern('link', [
      attributeLookahead('rel', 'alternate'),
      attributeLookahead('hreflang', escapeRegExp(hreflang)),
      attributeLookahead('href'),
    ]);

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
 * @param {{
 *   html: string;
 *   route: string;
 *   path: string;
 *   locales: string[];
 *   siteOrigin: string;
 *   errors: string[];
 * }} options
 */
const requireLanguageSwitcherLinks = ({ html, route, path, locales, siteOrigin, errors }) => {
  const foundLocales = new Set();

  for (const tag of anchorTags(html)) {
    const targetLocale = attributeValue(tag, 'data-locale-choice');
    if (!targetLocale || !locales.includes(targetLocale)) {
      continue;
    }

    const href = attributeValue(tag, 'href');
    if (!href) {
      errors.push(`Language switcher ${targetLocale} for ${route} is missing href`);
      continue;
    }

    foundLocales.add(targetLocale);
    const expectedHref = routePath(targetLocale, path);
    let actualPath = href;

    try {
      const url = new URL(href, siteOrigin);
      if (url.origin === new URL(siteOrigin).origin) {
        actualPath = url.pathname;
      }
    } catch {
      // Keep the raw href for comparison and error reporting.
    }

    if (actualPath !== expectedHref) {
      errors.push(`Language switcher ${targetLocale} for ${route} must link to ${expectedHref}`);
    }
  }

  for (const locale of locales) {
    if (!foundLocales.has(locale)) {
      errors.push(`Missing language switcher ${locale} for ${route}`);
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
      tagPattern('meta', [
        attributeLookahead('name', 'robots'),
        attributeLookahead('content', '[^"\']*\\bnoindex\\b[^"\']*'),
      ]),
    )
  ) {
    errors.push('Missing noindex robots meta for /');
  }

  if (!/window\.location\.replace\(/.test(html)) {
    errors.push('Missing language redirect script for /');
  } else if (!/window\.location\.replace\(\s*supportedLocaleHrefs\[[^\]]+\]\s*\)/.test(html)) {
    errors.push('Root language redirect script must select from locale candidates');
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
 * @param {string} redirects
 * @param {string} source
 * @param {string} target
 * @returns {boolean}
 */
const hasRedirectRule = (redirects, source, target) =>
  redirects
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => {
      if (!line || line.startsWith('#')) {
        return false;
      }

      const [from, to, status] = line.split(/\s+/);
      return from === source && to === target && status === '301';
    });

/**
 * @param {{
 *   redirects: string;
 *   publicPagePaths: string[];
 *   defaultLocale: string;
 *   errors: string[];
 * }} options
 */
const requireLegacyRedirects = ({ redirects, publicPagePaths, defaultLocale, errors }) => {
  for (const publicPath of publicPagePaths) {
    if (!publicPath) {
      continue;
    }

    const source = `/${publicPath}`;
    const sourceWithSlash = `${source}/`;
    const target = legacyRedirectTargets[publicPath] ?? routePath(defaultLocale, publicPath);

    if (!hasRedirectRule(redirects, source, target)) {
      errors.push(`Missing legacy redirect ${source} -> ${target} 301`);
    }

    if (!hasRedirectRule(redirects, sourceWithSlash, target)) {
      errors.push(`Missing legacy redirect ${sourceWithSlash} -> ${target} 301`);
    }
  }
};

/**
 * @param {string} source
 * @returns {{
 *   locales: string[];
 *   localizedPaths: string[];
 *   defaultLocale: string;
 *   ogLocales: Record<string, string>;
 * }}
 */
export const parseWwwI18nSource = (source) => {
  const localesMatch = source.match(/supportedLocales\s*=\s*\[([^\]]+)\]/m);
  const slugsMatch = source.match(/pageSlugs\s*=\s*\{([\s\S]*?)\}\s*as const/m);
  const defaultLocaleMatch = source.match(/defaultLocale\s*=\s*["']([^"']+)["']/m);
  const ogLocalesMatch = source.match(/ogLocales\s*=\s*\{([\s\S]*?)\}\s*as const/m);

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
  const ogLocales = Object.fromEntries(
    [...(ogLocalesMatch?.[1] ?? '').matchAll(/([A-Za-z0-9_-]+)\s*:\s*["']([^"']+)["']/g)]
      .flatMap((match) => (match[1] && match[2] ? [[match[1], match[2]]] : [])),
  );

  return {
    locales,
    localizedPaths: [...localizedPaths, 'dashboard'],
    defaultLocale: defaultLocaleMatch?.[1] ?? locales[0] ?? '',
    ogLocales,
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
      if (entry.name.startsWith('[') && entry.name !== '[locale]') {
        continue;
      }

      const nextSegments = entry.name === '[locale]' ? segments : [...segments, entry.name];
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
 *   ogLocales?: Record<string, string>;
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
  ogLocales = defaultOgLocales,
  publicPagePaths = [],
  siteOrigin = defaultSiteOrigin,
}) => {
  /** @type {string[]} */
  const errors = [];
  const sitemapFile = join(distRoot, 'sitemap.xml');
  const sitemap = existsSync(sitemapFile) ? readFileSync(sitemapFile, 'utf8') : '';
  const redirectsFile = join(distRoot, '_redirects');
  const redirects = existsSync(redirectsFile) ? readFileSync(redirectsFile, 'utf8') : '';
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
  requireLegacyRedirects({ redirects, publicPagePaths, defaultLocale, errors });

  if (!sitemap) {
    errors.push('Missing sitemap.xml');
  }

  for (const loc of sitemapLocs(sitemap)) {
    let url;
    try {
      url = new URL(loc, siteOrigin);
    } catch {
      continue;
    }

    if (
      url.origin === new URL(siteOrigin).origin &&
      !locales.some((locale) => url.pathname === `/${locale}` || url.pathname.startsWith(`/${locale}/`))
    ) {
      errors.push(`Sitemap URL ${loc} must be under a supported locale prefix`);
    }
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
      requireMetadata({
        html,
        route,
        path,
        locale,
        locales,
        defaultLocale,
        ogLocales,
        siteOrigin,
        errors,
      });
      requireLanguageSwitcherLinks({ html, route, path, locales, siteOrigin, errors });

      for (const href of anchorHrefs(html)) {
        if (isUnlocalizedInternalUrl(href, locales, siteOrigin, route)) {
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
  const { locales, localizedPaths, defaultLocale, ogLocales } = parseWwwI18nSource(
    readFileSync(i18nSourcePath, 'utf8'),
  );

  return validateBuiltWwwI18n({
    distRoot: defaultDistRoot,
    locales,
    localizedPaths,
    defaultLocale,
    ogLocales,
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
