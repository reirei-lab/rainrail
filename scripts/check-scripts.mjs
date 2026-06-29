import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} root
 * @returns {string[]}
 */
export function findMjsFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return findMjsFiles(path);
      }

      return entry.isFile() && entry.name.endsWith('.mjs') ? [path] : [];
    })
    .sort();
}

/**
 * @param {string} root
 * @param {{ stdio?: import('node:child_process').StdioOptions }} [options]
 * @returns {number}
 */
export function checkScriptSyntax(root, options = {}) {
  const scripts = findMjsFiles(root);

  for (const script of scripts) {
    const result = spawnSync(process.execPath, ['--check', script], {
      stdio: options.stdio ?? 'inherit',
    });

    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }

  return 0;
}

const invokedScript = process.argv[1];

if (invokedScript && import.meta.url === pathToFileURL(invokedScript).href) {
  process.exitCode = checkScriptSyntax(new URL('.', import.meta.url).pathname);
}
