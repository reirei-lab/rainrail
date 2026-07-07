import { getDashboardHref } from '../lib/dashboard-content.js';
import {
  defaultLocale,
  getLocaleHref,
  pageIds,
  supportedLocales,
  type Hreflang,
  type Locale,
} from '../lib/i18n.js';

const fallbackSite = 'https://rainrail.dev';

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function GET({ site }: { site?: URL }) {
  const baseUrl = site ?? new URL(fallbackSite);
  const hreflangs = [...supportedLocales, 'x-default'] as const satisfies readonly Hreflang[];
  const defaultLocaleHref = (alternateHref: (locale: Locale) => string): string =>
    alternateHref(defaultLocale);
  const localizedPages = supportedLocales.flatMap((locale) =>
    pageIds.map((pageId) => ({
      locale,
      href: getLocaleHref(locale, pageId),
      alternateHref: (alternateLocale: typeof supportedLocales[number]) =>
        getLocaleHref(alternateLocale, pageId),
    })),
  );
  const localizedDashboards = supportedLocales.map((locale) => ({
    locale,
    href: getDashboardHref(locale),
    alternateHref: getDashboardHref,
  }));
  const entries = [...localizedPages, ...localizedDashboards].map((entry) => {
      const loc = new URL(entry.href, baseUrl).toString();
      const alternates = hreflangs
        .map((hreflang) => {
          const alternatePath =
            hreflang === 'x-default'
              ? defaultLocaleHref(entry.alternateHref)
              : entry.alternateHref(hreflang);
          const href = new URL(alternatePath, baseUrl).toString();
          return `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeXml(href)}" />`;
        })
        .join('');

      return `<url><loc>${escapeXml(loc)}</loc>${alternates}</url>`;
    });

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
      `xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries.join('')}</urlset>`,
    {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
      },
    },
  );
}
