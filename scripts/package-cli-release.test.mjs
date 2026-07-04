import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getCliReleaseAssetName,
  packageCliRelease,
} from './package-cli-release.mjs';

describe('CLI release package builder', () => {
  it('names release assets with the Rainrail CLI version tag format', () => {
    expect(getCliReleaseAssetName('1.2.3')).toBe('rainrail-cli-v1.2.3.tgz');
  });

  it('derives the default repository root through fileURLToPath', () => {
    const script = readFileSync(new URL('./package-cli-release.mjs', import.meta.url), 'utf8');

    expect(script).toContain('fileURLToPath');
    expect(script).not.toContain("new URL('..', import.meta.url).pathname");
  });

  it('packs the CLI workspace package and writes the GitHub Release asset name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-release-pack-'));
    const cli = join(root, 'packages', 'cli');
    const outDir = join(root, 'dist', 'release');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ version: '2.3.4' }));

    /** @type {Array<[string, string[]]>} */
    const calls = [];
    const result = packageCliRelease({
      root,
      outDir,
      spawn: (command, args) => {
        calls.push([command, args]);
        if (command === 'npm') {
          const packDestination = args.at(-1);
          if (packDestination === undefined) {
            throw new Error('missing npm pack destination');
          }
          writeFileSync(join(packDestination, 'rainrail-cli-2.3.4.tgz'), 'tgz');
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.assetPath).toBe(join(outDir, 'rainrail-cli-v2.3.4.tgz'));
    expect(readFileSync(result.assetPath, 'utf8')).toBe('tgz');
    expect(calls).toEqual([
      ['pnpm', ['--filter', '@rainrail/cli', 'build']],
      ['npm', ['pack', cli, '--pack-destination', outDir]],
    ]);
  });
});
