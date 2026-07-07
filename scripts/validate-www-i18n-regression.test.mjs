import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateBuiltWwwI18n } from './validate-www-i18n-regression.mjs';

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

  it('reports missing localized sitemap URLs', async () => {
    const distRoot = await writeCompleteDist();
    writeFileSync(join(distRoot, 'sitemap.xml'), '<urlset></urlset>');

    expect(validateBuiltWwwI18n({ distRoot, locales, localizedPaths })).toContain(
      'Missing sitemap URL https://rainrail.dev/ja/how-it-works',
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
});
