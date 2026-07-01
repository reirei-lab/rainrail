import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInsideRoot,
  validateChangedFiles,
  validateContractsManifest,
  validateMarkdownLinks,
} from './check-docs-drift.mjs';

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'rainrail-docs-drift-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });

  writeFileSync(join(root, 'README.md'), '[contract](docs/contract.md)\n');
  writeFileSync(join(root, 'docs/contract.md'), '`PublicThing`\n');
  writeFileSync(join(root, 'src/contract.ts'), 'export interface PublicThing {}\n');
  writeFileSync(join(root, 'src/index.ts'), "export * from './contract.js';\n");
  writeFileSync(join(root, 'tests/contract.test.ts'), 'export {};\n');
  writeFileSync(
    join(root, 'docs/contracts.manifest.json'),
    JSON.stringify(
      {
        contracts: [
          {
            id: 'contract',
            title: 'Contract',
            sources: ['src/contract.ts'],
            docs: ['docs/contract.md'],
            tests: ['tests/contract.test.ts'],
            publicExports: ['PublicThing'],
          },
        ],
      },
      null,
      2,
    ),
  );

  return root;
};

describe('docs drift checks', () => {
  it('validates relative Markdown links in docs and README', () => {
    const root = makeRepo();

    expect(validateMarkdownLinks(root)).toEqual([]);

    writeFileSync(join(root, 'README.md'), '[missing](docs/missing.md)\n');
    expect(validateMarkdownLinks(root)).toContain(
      'README.md links to missing path docs/missing.md',
    );
  });

  it('keeps contract source, docs, tests, and public exports mapped', () => {
    const root = makeRepo();

    expect(validateContractsManifest(root)).toEqual([]);

    writeFileSync(join(root, 'docs/contract.md'), 'No export mention here.\n');
    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not mentioned by its docs',
    );
  });

  it('requires public exports to be exported declarations instead of loose source mentions', () => {
    const root = makeRepo();

    writeFileSync(
      join(root, 'src/contract.ts'),
      [
        '// export interface PublicThing {}',
        'const sample = "export const PublicThing = true";',
        'interface PublicThing {}',
        '',
      ].join('\n'),
    );

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not exported by its sources',
    );
  });

  it('treats Windows-style child paths as inside the project root', () => {
    expect(
      isPathInsideRoot('C:\\repo\\rainrail', 'docs\\contract.md', win32),
    ).toBe(true);
    expect(
      isPathInsideRoot('C:\\repo\\rainrail', '..\\outside.md', win32),
    ).toBe(false);
  });

  it('requires docs or tests to move with changed contract sources', () => {
    const root = makeRepo();

    expect(
      validateChangedFiles(root, ['src/contract.ts', 'docs/contract.md']),
    ).toEqual([]);
    expect(validateChangedFiles(root, ['src/contract.ts'])).toContain(
      'contract source changed without matching docs or tests: src/contract.ts',
    );
  });
});
