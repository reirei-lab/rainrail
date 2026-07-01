import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homepage = readFileSync(
  new URL('../apps/www/src/pages/index.astro', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../apps/www/src/styles/global.css', import.meta.url),
  'utf8',
);

describe('product homepage', () => {
  it('states Rainrail positioning and conversion paths in the first viewport', () => {
    expect(homepage).toContain('Rainrail');
    expect(homepage).toContain('development events');
    expect(homepage).toContain('agent workflows');
    expect(homepage).toContain('Start with the workflow');
    expect(homepage).toContain('Inspect the contracts');
  });

  it('shows the core source to runtime workflow as both copy and visual stages', () => {
    for (const stage of [
      'Development event',
      'Neutral event',
      'Policy and plugin routing',
      'Agent workflow',
    ]) {
      expect(homepage).toContain(stage);
    }

    expect(homepage).toContain('aria-label="Rainrail routing console"');
    expect(homepage).toContain('class="route-rail"');
    expect(homepage).toContain('class="event-card source"');
    expect(homepage).toContain('class="event-card workflow"');
  });

  it('communicates the developer automation value proposition without SaaS filler', () => {
    for (const phrase of [
      'Webhook storms become ordered work',
      'Contracts stay stable',
      'Plugins own the routing logic',
      'Operators can audit every handoff',
    ]) {
      expect(homepage).toContain(phrase);
    }

    expect(homepage).not.toMatch(/unlock.*potential/i);
    expect(homepage).not.toMatch(/supercharge/i);
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
});
