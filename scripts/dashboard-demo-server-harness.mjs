import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedDashboardDemoDatabase } from './seed-dashboard-demo-db.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCliBinPath = resolve(repositoryRoot, 'packages', 'cli', 'dist', 'bin', 'rainrail.js');
const defaultDashboardAssetRoot = resolve(repositoryRoot, 'apps', 'www', 'dist');
const dashboardEnvOverrides = {
  RAINRAIL_DASHBOARD_DEMO: '1',
};
const dashboardEnvDeletes = [
  'RAINRAIL_OPERATIONAL_STORE',
  'RAINRAIL_OPERATIONAL_DB',
  'RAINRAIL_OPERATIONAL_EVENT_LIMIT',
  'SSE_BEARER_TOKEN',
];

/**
 * Starts a disposable Rainrail dashboard demo server for E2E tests.
 *
 * The harness owns a temporary directory, seeds a fresh SQLite demo database,
 * starts the Node CLI server on a random localhost port, and returns a base URL
 * that can be passed to Playwright. Call `cleanup()` from test teardown.
 *
 * @param {{
 *   cliBinPath?: string;
 *   dashboardAssetRoot?: string;
 *   env?: Record<string, string | undefined>;
 *   host?: string;
 *   timeoutMs?: number;
 * }} [options]
 */
export async function startDashboardDemoServerHarness(options = {}) {
  const host = normalizeBindHost(options.host ?? '127.0.0.1');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cliBinPath = options.cliBinPath ?? defaultCliBinPath;
  const dashboardAssetRoot = options.dashboardAssetRoot ?? defaultDashboardAssetRoot;
  if (!existsSync(cliBinPath)) {
    throw new Error(`Rainrail CLI build is missing at ${cliBinPath}; run pnpm --filter @rainrail/cli exec tsc -p tsconfig.build.json first.`);
  }
  assertDashboardAssets(dashboardAssetRoot);

  const root = mkdtempSync(join(tmpdir(), 'rainrail-dashboard-demo-'));
  const databasePath = join(root, 'dashboard-demo.sqlite');
  const configPath = join(root, 'rainrail.config.json');
  const port = await allocateLocalPort(host);
  const baseUrl = formatDashboardDemoBaseUrl(host, port);

  seedDashboardDemoDatabase({ databasePath });
  writeDemoConfig(configPath, { databasePath, host, port });

  const child = spawn(process.execPath, [
    cliBinPath,
    '--config',
    configPath,
    'start',
    '--demo',
    '--host',
    host,
    '--port',
    String(port),
  ], {
    cwd: repositoryRoot,
    env: dashboardDemoServerEnv(options.env ?? process.env, dashboardAssetRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let cleaned = false;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  };

  try {
    await waitForHttpOk(`${baseUrl}/healthz`, { timeoutMs, child, getLogs: () => ({ stdout, stderr }) });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    baseUrl,
    host,
    port,
    root,
    databasePath,
    configPath,
    dashboardAssetRoot,
    process: child,
    cleanup,
  };
}

/**
 * @param {string} host
 * @param {number} port
 */
export function formatDashboardDemoBaseUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}`;
}

/**
 * @param {string} host
 */
function formatUrlHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * @param {string} host
 */
function normalizeBindHost(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * @param {Record<string, string | undefined>} sourceEnv
 * @param {string} dashboardAssetRoot
 */
function dashboardDemoServerEnv(sourceEnv, dashboardAssetRoot) {
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...sourceEnv,
    ...dashboardEnvOverrides,
    RAINRAIL_DASHBOARD_DIST_DIR: dashboardAssetRoot,
  };
  for (const key of dashboardEnvDeletes) {
    delete env[key];
  }
  return env;
}

/**
 * @param {string} dashboardAssetRoot
 */
function assertDashboardAssets(dashboardAssetRoot) {
  const dashboardIndex = join(dashboardAssetRoot, 'en', 'dashboard', 'index.html');
  if (!existsSync(dashboardIndex)) {
    throw new Error(`Rainrail dashboard assets are missing at ${dashboardAssetRoot}; run pnpm --filter www build first.`);
  }
}

/**
 * @param {string} configPath
 * @param {{ databasePath: string; host: string; port: number }} options
 */
function writeDemoConfig(configPath, options) {
  writeFileSync(configPath, `${JSON.stringify({
    server: { host: options.host, port: options.port },
    operationalStore: {
      kind: 'sqlite',
      databasePath: options.databasePath,
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
    sources: [
      {
        type: 'manual-chat',
        name: 'manual-chat',
        sourceType: 'chat',
        endpoint: '/manual/chat',
      },
    ],
    taskProviders: {},
    runtimeProviders: {},
  }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param {string} host
 */
async function allocateLocalPort(host) {
  const server = http.createServer();
  /** @type {Promise<void>} */
  await new Promise((resolveListen, rejectListen) => {
    /** @param {Error} error */
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to allocate a local dashboard demo port');
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

/**
 * @param {http.Server} server
 */
async function closeServer(server) {
  /** @type {Promise<void>} */
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }
      resolveClose(undefined);
    });
  });
}

/**
 * @param {string} url
 * @param {{
 *   timeoutMs: number;
 *   child: import('node:child_process').ChildProcess;
 *   getLogs: () => { stdout: string; stderr: string };
 * }} options
 */
async function waitForHttpOk(url, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (options.child.exitCode !== null) {
      const logs = options.getLogs();
      throw new Error(`dashboard demo server exited before readiness with code ${options.child.exitCode}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
  }
  const logs = options.getLogs();
  throw new Error(`dashboard demo server did not become ready at ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
  });
  child.kill('SIGINT');
  const timeout = new Promise((resolveTimeout) => {
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolveTimeout(undefined);
    }, 2_000);
  });
  await Promise.race([exited, timeout]);
  if (child.exitCode === null && child.signalCode === null) {
    await exited;
  }
}
