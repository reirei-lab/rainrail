import { getLocaleHref, pageIds, supportedLocales } from '../lib/i18n';

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
  const entries = supportedLocales.flatMap((locale) =>
    pageIds.map((pageId) => {
      const loc = new URL(getLocaleHref(locale, pageId), baseUrl).toString();
      const alternates = supportedLocales
        .map((alternateLocale) => {
          const href = new URL(getLocaleHref(alternateLocale, pageId), baseUrl).toString();
          return `<xhtml:link rel="alternate" hreflang="${alternateLocale}" href="${escapeXml(href)}" />`;
        })
        .join('');

      return `<url><loc>${escapeXml(loc)}</loc>${alternates}</url>`;
    }),
  );

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
