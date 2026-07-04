import { chmodSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installScript = new URL('../install.sh', import.meta.url);

describe('install.sh', () => {
  it('installs a release tarball into a user-local Rainrail prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-'));
    const packageRoot = join(root, 'package');
    mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    writeFileSync(
      join(packageRoot, 'dist', 'bin', 'rainrail.js'),
      '#!/usr/bin/env node\nconsole.log("rainrail");\n',
    );
    chmodSync(join(packageRoot, 'dist', 'bin', 'rainrail.js'), 0o755);

    const tarball = join(root, 'rainrail-cli-v9.8.7.tgz');
    const pack = spawnSync('tar', ['-czf', tarball, '-C', root, 'package']);
    expect(pack.status).toBe(0);

    const prefix = join(root, 'prefix');
    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(join(prefix, 'lib', 'rainrail', '9.8.7', 'package.json'), 'utf8'))
      .toContain('"version":"9.8.7"');
    expect(readlinkSync(join(prefix, 'bin', 'rainrail'))).toBe(
      '../lib/rainrail/9.8.7/dist/bin/rainrail.js',
    );
    expect(result.stdout).toContain(`${join(prefix, 'bin')} is not on PATH`);
  });
});
