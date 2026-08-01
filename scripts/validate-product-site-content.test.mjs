import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getProductPageContent } from '../apps/www/src/lib/site-content.js';

/**
 * @param {string} name
 */
const page = (name) =>
  readFileSync(
    new URL(`../apps/www/src/pages/${name}.astro`, import.meta.url),
    'utf8',
  );

const layout = readFileSync(
  new URL('../apps/www/src/layouts/SiteLayout.astro', import.meta.url),
  'utf8',
);
const localizedRoute = page('[locale]/[...slug]');
const siteContent = readFileSync(
  new URL('../apps/www/src/lib/site-content.ts', import.meta.url),
  'utf8',
);
const i18n = readFileSync(
  new URL('../apps/www/src/lib/i18n.ts', import.meta.url),
  'utf8',
);
const indexPage = page('index');
const sitemapRoute = readFileSync(
  new URL('../apps/www/src/pages/sitemap.xml.ts', import.meta.url),
  'utf8',
);
const dashboardContent = readFileSync(
  new URL('../apps/www/src/lib/dashboard-content.ts', import.meta.url),
  'utf8',
);
const contractsManifest = readFileSync(
  new URL('../docs/contracts.manifest.json', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const rootInstallScript = new URL('../install.sh', import.meta.url);
const publicInstallScript = new URL('../apps/www/public/install.sh', import.meta.url);
const publicRedirects = new URL('../apps/www/public/_redirects', import.meta.url);

describe('product site concepts, guides, and examples', () => {
  it('serves every product page under both /ja/ and /en/ locale routes', () => {
    expect(localizedRoute).toContain('getStaticPaths');
    expect(localizedRoute).toContain('supportedLocales.flatMap');
    expect(localizedRoute).toContain('pageIds.map');
    expect(localizedRoute).toContain('getPageBySlug(locale, slug)');

    for (const locale of ['ja', 'en']) {
      expect(i18n).toContain(`'${locale}'`);
    }
    for (const slug of ['concepts', 'guides', 'examples', 'docs']) {
      expect(i18n).toContain(`'${slug}'`);
    }
    expect(i18n).toContain('`/${locale}/`');
    expect(i18n).toContain('`/${locale}/${slug}`');
  });

  it('keeps navigation, brand links, CTA links, and language switching locale-aware', () => {
    expect(layout).toContain('page.alternates');
    expect(layout).toContain('page.href');
    expect(layout).toContain('rel="canonical"');
    expect(layout).toContain('absolutePageAlternates');
    expect(layout).toContain('language-switcher');
    expect(layout).toContain('site.nav.languageSwitcherLabel');
    expect(layout).toContain('hrefFor(item.pageId)');
    expect(localizedRoute).toContain('resolveActionHref(locale, action)');
    expect(localizedRoute).toContain('resolveActionHref(locale, { label: card.title, pageId: card.pageId })');
    expect(layout).not.toContain("href=\"/how-it-works\"");
    expect(layout).not.toContain("href=\"/docs\"");
    expect(layout).not.toContain("href=\"/concepts\"");
  });

  it('redirects legacy product URLs to the default English locale', () => {
    const redirects = readFileSync(publicRedirects, 'utf8');

    for (const redirect of [
      '/concepts /en/concepts 301',
      '/concepts/ /en/concepts 301',
      '/how-it-works /en/concepts 301',
      '/how-it-works/ /en/concepts 301',
      '/ja/how-it-works /ja/concepts 301',
      '/ja/how-it-works/ /ja/concepts 301',
      '/en/how-it-works /en/concepts 301',
      '/en/how-it-works/ /en/concepts 301',
      '/guides /en/guides 301',
      '/guides/ /en/guides 301',
      '/examples /en/examples 301',
      '/examples/ /en/examples 301',
      '/docs https://docs.rainrail.dev/ 301',
      '/docs/ https://docs.rainrail.dev/ 301',
    ]) {
      expect(redirects).toContain(redirect);
    }

    expect(i18n).not.toContain('howItWorks');

    for (const route of ['concepts', 'guides', 'examples', 'docs']) {
      const routeSource = page(route);
      expect(routeSource).toContain('getDefaultLocaleRedirect');
      expect(routeSource).toContain('http-equiv="refresh"');
      expect(routeSource).not.toContain('Astro.redirect');
    }
  });

  it('keeps / as the automatic locale detection entry point', () => {
    expect(indexPage).toContain('navigator.languages');
    expect(indexPage).toContain('find((language)');
    expect(indexPage).toContain('supportedLocaleHrefs');
    expect(indexPage).toContain('languagePreferenceKey');
    expect(indexPage).toContain("window.localStorage?.getItem(languagePreferenceKey)");
    expect(indexPage.indexOf('getStoredLocale()')).toBeLessThan(
      indexPage.indexOf('getPreferredBrowserLocale(languages)'),
    );
    expect(indexPage).toContain('Rainrail routes development events into agent workflows.');
    expect(indexPage).toContain("getLocaleHref('ja', 'home')");
    expect(indexPage).toContain("getLocaleHref('en', 'home')");
    expect(indexPage).not.toContain('redirectToDefaultLocale');
    expect(indexPage).not.toContain('Astro.redirect');
  });

  it('persists manual language switcher choices for the next automatic entry visit', () => {
    expect(layout).toContain('languagePreferenceKey');
    expect(layout).toContain('data-locale-choice={targetLocale}');
    expect(layout).toContain("window.localStorage?.setItem(languagePreferenceKey, locale)");
    expect(layout).not.toContain('window.location.replace');
  });

  it('localizes Japanese home visible labels and assistive labels', () => {
    const japaneseHome = getProductPageContent('ja', 'home');

    if (japaneseHome.kind !== 'home') {
      throw new Error('Japanese home content must use the home renderer');
    }

    expect(japaneseHome.headline).toBe('自分のループを組み立てる。');
    expect(japaneseHome.primaryActionsLabel).toBe('主要アクション');
    expect(japaneseHome.facts.ariaLabel).toBe('Rainrail の運用モデル');
    expect(japaneseHome.console.decisionsLabel).toBe('ルーティング判断');
    expect(japaneseHome.console.events.map((event) => event.label)).toEqual([
      '開発イベント',
      '中立イベント',
      'ポリシーとプラグインルーティング',
      'エージェントワークフロー',
    ]);
    expect(japaneseHome.console.logs).toEqual([
      'source adapter github.issue に一致',
      'payload を rainrail.event.v1 契約で正規化',
      'runtime provider openclaw へ dispatch',
    ]);
    expect(japaneseHome.sections.map((section) => section.eyebrow)).toContain(
      '中核ワークフロー',
    );
    expect(japaneseHome.cta.actions.map((action) => action.label)).toEqual([
      '技術ドキュメント',
      'ランタイム契約',
      'Issue を見る',
    ]);
  });

  it('publishes sitemap entries from the localized page model', () => {
    expect(sitemapRoute).toContain('supportedLocales.flatMap');
    expect(sitemapRoute).toContain('pageIds.map');
    expect(sitemapRoute).toContain('getDashboardRoutes().map');
    expect(sitemapRoute).toContain('getDashboardHref(locale, route.id)');
    expect(sitemapRoute).toContain('getLocaleHref(locale, pageId)');
    expect(sitemapRoute).toContain('application/xml');
  });

  it('keeps docs drift manifest pointed at the product content source', () => {
    /** @type {{ contracts: Array<{ id: string, docs: string[] }> }} */
    const manifest = JSON.parse(contractsManifest);
    const coreBoundary = manifest.contracts.find(
      (contract) => contract.id === 'core-eep-bridge-source-adapter-boundary',
    );

    if (coreBoundary === undefined) {
      throw new Error('core-eep-bridge-source-adapter-boundary contract is missing');
    }

    expect(coreBoundary.docs).toContain('apps/www/src/lib/site-content.ts');
    expect(coreBoundary.docs).not.toContain('apps/www/src/pages/concepts.astro');
    expect(coreBoundary.docs).not.toContain('apps/www/src/pages/guides.astro');
    expect(coreBoundary.docs).not.toContain('apps/www/src/pages/examples.astro');
  });

  it('keeps Japanese visible page content separate from English page copy', () => {
    expect(siteContent).not.toContain('...english.concepts');
    expect(siteContent).not.toContain('...english.guides');
    expect(siteContent).not.toContain('...english.examples');
    expect(siteContent).not.toContain('...english.docs');
    expect(siteContent).not.toContain('english.concepts.sections[0]');
    expect(siteContent).not.toContain('english.guides.sections[0]');
    expect(siteContent).not.toContain('english.examples.sections[0]');
    expect(siteContent).not.toContain('english.docs.sections[0]');
  });

  it('exposes Concepts, Guides, and Examples from the primary navigation and docs gateway', () => {
    expect(layout).toContain('site.nav.primary.map');
    expect(layout).toContain('hrefFor(item.pageId)');
    expect(layout).toContain('item.href ?? hrefFor(item.pageId)');
    expect(i18n).toContain("href: 'https://docs.rainrail.dev/'");

    for (const pageId of ['concepts', 'guides', 'examples']) {
      expect(siteContent).toContain(`pageId: '${pageId}'`);
    }

    expect(dashboardContent).toContain('Rainrail Operations');
    expect(dashboardContent).toContain('Rainrail 運用');
  });

  it('points primary product navigation and home CTAs to the self-hosted docs site', () => {
    const englishHome = getProductPageContent('en', 'home');
    const japaneseHome = getProductPageContent('ja', 'home');

    if (englishHome.kind !== 'home' || japaneseHome.kind !== 'home') {
      throw new Error('Localized home content must use the home renderer');
    }

    expect(i18n).toContain("href: 'https://docs.rainrail.dev/'");
    expect(englishHome.actions).toContainEqual(
      expect.objectContaining({ label: 'Open developer docs', href: 'https://docs.rainrail.dev/' }),
    );
    expect(japaneseHome.actions).toContainEqual(
      expect.objectContaining({ label: '技術ドキュメントを開く', href: 'https://docs.rainrail.dev/' }),
    );
  });

  it('publishes the initial Concepts content with links to public docs contract pages', () => {
    for (const term of [
      'RainrailEventEnvelope',
      'Source plugin',
      'Source bundle',
      'Workflow plugin',
      'Runtime provider',
      'Codex App Server',
      'Bridge room',
    ]) {
      expect(siteContent).toContain(term);
    }

    expect(siteContent).toContain('`${publicDocsBase}/reference/plugin-runtime/`');
    expect(siteContent).toContain('`${publicDocsBase}/concepts/event-delivery/`');
  });

  it('publishes the initial Guides content for the first operational workflows', () => {
    for (const guide of [
      'GitHub issue automation',
      'Manual and chat intake',
      'PR review loop',
      'Cloudflare event reporting',
    ]) {
      expect(siteContent).toContain(guide);
    }

    expect(siteContent).toContain('`${publicDocsBase}/operations/task-queue/`');
    expect(siteContent).toContain('`${publicDocsBase}/operations/cloudflare-worker/`');
  });

  it('keeps CLI setup docs minimal and points command details at rainrail help', () => {
    expect(siteContent).toContain('CLI quick start');
    expect(readme).toContain('## Getting Started');

    for (const command of [
      'curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes',
      'exec $SHELL',
      'rainrail help',
      'mkdir -p ~/rainrail-sandbox',
      'cd ~/rainrail-sandbox',
      'mkdir my-agent-ops',
      'cd my-agent-ops',
      'rainrail init',
      'cat rainrail.config.json',
      'rainrail openclaw help',
      'rainrail openclaw session test help',
      'rainrail <plugin> help',
    ]) {
      expect(siteContent).toContain(command);
    }

    for (const command of [
      'curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes',
      'exec $SHELL',
      'rainrail help',
      'mkdir -p ~/rainrail-sandbox',
      'cd ~/rainrail-sandbox',
      'mkdir my-agent-ops',
      'cd my-agent-ops',
      'rainrail init',
      'cat rainrail.config.json',
      'rainrail openclaw help',
      'rainrail openclaw session test help',
      'rainrail setup codex-app-server --yes',
      'rainrail plugin codex-app-server doctor',
      'rainrail plugin codex-app-server session test',
    ]) {
      expect(readme).toContain(command);
    }

    expect(readme).toContain('Node.js 22.5 or newer');
    expect(readme).toContain('adds a separate `codex-app-server` runtime provider entry');
    expect(readme).toContain('replace, or proxy the OpenClaw plugin');
    expect(siteContent).not.toContain('less install.sh');
    expect(siteContent).not.toContain('bash install.sh');
    expect(siteContent).not.toContain('Usage: rainrail github');
    expect(siteContent).not.toContain('Usage: rainrail cloudflare');
    expect(siteContent).not.toContain('Usage: rainrail openclaw');
    expect(siteContent).not.toContain('webhook add');
  });

  it('publishes the root installer through the product site public assets', () => {
    expect(existsSync(publicInstallScript)).toBe(true);
    expect(realpathSync(publicInstallScript)).toBe(realpathSync(rootInstallScript));
  });

  it('publishes an end-to-end example from GitHub issue to merge', () => {
    for (const step of [
      'GitHub issue',
      'Manual or chat message',
      'Project queue',
      'agent run',
      'codex-app-server plugin',
      'pull request',
      'review',
      'merge',
    ]) {
      expect(siteContent).toContain(step);
    }
  });

  it('links product readers to repository work surfaces and public docs contracts', () => {
    for (const target of [
      'https://github.com/reirei-lab/rainrail',
      '/issues',
      '`${publicDocsBase}/reference/plugin-runtime/`',
      '`${publicDocsBase}/`',
    ]) {
      expect(siteContent).toContain(target);
    }
  });
});
