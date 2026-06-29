import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkScriptSyntax, findMjsFiles } from './check-scripts.mjs';

describe('script syntax checker', () => {
  it('finds every mjs file in a directory tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-scripts-'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'first.mjs'), 'export const first = 1;\n');
    writeFileSync(join(root, 'nested', 'second.mjs'), 'export const second = 2;\n');
    writeFileSync(join(root, 'ignored.txt'), 'not a script\n');

    expect(findMjsFiles(root).map((file) => file.replace(`${root}/`, ''))).toEqual([
      'first.mjs',
      'nested/second.mjs',
    ]);
  });

  it('fails when any later script has invalid syntax', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainrail-scripts-'));
    writeFileSync(join(root, 'a-valid.mjs'), 'export const valid = true;\n');
    writeFileSync(join(root, 'z-invalid.mjs'), 'export const invalid = ;\n');

    expect(checkScriptSyntax(root, { stdio: 'pipe' })).toBe(1);
  });
});
