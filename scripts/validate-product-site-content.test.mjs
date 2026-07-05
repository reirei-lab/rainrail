import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
const docsPage = page('docs');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const rootInstallScript = new URL('../install.sh', import.meta.url);
const publicInstallScript = new URL('../apps/www/public/install.sh', import.meta.url);

describe('product site concepts, guides, and examples', () => {
  it('exposes Concepts, Guides, and Examples from the primary navigation and docs gateway', () => {
    for (const href of ['/concepts', '/guides', '/examples']) {
      expect(layout).toContain(`href="${href}"`);
      expect(docsPage).toContain(`href: '${href}'`);
    }
  });

  it('publishes the initial Concepts content with links back to implementation contracts', () => {
    const concepts = page('concepts');

    for (const term of [
      'RainrailEventEnvelope',
      'Source plugin',
      'Source bundle',
      'Workflow plugin',
      'Runtime provider',
      'Bridge room',
    ]) {
      expect(concepts).toContain(term);
    }

    expect(concepts).toContain('docs/plugin-runtime-contract.md');
    expect(concepts).toContain('docs/event-delivery.md');
  });

  it('publishes the initial Guides content for the first operational workflows', () => {
    const guides = page('guides');

    for (const guide of [
      'GitHub issue automation',
      'Manual and chat intake',
      'PR review loop',
      'Cloudflare event reporting',
    ]) {
      expect(guides).toContain(guide);
    }

    expect(guides).toContain('docs/task-queue-project-issues.md');
    expect(guides).toContain('docs/cloudflare-worker.md');
  });

  it('keeps CLI setup docs minimal and points command details at rainrail help', () => {
    expect(docsPage).toContain('CLI quick start');
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
      expect(docsPage).toContain(command);
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
    ]) {
      expect(readme).toContain(command);
    }

    expect(readme).toContain('Node.js 20 or newer');
    expect(docsPage).not.toContain('less install.sh');
    expect(docsPage).not.toContain('bash install.sh');
    expect(docsPage).not.toContain('Usage: rainrail github');
    expect(docsPage).not.toContain('Usage: rainrail cloudflare');
    expect(docsPage).not.toContain('Usage: rainrail openclaw');
    expect(docsPage).not.toContain('webhook add');
  });

  it('publishes the root installer through the product site public assets', () => {
    expect(existsSync(publicInstallScript)).toBe(true);
    expect(realpathSync(publicInstallScript)).toBe(realpathSync(rootInstallScript));
  });

  it('publishes an end-to-end example from GitHub issue to merge', () => {
    const examples = page('examples');

    for (const step of [
      'GitHub issue',
      'Manual or chat message',
      'Project queue',
      'agent run',
      'pull request',
      'review',
      'merge',
    ]) {
      expect(examples).toContain(step);
    }
  });

  it('links product readers back to repository work surfaces and engineering contracts', () => {
    const homepage = page('index');

    for (const target of [
      'https://github.com/reirei-lab/rainrail',
      'https://github.com/reirei-lab/rainrail/issues',
      'https://github.com/reirei-lab/rainrail/blob/main/docs/plugin-runtime-contract.md',
      'https://github.com/reirei-lab/rainrail/blob/main/docs/README.md',
    ]) {
      expect(homepage).toContain(target);
      expect(docsPage).toContain(target);
    }
  });
});
