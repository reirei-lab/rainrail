import { describe, expect, it } from 'vitest';

import {
  createDashboardCardProviderFromManifest,
  createDashboardCardRegistry,
  type DashboardPluginManifest,
} from './index.js';

describe('dashboard card plugin manifest contribution', () => {
  it('creates a dashboard card provider from plugin manifest dashboard.cards', () => {
    const manifest: DashboardPluginManifest = {
      name: 'github',
      version: '1.0.0',
      dashboard: {
        cards: [{
          name: 'queue',
          title: 'GitHub queue',
          description: 'Open issue and pull request queue',
          category: 'operations',
          requiredCapabilities: ['dashboard:read', 'github:read'],
          size: {
            default: { columns: 3, rows: 2 },
            min: { columns: 2, rows: 1 },
            max: { columns: 6, rows: 4 },
          },
          settingsSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string' },
            },
            additionalProperties: false,
          },
        }],
      },
    };

    const provider = createDashboardCardProviderFromManifest(manifest);
    const registry = createDashboardCardRegistry();
    registry.registerProvider(provider);

    expect(registry.list({
      availableCapabilities: ['dashboard:read', 'github:read'],
      enabledPlugins: ['github'],
    })).toEqual([{
      definition: {
        id: 'plugin:github.queue',
        title: 'GitHub queue',
        description: 'Open issue and pull request queue',
        entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
        category: 'operations',
        requiredCapabilities: ['dashboard:read', 'github:read'],
        size: {
          default: { columns: 3, rows: 2 },
          min: { columns: 2, rows: 1 },
          max: { columns: 6, rows: 4 },
        },
        settingsSchema: {
          type: 'object',
          properties: { repository: { type: 'string' } },
          additionalProperties: false,
        },
      },
      availability: { status: 'available' },
    }]);
  });

  it('rejects malformed manifest dashboard card contributions before registration', () => {
    expect(() => createDashboardCardProviderFromManifest({
      name: 'github',
      version: '1.0.0',
      dashboard: { cards: 'queue' },
    } as unknown as DashboardPluginManifest)).toThrow(/manifest dashboard\.cards must be an array/u);

    expect(() => createDashboardCardProviderFromManifest({
      name: 'github',
      version: '1.0.0',
      dashboard: {
        cards: [{
          name: 'issue.queue',
          title: 'GitHub queue',
          category: 'operations',
          size: { default: { columns: 3, rows: 2 } },
        }],
      },
    })).toThrow(/cardName must not contain "\." or ":"/u);

    expect(() => createDashboardCardProviderFromManifest({
      name: 'github',
      version: '1.0.0',
      dashboard: {
        cards: [{
          name: 'queue',
          title: 'GitHub queue',
          category: 'operations',
          requiredCapabilities: 'github:read',
          size: { default: { columns: 3, rows: 2 } },
        }],
      },
    } as unknown as DashboardPluginManifest)).toThrow(/requiredCapabilities must be an array of non-empty strings/u);
  });
});
