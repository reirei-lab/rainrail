import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
const outdir = join(root, '.tmp', 'wrangler-deploy-dry-run');
const logPath = join(root, '.tmp', 'wrangler-deploy-dry-run.log');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(dirname(logPath), { recursive: true });

const smokeScript = readFileSync(new URL('./smoke-cloudflare-worker.mjs', import.meta.url), 'utf8');
const deployTemplate = readFileSync(new URL('../docs/templates/cloudflare-self-host-deploy.yml', import.meta.url), 'utf8');
const wranglerConfig = JSON.parse(stripJsonComments(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
const summaryRows = [];
const disallowedWebhookEvent = ['issu', 'es'].join('');
const disallowedWebhookAction = ['open', 'ed'].join('');

const smokeGuardOk = smokeScript.includes("'x-github-event': 'ping'")
  && smokeScript.includes('signature_mismatch')
  && !smokeScript.includes(`'x-github-event': '${disallowedWebhookEvent}'`)
  && !smokeScript.includes(`action: '${disallowedWebhookAction}'`);

summaryRows.push({
  check: 'Smoke template guard',
  ok: smokeGuardOk,
  detail: smokeGuardOk
    ? 'Only health and invalid ping signature checks are allowed.'
    : 'Smoke script must avoid issue/opened events and replay-producing payloads.',
});

const requiredInputs = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'RAINRAIL_WORKER_URL',
  ...parseRequiredSecrets(wranglerConfig),
];
const requiredInputsOk = requiredInputs.every((name) => deployTemplate.includes(name));

summaryRows.push({
  check: 'Required deploy inputs',
  ok: requiredInputsOk,
  detail: requiredInputsOk
    ? `Template documents ${requiredInputs.join(', ')}.`
    : 'Template is missing one or more required vars/secrets.',
});

const dryRun = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir], {
  cwd: root,
  encoding: 'utf8',
});
const dryRunOutput = `${dryRun.stdout ?? ''}${dryRun.stderr ?? ''}`;
writeFileSync(logPath, dryRunOutput);

const dryRunOk = dryRun.status === 0;
const bundleFiles = existsSync(outdir) ? listFiles(outdir) : [];

summaryRows.push({
  check: 'Wrangler deploy dry run',
  ok: dryRunOk,
  detail: dryRunOk ? `Dry run completed. Log: ${relativePath(logPath)}` : logExcerpt(dryRunOutput),
});

summaryRows.push({
  check: 'Worker bundle dry run',
  ok: dryRunOk && bundleFiles.length > 0,
  detail: bundleFiles.length > 0
    ? `Generated ${bundleFiles.length} bundle file(s) in ${relativePath(outdir)}.`
    : `No bundle files were generated in ${relativePath(outdir)}.`,
});

writeSummary(summaryRows);

if (summaryRows.some((row) => !row.ok)) {
  process.exitCode = dryRun.status === 0 ? 1 : dryRun.status ?? 1;
}

/**
 * @param {unknown} wranglerConfig
 * @returns {string[]}
 */
function parseRequiredSecrets(wranglerConfig) {
  const config = /** @type {{ secrets?: { required?: unknown } }} */ (wranglerConfig);
  const required = config.secrets?.required;
  if (!Array.isArray(required) || !required.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new Error('wrangler.jsonc must define secrets.required as a list of secret names');
  }

  return required;
}

/**
 * @param {{ check: string; ok: boolean; detail: string }[]} rows
 */
function writeSummary(rows) {
  const markdown = [
    '## Cloudflare deployability',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.check} | ${row.ok ? 'pass' : 'fail'} | ${escapeTableCell(row.detail)} |`),
    '',
  ].join('\n');

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, markdown);
  } else {
    console.log(markdown);
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * @param {string} source
 * @returns {string}
 */
function stripJsonComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * @param {string} path
 * @returns {string}
 */
function relativePath(path) {
  return path.replace(`${root}/`, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function logExcerpt(value) {
  const excerpt = value.trim().split('\n').slice(-10).join('<br>');
  return excerpt.length > 0 ? excerpt : 'wrangler exited without output';
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeTableCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
