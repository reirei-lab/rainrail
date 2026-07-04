import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installScript = new URL('../install.sh', import.meta.url);

/**
 * @param {string} root
 * @param {string} version
 */
function createReleaseTarball(root, version) {
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }));
  writeFileSync(
    join(packageRoot, 'dist', 'bin', 'rainrail.js'),
    '#!/usr/bin/env node\nconsole.log("rainrail");\n',
  );
  chmodSync(join(packageRoot, 'dist', 'bin', 'rainrail.js'), 0o755);

  const tarball = join(root, 'rainrail-cli.tgz');
  const pack = spawnSync('tar', ['-czf', tarball, '-C', root, 'package']);
  expect(pack.status).toBe(0);
  return tarball;
}

describe('install.sh', () => {
  it('installs a release tarball into a user-local Rainrail prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-'));
    const tarball = createReleaseTarball(root, '9.8.7');

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

  it('treats EOF on the shell rc prompt as no without failing the install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-eof-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    const home = join(root, 'home');
    mkdirSync(home);

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix, '--add-to-shell'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, SHELL: '/bin/zsh' },
      },
    );

    expect(result.status).toBe(0);
    expect(readlinkSync(join(prefix, 'bin', 'rainrail'))).toBe(
      '../lib/rainrail/9.8.7/dist/bin/rainrail.js',
    );
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
  });

  it('uses an explicit prefix without requiring HOME to be set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-no-home-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    const { HOME: _home, ...envWithoutHome } = process.env;

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      {
        encoding: 'utf8',
        env: envWithoutHome,
      },
    );

    expect(result.status).toBe(0);
    expect(readlinkSync(join(prefix, 'bin', 'rainrail'))).toBe(
      '../lib/rainrail/9.8.7/dist/bin/rainrail.js',
    );
  });

  it('shell-quotes the PATH line written to a shell rc file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-rc-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const home = join(root, 'home');
    mkdirSync(home);
    const prefix = join(root, 'prefix $(touch should-not-run)"');

    const result = spawnSync(
      'bash',
      [
        installScript.pathname,
        '--asset-url',
        `file://${tarball}`,
        '--prefix',
        prefix,
        '--add-to-shell',
        '--yes',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, SHELL: '/bin/zsh' },
      },
    );

    expect(result.status).toBe(0);
    const rcContent = readFileSync(join(home, '.zshrc'), 'utf8');
    expect(rcContent).toContain('\\$\\(touch\\ should-not-run\\)');
    expect(rcContent).toContain('\\"/bin:$PATH');
    expect(existsSync(join(root, 'should-not-run'))).toBe(false);
  });

  it('rejects release tarballs with a path-like package version before installing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-version-'));
    const tarball = createReleaseTarball(root, '../../../outside');
    const prefix = join(root, 'prefix');

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release asset package version is invalid');
    expect(existsSync(join(root, 'outside'))).toBe(false);
  });
});
