const pagesUrl = requiredEnv('RAINRAIL_PAGES_URL').replace(/\/+$/u, '');

const routes = [
  { path: '/', expectedText: 'Rainrail' },
  { path: '/docs', expectedText: 'Docs' },
  { path: '/how-it-works', expectedText: 'How it works' },
];

for (const route of routes) {
  await expectHtml(route.path, route.expectedText);
}

console.log(`Cloudflare Pages smoke passed for ${pagesUrl}`);

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
 * @param {string} expectedText
 */
async function expectHtml(path, expectedText) {
  const response = await fetch(`${pagesUrl}${path}`);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`${path} returned ${contentType}, expected text/html`);
  }

  if (!body.includes(expectedText)) {
    throw new Error(`${path} did not include ${JSON.stringify(expectedText)}`);
  }
}
