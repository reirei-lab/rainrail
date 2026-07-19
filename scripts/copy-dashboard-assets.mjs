import { cpSync, existsSync, rmSync } from 'node:fs';

const source = new URL('../apps/www/dist/', import.meta.url);
const sourceDashboard = new URL('../apps/www/dist/dashboard/', import.meta.url);
const sourceLocalizedDashboard = new URL('../apps/www/dist/ja/dashboard/', import.meta.url);
const sourceEnglishDashboard = new URL('../apps/www/dist/en/dashboard/', import.meta.url);
const sourceAstroAssets = new URL('../apps/www/dist/_astro/', import.meta.url);
const target = new URL('../packages/cli/dist/dashboard/', import.meta.url);
const expectedDashboardAssetRoutes = [
  'dashboard/index.html',
  'dashboard/events/index.html',
  'dashboard/runs/index.html',
  'dashboard/workflow-runs/index.html',
  'dashboard/tasks/index.html',
  'dashboard/agent-tasks/index.html',
  'dashboard/sources/index.html',
  'dashboard/queue/index.html',
  'dashboard/settings/index.html',
  'en/dashboard/index.html',
  'en/dashboard/events/index.html',
  'en/dashboard/runs/index.html',
  'en/dashboard/workflow-runs/index.html',
  'en/dashboard/tasks/index.html',
  'en/dashboard/agent-tasks/index.html',
  'en/dashboard/sources/index.html',
  'en/dashboard/queue/index.html',
  'en/dashboard/settings/index.html',
  'ja/dashboard/index.html',
  'ja/dashboard/events/index.html',
  'ja/dashboard/runs/index.html',
  'ja/dashboard/workflow-runs/index.html',
  'ja/dashboard/tasks/index.html',
  'ja/dashboard/agent-tasks/index.html',
  'ja/dashboard/sources/index.html',
  'ja/dashboard/queue/index.html',
  'ja/dashboard/settings/index.html',
];

if (!existsSync(source)) {
  throw new Error('apps/www/dist is missing; run pnpm --filter www build before building @rainrail/cli');
}
if (!existsSync(sourceDashboard) || !existsSync(sourceAstroAssets)) {
  throw new Error('apps/www/dist is missing dashboard assets');
}
const missingDashboardRoutes = expectedDashboardAssetRoutes.filter((route) => !existsSync(new URL(route, source)));
if (missingDashboardRoutes.length > 0) {
  throw new Error(`apps/www/dist is missing dashboard route assets: ${missingDashboardRoutes.join(', ')}`);
}

rmSync(target, { recursive: true, force: true });
cpSync(sourceDashboard, new URL('dashboard/', target), { recursive: true });
if (existsSync(sourceLocalizedDashboard)) {
  cpSync(sourceLocalizedDashboard, new URL('ja/dashboard/', target), { recursive: true });
}
if (existsSync(sourceEnglishDashboard)) {
  cpSync(sourceEnglishDashboard, new URL('en/dashboard/', target), { recursive: true });
}
cpSync(sourceAstroAssets, new URL('_astro/', target), { recursive: true });
