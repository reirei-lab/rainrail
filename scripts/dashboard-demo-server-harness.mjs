import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedDashboardDemoDatabase } from './seed-dashboard-demo-db.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCliBinPath = resolve(repositoryRoot, 'packages', 'cli', 'dist', 'bin', 'rainrail.js');

/**
 * Starts a disposable Rainrail dashboard demo server for E2E tests.
 *
 * The harness owns a temporary directory, seeds a fresh SQLite demo database,
 * starts the Node CLI server on a random localhost port, and returns a base URL
 * that can be passed to Playwright. Call `cleanup()` from test teardown.
 *
 * @param {{
 *   cliBinPath?: string;
 *   host?: string;
 *   timeoutMs?: number;
 * }} [options]
 */
export async function startDashboardDemoServerHarness(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cliBinPath = options.cliBinPath ?? defaultCliBinPath;
  if (!existsSync(cliBinPath)) {
    throw new Error(`Rainrail CLI build is missing at ${cliBinPath}; run pnpm --filter @rainrail/cli exec tsc -p tsconfig.build.json first.`);
  }

  const root = mkdtempSync(join(tmpdir(), 'rainrail-dashboard-demo-'));
  const databasePath = join(root, 'dashboard-demo.sqlite');
  const configPath = join(root, 'rainrail.config.json');
  const dashboardAssetRoot = join(root, 'dashboard-assets');
  const port = await allocateLocalPort(host);
  const baseUrl = `http://${host}:${port}`;

  seedDashboardDemoDatabase({ databasePath });
  writeDemoDashboardAssets(dashboardAssetRoot);
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
    env: {
      ...process.env,
      RAINRAIL_DASHBOARD_DEMO: '1',
      RAINRAIL_DASHBOARD_DIST_DIR: dashboardAssetRoot,
    },
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
    process: child,
    cleanup,
  };
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
    sourceBundles: [],
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
 * @param {string} assetRoot
 */
function writeDemoDashboardAssets(assetRoot) {
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Rainrail Dashboard Demo</title></head>',
    '<body data-api-base-url="" data-auth-required="false">',
    '<main id="dashboard-root">Rainrail Dashboard Demo</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  for (const locale of ['en', 'ja']) {
    const directory = join(assetRoot, locale, 'dashboard');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.html'), html, { mode: 0o600 });
  }
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
