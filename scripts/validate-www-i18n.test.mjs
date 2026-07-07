import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertSupportedLocale,
  getLocaleHref,
  getPageContent,
  getSiteMessages,
  isSupportedLocale,
  pageIds,
  supportedLocales,
  translate,
} from '../apps/www/src/lib/i18n.js';

const i18nSpec = readFileSync(
  new URL('../docs/www-i18n-foundation.md', import.meta.url),
  'utf8',
);

describe('www locale-aware i18n foundation', () => {
  it('keeps the supported locales centralized and explicit', () => {
    expect(supportedLocales).toEqual(['ja', 'en']);
    expect(isSupportedLocale('ja')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(() => assertSupportedLocale('fr')).toThrow(/Unsupported locale: fr/);
  });

  it('defines localized navigation, page metadata, and routes for every public page', () => {
    expect(pageIds).toEqual([
      'home',
      'howItWorks',
      'concepts',
      'guides',
      'examples',
      'docs',
    ]);

    for (const locale of supportedLocales) {
      const messages = getSiteMessages(locale);
      expect(messages.nav.primary).toHaveLength(pageIds.length - 1);
      expect(messages.footer).not.toHaveLength(0);

      for (const pageId of pageIds) {
        const page = getPageContent(locale, pageId);
        expect(page.meta.title).not.toHaveLength(0);
        expect(page.meta.description).not.toHaveLength(0);
        expect(page.href).toBe(getLocaleHref(locale, pageId));
        expect(page.alternates).toEqual({
          ja: getLocaleHref('ja', pageId),
          en: getLocaleHref('en', pageId),
        });
      }
    }
  });

  it('keeps language-specific copy distinct where translation is required', () => {
    expect(getPageContent('ja', 'home').meta.description).not.toBe(
      getPageContent('en', 'home').meta.description,
    );
    expect(getSiteMessages('ja').nav.primary[0]?.label).not.toBe(
      getSiteMessages('en').nav.primary[0]?.label,
    );
  });

  it('fails fast for unknown translation keys instead of silently rendering gaps', () => {
    expect(translate('en', 'nav.github')).toBe('GitHub');
    expect(() => translate('en', 'nav.missing')).toThrow(
      /Missing translation key "nav.missing" for locale "en"/,
    );
  });

  it('documents the locale fallback and missing-key policy for follow-up routing work', () => {
    for (const phrase of [
      'サポート locale は `ja` / `en`',
      '未対応 locale は自動 fallback しない',
      '存在しない翻訳キーは例外',
      'product pages は `/ja/` / `/en/` の明示 URL で公開する',
      '`/` は自動 locale detection entry point',
      'legacy unprefixed product URL は `/en/` へ 301 redirect',
      'canonical URL と `hreflang` alternate は同じ page model から生成する',
    ]) {
      expect(i18nSpec).toContain(phrase);
    }
  });
});
