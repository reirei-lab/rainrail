import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectPublicPagePaths,
  validateBuiltWwwI18n,
} from './validate-www-i18n-regression.mjs';

const locales = ['ja', 'en'];
const localizedPaths = ['', 'how-it-works'];

/**
 * @param {{ locale: string; path?: string; href?: string }} options
 * @returns {string}
 */
const pageHtml = ({ locale, path = '', href = `/${locale}/${path}` }) => {
  const title = path ? `${path} - Rainrail` : 'Rainrail';
  const canonical = `https://rainrail.dev${href}`;

  return `<!doctype html>
<html lang="${locale}">
<head>
  <title>${title}</title>
  <meta name="description" content="${title} description">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${title} description">
  <meta property="og:url" content="${canonical}">
  <meta property="og:locale" content="${locale === 'ja' ? 'ja_JP' : 'en_US'}">
  <link rel="alternate" hreflang="ja" href="https://rainrail.dev/ja/${path}">
  <link rel="alternate" hreflang="en" href="https://rainrail.dev/en/${path}">
  <link rel="alternate" hreflang="x-default" href="https://rainrail.dev/en/${path}">
</head>
<body>
  <a href="/${locale}/${path}">same locale</a>
  <a href="/ja/${path}" data-locale-choice="ja">日本語</a>
  <a href="/en/${path}" data-locale-choice="en">English</a>
  <a href="https://github.com/reirei-lab/rainrail">GitHub</a>
</body>
</html>`;
};

/**
 * @param {string} root
 * @param {string} route
 * @param {string} html
 */
const writeRoute = (root, route, html) => {
  const routeDir = join(root, route);
  mkdirSync(routeDir, { recursive: true });
  writeFileSync(join(routeDir, 'index.html'), html);
};

const writeCompleteDist = async () => {
  const root = await mkdtemp(join(tmpdir(), 'rainrail-www-i18n-'));

  writeRoute(
    root,
    '',
    `<!doctype html>
<html lang="en">
<head>
  <meta name="robots" content="noindex">
  <script>
    const supportedLocaleHrefs = {"ja":"/ja/","en":"/en/"};
    const locale = "en";
    window.location.replace(supportedLocaleHrefs[locale]);
  </script>
</head>
<body>
  <a href="/ja/">日本語</a>
  <a href="/en/">English</a>
</body>
</html>`,
  );

  for (const locale of locales) {
    writeRoute(root, locale, pageHtml({ locale, href: `/${locale}/` }));
    writeRoute(
      root,
      `${locale}/how-it-works`,
      pageHtml({ locale, path: 'how-it-works' }),
    );
  }

  writeFileSync(
    join(root, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://rainrail.dev/ja/</loc></url>
  <url><loc>https://rainrail.dev/en/</loc></url>
  <url><loc>https://rainrail.dev/ja/how-it-works</loc></url>
  <url><loc>https://rainrail.dev/en/how-it-works</loc></url>
</urlset>`,
  );
  writeFileSync(
    join(root, '_redirects'),
    `/how-it-works /en/how-it-works 301
/how-it-works/ /en/how-it-works 301`,
  );

  return root;
};

describe('www i18n regression validator', () => {
  it('accepts complete localized pages with metadata, alternates, and sitemap entries', async () => {
    const distRoot = await writeCompleteDist();

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toEqual([]);
  });

  it('reports a missing locale page for an existing public page', async () => {
    const distRoot = await writeCompleteDist();
    writeFileSync(join(distRoot, 'ja/how-it-works/index.html'), '');

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Missing built HTML for /ja/how-it-works',
    );
  });

  it('reports missing title, description, OGP, canonical, and hreflang metadata', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'en/how-it-works',
      '<!doctype html><html lang="en"><head></head><body></body></html>',
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toEqual(
      expect.arrayContaining([
        'Missing <title> for /en/how-it-works',
        'Missing meta description for /en/how-it-works',
        'Missing canonical link for /en/how-it-works',
        'Missing og:title for /en/how-it-works',
        'Missing og:description for /en/how-it-works',
        'Missing og:url for /en/how-it-works',
        'Missing og:locale for /en/how-it-works',
        'Missing hreflang ja for /en/how-it-works',
        'Missing hreflang en for /en/how-it-works',
        'Missing hreflang x-default for /en/how-it-works',
      ]),
    );
  });

  it('reports canonical and og:url values that do not match the locale route', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replaceAll(
        'https://rainrail.dev/ja/how-it-works',
        'https://rainrail.dev/en/how-it-works',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toEqual(
      expect.arrayContaining([
        'Canonical URL for /ja/how-it-works must be https://rainrail.dev/ja/how-it-works',
        'og:url for /ja/how-it-works must be https://rainrail.dev/ja/how-it-works',
      ]),
    );
  });

  it('reports og:locale values that do not match the route locale', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'property="og:locale" content="ja_JP"',
        'property="og:locale" content="en_US"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'og:locale for /ja/how-it-works must be ja_JP',
    );
  });

  it('reports html lang values that do not match the route locale', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        '<html lang="ja">',
        '<html lang="en">',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'html lang for /ja/how-it-works must be ja',
    );
  });

  it('reports hreflang hrefs that do not point to the same page in each locale', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'hreflang="en" href="https://rainrail.dev/en/how-it-works"',
        'hreflang="en" href="https://rainrail.dev/en/docs"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'hreflang en for /ja/how-it-works must be https://rainrail.dev/en/how-it-works',
    );
  });

  it('reports language switcher links that do not point to the same page in each locale', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'href="/en/how-it-works" data-locale-choice="en"',
        'href="/en/" data-locale-choice="en"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Language switcher en for /ja/how-it-works must link to /en/how-it-works',
    );
  });

  it('reports missing language switcher links for every supported locale', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        '<a href="/en/how-it-works" data-locale-choice="en">English</a>',
        '',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Missing language switcher en for /ja/how-it-works',
    );
  });

  it('does not treat data-href as a language switcher href', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        '<a href="/en/how-it-works" data-locale-choice="en">English</a>',
        '<a data-locale-choice="en" data-href="/en/how-it-works">English</a>',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Language switcher en for /ja/how-it-works is missing href',
    );
  });

  it('reports same-origin internal links that drop the locale prefix', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'href="/ja/how-it-works"',
        'href="/docs"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Locale page /ja/how-it-works links to unlocalized internal URL /docs',
    );
  });

  it('resolves relative links from the current localized route', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'href="/ja/how-it-works"',
        'href="docs"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).not.toContain(
      'Locale page /ja/how-it-works links to unlocalized internal URL docs',
    );
  });

  it('reports localized page links back to the automatic root entrypoint', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'href="/ja/how-it-works"',
        'href="/"',
      ),
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Locale page /ja/how-it-works links to unlocalized internal URL /',
    );
  });

  it('uses the configured site origin for same-origin internal link checks', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      'ja/how-it-works',
      pageHtml({ locale: 'ja', path: 'how-it-works' }).replace(
        'href="/ja/how-it-works"',
        'href="https://preview.example.com/docs"',
      ),
    );

    expect(
      validateBuiltWwwI18n({
        distRoot,
        locales,
        localizedPaths,
        siteOrigin: 'https://preview.example.com',
      }),
    ).toContain(
      'Locale page /ja/how-it-works links to unlocalized internal URL https://preview.example.com/docs',
    );
  });

  it('reports missing localized sitemap URLs', async () => {
    const distRoot = await writeCompleteDist();
    writeFileSync(join(distRoot, 'sitemap.xml'), '<urlset></urlset>');

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Missing sitemap URL https://rainrail.dev/ja/how-it-works',
    );
  });

  it('reports same-origin unlocalized sitemap URLs', async () => {
    const distRoot = await writeCompleteDist();
    writeFileSync(
      join(distRoot, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://rainrail.dev/ja/</loc></url>
  <url><loc>https://rainrail.dev/en/</loc></url>
  <url><loc>https://rainrail.dev/ja/how-it-works</loc></url>
  <url><loc>https://rainrail.dev/en/how-it-works</loc></url>
  <url><loc>https://rainrail.dev/docs</loc></url>
</urlset>`,
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Sitemap URL https://rainrail.dev/docs must be under a supported locale prefix',
    );
  });

  it('reports a broken root language detection entry point', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(distRoot, '', '<!doctype html><html><head></head><body></body></html>');

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toEqual(
      expect.arrayContaining([
        'Missing noindex robots meta for /',
        'Missing language redirect script for /',
        'Root language entrypoint is missing link to /ja/',
        'Root language entrypoint is missing link to /en/',
      ]),
    );
  });

  it('reports root redirect scripts that do not include every supported locale target', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      '',
      `<!doctype html>
<html lang="en">
<head>
  <meta name="robots" content="noindex">
  <script>
    const supportedLocaleHrefs = {"en":"/en/"};
    const locale = "en";
    window.location.replace(supportedLocaleHrefs[locale]);
  </script>
</head>
<body>
  <a href="/ja/">日本語</a>
  <a href="/en/">English</a>
</body>
</html>`,
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Root language redirect candidates are missing /ja/',
    );
  });

  it('reports root redirect scripts that do not use locale candidates', async () => {
    const distRoot = await writeCompleteDist();
    writeRoute(
      distRoot,
      '',
      `<!doctype html>
<html lang="en">
<head>
  <meta name="robots" content="noindex">
  <script>
    const supportedLocaleHrefs = {"ja":"/ja/","en":"/en/"};
    window.location.replace('/en/');
  </script>
</head>
<body>
  <a href="/ja/">日本語</a>
  <a href="/en/">English</a>
</body>
</html>`,
    );

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Root language redirect script must select from locale candidates',
    );
  });

  it('reports top-level public pages missing from the localized page collection', async () => {
    const distRoot = await writeCompleteDist();

    expect(
      validateBuiltWwwI18n({
        distRoot,
        locales,
        localizedPaths,
        publicPagePaths: ['', 'how-it-works', 'docs'],
      }),
    ).toContain('Public page /docs is missing from the localized page collection');
  });

  it('reports public pages missing legacy unprefixed 301 redirects', async () => {
    const distRoot = await writeCompleteDist();
    writeFileSync(join(distRoot, '_redirects'), '');

    expect(
      validateBuiltWwwI18n({
        distRoot,
        locales,
        localizedPaths,
        publicPagePaths: ['how-it-works'],
      }),
    ).toEqual(
      expect.arrayContaining([
        'Missing legacy redirect /how-it-works -> /en/how-it-works 301',
        'Missing legacy redirect /how-it-works/ -> /en/how-it-works 301',
      ]),
    );
  });

  it('collects nested directory-style public pages', async () => {
    const pagesRoot = await mkdtemp(join(tmpdir(), 'rainrail-www-pages-'));
    mkdirSync(join(pagesRoot, 'pricing'), { recursive: true });
    mkdirSync(join(pagesRoot, 'docs'), { recursive: true });
    mkdirSync(join(pagesRoot, '[locale]'), { recursive: true });
    writeFileSync(join(pagesRoot, 'index.astro'), 'root entry');
    writeFileSync(join(pagesRoot, 'dashboard.astro'), 'dashboard');
    writeFileSync(join(pagesRoot, 'pricing/index.astro'), 'pricing');
    writeFileSync(join(pagesRoot, 'docs/getting-started.astro'), 'nested docs');
    writeFileSync(join(pagesRoot, '[locale]/[...slug].astro'), 'localized dynamic route');

    expect(collectPublicPagePaths(pagesRoot)).toEqual([
      'dashboard',
      'docs/getting-started',
      'pricing',
    ]);
  });

  it('collects static pages below the locale directory without collecting dynamic locale routes', async () => {
    const pagesRoot = await mkdtemp(join(tmpdir(), 'rainrail-www-locale-pages-'));
    mkdirSync(join(pagesRoot, '[locale]/docs'), { recursive: true });
    writeFileSync(join(pagesRoot, '[locale]/pricing.astro'), 'locale pricing');
    writeFileSync(join(pagesRoot, '[locale]/docs/getting-started.astro'), 'locale docs');
    writeFileSync(join(pagesRoot, '[locale]/[...slug].astro'), 'localized dynamic route');

    expect(collectPublicPagePaths(pagesRoot)).toEqual([
      'docs/getting-started',
      'pricing',
    ]);
  });
});
