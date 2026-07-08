import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const siteContent = readFileSync(
  new URL('../apps/www/src/lib/site-content.ts', import.meta.url),
  'utf8',
);
const localizedRoute = readFileSync(
  new URL('../apps/www/src/pages/[locale]/[...slug].astro', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../apps/www/src/styles/global.css', import.meta.url),
  'utf8',
);

describe('product homepage', () => {
  it('states Rainrail positioning and conversion paths in the first viewport', () => {
    expect(siteContent).toContain('Rainrail');
    expect(siteContent).toContain('development events');
    expect(siteContent).toContain('agent workflows');
    expect(siteContent).toContain('Start with the workflow');
    expect(siteContent).toContain('Open developer docs');
    expect(localizedRoute).toContain("content.kind === 'home'");
  });

  it('shows the core source to runtime workflow as both copy and visual stages', () => {
    for (const stage of [
      'Development event',
      'Neutral event',
      'Policy and plugin routing',
      'Agent workflow',
    ]) {
      expect(siteContent).toContain(stage);
    }

    expect(localizedRoute).toContain('aria-label={content.console.ariaLabel}');
    expect(localizedRoute).toContain('class="route-rail"');
    expect(localizedRoute).toContain('class={`event-card ${event.className}`}');
  });

  it('communicates the developer automation value proposition without SaaS filler', () => {
    for (const phrase of [
      'Webhook storms become ordered work',
      'Contracts stay stable',
      'Plugins own the routing logic',
      'Operators can audit every handoff',
    ]) {
      expect(siteContent).toContain(phrase);
    }

    expect(siteContent).not.toMatch(/unlock.*potential/i);
    expect(siteContent).not.toMatch(/supercharge/i);
  });

  it('keeps the homepage responsive and visually structured', () => {
    expect(globalStyles).toContain('.product-hero');
    expect(globalStyles).toContain('.routing-console');
    expect(globalStyles).toContain('@media (max-width: 860px)');
    expect(globalStyles).toContain('grid-template-columns: 1fr');
    expect(globalStyles).toContain('.route-rail');
    expect(globalStyles).toContain('width: auto;');
    expect(globalStyles).toContain('margin-right: 12px;');
    expect(globalStyles).not.toContain('min(100% - 24px');
  });

  it('keeps the shared hero layout for secondary product pages', () => {
    expect(globalStyles).toMatch(/\.hero\s*{[\s\S]*?grid-template-columns: minmax\(0, 1\.08fr\) minmax\(280px, 0\.92fr\);/);
    expect(globalStyles).toMatch(/\.hero\s*{[\s\S]*?padding: 72px 0 48px;/);
    expect(globalStyles).toMatch(/\.hero\s*{[\s\S]*?align-items: center;/);
  });
});
