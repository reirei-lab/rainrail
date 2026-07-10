#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedDashboardDemoDatabase } from './seed-dashboard-demo-db.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = resolve(repositoryRoot, '.tmp', 'dashboard-demo');
const configPath = resolve(demoRoot, 'rainrail.config.json');
const databasePath = resolve(repositoryRoot, '.tmp', 'dashboard-demo.sqlite');
const cliEntrypoint = resolve(repositoryRoot, 'packages', 'cli', 'dist', 'bin', 'rainrail.js');

runRequiredPnpm(['--filter', 'www', 'build']);
runRequiredPnpm(['--filter', '@rainrail/cli', 'build']);

mkdirSync(demoRoot, { recursive: true });
seedDashboardDemoDatabase({ databasePath });
writeFileSync(configPath, `${JSON.stringify({
  server: { host: '127.0.0.1', port: 8787 },
  operationalStore: {
    kind: 'sqlite',
    databasePath: '../dashboard-demo.sqlite',
    eventLimit: 250,
  },
  sourceBundles: [{
    type: 'eep-bridge',
    name: 'demo-eep',
    sources: [{
      type: 'github-webhook',
      name: 'github-webhook',
      sourceType: 'github',
      provider: 'github',
      webhookSecret: 'demo-webhook-secret',
      endpoint: '/webhooks/github',
    }],
  }],
  sources: [{
    type: 'manual-chat',
    name: 'manual-chat',
    sourceType: 'chat',
    endpoint: '/manual/chat',
  }],
  taskProviders: {},
  runtimeProviders: {},
}, null, 2)}\n`, { mode: 0o600 });

const result = spawnSync(process.execPath, [
  cliEntrypoint,
  '--config',
  configPath,
  'start',
  '--demo',
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    RAINRAIL_DASHBOARD_DEMO: '1',
  },
  stdio: 'inherit',
});

process.exitCode = result.status ?? 1;

/**
 * @param {string[]} args
 */
function runRequiredPnpm(args) {
  const result = spawnSync('pnpm', args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
