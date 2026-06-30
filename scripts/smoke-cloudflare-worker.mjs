const workerUrl = requiredEnv('RAINRAIL_WORKER_URL').replace(/\/+$/u, '');

const deliveryId = process.env.GITHUB_DELIVERY_ID ?? `smoke-${Date.now()}`;
const payload = JSON.stringify({
  zen: 'Rainrail webhook smoke avoids publishing production events.',
});
const invalidSignature = `sha256=${'0'.repeat(64)}`;

await expectOk('health endpoint', fetch(`${workerUrl}/healthz`));

await expectJsonError('webhook endpoint', fetch(`${workerUrl}/webhooks/github`, {
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
