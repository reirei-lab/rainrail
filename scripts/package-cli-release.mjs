import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @param {string} version
 * @returns {string}
 */
export function getCliReleaseAssetName(version) {
  return `rainrail-cli-v${version}.tgz`;
}

/**
 * @typedef {{ status: number | null; stdout?: string | Buffer }} ScriptSpawnResult
 * @typedef {(command: string, args: string[]) => ScriptSpawnResult} ScriptSpawn
 */

/**
 * @param {ScriptSpawn} spawn
 * @param {string} command
 * @param {string[]} args
 */
function runChecked(spawn, command, args) {
  const result = spawn(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
  return result;
}

/**
 * @param {ScriptSpawn} spawn
 * @param {string} assetPath
 */
function validateCliReleaseAsset(spawn, assetPath) {
  const result = runChecked(spawn, 'tar', ['-tzf', assetPath]);
  const entries = String(result.stdout ?? '').split(/\r?\n/u).filter((entry) => entry.length > 0);
  const entrySet = new Set(entries);
  const requiredEntries = [
    'package/dist/dashboard/dashboard/index.html',
    'package/dist/dashboard/ja/dashboard/index.html',
    'package/dist/dashboard/en/dashboard/index.html',
  ];
  const missing = requiredEntries.filter((entry) => !entrySet.has(entry));
  const hasAstroAsset = entries.some((entry) =>
    entry.startsWith('package/dist/dashboard/_astro/') && !entry.endsWith('/'));

  if (missing.length > 0 || !hasAstroAsset) {
    throw new Error([
      'CLI release package is missing dashboard assets:',
      ...missing,
      ...(hasAstroAsset ? [] : ['package/dist/dashboard/_astro/*']),
    ].join(' '));
  }
}

/**
 * @param {{
 *   root?: string;
 *   outDir?: string;
 *   spawn?: ScriptSpawn;
 * }} [options]
 * @returns {{ assetName: string; assetPath: string; version: string }}
 */
export function packageCliRelease({
  root = fileURLToPath(new URL('..', import.meta.url)),
  outDir = join(root, 'dist', 'release'),
  spawn = (command, args) => spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
} = {}) {
  const cliPackageDir = join(root, 'packages', 'cli');
  const cliPackageJson = JSON.parse(
    readFileSync(join(cliPackageDir, 'package.json'), 'utf8'),
  );
  const assetName = getCliReleaseAssetName(cliPackageJson.version);
  const assetPath = join(outDir, assetName);
  const npmPackName = `rainrail-cli-${cliPackageJson.version}.tgz`;
  const npmPackPath = join(outDir, npmPackName);

  mkdirSync(outDir, { recursive: true });
  for (const path of [assetPath, npmPackPath]) {
    if (existsSync(path)) {
      rmSync(path);
    }
  }

  runChecked(spawn, 'pnpm', ['--filter', 'www', 'build']);
  runChecked(spawn, 'pnpm', ['--filter', '@rainrail/cli', 'build']);
  runChecked(spawn, 'npm', ['pack', cliPackageDir, '--pack-destination', outDir]);
  renameSync(npmPackPath, assetPath);
  validateCliReleaseAsset(spawn, assetPath);

  return {
    assetName,
    assetPath,
    version: cliPackageJson.version,
  };
}

const invokedScript = process.argv[1];

if (invokedScript && import.meta.url === pathToFileURL(invokedScript).href) {
  try {
    const result = packageCliRelease();
    console.log(result.assetPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
