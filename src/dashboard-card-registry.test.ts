import { describe, expect, it } from 'vitest';

import {
  createDashboardCardRegistry,
  type DashboardCardDefinition,
  type DashboardLayoutItem,
} from './index.js';

const recentEventsCard: DashboardCardDefinition = {
  id: 'core.recentEvents',
  title: 'Recent events',
  entry: { type: 'core', name: 'recentEvents' },
  category: 'operations',
  requiredCapabilities: ['dashboard:read'],
  size: {
    default: { columns: 4, rows: 2 },
    min: { columns: 2, rows: 1 },
    max: { columns: 8, rows: 4 },
  },
};

const pluginQueueCard: DashboardCardDefinition = {
  id: 'plugin:github.queue',
  title: 'GitHub queue',
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
    properties: {
      repository: { type: 'string' },
    },
    additionalProperties: false,
  },
};

describe('dashboard card registry contract', () => {
  it('returns core and plugin dashboard cards from the same catalog list', () => {
    const registry = createDashboardCardRegistry();

    registry.register(recentEventsCard);
    registry.register(pluginQueueCard);

    expect(registry.list({
      availableCapabilities: ['dashboard:read', 'github:read'],
      enabledPlugins: ['github'],
    })).toEqual([
      {
        definition: recentEventsCard,
        availability: { status: 'available' },
      },
      {
        definition: pluginQueueCard,
        availability: { status: 'available' },
      },
    ]);
  });

  it('rejects duplicate card ids before they can collide in a layout', () => {
    const registry = createDashboardCardRegistry();

    registry.register(recentEventsCard);

    expect(() => registry.register({
      ...recentEventsCard,
      title: 'Recent events duplicate',
    })).toThrow(/Dashboard card id "core\.recentEvents" is already registered/u);
  });

  it('rejects definitions with required fields missing at runtime boundaries', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      title: 'Broken card',
      entry: { type: 'core', name: 'broken' },
      category: 'operations',
      size: { default: { columns: 2, rows: 1 } },
    } as unknown as DashboardCardDefinition)).toThrow(/Dashboard card id must be a non-empty string/u);
  });

  it('rejects invalid size constraints', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      ...recentEventsCard,
      id: 'core.badSize',
      size: {
        default: { columns: 1, rows: 2 },
        min: { columns: 2, rows: 1 },
      },
    })).toThrow(/default columns must be greater than or equal to min columns/u);
  });

  it('marks unavailable plugin cards and missing capabilities without dropping them from the catalog', () => {
    const registry = createDashboardCardRegistry();
    registry.register(pluginQueueCard);

    expect(registry.list({
      availableCapabilities: ['dashboard:read'],
      enabledPlugins: [],
    })).toEqual([{
      definition: pluginQueueCard,
      availability: {
        status: 'unavailable',
        reason: 'invalid_plugin',
        missingCapabilities: ['github:read'],
        message: 'Plugin "github" is not enabled and required capabilities are missing: github:read',
      },
    }]);
  });

  it('marks entry resolution failures without dropping the card from the catalog', () => {
    const registry = createDashboardCardRegistry();
    registry.register(pluginQueueCard);

    expect(registry.list({
      availableCapabilities: ['dashboard:read', 'github:read'],
      enabledPlugins: ['github'],
      entryResolutionFailures: {
        'plugin:github.queue': 'Plugin card module did not export the requested card entry',
      },
    })).toEqual([{
      definition: pluginQueueCard,
      availability: {
        status: 'unavailable',
        reason: 'entry_resolution_failed',
        message: 'Plugin card module did not export the requested card entry',
      },
    }]);
  });

  it('defines layout items independently from card availability', () => {
    const layoutItem: DashboardLayoutItem = {
      cardId: 'plugin:github.queue',
      x: 0,
      y: 0,
      columns: 3,
      rows: 2,
      settings: { repository: 'reirei-lab/rainrail' },
    };

    expect(layoutItem).toMatchObject({
      cardId: 'plugin:github.queue',
      columns: 3,
      rows: 2,
    });
  });
});
