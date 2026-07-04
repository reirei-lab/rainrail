import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { configuredGitHubWebhookEndpoint } from './smoke-cloudflare-worker.mjs';
import { parseRequiredSecrets, parseSecretList } from './validate-cloudflare-secrets.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wranglerConfig = JSON.parse(stripJsonComments(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const cloudflareDocs = readFileSync(new URL('../docs/cloudflare-worker.md', import.meta.url), 'utf8');
const selfHostDeployTemplate = readFileSync(new URL('../docs/templates/cloudflare-self-host-deploy.yml', import.meta.url), 'utf8');

describe('Cloudflare Worker operations', () => {
  it('deploys the Worker entrypoint with the Durable Object binding used by runtime code', () => {
    expect(wranglerConfig.name).toBe('rainrail');
    expect(wranglerConfig.main).toBe('src/worker.ts');
    expect(wranglerConfig.durable_objects.bindings).toContainEqual({
      name: 'BRIDGE_ROOM',
      class_name: 'RainrailBridgeRoomDurableObject',
    });
    expect(wranglerConfig.vars).toEqual({
      BRIDGE_ID: 'events',
    });
  });

  it('keeps required secrets out of wrangler vars and documents their secret names', () => {
    expect(gitignore).toContain('.dev.vars*');
    expect(gitignore).toContain('.env*');
    expect(Object.keys(wranglerConfig.vars ?? {})).not.toEqual(expect.arrayContaining([
      'GITHUB_WEBHOOK_SECRET',
      'RAINRAIL_PUBLISH_TOKEN',
      'SSE_BEARER_TOKEN',
    ]));
    expect(wranglerConfig.secrets.required).toEqual([
      'GITHUB_WEBHOOK_SECRET',
      'RAINRAIL_PUBLISH_TOKEN',
      'SSE_BEARER_TOKEN',
    ]);
    for (const secretName of ['GITHUB_WEBHOOK_SECRET', 'RAINRAIL_PUBLISH_TOKEN', 'SSE_BEARER_TOKEN']) {
      expect(cloudflareDocs).toContain(`\`${secretName}\``);
      expect(cloudflareDocs).toContain(`wrangler secret put ${secretName}`);
    }
  });

  it('exposes local dev, deploy, and smoke commands for the Worker', async () => {
    expect(packageJson.scripts['cf:dev']).toBe('wrangler dev --local');
    expect(packageJson.scripts['cf:deploy']).toBe('node scripts/validate-cloudflare-secrets.mjs && wrangler deploy');
    expect(packageJson.scripts['cf:smoke']).toBe('node scripts/smoke-cloudflare-worker.mjs');
    await expect(access(new URL('./validate-cloudflare-secrets.mjs', import.meta.url))).resolves.toBeUndefined();
    await expect(access(new URL('./smoke-cloudflare-worker.mjs', import.meta.url))).resolves.toBeUndefined();
    expect(cloudflareDocs).toContain('pnpm cf:smoke');
    expect(selfHostDeployTemplate).toContain('RAINRAIL_GITHUB_WEBHOOK_ENDPOINT: ${{ vars.RAINRAIL_GITHUB_WEBHOOK_ENDPOINT }}');
    expect(cloudflareDocs).toContain('RAINRAIL_GITHUB_WEBHOOK_ENDPOINT');
  });

  it('smokes the webhook endpoint without publishing a GitHub issue event', () => {
    const smokeScript = readFileSync(new URL('./smoke-cloudflare-worker.mjs', import.meta.url), 'utf8');

    expect(smokeScript).toContain('RAINRAIL_GITHUB_WEBHOOK_ENDPOINT');
    expect(smokeScript).toContain('RAINRAIL_CONFIG_JSON');
    expect(smokeScript).toContain('${workerUrl}${githubWebhookEndpoint}');
    expect(smokeScript).toContain("'x-github-event': 'ping'");
    expect(smokeScript).toContain('signature_mismatch');
    expect(smokeScript).not.toContain("'x-github-event': 'issues'");
    expect(smokeScript).not.toContain("action: 'opened'");
    expect(cloudflareDocs).toContain('署名不一致');
  });

  it('selects the configured GitHub webhook endpoint for smoke checks', () => {
    expect(configuredGitHubWebhookEndpoint({})).toBe('/webhooks/github');
    expect(configuredGitHubWebhookEndpoint({
      RAINRAIL_GITHUB_WEBHOOK_ENDPOINT: '/github',
    })).toBe('/github');
    expect(configuredGitHubWebhookEndpoint({
      RAINRAIL_CONFIG_JSON: JSON.stringify({
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
                endpoint: '${RAINRAIL_SMOKE_ENDPOINT}',
              },
            ],
          },
        ],
      }),
      RAINRAIL_SMOKE_ENDPOINT: '/configured-github',
    })).toBe('/configured-github');
    expect(() => configuredGitHubWebhookEndpoint({
      RAINRAIL_GITHUB_WEBHOOK_ENDPOINT: 'github',
    })).toThrow('RAINRAIL_GITHUB_WEBHOOK_ENDPOINT must start with "/"');
  });


  it('documents the minimum Cloudflare event path from GitHub webhook to downstream consumers', () => {
    expect(cloudflareDocs).toContain('## 最小経路');
    expect(cloudflareDocs).toContain('`POST /webhooks/github`');
    expect(cloudflareDocs).toContain('GitHub webhook');
    expect(cloudflareDocs).toContain('Rainrail event');
    expect(cloudflareDocs).toContain('`GET /events`');
    expect(cloudflareDocs).toContain('downstream consumer');
    expect(cloudflareDocs).toContain('`Authorization: Bearer <SSE_BEARER_TOKEN>`');
  });

  it('parses required and registered Cloudflare secrets for predeploy validation', () => {
    expect(parseRequiredSecrets(wranglerConfig)).toEqual([
      'GITHUB_WEBHOOK_SECRET',
      'RAINRAIL_PUBLISH_TOKEN',
      'SSE_BEARER_TOKEN',
    ]);
    expect(parseRequiredSecrets(wranglerConfig, {
      RAINRAIL_CONFIG_JSON: JSON.stringify({
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
                webhookSecret: '${RAINRAIL_WEBHOOK_SECRET_NAME}',
              },
            ],
          },
        ],
      }),
      RAINRAIL_WEBHOOK_SECRET_NAME: 'CUSTOM_GITHUB_WEBHOOK_SECRET',
    })).toEqual([
      'CUSTOM_GITHUB_WEBHOOK_SECRET',
      'RAINRAIL_PUBLISH_TOKEN',
      'SSE_BEARER_TOKEN',
    ]);
    expect(parseSecretList(JSON.stringify([
      { name: 'GITHUB_WEBHOOK_SECRET', type: 'secret_text' },
      { name: 'RAINRAIL_PUBLISH_TOKEN', type: 'secret_text' },
    ]))).toEqual(new Set(['GITHUB_WEBHOOK_SECRET', 'RAINRAIL_PUBLISH_TOKEN']));
  });
});

/**
 * @param {string} source
 * @returns {string}
 */
function stripJsonComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, '');
}
