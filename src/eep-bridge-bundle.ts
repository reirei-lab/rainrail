import { createCloudflareTailIntakeAdapter } from './cloudflare-tail.js';
import type { RainrailConfig } from './config.js';
import { createGitHubWebhookIntakeAdapter } from './github-webhook.js';
import { stableIntakeFallbackDeliveryId } from './http-app.js';
import type { RainrailIntakeAdapter } from './intake-adapter.js';

export interface RainrailEepBridgeBundleEnv {
  GITHUB_WEBHOOK_SECRET?: string;
}

export interface RainrailEepBridgeIntakeAdaptersOptions {
  env: RainrailEepBridgeBundleEnv;
  githubSourceName?: string;
  githubMaxBodyBytes?: number;
  includeCloudflareTail?: boolean;
  fallbackDeliveryId?: (events: unknown[]) => string | Promise<string>;
}

export function createRainrailEepBridgeIntakeAdaptersFromEnv(
  env: RainrailEepBridgeBundleEnv,
): readonly RainrailIntakeAdapter[] {
  return createRainrailEepBridgeIntakeAdapters({ env });
}

export interface RainrailEepBridgeIntakeAdaptersConfigOptions {
  config: RainrailConfig;
  env: RainrailEepBridgeBundleEnv;
  bundleName?: string;
  fallbackDeliveryId?: (events: unknown[]) => string | Promise<string>;
}

export function createRainrailEepBridgeIntakeAdaptersFromConfig({
  config,
  env,
  bundleName,
  fallbackDeliveryId,
}: RainrailEepBridgeIntakeAdaptersConfigOptions): readonly RainrailIntakeAdapter[] {
  const bundle = bundleName === undefined
    ? config.sourceBundles.find((candidate) => candidate.type === 'eep-bridge')
    : config.sourceBundles.find((candidate) => candidate.type === 'eep-bridge' && candidate.name === bundleName);
  if (bundle === undefined) {
    throw new Error(bundleName === undefined
      ? 'config.sourceBundles must include an eep-bridge bundle'
      : `config.sourceBundles must include eep-bridge bundle "${bundleName}"`);
  }

  const githubSources = bundle.sources.filter((source) => source.type === 'github-webhook');
  if (githubSources.length !== 1) {
    throw new Error(`config.sourceBundles.${bundle.name} must include exactly one github-webhook source`);
  }

  const githubSource = githubSources[0]!;
  return createRainrailEepBridgeIntakeAdapters({
    env: {
      GITHUB_WEBHOOK_SECRET: secretValueFromEnv(env, githubSource.webhookSecret),
    },
    githubSourceName: githubSource.name,
    ...(githubSource.maxBodyBytes === undefined ? {} : { githubMaxBodyBytes: githubSource.maxBodyBytes }),
    includeCloudflareTail: bundle.sources.some((source) => source.type === 'cloudflare-tail'),
    ...(fallbackDeliveryId === undefined ? {} : { fallbackDeliveryId }),
  });
}

export function createRainrailEepBridgeIntakeAdapters({
  env,
  githubSourceName,
  githubMaxBodyBytes,
  includeCloudflareTail = true,
  fallbackDeliveryId = stableIntakeFallbackDeliveryId,
}: RainrailEepBridgeIntakeAdaptersOptions): readonly RainrailIntakeAdapter[] {
  const adapters: RainrailIntakeAdapter[] = [
    createGitHubWebhookIntakeAdapter({
      secret: gitHubWebhookSecretFromEnv(env),
      ...(githubSourceName === undefined ? {} : { sourceName: githubSourceName }),
      ...(githubMaxBodyBytes === undefined ? {} : { maxBodyBytes: githubMaxBodyBytes }),
    }),
  ];

  if (includeCloudflareTail) {
    adapters.push(createCloudflareTailIntakeAdapter({
      fallbackDeliveryId,
    }));
  }

  return adapters;
}

function gitHubWebhookSecretFromEnv(env: RainrailEepBridgeBundleEnv): string {
  return env.GITHUB_WEBHOOK_SECRET ?? '';
}

function secretValueFromEnv(env: RainrailEepBridgeBundleEnv, secretName: string | undefined): string {
  if (secretName === undefined) {
    return '';
  }
  return (env as Record<string, string | undefined>)[secretName] ?? '';
}
