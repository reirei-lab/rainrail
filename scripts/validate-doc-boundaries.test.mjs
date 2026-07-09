import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contentPlan = readFileSync(
  new URL('../docs/product-site-information-architecture.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
const contractsManifest = readFileSync(
  new URL('../docs/contracts.manifest.json', import.meta.url),
  'utf8',
);
const pluginRuntimeContract = readFileSync(
  new URL('../docs/plugin-runtime-contract.md', import.meta.url),
  'utf8',
);
const eventDeliveryContract = readFileSync(
  new URL('../docs/event-delivery.md', import.meta.url),
  'utf8',
);
const coverageMatrix = readFileSync(
  new URL('../docs/repo-test-coverage-matrix.md', import.meta.url),
  'utf8',
);
const coreBridgeBoundary = readFileSync(
  new URL('../docs/core-eep-bridge-source-adapter-boundary.md', import.meta.url),
  'utf8',
);
const cliUpdateAndVersion = readFileSync(
  new URL('../docs/cli-update-and-version.md', import.meta.url),
  'utf8',
);

describe('product site information architecture', () => {
  it('keeps the product sitemap, docs boundary, and content priorities in one plan', () => {
    expect(contentPlan).toContain('# Product site information architecture');
    expect(contentPlan).toContain('## Product site sitemap');
    expect(contentPlan).toContain('## Documentation boundary');
    expect(contentPlan).toContain('## Surface roles');
    expect(contentPlan).toContain('## Initial page priority');

    expect(contentPlan).toContain('`apps/www`');
    expect(contentPlan).toContain('`docs/`');
    expect(contentPlan).toContain('`README.md`');
    expect(contentPlan).toContain('`examples/`');
  });

  it('links the plan from the project README', () => {
    expect(readme).toContain('docs/product-site-information-architecture.md');
  });

  it('keeps README and docs index entry points aligned with product and engineering surfaces', () => {
    for (const entry of [
      'https://rainrail.dev',
      'https://rainrail.dev/docs',
      'docs/README.md',
      'docs/plugin-runtime-contract.md',
      'docs/task-queue-project-issues.md',
      'docs/cli-update-and-version.md',
      'docs/cloudflare-pages.md',
      'apps/www',
      'src/',
      'scripts/',
      'Core keeps provider-neutral event delivery, replay, dispatch, runtime gates, and operational state',
      'Source bundles compose ingress adapters such as EEP Bridge, GitHub webhook, Cloudflare tail, manual input, and web chat',
    ]) {
      expect(readme).toContain(entry);
    }

    for (const entry of [
      'https://rainrail.dev',
      'https://rainrail.dev/docs',
      'plugin-runtime-contract.md',
      'github-webhook-normalization.md',
      'event-delivery.md',
      'task-queue-project-issues.md',
      'cli-update-and-version.md',
      'cloudflare-worker.md',
      'cloudflare-pages.md',
      'repo-test-coverage-matrix.md',
    ]) {
      expect(docsIndex).toContain(entry);
    }
  });

  it('documents the Core, EEP Bridge bundle, Source adapter, and transport boundary', () => {
    for (const entry of [
      'Core responsibilities',
      'EEP Bridge bundle responsibilities',
      'Source adapter responsibilities',
      'Transport and Core boundary',
      'Current Core also keeps narrow provider-aware durable replay sanitization',
      'Source adapter output is not limited to the durable replay allowlist',
      'The public `createRainrailHttpApp` surface does not expose a generic `POST /publish` route',
      'Manual input and web chat are source adapters, not EEP Bridge responsibilities',
      'Command action audit attribution is a transport/core-adapter responsibility',
      'Dashboard layout metadata such as `filteredItemCount` is also a provider-neutral',
    ]) {
      expect(coreBridgeBoundary).toContain(entry);
    }

    expect(docsIndex).toContain('core-eep-bridge-source-adapter-boundary.md');

    const manifest = JSON.parse(contractsManifest);
    expect(manifest.contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'core-eep-bridge-source-adapter-boundary',
          docs: expect.arrayContaining([
            'docs/core-eep-bridge-source-adapter-boundary.md',
            'README.md',
            'docs/repo-test-coverage-matrix.md',
            'apps/www/src/lib/site-content.ts',
          ]),
        }),
      ]),
    );
  });

  it('keeps source bundle boundaries consistent across runtime, delivery, and coverage docs', () => {
    for (const text of [pluginRuntimeContract, eventDeliveryContract, coverageMatrix]) {
      expect(text).toContain('source bundle');
      expect(text).toContain('manual/chat');
    }

    expect(pluginRuntimeContract).toContain('EEP Bridge bundle is one source bundle');
    expect(eventDeliveryContract).toContain('Core-owned routes stay provider-neutral');
    expect(coverageMatrix).toContain('Core/source boundary mapping');
    expect(coverageMatrix).toContain('Manual/chat input is covered outside the legacy EEP Bridge inventories');
  });

  it('documents CLI version and update-check behavior from the implemented command surface', () => {
    for (const entry of [
      'rainrail version',
      'rainrail update check',
      'rainrail update --version release/0.2.1',
      'Rainrail 0.2.1 is available',
      'Rainrail is up to date (0.2.1).',
      'Unable to check Rainrail updates. Try again later.',
      'update-check.json',
      'cached',
      'Automatic update notice',
    ]) {
      expect(cliUpdateAndVersion).toContain(entry);
    }

    expect(readme).toContain('rainrail version');
    expect(readme).toContain('rainrail update check');
    expect(docsIndex).toContain('CLI update check and version commands');
  });
});
