import { describe, expect, it } from 'vitest';

import {
  createRainrailEepBridgeIntakeAdapters,
  createRainrailEepBridgeIntakeAdaptersFromEnv,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
} from './index.js';

describe('Rainrail EEP Bridge bundle', () => {
  it('creates GitHub webhook and Cloudflare tail ingress adapters from one bundle API', () => {
    const adapters = createRainrailEepBridgeIntakeAdaptersFromEnv({
      GITHUB_WEBHOOK_SECRET: 'secret',
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual([
      'github-webhook',
      'cloudflare-tail',
    ]);
    expect(adapters[0]?.routes?.map((route) => route.path)).toEqual(['/webhooks/github']);
    expect(adapters[1]?.tail).toEqual(expect.any(Function));
  });

  it('keeps GitHub webhook source-specific options inside the bundle contract', () => {
    const adapters = createRainrailEepBridgeIntakeAdapters({
      env: { GITHUB_WEBHOOK_SECRET: 'secret' },
      githubSourceName: 'github-production-webhook',
      githubMaxBodyBytes: 1024,
    });

    expect(adapters[0]?.name).toBe('github-production-webhook');
    expect(adapters[0]?.routes?.[0]?.maxBodyBytes).toBe(1024);
    expect(adapters[1]?.name).toBe('cloudflare-tail');
  });

  it('keeps the default GitHub webhook body limit on the bundled route', () => {
    const adapters = createRainrailEepBridgeIntakeAdapters({
      env: { GITHUB_WEBHOOK_SECRET: 'secret' },
    });

    expect(adapters[0]?.routes?.[0]?.maxBodyBytes).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });
});
