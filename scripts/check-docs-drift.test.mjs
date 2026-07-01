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
            publicExportKinds: {
              PublicThing: 'type',
            },
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

  it('does not count named default declarations as named public exports', () => {
    const root = makeRepo();

    writeFileSync(
      join(root, 'src/contract.ts'),
      'export default function PublicThing() {}\n',
    );

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not exported by its sources',
    );
  });

  it('requires src/index.ts to re-export contract sources as syntax', () => {
    const root = makeRepo();

    writeFileSync(
      join(root, 'src/index.ts'),
      [
        "// export * from './contract.js';",
        "const planned = './contract.js';",
        '',
      ].join('\n'),
    );

    expect(validateContractsManifest(root)).toContain(
      'contract source is not exported from src/index.ts: src/contract.ts',
    );
  });

  it('requires src/index.ts to re-export public names from contract sources', () => {
    const root = makeRepo();

    writeFileSync(
      join(root, 'src/index.ts'),
      "export { PublicThing as HiddenThing } from './contract.js';\n",
    );

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not re-exported from src/index.ts',
    );

    writeFileSync(join(root, 'src/index.ts'), "export {} from './contract.js';\n");
    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not re-exported from src/index.ts',
    );
  });

  it('does not count type-only re-exports for value public exports', () => {
    const root = makeRepo();
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
              publicExportKinds: {
                PublicThing: 'value',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    writeFileSync(join(root, 'src/contract.ts'), 'export function PublicThing() {}\n');
    writeFileSync(
      join(root, 'src/index.ts'),
      "export type { PublicThing } from './contract.js';\n",
    );

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not re-exported from src/index.ts',
    );

    writeFileSync(join(root, 'src/index.ts'), "export type * from './contract.js';\n");
    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not re-exported from src/index.ts',
    );
  });

  it('keeps expected public export kind fixed by the manifest', () => {
    const root = makeRepo();
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
              publicExportKinds: {
                PublicThing: 'value',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    writeFileSync(join(root, 'src/contract.ts'), 'export type PublicThing = () => void;\n');

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not exported as value by its sources',
    );

    writeFileSync(
      join(root, 'src/contract.ts'),
      'type PublicThing = () => void;\nexport { PublicThing };\n',
    );

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not exported as value by its sources',
    );
  });

  it('requires docs to mention public exports as exact code spans', () => {
    const root = makeRepo();

    writeFileSync(join(root, 'docs/contract.md'), '`OtherPublicThing`\n');

    expect(validateContractsManifest(root)).toContain(
      'contract public export PublicThing is not mentioned by its docs',
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

  it('requires docs or tests when a base contract source is removed from the manifest', () => {
    const root = makeRepo();
    const baseContracts = [
      {
        id: 'contract',
        sources: ['src/contract.ts', 'src/removed.ts'],
        docs: ['docs/contract.md'],
        tests: ['tests/contract.test.ts'],
      },
    ];

    expect(
      validateChangedFiles(
        root,
        ['docs/contracts.manifest.json', 'src/removed.ts'],
        baseContracts,
      ),
    ).toContain(
      'contract source removed from manifest without matching docs or tests: src/removed.ts',
    );

    expect(
      validateChangedFiles(
        root,
        ['docs/contracts.manifest.json', 'src/removed.ts', 'tests/contract.test.ts'],
        baseContracts,
      ),
    ).toEqual([]);
  });

  it('requires docs or tests when base public exports are removed or weakened', () => {
    const root = makeRepo();
    const baseContracts = [
      {
        id: 'contract',
        sources: ['src/contract.ts'],
        docs: ['docs/contract.md'],
        tests: ['tests/contract.test.ts'],
        publicExports: ['PublicThing', 'RemovedThing'],
        publicExportKinds: {
          PublicThing: 'value',
          RemovedThing: 'value',
        },
      },
    ];

    expect(
      validateChangedFiles(
        root,
        ['docs/contracts.manifest.json'],
        baseContracts,
      ),
    ).toEqual([
      'contract public export removed from manifest without matching docs or tests: RemovedThing',
      'contract public export kind changed without matching docs or tests: PublicThing value -> type',
    ]);

    expect(
      validateChangedFiles(
        root,
        ['docs/contracts.manifest.json', 'docs/contract.md'],
        baseContracts,
      ),
    ).toEqual([]);
  });
});
