import { cpSync, existsSync, rmSync } from 'node:fs';

const source = new URL('../apps/www/dist/', import.meta.url);
const sourceDashboard = new URL('../apps/www/dist/dashboard/', import.meta.url);
const sourceAstroAssets = new URL('../apps/www/dist/_astro/', import.meta.url);
const target = new URL('../packages/cli/dist/dashboard/', import.meta.url);

if (!existsSync(source)) {
  throw new Error('apps/www/dist is missing; run pnpm --filter www build before building @rainrail/cli');
}
if (!existsSync(sourceDashboard) || !existsSync(sourceAstroAssets)) {
  throw new Error('apps/www/dist is missing dashboard assets');
}

rmSync(target, { recursive: true, force: true });
cpSync(sourceDashboard, new URL('dashboard/', target), { recursive: true });
cpSync(sourceAstroAssets, new URL('_astro/', target), { recursive: true });
