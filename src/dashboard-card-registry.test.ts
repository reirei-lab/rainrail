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

    expect(() => registry.register(null as unknown as DashboardCardDefinition)).toThrow(
      /Dashboard card definition must be a plain object/u,
    );

    expect(() => registry.register({
      title: 'Broken card',
      entry: { type: 'core', name: 'broken' },
      category: 'operations',
      size: { default: { columns: 2, rows: 1 } },
    } as unknown as DashboardCardDefinition)).toThrow(/Dashboard card id must be a non-empty string/u);
  });

  it('rejects ids that do not match the entry namespace', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      ...pluginQueueCard,
      id: 'core.fake',
    })).toThrow(/id must match plugin entry namespace "plugin:github.queue"/u);

    expect(() => registry.register({
      ...recentEventsCard,
      id: 'core.events',
    })).toThrow(/id must match core entry namespace "core.recentEvents"/u);
  });

  it('rejects non-array required capabilities at registration time', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      ...pluginQueueCard,
      requiredCapabilities: 'github:read',
    } as unknown as DashboardCardDefinition)).toThrow(/requiredCapabilities must be an array of non-empty strings/u);
  });

  it('rejects invalid settings schema at registration time', () => {
    const registry = createDashboardCardRegistry();
    const circularSchema: Record<string, unknown> = { type: 'object', properties: {} };
    circularSchema.properties = { self: circularSchema };

    expect(() => registry.register({
      ...pluginQueueCard,
      settingsSchema: { type: 'string' },
    } as unknown as DashboardCardDefinition)).toThrow(/settingsSchema.type must be "object"/u);

    expect(() => registry.register({
      ...pluginQueueCard,
      settingsSchema: new Map([['type', 'object']]),
    } as unknown as DashboardCardDefinition)).toThrow(/settingsSchema must be a plain JSON object/u);

    expect(() => registry.register({
      ...pluginQueueCard,
      settingsSchema: { type: 'object', properties: { repository: undefined } },
    } as unknown as DashboardCardDefinition)).toThrow(/settingsSchema must contain only JSON-serializable values/u);

    expect(() => registry.register({
      ...pluginQueueCard,
      settingsSchema: circularSchema,
    } as unknown as DashboardCardDefinition)).toThrow(/settingsSchema must contain only JSON-serializable values/u);
  });

  it('rejects invalid size constraints', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      ...recentEventsCard,
      id: 'core.badSize',
      entry: { type: 'core', name: 'badSize' },
      size: {
        default: { columns: 1, rows: 2 },
        min: { columns: 2, rows: 1 },
      },
    })).toThrow(/default columns must be greater than or equal to min columns/u);
  });

  it('isolates registered definitions from caller-side mutation', () => {
    const registry = createDashboardCardRegistry();
    const mutableDefinition = {
      ...pluginQueueCard,
      entry: { ...pluginQueueCard.entry },
      requiredCapabilities: [...pluginQueueCard.requiredCapabilities!],
      size: {
        default: { ...pluginQueueCard.size.default },
        min: { ...pluginQueueCard.size.min! },
        max: { ...pluginQueueCard.size.max! },
      },
    };

    registry.register(mutableDefinition);
    mutableDefinition.id = 'plugin:github.changed';
    if (mutableDefinition.entry.type === 'plugin') {
      mutableDefinition.entry.pluginName = 'other';
    }
    mutableDefinition.requiredCapabilities.push('other:read');
    mutableDefinition.size.default.columns = 99;

    const [entry] = registry.list({
      availableCapabilities: ['dashboard:read', 'github:read'],
      enabledPlugins: ['github'],
    });

    expect(entry).toMatchObject({
      definition: {
        id: 'plugin:github.queue',
        entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
        requiredCapabilities: ['dashboard:read', 'github:read'],
        size: { default: { columns: 3, rows: 2 } },
      },
      availability: { status: 'available' },
    });
    expect(Object.isFrozen(entry!.definition)).toBe(true);
    expect(Object.isFrozen(entry!.definition.entry)).toBe(true);
    expect(Object.isFrozen(entry!.definition.size.default)).toBe(true);
  });

  it('rejects plugin provider cards outside the provider namespace', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.registerProvider({
      name: 'other',
      kind: 'dashboard-card-provider',
      cards: [pluginQueueCard],
    })).toThrow(/Provider "other" cannot register plugin card "plugin:github.queue"/u);
  });

  it('rejects ambiguous plugin and card names containing id delimiters', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.register({
      ...pluginQueueCard,
      id: 'plugin:docs.issueSummary.queue',
      entry: { type: 'plugin', pluginName: 'docs.issueSummary', cardName: 'queue' },
    })).toThrow(/pluginName must not contain "." or ":"/u);

    expect(() => registry.register({
      ...pluginQueueCard,
      id: 'plugin:github.issue.queue',
      entry: { type: 'plugin', pluginName: 'github', cardName: 'issue.queue' },
    })).toThrow(/cardName must not contain "." or ":"/u);
  });

  it('rejects provider objects with invalid kind or cards shape', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.registerProvider({
      name: 'github',
      kind: 'workflow-plugin',
      cards: [pluginQueueCard],
    } as unknown as Parameters<typeof registry.registerProvider>[0])).toThrow(
      /Dashboard card provider kind must be "dashboard-card-provider"/u,
    );

    expect(() => registry.registerProvider({
      name: 'github',
      kind: 'dashboard-card-provider',
      cards: pluginQueueCard,
    } as unknown as Parameters<typeof registry.registerProvider>[0])).toThrow(
      /Dashboard card provider cards must be an array/u,
    );
  });

  it('rejects core cards from plugin providers', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.registerProvider({
      name: 'github',
      kind: 'dashboard-card-provider',
      cards: [recentEventsCard],
    })).toThrow(/Provider "github" cannot register non-plugin card "core.recentEvents"/u);
  });

  it('keeps provider registration all-or-nothing when a later card is invalid', () => {
    const registry = createDashboardCardRegistry();

    expect(() => registry.registerProvider({
      name: 'github',
      kind: 'dashboard-card-provider',
      cards: [
        pluginQueueCard,
        {
          ...pluginQueueCard,
          id: 'plugin:github.badSize',
          entry: { type: 'plugin', pluginName: 'github', cardName: 'badSize' },
          size: {
            default: { columns: 1, rows: 2 },
            min: { columns: 2, rows: 1 },
          },
        },
      ],
    })).toThrow(/default columns must be greater than or equal to min columns/u);

    expect(registry.list({ enabledPlugins: ['github'] })).toEqual([]);
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

  it('treats all required capabilities as missing when no capability snapshot is supplied', () => {
    const registry = createDashboardCardRegistry();
    registry.register(pluginQueueCard);

    expect(registry.list({
      enabledPlugins: ['github'],
    })).toEqual([{
      definition: pluginQueueCard,
      availability: {
        status: 'unavailable',
        reason: 'missing_capability',
        missingCapabilities: ['dashboard:read', 'github:read'],
        message: 'Required capabilities are missing: dashboard:read, github:read',
      },
    }]);
  });

  it('marks plugin cards unavailable when enabled plugins are not supplied', () => {
    const registry = createDashboardCardRegistry();
    registry.register(pluginQueueCard);

    expect(registry.list({
      availableCapabilities: ['dashboard:read', 'github:read'],
    })).toEqual([{
      definition: pluginQueueCard,
      availability: {
        status: 'unavailable',
        reason: 'invalid_plugin',
        message: 'Plugin "github" is not enabled',
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

  it('preserves missing capabilities when entry resolution also fails', () => {
    const registry = createDashboardCardRegistry();
    registry.register(pluginQueueCard);

    expect(registry.list({
      availableCapabilities: ['dashboard:read'],
      enabledPlugins: ['github'],
      entryResolutionFailures: {
        'plugin:github.queue': 'Plugin card module did not export the requested card entry',
      },
    })).toEqual([{
      definition: pluginQueueCard,
      availability: {
        status: 'unavailable',
        reason: 'entry_resolution_failed',
        missingCapabilities: ['github:read'],
        message: 'Plugin card module did not export the requested card entry and required capabilities are missing: github:read',
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
