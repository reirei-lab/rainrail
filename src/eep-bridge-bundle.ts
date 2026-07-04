import { createCloudflareTailIntakeAdapter } from './cloudflare-tail.js';
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
  fallbackDeliveryId?: (events: unknown[]) => string | Promise<string>;
}

export function createRainrailEepBridgeIntakeAdaptersFromEnv(
  env: RainrailEepBridgeBundleEnv,
): readonly RainrailIntakeAdapter[] {
  return createRainrailEepBridgeIntakeAdapters({ env });
}

export function createRainrailEepBridgeIntakeAdapters({
  env,
  githubSourceName,
  githubMaxBodyBytes,
  fallbackDeliveryId = stableIntakeFallbackDeliveryId,
}: RainrailEepBridgeIntakeAdaptersOptions): readonly RainrailIntakeAdapter[] {
  return [
    createGitHubWebhookIntakeAdapter({
      secret: gitHubWebhookSecretFromEnv(env),
      ...(githubSourceName === undefined ? {} : { sourceName: githubSourceName }),
      ...(githubMaxBodyBytes === undefined ? {} : { maxBodyBytes: githubMaxBodyBytes }),
    }),
    createCloudflareTailIntakeAdapter({
      fallbackDeliveryId,
    }),
  ];
}

function gitHubWebhookSecretFromEnv(env: RainrailEepBridgeBundleEnv): string {
  return env.GITHUB_WEBHOOK_SECRET ?? '';
}
