const docsUrl = requiredEnv('RAINRAIL_DOCS_URL').replace(/\/+$/u, '');

const routes = [
  { path: '/' },
  { path: '/quickstart/' },
  { path: '/operations/' },
];

for (const route of routes) {
  await expectHtmlHead(route.path);
}

console.log(`Cloudflare Docs Pages smoke passed for ${docsUrl}`);

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
 * @param {string} path
 */
async function expectHtmlHead(path) {
  const response = await fetch(`${docsUrl}${path}`, { method: 'HEAD' });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`${path} returned ${contentType}, expected text/html`);
  }
}
