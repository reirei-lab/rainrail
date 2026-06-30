import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wranglerConfig = JSON.parse(stripJsonComments(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const cloudflareDocs = readFileSync(new URL('../docs/cloudflare-worker.md', import.meta.url), 'utf8');

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
    expect(gitignore).toContain('.dev.vars');
    expect(Object.keys(wranglerConfig.vars ?? {})).not.toEqual(expect.arrayContaining([
      'GITHUB_WEBHOOK_SECRET',
      'RAINRAIL_PUBLISH_TOKEN',
      'SSE_BEARER_TOKEN',
    ]));
    for (const secretName of ['GITHUB_WEBHOOK_SECRET', 'RAINRAIL_PUBLISH_TOKEN', 'SSE_BEARER_TOKEN']) {
      expect(cloudflareDocs).toContain(`\`${secretName}\``);
      expect(cloudflareDocs).toContain(`wrangler secret put ${secretName}`);
    }
  });

  it('exposes local dev, deploy, and smoke commands for the Worker', async () => {
    expect(packageJson.scripts['cf:dev']).toBe('wrangler dev --local');
    expect(packageJson.scripts['cf:deploy']).toBe('wrangler deploy');
    expect(packageJson.scripts['cf:smoke']).toBe('node scripts/smoke-cloudflare-worker.mjs');
    await expect(access(new URL('./smoke-cloudflare-worker.mjs', import.meta.url))).resolves.toBeUndefined();
    expect(cloudflareDocs).toContain('pnpm cf:smoke');
  });
});

/**
 * @param {string} source
 * @returns {string}
 */
function stripJsonComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, '');
}
