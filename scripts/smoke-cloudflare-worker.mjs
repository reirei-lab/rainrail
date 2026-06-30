import { createHmac } from 'node:crypto';

const workerUrl = requiredEnv('RAINRAIL_WORKER_URL').replace(/\/+$/u, '');
const webhookSecret = requiredEnv('GITHUB_WEBHOOK_SECRET');

const deliveryId = process.env.GITHUB_DELIVERY_ID ?? `smoke-${Date.now()}`;
const payload = JSON.stringify({
  action: 'opened',
  repository: {
    full_name: 'reirei-lab/rainrail',
    html_url: 'https://github.com/reirei-lab/rainrail',
  },
  issue: {
    number: 28,
    title: 'Cloudflare Worker smoke',
    html_url: 'https://github.com/reirei-lab/rainrail/issues/28',
  },
});

await expectOk('health endpoint', fetch(`${workerUrl}/healthz`));

await expectStatus('webhook endpoint', fetch(`${workerUrl}/webhooks/github`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': githubSignature(webhookSecret, payload),
  },
  body: payload,
}), 202);

console.log(`Cloudflare Worker smoke passed for ${workerUrl}`);

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }

  return value;
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
 */
async function expectStatus(label, responsePromise, expectedStatus) {
  const response = await responsePromise;
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`);
  }
}

/**
 * @param {string} secret
 * @param {string} body
 * @returns {string}
 */
function githubSignature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
