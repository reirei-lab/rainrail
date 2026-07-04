import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Rainrail Worker entrypoint boundary', () => {
  it('keeps provider-specific intake adapters in the EEP Bridge bundle', () => {
    const workerSource = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
    const bundleSource = readFileSync(new URL('./eep-bridge-bundle.ts', import.meta.url), 'utf8');

    expect(workerSource).not.toContain('./github-webhook.js');
    expect(workerSource).not.toContain('./cloudflare-tail.js');
    expect(workerSource).toContain('./eep-bridge-bundle.js');
    expect(bundleSource).toContain('createGitHubWebhookIntakeAdapter');
    expect(bundleSource).toContain('createCloudflareTailIntakeAdapter');
  });
});
