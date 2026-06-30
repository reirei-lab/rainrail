import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function main() {
  const wranglerConfig = JSON.parse(stripJsonComments(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
  const requiredSecrets = parseRequiredSecrets(wranglerConfig);

  if (requiredSecrets.length === 0) {
    console.log('No required Cloudflare Worker secrets configured.');
    return 0;
  }

  const result = spawnSync('wrangler', ['secret', 'list', '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write('Failed to list Cloudflare Worker secrets before deploy.\n');
    return result.status ?? 1;
  }

  const availableSecrets = parseSecretList(result.stdout);
  const missingSecrets = requiredSecrets.filter((secretName) => !availableSecrets.has(secretName));

  if (missingSecrets.length > 0) {
    process.stderr.write(`Missing Cloudflare Worker secrets: ${missingSecrets.join(', ')}\n`);
    process.stderr.write('Register them with `pnpm exec wrangler secret put <NAME>` before deploy.\n');
    return 1;
  }

  console.log(`Cloudflare Worker secrets present: ${requiredSecrets.join(', ')}`);
  return 0;
}

/**
 * @param {string} source
 * @returns {string}
 */
function stripJsonComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * @param {unknown} config
 * @returns {string[]}
 */
export function parseRequiredSecrets(config) {
  if (!isRecord(config) || !isRecord(config.secrets) || !Array.isArray(config.secrets.required)) {
    return [];
  }

  return config.secrets.required.filter((item) => typeof item === 'string');
}

/**
 * @param {string} stdout
 * @returns {Set<string>}
 */
export function parseSecretList(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('wrangler secret list did not return an array');
  }

  return new Set(parsed
    .map((item) => isRecord(item) ? item.name : undefined)
    .filter((name) => typeof name === 'string'));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invokedScript = process.argv[1];

if (invokedScript && import.meta.url === pathToFileURL(invokedScript).href) {
  process.exitCode = main();
}
