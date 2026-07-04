import { pathToFileURL } from 'node:url';

export async function main(env = process.env, fetchImpl = fetch) {
  const workerUrl = requiredEnv(env, 'RAINRAIL_WORKER_URL').replace(/\/+$/u, '');
  const githubWebhookEndpoint = configuredGitHubWebhookEndpoint(env);

  const deliveryId = env.GITHUB_DELIVERY_ID ?? `smoke-${Date.now()}`;
  const payload = JSON.stringify({
    zen: 'Rainrail webhook smoke avoids publishing production events.',
  });
  const invalidSignature = `sha256=${'0'.repeat(64)}`;

  await expectOk('health endpoint', fetchImpl(`${workerUrl}/healthz`));

  await expectJsonError('webhook endpoint', fetchImpl(`${workerUrl}${githubWebhookEndpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': invalidSignature,
    },
    body: payload,
  }), 401, 'signature_mismatch');

  console.log(`Cloudflare Worker smoke passed for ${workerUrl}`);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }

  return value;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function configuredGitHubWebhookEndpoint(env) {
  const explicitEndpoint = env.RAINRAIL_GITHUB_WEBHOOK_ENDPOINT;
  if (explicitEndpoint !== undefined && explicitEndpoint.length > 0) {
    return parseEndpoint(explicitEndpoint, 'RAINRAIL_GITHUB_WEBHOOK_ENDPOINT');
  }

  const rawConfig = env.RAINRAIL_CONFIG_JSON;
  if (rawConfig === undefined || rawConfig.length === 0) {
    return '/webhooks/github';
  }

  const config = JSON.parse(expandEnv(rawConfig, env));
  const source = firstGitHubWebhookSource(config);
  if (source === undefined || typeof source.endpoint !== 'string') {
    return '/webhooks/github';
  }

  return parseEndpoint(source.endpoint, 'RAINRAIL_CONFIG_JSON github-webhook.endpoint');
}

/**
 * @param {unknown} config
 * @returns {Record<string, unknown> | undefined}
 */
function firstGitHubWebhookSource(config) {
  const bundles = isRecord(config) ? config.sourceBundles : undefined;
  if (!Array.isArray(bundles)) return undefined;

  for (const bundle of bundles) {
    const sources = isRecord(bundle) ? bundle.sources : undefined;
    if (!Array.isArray(sources)) continue;
    const source = sources.find((candidate) => isRecord(candidate) && candidate.type === 'github-webhook');
    if (isRecord(source)) return source;
  }

  return undefined;
}

/**
 * @param {string} endpoint
 * @param {string} label
 * @returns {string}
 */
function parseEndpoint(endpoint, label) {
  if (!endpoint.startsWith('/')) {
    throw new Error(`${label} must start with "/"`);
  }
  if (endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error(`${label} must be a path without query or fragment`);
  }
  return endpoint;
}

/**
 * @param {string} raw
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function expandEnv(raw, env) {
  return raw.replace(
    /\$\{([A-Z0-9_]+)\}/gu,
    (_match, name) => JSON.stringify(env[name] ?? '').slice(1, -1),
  );
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
  await main();
}

/**
 * @param {string} label
 * @param {Promise<Response>} responsePromise
 */
async function expectOk(label, responsePromise) {
  const response = await responsePromise;
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
  }
}

/**
 * @param {string} label
 * @param {Promise<Response>} responsePromise
 * @param {number} expectedStatus
 * @param {string} expectedError
 */
async function expectJsonError(label, responsePromise, expectedStatus, expectedError) {
  const response = await responsePromise;
  const bodyText = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}: ${bodyText}`);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`${label} returned non-JSON body: ${bodyText}`);
  }

  if (body?.error !== expectedError) {
    throw new Error(`${label} returned ${bodyText}, expected error ${expectedError}`);
  }
}
