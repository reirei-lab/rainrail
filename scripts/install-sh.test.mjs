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
 * @param {{ includeBin?: boolean }} [options]
 */
function createReleaseTarball(root, version, { includeBin = true } = {}) {
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }));
  if (includeBin) {
    writeFileSync(
      join(packageRoot, 'dist', 'bin', 'rainrail.js'),
      '#!/usr/bin/env node\nconsole.log("rainrail");\n',
    );
    chmodSync(join(packageRoot, 'dist', 'bin', 'rainrail.js'), 0o755);
  }

  const tarball = join(root, 'rainrail-cli.tgz');
  const pack = spawnSync('tar', ['-czf', tarball, '-C', root, 'package']);
  expect(pack.status).toBe(0);
  return tarball;
}

describe('install.sh', () => {
  it('builds default asset URLs from release/x.y.z tags', () => {
    const script = readFileSync(installScript, 'utf8');

    expect(script).toContain("sed -e 's/^v//' -e 's#^release/##' -e 's#^release%2F##' -e 's#^release%2f##'");
    expect(script).toContain('printf \'%s\' "${tag//\\//%2F}"');
    expect(script).toContain('version="${version#release/}"');
    expect(script).toContain('version="${version#release%2F}"');
    expect(script).toContain('download "https://github.com/${repo}/releases/download/${encoded_release_tag}/${asset_name}" "${output}"');
  });

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

  it('skips shell rc updates without failing when HOME is unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-no-home-shell-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    const { HOME: _home, ...envWithoutHome } = process.env;

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
        env: envWithoutHome,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Skipping shell rc update because HOME is not set');
    expect(readlinkSync(join(prefix, 'bin', 'rainrail'))).toBe(
      '../lib/rainrail/9.8.7/dist/bin/rainrail.js',
    );
  });

  it('does not require npm when installing from a release tarball', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-no-npm-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'npm'), '#!/usr/bin/env sh\nexit 127\n');
    chmodSync(join(fakeBin, 'npm'), 0o755);

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      },
    );

    expect(result.status).toBe(0);
    expect(readlinkSync(join(prefix, 'bin', 'rainrail'))).toBe(
      '../lib/rainrail/9.8.7/dist/bin/rainrail.js',
    );
  });

  it('uses authenticated gh release downloads for private repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-gh-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "release view" ]; then
  printf 'release/9.8.7\\n'
  exit 0
fi
if [ "$1 $2" = "release download" ]; then
  out_dir=""
  pattern=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) out_dir="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "${tarball}" "$out_dir/$pattern"
  exit 0
fi
exit 1
`,
    );
    chmodSync(join(fakeBin, 'gh'), 0o755);

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--prefix', prefix],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
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

  it('leaves the current install intact when staging a replacement fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-stage-fail-'));
    const tarball = createReleaseTarball(root, '9.8.7', { includeBin: false });
    const prefix = join(root, 'prefix');
    const currentTarget = join(prefix, 'lib', 'rainrail', '9.8.7');
    mkdirSync(join(currentTarget, 'dist', 'bin'), { recursive: true });
    writeFileSync(join(currentTarget, 'package.json'), JSON.stringify({ version: 'old' }));
    writeFileSync(join(currentTarget, 'dist', 'bin', 'rainrail.js'), 'old');
    mkdirSync(join(prefix, 'bin'), { recursive: true });

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(readFileSync(join(currentTarget, 'package.json'), 'utf8')).toContain('"old"');
  });

  it('fails when the rainrail bin path is an existing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-install-bin-dir-'));
    const tarball = createReleaseTarball(root, '9.8.7');
    const prefix = join(root, 'prefix');
    mkdirSync(join(prefix, 'bin', 'rainrail'), { recursive: true });

    const result = spawnSync(
      'bash',
      [installScript.pathname, '--asset-url', `file://${tarball}`, '--prefix', prefix],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot replace existing directory at');
    expect(existsSync(join(prefix, 'bin', 'rainrail', 'rainrail.js'))).toBe(false);
  });
});
