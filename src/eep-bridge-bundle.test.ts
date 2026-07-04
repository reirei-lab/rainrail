import { describe, expect, it } from 'vitest';

import {
  createRainrailEepBridgeIntakeAdapters,
  createRainrailEepBridgeIntakeAdaptersFromConfig,
  createRainrailEepBridgeIntakeAdaptersFromEnv,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  parseConfig,
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

  it('can omit the bundled Cloudflare tail ingress for callers with their own tail adapter', () => {
    const adapters = createRainrailEepBridgeIntakeAdapters({
      env: { GITHUB_WEBHOOK_SECRET: 'secret' },
      includeCloudflareTail: false,
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual(['github-webhook']);
    expect(adapters[0]?.routes?.map((route) => route.path)).toEqual(['/webhooks/github']);
  });

  it('creates EEP Bridge intake adapters from Rainrail config source bundle composition', () => {
    const config = parseConfig({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'worker-ingress',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-production-webhook',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'GITHUB_WEBHOOK_SECRET',
              endpoint: '/github',
              maxBodyBytes: 2048,
            },
            {
              type: 'cloudflare-tail',
              name: 'prod-tail',
              sourceType: 'cloudflare',
            },
          ],
        },
      ],
    });

    const adapters = createRainrailEepBridgeIntakeAdaptersFromConfig({
      config,
      env: { GITHUB_WEBHOOK_SECRET: 'secret-value' },
      bundleName: 'worker-ingress',
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual([
      'github-production-webhook',
      'prod-tail',
    ]);
    expect(adapters[0]?.routes?.[0]?.path).toBe('/github');
    expect(adapters[0]?.routes?.[0]?.maxBodyBytes).toBe(2048);
    expect(adapters[1]?.tail).toEqual(expect.any(Function));
  });

  it('uses the configured Cloudflare tail source name for published events', async () => {
    const config = parseConfig({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'worker-ingress',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-webhook',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            },
            {
              type: 'cloudflare-tail',
              name: 'prod-tail',
              sourceType: 'cloudflare',
            },
          ],
        },
      ],
    });
    const adapters = createRainrailEepBridgeIntakeAdaptersFromConfig({
      config,
      env: { GITHUB_WEBHOOK_SECRET: 'secret-value' },
    });
    const published: unknown[] = [];

    await adapters[1]?.tail?.([{
      eventTimestamp: '2026-06-30T12:00:00.000Z',
      outcome: 'ok',
      scriptName: 'rainrail-worker',
      event: {
        request: {
          method: 'GET',
          url: 'https://rainrail.example/healthz',
          headers: { 'cf-ray': 'ray-prod-tail' },
        },
        response: { status: 200 },
      },
    }], {
      async publish(event) {
        published.push(event);
        return { ok: true, status: 202 };
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: 'prod-tail:tail-rainrail-worker-20260630T120000000Z-ray-prod-tail:cloudflare.tail',
      source: {
        type: 'cloudflare',
        name: 'prod-tail',
      },
    });
  });

  it('omits Cloudflare tail when the selected config bundle does not include that source', () => {
    const config = parseConfig({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'http-only',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-webhook',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          ],
        },
      ],
    });

    const adapters = createRainrailEepBridgeIntakeAdaptersFromConfig({
      config,
      env: { GITHUB_WEBHOOK_SECRET: 'secret-value' },
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual(['github-webhook']);
  });

  it('rejects config bundles that cannot map to the current EEP Bridge intake contract', () => {
    const config = parseConfig({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'tail-only',
          sources: [
            {
              type: 'cloudflare-tail',
              name: 'cloudflare-tail',
              sourceType: 'cloudflare',
            },
          ],
        },
      ],
    });

    expect(() => createRainrailEepBridgeIntakeAdaptersFromConfig({
      config,
      env: {},
    })).toThrow('config.sourceBundles.tail-only must include exactly one github-webhook source');
  });

  it('rejects config bundles with more than one Cloudflare tail source', () => {
    const config = parseConfig({
      sourceBundles: [
        {
          type: 'eep-bridge',
          name: 'worker-ingress',
          sources: [
            {
              type: 'github-webhook',
              name: 'github-webhook',
              sourceType: 'github',
              provider: 'github',
              webhookSecret: 'GITHUB_WEBHOOK_SECRET',
            },
            {
              type: 'cloudflare-tail',
              name: 'prod-tail',
              sourceType: 'cloudflare',
            },
            {
              type: 'cloudflare-tail',
              name: 'staging-tail',
              sourceType: 'cloudflare',
            },
          ],
        },
      ],
    });

    expect(() => createRainrailEepBridgeIntakeAdaptersFromConfig({
      config,
      env: { GITHUB_WEBHOOK_SECRET: 'secret-value' },
    })).toThrow('config.sourceBundles.worker-ingress must include at most one cloudflare-tail source');
  });
});
