import { describe, expect, it, vi } from 'vitest';

import {
  createCloudflareTailIntakeAdapter,
  createEventEnvelope,
  createDashboardCardRegistry,
  createGitHubWebhookIntakeAdapter,
  createGitHubWebhookSignature,
  createManualInputIntakeAdapter,
  createRainrailHttpApp,
  RainrailBridgeRoom,
  RainrailOperationalStore,
  type DashboardCardDefinition,
  type OperationalStore,
  type RainrailBridgeRoomState,
} from './index.js';

describe('Rainrail dashboard API', () => {
  it('registers the existing standard dashboard surfaces as default core cards', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: { readOnlyToken: 'read-token' },
      operationalStore,
    });

    const headers = { authorization: 'Bearer read-token' };
    const cardsResponse = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards', { headers }));
    expect(cardsResponse.status).toBe(200);
    const cardsBody = await cardsResponse.json() as {
      data: Array<{ definition: DashboardCardDefinition; availability: { status: string } }>;
    };

    expect(cardsBody.data.map((entry) => entry.definition.id)).toEqual([
      'core.operationalTotals',
      'core.eventInbox',
      'core.workflowRuns',
      'core.agentTasks',
      'core.sources',
      'core.queue',
      'core.settings',
      'core.operatorActions',
      'core.overview',
      'core.recentEvents',
    ]);
    expect(cardsBody.data.map((entry) => entry.definition.entry)).toEqual([
      { type: 'core', name: 'operationalTotals' },
      { type: 'core', name: 'eventInbox' },
      { type: 'core', name: 'workflowRuns' },
      { type: 'core', name: 'agentTasks' },
      { type: 'core', name: 'sources' },
      { type: 'core', name: 'queue' },
      { type: 'core', name: 'settings' },
      { type: 'core', name: 'operatorActions' },
      { type: 'core', name: 'overview' },
      { type: 'core', name: 'recentEvents' },
    ]);
    expect(cardsBody.data.map((entry) => entry.availability)).toEqual(Array.from({ length: 10 }, () => ({ status: 'available' })));
    expect(cardsBody.data.every((entry) => entry.definition.requiredCapabilities?.includes('dashboard:read'))).toBe(true);

    const layoutResponse = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', { headers }));
    expect(layoutResponse.status).toBe(200);
    const layoutBody = await layoutResponse.json() as { data: { items: Array<{ id: string; cardId: string }> } };
    expect(layoutBody.data.items.map((item) => item.cardId)).toEqual(cardsBody.data.slice(0, 8).map((entry) => entry.definition.id));
    operationalStore.close();
  });

  it('keeps legacy core card ids available for saved dashboard layouts', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
      operationalStore,
    });

    const savedLegacyLayout = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'legacy-overview', cardId: 'core.overview', x: 0, y: 0, columns: 4, rows: 2 },
          { id: 'legacy-recent-events', cardId: 'core.recentEvents', x: 4, y: 0, columns: 4, rows: 2 },
        ],
      }),
    }));
    expect(savedLegacyLayout.status).toBe(200);

    const headers = { authorization: 'Bearer read-token' };
    const cardsBody = await (await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards', { headers }))).json() as {
      data: Array<{ definition: DashboardCardDefinition }>;
    };
    const cardIds = cardsBody.data.map((entry) => entry.definition.id);
    expect(cardIds).toContain('core.overview');
    expect(cardIds).toContain('core.recentEvents');

    const layoutBody = await (await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', { headers }))).json() as {
      data: { filteredItemCount: number; items: Array<{ cardId: string }> };
    };
    expect(layoutBody.data.filteredItemCount).toBe(0);
    expect(layoutBody.data.items.map((item) => item.cardId)).toEqual(['core.overview', 'core.recentEvents']);
    operationalStore.close();
  });

  it('serves dashboard card catalog and the default layout for read-only clients', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    registry.register(queueCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: { readOnlyToken: 'read-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read', 'github:read'],
        enabledPlugins: ['github'],
      },
      dashboardDefaultLayout: [{
        id: 'recent-events',
        cardId: 'core.recentEvents',
        x: 0,
        y: 0,
        columns: 4,
        rows: 2,
      }],
    });

    const headers = { authorization: 'Bearer read-token' };
    const cardsBody = await (await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards', { headers }))).json() as {
      data: Array<{ definition: DashboardCardDefinition; availability: { status: string } }>;
    };
    const cardsById = new Map(cardsBody.data.map((entry) => [entry.definition.id, entry]));
    expect(cardsById.get('core.operationalTotals')?.availability).toEqual({ status: 'available' });
    expect(cardsById.get('core.recentEvents')?.availability).toEqual({ status: 'available' });
    expect(cardsById.get('plugin:github.queue')).toEqual({
      definition: queueCard,
      availability: { status: 'available' },
    });

    await expect((await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', { headers }))).json())
      .resolves.toEqual({
        data: {
          id: 'core.defaultLayout',
          source: 'default',
          updatedAt: null,
          filteredItemCount: 0,
          items: [{
            id: 'recent-events',
            cardId: 'core.recentEvents',
            x: 0,
            y: 0,
            columns: 4,
            rows: 2,
          }],
        },
      });

    operationalStore.close();
  });

  it('revalidates default dashboard layouts against the current card catalog before returning them', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(queueCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: { readOnlyToken: 'read-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read'],
        enabledPlugins: [],
      },
      dashboardDefaultLayout: [
        { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
        { id: 'queue', cardId: 'plugin:github.queue', x: 4, y: 0, columns: 3, rows: 2 },
        { id: 'missing', cardId: 'plugin:github.missing', x: 0, y: 2, columns: 3, rows: 2 },
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: 'core.defaultLayout',
        source: 'default',
        items: [{ id: 'recent-events', cardId: 'core.recentEvents' }],
      },
    });
    operationalStore.close();
  });

  it('lets operator clients persist dashboard layouts after card and grid validation', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    registry.register(queueCard);
    registry.register({
      id: 'plugin:github.wideDashboardCard',
      title: 'Wide dashboard card',
      entry: { type: 'plugin', pluginName: 'github', cardName: 'wideDashboardCard' },
      category: 'operations',
      requiredCapabilities: ['dashboard:read', 'github:read'],
      size: {
        default: { columns: 12, rows: 2 },
        min: { columns: 2, rows: 1 },
        max: { columns: 16, rows: 4 },
      },
    });
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read', 'github:read'],
        enabledPlugins: ['github'],
      },
    });

    const readOnlySave = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer read-token', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    }));
    expect(readOnlySave.status).toBe(403);
    await expect(readOnlySave.json()).resolves.toEqual({ error: 'insufficient_scope', requiredScope: 'operator' });

    const invalidCard = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: 'unknown', cardId: 'core.unknown', x: 0, y: 0, columns: 2, rows: 1 }],
      }),
    }));
    expect(invalidCard.status).toBe(400);
    await expect(invalidCard.json()).resolves.toEqual({ error: 'unknown_dashboard_card', cardId: 'core.unknown' });

    const invalidSize = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: 'queue', cardId: 'plugin:github.queue', x: 0, y: 0, columns: 1, rows: 1 }],
      }),
    }));
    expect(invalidSize.status).toBe(400);
    await expect(invalidSize.json()).resolves.toEqual({
      error: 'dashboard_card_size_out_of_range',
      itemId: 'queue',
      cardId: 'plugin:github.queue',
    });

    const unavailableCardRegistry = createDashboardCardRegistry();
    unavailableCardRegistry.register(queueCard);
    const unavailableCardApp = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: unavailableCardRegistry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read'],
        enabledPlugins: ['github'],
      },
    });
    const unavailableCard = await unavailableCardApp.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: 'queue', cardId: 'plugin:github.queue', x: 0, y: 0, columns: 3, rows: 2 }],
      }),
    }));
    expect(unavailableCard.status).toBe(400);
    await expect(unavailableCard.json()).resolves.toEqual({
      error: 'unavailable_dashboard_card',
      cardId: 'plugin:github.queue',
    });

    const duplicateItem = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'dup', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
          { id: 'dup', cardId: 'core.recentEvents', x: 4, y: 0, columns: 4, rows: 2 },
        ],
      }),
    }));
    expect(duplicateItem.status).toBe(400);
    await expect(duplicateItem.json()).resolves.toEqual({ error: 'duplicate_dashboard_layout_item', itemId: 'dup' });

    const overlappingItem = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
          { id: 'queue', cardId: 'plugin:github.queue', x: 3, y: 1, columns: 3, rows: 2 },
        ],
      }),
    }));
    expect(overlappingItem.status).toBe(400);
    await expect(overlappingItem.json()).resolves.toEqual({
      error: 'overlapping_dashboard_layout_item',
      itemId: 'queue',
    });

    const outOfGridItem = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'wide', cardId: 'plugin:github.wideDashboardCard', x: 8, y: 0, columns: 8, rows: 2 },
        ],
      }),
    }));
    expect(outOfGridItem.status).toBe(400);
    await expect(outOfGridItem.json()).resolves.toEqual({
      error: 'invalid_dashboard_layout_item',
      itemId: 'wide',
    });

    const saved = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-layout-save',
      },
      body: JSON.stringify({
        items: [{
          id: 'queue',
          cardId: 'plugin:github.queue',
          x: 4,
          y: 0,
          columns: 3,
          rows: 2,
          config: { repository: 'reirei-lab/rainrail' },
        }],
      }),
    }));
    expect(saved.status).toBe(200);
    expect(saved.headers.get('x-request-id')).toBe('request-layout-save');
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        id: 'user.dashboardLayout',
        source: 'user',
        updatedAt: '2026-07-09T00:00:00.000Z',
        items: [{
          id: 'queue',
          cardId: 'plugin:github.queue',
          x: 4,
          y: 0,
          columns: 3,
          rows: 2,
          config: { repository: 'reirei-lab/rainrail' },
        }],
      },
    });

    await expect((await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }))).json()).resolves.toMatchObject({
      data: {
        id: 'user.dashboardLayout',
        source: 'user',
        items: [{ id: 'queue', cardId: 'plugin:github.queue' }],
      },
    });

    operationalStore.close();
  });

  it('previews dashboard layout saves without persisting on dry run', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: { availableCapabilities: ['dashboard:read'] },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-rainrail-client': 'dashboard',
        'x-request-id': 'request-layout-preview',
      },
      body: JSON.stringify({
        dryRun: true,
        items: [{ id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-layout-preview');
    await expect(response.json()).resolves.toMatchObject({
      data: {
        action: 'dashboard_layout_update',
        targetType: 'dashboard_layout',
        targetId: 'user.dashboardLayout',
        status: 'preview',
        dryRun: true,
        auditId: 'cmd_000001',
        result: { itemCount: 1 },
      },
    });
    expect(operationalStore.getDashboardLayout()).toBeUndefined();
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        actionType: 'dashboard_layout_update',
        status: 'preview',
        dryRun: true,
        result: { itemCount: 1 },
      }],
      activityEvents: [{
        category: 'command',
        actionType: 'dashboard_layout_update',
        outcome: 'skipped',
      }],
    });
    operationalStore.close();
  });

  it('returns saved dashboard layouts with an audit warning when post-save audit storage fails', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const originalRecordActivityEvent = operationalStore.recordActivityEvent.bind(operationalStore);
    vi.spyOn(operationalStore, 'recordActivityEvent').mockImplementation((input) => {
      if (input.category === 'command' && input.outcome === 'success') {
        throw new Error('simulated layout post-save audit failure');
      }

      return originalRecordActivityEvent(input);
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: { availableCapabilities: ['dashboard:read'] },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-layout-audit-warning',
      },
      body: JSON.stringify({
        items: [{ id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-layout-audit-warning');
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: 'user.dashboardLayout',
        source: 'user',
        auditId: 'cmd_000002',
        auditWarning: 'post_dispatch_audit_failed',
        items: [{ id: 'recent-events', cardId: 'core.recentEvents' }],
      },
    });
    expect(operationalStore.getDashboardLayout()?.items).toEqual([
      { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
    ]);
    operationalStore.close();
  });

  it('revalidates saved dashboard layouts against the current card catalog before returning them', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    registry.register(queueCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    operationalStore.saveDashboardLayout([
      { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
      { id: 'queue', cardId: 'plugin:github.queue', x: 3, y: 1, columns: 3, rows: 2 },
      { id: 'missing', cardId: 'plugin:github.missing', x: 0, y: 2, columns: 3, rows: 2 },
    ]);
    const app = createTestApp({
      dashboardAuth: { readOnlyToken: 'read-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read'],
        enabledPlugins: [],
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: 'user.dashboardLayout',
        source: 'user',
        filteredItemCount: 2,
        items: [{ id: 'recent-events', cardId: 'core.recentEvents' }],
      },
    });

    operationalStore.close();
  });

  it('updates a single dashboard layout item config without dropping currently hidden items', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    registry.register(queueCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    operationalStore.saveDashboardLayout([
      { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
      {
        id: 'queue',
        cardId: 'plugin:github.queue',
        x: 4,
        y: 0,
        columns: 3,
        rows: 2,
        config: { repository: 'reirei-lab/rainrail', apiToken: 'must-not-leak' },
      },
    ]);
    const app = createTestApp({
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read'],
        enabledPlugins: [],
      },
    });

    await expect((await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }))).json()).resolves.toMatchObject({
      data: {
        items: [{ id: 'recent-events', cardId: 'core.recentEvents' }],
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout/items/recent-events/config', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-card-config-save',
      },
      body: JSON.stringify({
        config: { density: 'compact' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-card-config-save');
    const responseText = await response.text();
    expect(responseText).not.toContain('must-not-leak');
    expect(responseText).not.toContain('apiToken');
    expect(JSON.parse(responseText)).toMatchObject({
      data: {
        id: 'user.dashboardLayout',
        source: 'user',
        updatedAt: '2026-07-09T00:00:00.000Z',
        items: [
          { id: 'recent-events', cardId: 'core.recentEvents', config: { density: 'compact' } },
        ],
      },
    });
    expect(operationalStore.getDashboardLayout()?.items).toEqual([
      { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2, config: { density: 'compact' } },
      {
        id: 'queue',
        cardId: 'plugin:github.queue',
        x: 4,
        y: 0,
        columns: 3,
        rows: 2,
        config: { repository: 'reirei-lab/rainrail', apiToken: 'must-not-leak' },
      },
    ]);
    operationalStore.close();
  });

  it('saves single item config from the filtered default dashboard layout', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    registry.register(queueCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: {
        availableCapabilities: ['dashboard:read'],
        enabledPlugins: [],
      },
      dashboardDefaultLayout: [
        { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 },
        {
          id: 'queue',
          cardId: 'plugin:github.queue',
          x: 4,
          y: 0,
          columns: 3,
          rows: 2,
        },
      ],
    });

    await expect((await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }))).json()).resolves.toMatchObject({
      data: {
        source: 'default',
        items: [{ id: 'recent-events', cardId: 'core.recentEvents' }],
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout/items/recent-events/config', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        config: { density: 'compact' },
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        source: 'user',
        items: [{ id: 'recent-events', cardId: 'core.recentEvents', config: { density: 'compact' } }],
      },
    });
    expect(operationalStore.getDashboardLayout()?.items).toEqual([
      { id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2, config: { density: 'compact' } },
    ]);
    operationalStore.close();
  });

  it('records audit rows when operators save dashboard layouts', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: { availableCapabilities: ['dashboard:read'] },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-rainrail-client': 'dashboard',
        'x-request-id': 'request-layout-save',
      },
      body: JSON.stringify({
        items: [{ id: 'recent-events', cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-layout-save');
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        actionType: 'dashboard_layout_update',
        targetType: 'dashboard_layout',
        targetId: 'user.dashboardLayout',
        status: 'accepted',
        actor: 'operator',
        client: 'dashboard',
        requestId: 'request-layout-save',
        dryRun: false,
        result: { itemCount: 1 },
      }, {
        actionType: 'dashboard_layout_update',
        targetType: 'dashboard_layout',
        targetId: 'user.dashboardLayout',
        status: 'dispatching',
        actor: 'operator',
        client: 'dashboard',
        requestId: 'request-layout-save',
        dryRun: false,
      }],
      activityEvents: [{
        category: 'command',
        targetType: 'dashboard_layout',
        targetId: 'user.dashboardLayout',
        actionType: 'dashboard_layout_update',
        outcome: 'success',
      }],
    });

    operationalStore.close();
  });

  it('allows browser preflight for saving dashboard layouts', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'OPTIONS',
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
    operationalStore.close();
  });

  it('protects card catalog reads even when no operational store is configured', async () => {
    const app = createTestApp({
      dashboardAuth: { readOnlyToken: 'read-token' },
    });

    const unauthorized = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards'));
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const authorized = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/cards', {
      headers: { authorization: 'Bearer read-token' },
    }));
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({ data: expect.any(Array) });
  });

  it('protects dashboard layout reads and writes even when no operational store is configured', async () => {
    const app = createTestApp({
      dashboardAuth: {
        readOnlyToken: 'read-token',
        operatorToken: 'operator-token',
      },
    });

    const unauthenticatedRead = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout'));
    expect(unauthenticatedRead.status).toBe(401);
    await expect(unauthenticatedRead.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const authorizedRead = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      headers: { authorization: 'Bearer read-token' },
    }));
    expect(authorizedRead.status).toBe(503);
    await expect(authorizedRead.json()).resolves.toEqual({ error: 'operational_store_not_configured' });

    const unauthenticatedWrite = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    }));
    expect(unauthenticatedWrite.status).toBe(401);
    await expect(unauthenticatedWrite.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const readOnlyWrite = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer read-token', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    }));
    expect(readOnlyWrite.status).toBe(403);
    await expect(readOnlyWrite.json()).resolves.toEqual({ error: 'insufficient_scope', requiredScope: 'operator' });

    const operatorWrite = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    }));
    expect(operatorWrite.status).toBe(503);
    await expect(operatorWrite.json()).resolves.toEqual({ error: 'operational_store_not_configured' });
  });

  it('rejects non-string dashboard layout ids and card ids before persistence', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: { availableCapabilities: ['dashboard:read'] },
    });

    const invalidId = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: {}, cardId: 'core.recentEvents', x: 0, y: 0, columns: 4, rows: 2 }],
      }),
    }));
    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toEqual({ error: 'invalid_dashboard_layout_item' });

    const invalidCardId = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: 'recent-events', cardId: {}, x: 0, y: 0, columns: 4, rows: 2 }],
      }),
    }));
    expect(invalidCardId.status).toBe(400);
    await expect(invalidCardId.json()).resolves.toEqual({ error: 'invalid_dashboard_layout_item' });

    expect(operationalStore.getDashboardLayout()).toBeUndefined();
    operationalStore.close();
  });

  it('rejects sensitive dashboard layout config keys before persistence', async () => {
    const registry = createDashboardCardRegistry();
    registry.register(recentEventsCard);
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
    });
    const app = createTestApp({
      dashboardAuth: { operatorToken: 'operator-token' },
      operationalStore,
      dashboardCardRegistry: registry,
      dashboardCardCatalog: { availableCapabilities: ['dashboard:read'] },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-layout-sensitive-config',
      },
      body: JSON.stringify({
        items: [{
          id: 'recent-events',
          cardId: 'core.recentEvents',
          x: 0,
          y: 0,
          columns: 4,
          rows: 2,
          config: { nested: { credential: 'secret-token' } },
        }],
      }),
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('request-layout-sensitive-config');
    await expect(response.json()).resolves.toEqual({
      error: 'sensitive_dashboard_card_config',
      itemId: 'recent-events',
      cardId: 'core.recentEvents',
    });
    expect(operationalStore.getDashboardLayout()).toBeUndefined();
    operationalStore.close();
  });

  it('serves split v1 overview, events, workflow runs, and agent tasks without requiring the snapshot shape', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 1,
      now: () => new Date('2026-07-02T00:05:00.000Z'),
    });
    const older = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-older', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '24', url: 'https://github.com/reirei-lab/rainrail/issues/24' },
      payload: { action: 'opened', token: 'should-not-appear-in-list' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-older' },
    }));
    const latest = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.pull_request',
      delivery: { id: 'delivery-latest', receivedAt: '2026-07-02T00:01:00.000Z' },
      occurredAt: '2026-07-02T00:01:00.000Z',
      subject: { type: 'pull_request', id: '25', url: 'https://github.com/reirei-lab/rainrail/pull/25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-latest' },
    }));
    const workflow = operationalStore.recordActivityEvent({
      sourceEventId: latest.id,
      sourceEventName: latest.name,
      category: 'plugin',
      targetType: 'event',
      targetId: latest.id,
      actionType: 'plugin_executed',
      outcome: 'success',
      summary: 'review-request plugin completed',
      metadata: { pluginName: 'review-request' },
    });
    for (let index = 0; index < 5; index += 1) {
      operationalStore.recordActivityEvent({
        category: 'command',
        targetType: 'agent-task',
        targetId: `agent_task_command_${index}`,
        actionType: 'resume',
        outcome: 'success',
        summary: `Accepted resume command ${index}`,
      });
    }
    operationalStore.recordEventHandlerRetry({
      eventId: latest.id,
      handlerName: 'conflict-check',
      nextRetryAt: '2026-07-02T00:10:00.000Z',
      lastError: 'GitHub mergeability is pending',
    });
    const task = operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_110',
      title: 'Dashboard query API を分割する',
      agentSessionId: 'agent:main:rainrail-110',
      branchName: 'agent/reirei-lab-rainrail-110-dashboard-query-api',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 110 },
      claim: { projectItemId: 'PVTI_110' },
      logPath: 'var/log/rainrail-110.log',
      pid: 2468,
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        listProjectIssues: async () => [{
          id: 'PVTI_STOPPED',
          title: 'Stopped task claim',
          status: 'Todo',
          state: 'OPEN',
          assigneeLogins: ['reirei-agent'],
          repository: 'reirei-lab/rainrail',
          number: 116,
        }],
      },
    });

    const overview = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      data: {
        counts: { events: 2, activityEvents: 6, agentTasks: 1, eventHandlerRetries: 1 },
        warnings: { staleProjectClaims: [] },
        recentActivity: [{ id: workflow.id, summary: 'review-request plugin completed' }],
      },
    });

    const events = await app.fetch(new Request('https://rainrail.local/api/v1/events?limit=1', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(events.status).toBe(200);
    const eventsBody = await events.json() as { data: Array<{ id: string }>; page: { nextCursor: string | null } };
    expect(eventsBody).toMatchObject({
      data: [{
        id: latest.id,
        type: 'event',
        name: 'github.pull_request',
        status: 'received',
        summary: 'github.pull_request reirei-lab/rainrail#25',
        deliveryId: 'delivery-latest',
        rawPayloadReference: 'github://deliveries/delivery-latest',
        workflowRunCount: 1,
        handlerRetryCount: 1,
        latestOutcome: 'success',
        links: { self: `/api/v1/events/${encodeURIComponent(latest.id)}` },
      }],
      page: { limit: 1 },
    });
    expect(JSON.stringify(eventsBody)).not.toContain('should-not-appear-in-list');
    expect(eventsBody.page.nextCursor).toEqual(expect.any(String));

    const nextEvents = await app.fetch(new Request(`https://rainrail.local/api/v1/events?limit=1&cursor=${encodeURIComponent(eventsBody.page.nextCursor!)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(nextEvents.json()).resolves.toMatchObject({
      data: [{ id: older.id }],
      page: { limit: 1, nextCursor: null },
    });

    const nameFilteredEvents = await app.fetch(new Request('https://rainrail.local/api/v1/events?filter[name]=github.issue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(nameFilteredEvents.json()).resolves.toMatchObject({
      data: [{ id: older.id, name: 'github.issue', deliveryId: 'delivery-older' }],
      page: { limit: 50, nextCursor: null },
    });

    const eventDetail = await app.fetch(new Request(`https://rainrail.local/api/v1/events/${encodeURIComponent(latest.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(eventDetail.status).toBe(200);
    const eventDetailBody = await eventDetail.json();
    expect(eventDetailBody).toMatchObject({
      data: {
        id: latest.id,
        type: 'event',
        record: {
          name: latest.name,
          humanSummary: 'github.pull_request reirei-lab/rainrail#25',
          envelope: {
            schemaVersion: 'rainrail.event.v1',
            rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-latest' },
          },
          activityEvents: [{ id: workflow.id }],
          handlerRetries: [{ handlerName: 'conflict-check' }],
        },
      },
    });
    expect(JSON.stringify(eventDetailBody)).not.toContain('"payload"');

    const workflowRuns = await app.fetch(new Request('https://rainrail.local/api/v1/workflow-runs', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(workflowRuns.json()).resolves.toMatchObject({
      data: [{ id: workflow.id, type: 'workflow-run', status: 'success', sourceEventId: latest.id }],
      page: { limit: 50, nextCursor: null },
    });

    const agentTasks = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(agentTasks.json()).resolves.toMatchObject({
      data: [{
        id: task.id,
        type: 'agent-task',
        status: 'running',
        branchName: 'agent/reirei-lab-rainrail-110-dashboard-query-api',
        links: { self: `/api/v1/agent-tasks/${encodeURIComponent(task.id)}` },
      }],
      page: { limit: 50, nextCursor: null },
    });

    const taskDetail = await app.fetch(new Request(`https://rainrail.local/api/v1/agent-tasks/${task.id}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(taskDetail.json()).resolves.toMatchObject({
      data: {
        id: task.id,
        type: 'agent-task',
        record: { runtime: { status: 'running', pid: 2468 }, logPath: 'var/log/rainrail-110.log' },
      },
    });

    operationalStore.close();
  });

  it('rejects invalid v1 pagination and unsupported event list filters', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const badCursor = await app.fetch(new Request('https://rainrail.local/api/v1/events?cursor=not-a-cursor', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(badCursor.status).toBe(400);
    await expect(badCursor.json()).resolves.toEqual({ error: 'invalid_cursor' });

    const badFilter = await app.fetch(new Request('https://rainrail.local/api/v1/events?filter[unknown]=value', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(badFilter.status).toBe(400);
    await expect(badFilter.json()).resolves.toEqual({ error: 'unsupported_filter', filter: 'filter[unknown]' });

    operationalStore.close();
  });

  it('serves source, queue, and settings dashboard views without exposing secrets', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-source', receivedAt: '2026-07-02T00:02:00.000Z' },
      occurredAt: '2026-07-02T00:02:00.000Z',
      subject: { type: 'issue', id: '115', url: 'https://github.com/reirei-lab/rainrail/issues/115' },
      payload: { action: 'opened', webhookSecret: 'should-not-appear' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-source' },
    }));
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Sources / Queue / Settings view を追加する',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115-sources-queue-settings-view',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'Todo' },
      pid: 1150,
    });
    operationalStore.recordEventHandlerRetry({
      eventId: 'github-webhook:delivery-source:github.issue',
      handlerName: 'queue-dispatch',
      nextRetryAt: '2026-07-02T00:20:00.000Z',
      lastError: 'Project item is blocked',
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      runtime: 'node',
      intakeAdapters: [
        createGitHubWebhookIntakeAdapter({ secret: 'should-not-appear', sourceName: 'github-webhook', endpoint: '/webhooks/github' }),
      ],
    });

    const sources = await app.fetch(new Request('https://rainrail.local/api/v1/sources', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(sources.status).toBe(200);
    const sourcesBody = await sources.json();
    expect(sourcesBody).toMatchObject({
      data: [{
        id: 'github-webhook',
        type: 'source',
        status: 'configured',
        sourceType: 'github',
        name: 'github-webhook',
        endpoint: '/webhooks/github',
        auth: { status: 'configured' },
        lastDelivery: { id: 'delivery-source', receivedAt: '2026-07-02T00:02:00.000Z' },
      }],
      page: { limit: 50, nextCursor: null },
    });
    expect(JSON.stringify(sourcesBody)).not.toContain('should-not-appear');

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'agent_task_running',
        type: 'queue-item',
        status: 'in-progress',
        title: 'Sources / Queue / Settings view を追加する',
        projectStatus: 'Todo',
        claimLock: { projectItemId: 'PVTI_115', heldBy: 'agent:main:rainrail-115' },
      }],
      summary: {
        upcomingIssues: 0,
        blockedReasons: ['Project item is blocked'],
        inProgressCount: 1,
        claimedCount: 1,
      },
      page: { limit: 50, nextCursor: null },
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      data: [
        { id: 'max-concurrency', type: 'setting', status: 'read-only', value: 'not configured' },
        { id: 'auto-start', type: 'setting', status: 'read-only', value: 'not configured' },
        { id: 'retry-policy', type: 'setting', status: 'read-only', value: '1 retry pending' },
        { id: 'operational-snapshot-limit', label: 'Operational snapshot limit', type: 'setting', status: 'read-only', value: '10 events' },
        { id: 'dashboard-auth', type: 'setting', status: 'read-only', value: 'bearer token configured' },
        { id: 'runtime', type: 'setting', status: 'read-only', value: 'node' },
      ],
      updatePolicy: { requiredScope: 'admin', audit: 'required' },
      page: { limit: 50, nextCursor: null },
    });

    const upcoming = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(upcoming.status).toBe(200);
    await expect(upcoming.json()).resolves.toMatchObject({
      data: [],
      summary: {
        upcomingIssues: 0,
      },
    });

    operationalStore.close();
  });

  it('keeps stored queue rows when the task queue provider fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Stored running task',
      agentSessionId: 'agent:main:running',
      branchName: 'agent/running',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_RUNNING', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        listProjectIssues: async () => {
          throw new Error('GitHub Project API unavailable');
        },
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{ id: 'agent_task_running', status: 'in-progress' }],
      summary: {
        inProgressCount: 1,
        upcomingIssues: 0,
      },
    });

    operationalStore.close();
  });

  it('uses intake adapter source metadata for source type and auth status', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      intakeAdapters: [
        createGitHubWebhookIntakeAdapter({ secret: '', sourceName: 'prod-webhook', endpoint: '/webhooks/github' }),
        createCloudflareTailIntakeAdapter({
          sourceName: 'prod-tail',
          fallbackDeliveryId: () => 'tail-delivery',
        }),
      ],
    });

    const cloudflare = await app.fetch(new Request('https://rainrail.local/api/v1/sources?filter[source]=cloudflare', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(cloudflare.json()).resolves.toMatchObject({
      data: [{
        id: 'prod-tail',
        sourceType: 'cloudflare',
        auth: { status: 'not required' },
      }],
      page: { limit: 50, nextCursor: null },
    });

    const github = await app.fetch(new Request('https://rainrail.local/api/v1/sources?filter[source]=github', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(github.json()).resolves.toMatchObject({
      data: [{
        id: 'prod-webhook',
        sourceType: 'github',
        auth: { status: 'missing' },
      }],
      page: { limit: 50, nextCursor: null },
    });

    operationalStore.close();
  });

  it('lists manual chat intake adapters with configured source metadata before first delivery', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-token',
          sourceName: 'web-chat',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/sources?filter[source]=chat', {
      headers: { authorization: 'Bearer events-token' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{
        id: 'web-chat',
        sourceType: 'chat',
        name: 'web-chat',
        endpoint: '/intake/chat',
        auth: { status: 'configured' },
      }],
      page: { limit: 50, nextCursor: null },
    });

    operationalStore.close();
  });

  it('reports unknown source auth when an intake adapter does not declare auth metadata', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      intakeAdapters: [{
        name: 'custom-http',
        source: { type: 'manual' },
        routes: [{
          path: '/custom/intake',
          methods: ['POST'],
          handle: () => new Response(null, { status: 202 }),
        }],
      }],
    });

    const sources = await app.fetch(new Request('https://rainrail.local/api/v1/sources', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(sources.status).toBe(200);
    await expect(sources.json()).resolves.toMatchObject({
      data: [{
        id: 'custom-http',
        endpoint: '/custom/intake',
        auth: { status: 'unknown' },
      }],
    });

    operationalStore.close();
  });

  it('uses unique source row ids so duplicate adapter names can paginate', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      intakeAdapters: [
        { name: 'shared-source', source: { type: 'manual', authStatus: 'not_required' } },
        { name: 'shared-source', source: { type: 'manual', authStatus: 'not_required' } },
      ],
    });

    const first = await app.fetch(new Request('https://rainrail.local/api/v1/sources?limit=1', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: Array<{ id: string; name: string }>; page: { nextCursor: string | null } };
    expect(firstBody).toMatchObject({
      data: [{ id: 'shared-source:0', name: 'shared-source' }],
    });
    expect(firstBody.page.nextCursor).toEqual(expect.any(String));
    const nextCursor = firstBody.page.nextCursor;
    expect(nextCursor).not.toBeNull();

    const second = await app.fetch(new Request(`https://rainrail.local/api/v1/sources?limit=1&cursor=${encodeURIComponent(nextCursor ?? '')}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      data: [{ id: 'shared-source:1', name: 'shared-source' }],
      page: { limit: 1, nextCursor: null },
    });

    operationalStore.close();
  });

  it('avoids source row id collisions between duplicate suffixes and adapter names', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      intakeAdapters: [
        { name: 'foo', source: { type: 'manual', authStatus: 'not_required' } },
        { name: 'foo', source: { type: 'manual', authStatus: 'not_required' } },
        { name: 'foo:0', source: { type: 'manual', authStatus: 'not_required' } },
      ],
    });

    const sources = await app.fetch(new Request('https://rainrail.local/api/v1/sources', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(sources.status).toBe(200);
    const body = await sources.json() as { data: Array<{ id: string; name: string }> };
    const ids = body.data.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(body.data.find((row) => row.name === 'foo:0')).toMatchObject({ id: 'foo:0' });

    operationalStore.close();
  });

  it('marks stale project claims and abnormal terminal statuses as blocked queue rows', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_compaction_failed',
      title: 'Release stale claim',
      agentSessionId: 'agent:main:rainrail-stale',
      branchName: 'agent/reirei-lab-rainrail-stale',
      status: 'compaction_failed',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_STALE', originalStatus: 'In Progress' },
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_stopped',
      title: 'Stopped task claim',
      agentSessionId: 'agent:main:rainrail-stopped',
      branchName: 'agent/reirei-lab-rainrail-stopped',
      status: 'stopped',
      issue: { repository: 'reirei-lab/rainrail', number: 116 },
      claim: { projectItemId: 'PVTI_STOPPED', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=blocked', {
      headers: { authorization: 'Bearer events-token' },
    }));

    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [
        {
          id: 'agent_task_compaction_failed',
          status: 'blocked',
          blockedReason: 'stale project claim: compaction_failed',
          staleProjectClaim: true,
          claimLock: { projectItemId: 'PVTI_STALE', heldBy: 'agent:main:rainrail-stale' },
        },
        {
          id: 'agent_task_stopped',
          status: 'blocked',
          blockedReason: 'stale project claim: stopped',
          staleProjectClaim: true,
          claimLock: { projectItemId: 'PVTI_STOPPED', heldBy: 'agent:main:rainrail-stopped' },
        },
      ],
      summary: {
        blockedCount: 2,
        staleClaimCount: 2,
        blockedReasons: [
          'stale project claim: stopped',
          'stale project claim: compaction_failed',
        ],
      },
      page: { limit: 50, nextCursor: null },
    });

    operationalStore.close();
  });

  it('includes unclaimed project issues from the task queue provider', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Already claimed issue',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress', maxConcurrentAgentTasks: 2 },
        listProjectIssues: async () => [
          {
            id: 'PVTI_115',
            title: 'Already claimed issue',
            status: 'In Progress',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 115,
            url: 'https://github.com/reirei-lab/rainrail/issues/115',
          },
          {
            id: 'PVTI_116',
            title: 'Someone else issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['another-agent'],
            repository: 'reirei-lab/rainrail',
            number: 116,
            url: 'https://github.com/reirei-lab/rainrail/issues/116',
          },
          {
            id: 'PVTI_117',
            title: 'Blocked issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 117,
            url: 'https://github.com/reirei-lab/rainrail/issues/117',
            blockedBy: [{ repository: 'reirei-lab/rainrail', number: 99, state: 'OPEN' }],
          },
          {
            id: 'PVTI_118',
            title: 'Upcoming issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 118,
            url: 'https://github.com/reirei-lab/rainrail/issues/118',
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'project:PVTI_118',
        type: 'queue-item',
        status: 'upcoming',
        title: 'Upcoming issue',
        issue: {
          repository: 'reirei-lab/rainrail',
          number: 118,
          url: 'https://github.com/reirei-lab/rainrail/issues/118',
        },
        projectStatus: 'Todo',
      }],
      summary: {
        upcomingIssues: 1,
        inProgressCount: 1,
        claimedCount: 1,
      },
    });

    operationalStore.close();
  });

  it('skips represented project issues before selecting the next upcoming queue issue', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Already claimed issue',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress', maxConcurrentAgentTasks: 2 },
        listProjectIssues: async () => [
          {
            id: 'PVTI_115',
            title: 'Project status has not caught up',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 115,
            url: 'https://github.com/reirei-lab/rainrail/issues/115',
          },
          {
            id: 'PVTI_118',
            title: 'Next startable issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 118,
            url: 'https://github.com/reirei-lab/rainrail/issues/118',
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'project:PVTI_118',
        status: 'upcoming',
        title: 'Next startable issue',
      }],
      summary: {
        upcomingIssues: 1,
        inProgressCount: 1,
      },
    });

    operationalStore.close();
  });

  it('does not show upcoming project issues when local running tasks reach the concurrency limit', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_running',
      title: 'Already running issue',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: {},
        listProjectIssues: async () => [
          {
            id: 'PVTI_115',
            title: 'Project status has not caught up',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 115,
            url: 'https://github.com/reirei-lab/rainrail/issues/115',
          },
          {
            id: 'PVTI_118',
            title: 'Next startable issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 118,
            url: 'https://github.com/reirei-lab/rainrail/issues/118',
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [],
      summary: {
        upcomingIssues: 0,
        inProgressCount: 1,
      },
    });

    operationalStore.close();
  });

  it('keeps provider in-progress project issues visible when they block new starts', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress', maxConcurrentAgentTasks: 1 },
        listProjectIssues: async () => [
          {
            id: 'PVTI_115',
            title: 'Provider running issue',
            status: 'In Progress',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 115,
            url: 'https://github.com/reirei-lab/rainrail/issues/115',
          },
          {
            id: 'PVTI_118',
            title: 'Next startable issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 118,
            url: 'https://github.com/reirei-lab/rainrail/issues/118',
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'project:PVTI_115',
        type: 'queue-item',
        status: 'in-progress',
        title: 'Provider running issue',
        projectStatus: 'In Progress',
      }],
      summary: {
        upcomingIssues: 0,
        inProgressCount: 1,
      },
    });

    operationalStore.close();
  });

  it('treats running issue-only tasks as represented project issues', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_running_without_claim',
      title: 'Already running issue without claim metadata',
      agentSessionId: 'agent:main:rainrail-115',
      branchName: 'agent/reirei-lab-rainrail-115',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress', maxConcurrentAgentTasks: 2 },
        listProjectIssues: async () => [
          {
            id: 'PVTI_115',
            title: 'Project status has not caught up',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 115,
            url: 'https://github.com/reirei-lab/rainrail/issues/115',
          },
          {
            id: 'PVTI_118',
            title: 'Next startable issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 118,
            url: 'https://github.com/reirei-lab/rainrail/issues/118',
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{
        id: 'project:PVTI_118',
        status: 'upcoming',
        title: 'Next startable issue',
      }],
      summary: {
        upcomingIssues: 1,
        inProgressCount: 1,
      },
    });

    operationalStore.close();
  });

  it('keeps represented project issues in selection context before suppressing duplicate rows', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_child_running',
      title: 'Running child issue',
      agentSessionId: 'agent:main:child-running',
      branchName: 'agent/child-running',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 201 },
      claim: { projectItemId: 'PVTI_201', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress', maxConcurrentAgentTasks: 2 },
        listProjectIssues: async () => [
          {
            id: 'PVTI_200',
            title: 'Parent issue',
            status: 'Todo',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 200,
          },
          {
            id: 'PVTI_201',
            title: 'Running child issue',
            status: 'In Progress',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 201,
            parent: { repository: 'reirei-lab/rainrail', number: 200 },
          },
          {
            id: 'PVTI_202',
            title: 'Sibling should wait',
            status: 'Backlog',
            state: 'OPEN',
            assigneeLogins: ['reirei-agent'],
            repository: 'reirei-lab/rainrail',
            number: 202,
            parent: { repository: 'reirei-lab/rainrail', number: 200 },
          },
        ],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [],
      summary: { upcomingIssues: 0, inProgressCount: 1 },
    });

    operationalStore.close();
  });

  it('keeps requeued released issues visible and prioritizes project issue rows before history', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    for (let index = 0; index < 30; index += 1) {
      operationalStore.recordAgentTask({
        id: `agent_task_history_${index}`,
        title: `Historical task ${index}`,
        agentSessionId: `agent:main:history-${index}`,
        branchName: `agent/history-${index}`,
        status: 'succeeded',
        issue: { repository: 'reirei-lab/rainrail', number: 200 + index },
      });
    }
    operationalStore.recordAgentTask({
      id: 'agent_task_released',
      title: 'Released task for requeue',
      agentSessionId: 'agent:main:released',
      branchName: 'agent/released',
      status: 'failed',
      issue: { repository: 'reirei-lab/rainrail', number: 115 },
      claim: { projectItemId: 'PVTI_115', originalStatus: 'In Progress' },
      projectClaim: {
        status: 'released',
        updatedAt: '2026-07-02T00:10:00.000Z',
        reason: 'stale project claim: failed',
      },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { todoStatus: 'Todo', backlogStatus: 'Backlog', inProgressStatus: 'In Progress' },
        listProjectIssues: async () => [{
          id: 'PVTI_115',
          title: 'Requeued issue',
          status: 'Todo',
          state: 'OPEN',
          assigneeLogins: ['reirei-agent'],
          repository: 'reirei-lab/rainrail',
          number: 115,
          url: 'https://github.com/reirei-lab/rainrail/issues/115',
        }],
      },
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?limit=25', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    const body = await queue.json() as { data: Array<{ id: string; status: string }>; summary: { upcomingIssues: number } };
    expect(body.data[0]).toMatchObject({ id: 'project:PVTI_115', status: 'upcoming' });
    expect(body.data.some((row) => row.id === 'project:PVTI_115')).toBe(true);
    expect(body.summary.upcomingIssues).toBe(1);

    const upcoming = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=upcoming', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(upcoming.status).toBe(200);
    await expect(upcoming.json()).resolves.toMatchObject({
      data: [{ id: 'project:PVTI_115', status: 'upcoming' }],
    });

    operationalStore.close();
  });

  it('classifies human-decision terminal tasks as blocked queue rows', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_needs_human',
      title: 'Needs human decision',
      agentSessionId: 'agent:main:needs-human',
      branchName: 'agent/needs-human',
      status: 'needs_human',
      issue: { repository: 'reirei-lab/rainrail', number: 119 },
      claim: { projectItemId: 'PVTI_NEEDS_HUMAN', originalStatus: 'In Progress' },
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_split',
      title: 'Split recommended',
      agentSessionId: 'agent:main:split',
      branchName: 'agent/split',
      status: 'split_recommended',
      issue: { repository: 'reirei-lab/rainrail', number: 120 },
      claim: { projectItemId: 'PVTI_SPLIT', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=blocked', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [
        {
          id: 'agent_task_needs_human',
          status: 'blocked',
          claimLock: { projectItemId: 'PVTI_NEEDS_HUMAN', heldBy: 'agent:main:needs-human' },
        },
        {
          id: 'agent_task_split',
          status: 'blocked',
          claimLock: { projectItemId: 'PVTI_SPLIT', heldBy: 'agent:main:split' },
        },
      ],
      summary: { blockedCount: 2, claimedCount: 2 },
    });

    operationalStore.close();
  });

  it('does not report released project claims as active queue locks', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_released',
      title: 'Released stale claim',
      agentSessionId: 'agent:main:rainrail-released',
      branchName: 'agent/released-task',
      status: 'failed',
      issue: { repository: 'reirei-lab/rainrail', number: 117 },
      claim: { projectItemId: 'PVTI_RELEASED', originalStatus: 'In Progress' },
      projectClaim: {
        status: 'released',
        updatedAt: '2026-07-02T00:10:00.000Z',
        reason: 'stale project claim: failed',
      },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?filter[status]=blocked', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    const body = await queue.json() as { data: Array<{ claimLock?: unknown }> };
    expect(body).toMatchObject({
      data: [{
        id: 'agent_task_released',
        status: 'blocked',
        projectStatus: 'unknown',
        releaseStatus: 'released',
      }],
      summary: {
        blockedCount: 1,
        claimedCount: 0,
      },
    });
    const releasedRow = body.data[0];
    expect(releasedRow).toBeDefined();
    expect(releasedRow?.claimLock).toBeUndefined();

    operationalStore.close();
  });

  it('does not report completed task claim metadata as an active queue lock', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_succeeded',
      title: 'Completed task claim metadata',
      agentSessionId: 'agent:main:completed',
      branchName: 'agent/completed',
      status: 'succeeded',
      issue: { repository: 'reirei-lab/rainrail', number: 121 },
      claim: { projectItemId: 'PVTI_DONE', originalStatus: 'In Progress' },
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(200);
    const body = await queue.json() as { data: Array<{ claimLock?: unknown; projectStatus?: string }>; summary: { claimedCount: number } };
    expect(body).toMatchObject({
      data: [{ id: 'agent_task_succeeded', status: 'succeeded', projectStatus: 'unknown' }],
      summary: { claimedCount: 0 },
    });
    expect(body.data[0]?.claimLock).toBeUndefined();

    operationalStore.close();
  });

  it('reports configured queue max concurrency in settings', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: { maxConcurrentAgentTasks: 3 },
        listProjectIssues: async () => [],
      },
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(settings.status).toBe(200);
    const body = await settings.json() as { data: Array<{ id: string; value: string }> };
    expect(body.data.find((row) => row.id === 'max-concurrency')).toMatchObject({
      id: 'max-concurrency',
      value: '3 agent tasks',
    });

    operationalStore.close();
  });

  it('reports the effective default queue max concurrency in settings', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
      taskQueue: {
        selection: {},
        listProjectIssues: async () => [],
      },
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(settings.status).toBe(200);
    const body = await settings.json() as { data: Array<{ id: string; value: string }> };
    expect(body.data.find((row) => row.id === 'max-concurrency')).toMatchObject({
      id: 'max-concurrency',
      value: '1 agent task (default)',
    });

    operationalStore.close();
  });

  it('reports dashboard scoped tokens as configured dashboard auth', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      operationalStore,
      dashboardAuth: { readOnlyToken: 'read-only-token' },
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings', {
      headers: { authorization: 'Bearer read-only-token' },
    }));
    expect(settings.status).toBe(200);
    const body = await settings.json() as { data: Array<{ id: string; value: string }> };
    expect(body.data.find((row) => row.id === 'dashboard-auth')).toMatchObject({
      id: 'dashboard-auth',
      value: 'bearer token configured',
    });

    operationalStore.close();
  });

  it('rejects newest sort for the status-prioritized queue', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const queue = await app.fetch(new Request('https://rainrail.local/api/v1/queue?sort=newest', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(queue.status).toBe(400);
    await expect(queue.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'newest' });

    operationalStore.close();
  });

  it('rejects newest sort for static settings rows', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const settings = await app.fetch(new Request('https://rainrail.local/api/v1/settings?sort=newest', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(settings.status).toBe(400);
    await expect(settings.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'newest' });

    operationalStore.close();
  });

  it('rejects newest sort for registration-ordered sources', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:12:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const sources = await app.fetch(new Request('https://rainrail.local/api/v1/sources?sort=newest', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(sources.status).toBe(400);
    await expect(sources.json()).resolves.toEqual({ error: 'unsupported_sort', sort: 'newest' });

    operationalStore.close();
  });

  it('serves provider-neutral operational state through the HTTP app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-25', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25', url: 'https://github.com/reirei-lab/rainrail/issues/25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-25' },
    }));
    operationalStore.recordActivityEvent({
      category: 'plugin',
      targetType: 'event',
      actionType: 'plugin_executed',
      outcome: 'success',
      summary: 'plugin execution completed',
    });

    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const stateResponse = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      counts: { events: 1, activityEvents: 1 },
      events: [{ id: event.id, name: 'github.issue', source: { type: 'github' } }],
      activityEvents: [{ summary: 'plugin execution completed' }],
    });

    const detailResponse = await app.fetch(new Request(`https://rainrail.local/api/events/${encodeURIComponent(event.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: event.id,
      envelope: { subject: { type: 'issue', id: '25' } },
    });

    operationalStore.close();
  });

  it('protects operational dashboard API with the event bearer token', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-auth', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-auth' },
    }));
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const missingStateAuth = await app.fetch(new Request('https://rainrail.local/api/state'));
    expect(missingStateAuth.status).toBe(401);
    await expect(missingStateAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const missingDetailAuth = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`));
    expect(missingDetailAuth.status).toBe(401);
    await expect(missingDetailAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const missingV1Auth = await app.fetch(new Request('https://rainrail.local/api/v1/overview'));
    expect(missingV1Auth.status).toBe(401);
    await expect(missingV1Auth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(state.status).toBe(200);

    const detail = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detail.status).toBe(200);

    const overview = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(overview.status).toBe(200);

    operationalStore.close();
  });

  it('reports dashboard auth misconfiguration before missing credentials', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/overview'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'events_auth_not_configured' });
    operationalStore.close();
  });

  it('accepts scoped dashboard tokens for read-only operational APIs', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        readOnlyToken: 'read-only-token',
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      },
    });

    for (const token of ['read-only-token', 'operator-token', 'admin-token']) {
      const response = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { counts: { agentTasks: 1 } },
      });
    }

    const invalid = await app.fetch(new Request('https://rainrail.local/api/v1/overview', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(invalid.status).toBe(403);
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_bearer_token' });

    operationalStore.close();
  });

  it('rejects duplicated dashboard tokens across different scopes', () => {
    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'shared-token',
      dashboardAuth: {
        adminToken: 'shared-token',
      },
    })).toThrow(/duplicate dashboard token scopes/i);

    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      dashboardAuth: {
        operatorToken: 'shared-token',
        adminToken: 'shared-token',
      },
    })).toThrow(/duplicate dashboard token scopes/i);

    expect(() => createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'read-token',
      dashboardAuth: {
        readOnlyToken: 'read-token',
      },
    })).not.toThrow();
  });

  it('returns a stable unavailable response when the operational store is not configured', async () => {
    const app = createTestApp();

    const response = await app.fetch(new Request('https://rainrail.local/api/state'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_not_configured' });

    const v1Response = await app.fetch(new Request('https://rainrail.local/api/v1/events'));
    expect(v1Response.status).toBe(503);
    await expect(v1Response.json()).resolves.toEqual({ error: 'operational_store_not_configured' });
  });

  it('records HTTP-ingressed events in the operational store after publish succeeds', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));
    expect(webhook.status).toBe(202);

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(state.json()).resolves.toMatchObject({
      events: [{ id: 'github-webhook:delivery-operational-store:github.issue' }],
    });

    operationalStore.close();
  });

  it('stores the bridge-validated envelope instead of the raw webhook envelope', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    const rawBody = JSON.stringify({
      action: 'agent-run',
      branch: 'agent/reirei-lab-rainrail-25',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      client_payload: {
        issue: 25,
        token: 'should-not-be-persisted',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'repository_dispatch',
        'x-github-delivery': 'delivery-validated-envelope',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));
    expect(webhook.status).toBe(202);

    const event = operationalStore.getEvent('github-webhook:delivery-validated-envelope:github.repository_dispatch');
    expect(event?.envelope.payload).toEqual({ action: 'agent_run' });
    expect(JSON.stringify(event?.envelope)).not.toContain('should-not-be-persisted');
    operationalStore.close();
  });

  it('does not fail an already-published webhook when operational event recording fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    operationalStore.close();
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store-failure',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));

    expect(webhook.status).toBe(202);
    await expect(webhook.json()).resolves.toMatchObject({
      id: 'github-webhook:delivery-operational-store-failure:github.issue',
    });
  });

  it('treats malformed percent-encoded event ids as client errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createTestApp({
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/events/%E0%A4%A', {
      headers: { authorization: 'Bearer events-token' },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_event_id' });
    operationalStore.close();
  });

  it('gates agent task command actions to operator tokens and records dry-run audit', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'Resume / reset / terminate / settings の command API を権限付きで設計する',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      eventsBearerToken: 'read-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    const readOnlyResponse = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer read-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: true }),
    }));
    expect(readOnlyResponse.status).toBe(403);
    await expect(readOnlyResponse.json()).resolves.toEqual({
      error: 'insufficient_scope',
      requiredScope: 'operator',
    });

    const dryRunResponse = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-rainrail-client': 'dashboard',
        'x-request-id': 'request-resume-preview',
      },
      body: JSON.stringify({ dryRun: true }),
    }));

    expect(dryRunResponse.status).toBe(200);
    expect(dryRunResponse.headers.get('x-request-id')).toBe('request-resume-preview');
    await expect(dryRunResponse.json()).resolves.toMatchObject({
      data: {
        action: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_rainrail_111',
        status: 'preview',
        dryRun: true,
      },
    });
    expect(commandHandler).not.toHaveBeenCalled();
    expect(operationalStore.snapshot()).toMatchObject({
      counts: { activityEvents: 1, commandResults: 1 },
      activityEvents: [{
        category: 'command',
        actionType: 'agent_task_resume',
        outcome: 'skipped',
        metadata: {
          actor: 'operator',
          client: 'dashboard',
          requestId: 'request-resume-preview',
          dryRun: true,
        },
      }],
      commandResults: [{
        actionType: 'agent_task_resume',
        status: 'preview',
        actor: 'operator',
        client: 'dashboard',
        requestId: 'request-resume-preview',
        dryRun: true,
      }],
    });

    const workflowRuns = await app.fetch(new Request('https://rainrail.local/api/v1/workflow-runs', {
      headers: { authorization: 'Bearer read-token' },
    }));
    await expect(workflowRuns.json()).resolves.toMatchObject({
      data: [],
      page: { limit: 50, nextCursor: null },
    });

    const workflowRunDetail = await app.fetch(new Request('https://rainrail.local/api/v1/workflow-runs/activity_000001', {
      headers: { authorization: 'Bearer read-token' },
    }));
    expect(workflowRunDetail.status).toBe(404);
    await expect(workflowRunDetail.json()).resolves.toEqual({ error: 'workflow_run_not_found' });
    operationalStore.close();
  });

  it('returns 503 when dry-run command audit storage fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'Resume command',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    vi.spyOn(operationalStore, 'recordCommandResult').mockImplementation(() => {
      throw new Error('simulated dry-run audit failure');
    });
    const commandHandler = vi.fn();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-dry-run-audit-failure',
      },
      body: JSON.stringify({ dryRun: true }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('request-dry-run-audit-failure');
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_unavailable' });
    expect(commandHandler).not.toHaveBeenCalled();
    operationalStore.close();
  });

  it('requires confirmation for destructive commands before dispatching them', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const commandHandler = vi.fn(async () => ({ stopped: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });

    const preview = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/terminate', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(preview.status).toBe(409);
    await expect(preview.json()).resolves.toMatchObject({
      error: 'action_confirmation_required',
      data: {
        action: 'agent_task_terminate',
        confirmationToken: 'confirm:agent_task_terminate:agent_task:agent_task_rainrail_111',
      },
    });
    expect(commandHandler).not.toHaveBeenCalled();

    const confirmed = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/terminate', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-terminate',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:agent_task_terminate:agent_task:agent_task_rainrail_111',
      }),
    }));

    expect(confirmed.status).toBe(202);
    await expect(confirmed.json()).resolves.toMatchObject({
      data: {
        action: 'agent_task_terminate',
        status: 'accepted',
        result: { stopped: true },
      },
    });
    expect(commandHandler).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'agent_task_terminate',
      targetType: 'agent_task',
      targetId: 'agent_task_rainrail_111',
      actor: 'operator',
      requestId: 'request-terminate',
    }));
    operationalStore.close();
  });

  it('rejects accepted commands when no command handler is configured', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'command_handler_not_configured' });
    expect(operationalStore.snapshot()).toMatchObject({ counts: { commandResults: 0, activityEvents: 0 } });
    operationalStore.close();
  });

  it('enforces a size limit before parsing command action bodies', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      dashboardCommandMaxBodyBytes: 4,
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: '{"too":"large"}',
    }));

    expect(response.status).toBe(413);
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
    await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    operationalStore.close();
  });

  it('returns request ids on invalid command action bodies', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'running',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler: vi.fn(),
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-invalid-json',
      },
      body: '{',
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('request-invalid-json');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_json_body' });
    operationalStore.close();
  });

  it('limits settings updates to admin tokens', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => ({
      updated: command.inputs,
      providerResponse: {
        secretToken: 'handler-result-secret',
        publicStatus: 'applied',
      },
    }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const operatorResponse = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ settings: { autoAssign: false } }),
    }));
    expect(operatorResponse.status).toBe(403);
    await expect(operatorResponse.json()).resolves.toEqual({
      error: 'insufficient_scope',
      requiredScope: 'admin',
    });

    const adminResponse = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          autoAssign: false,
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));
    expect(adminResponse.status).toBe(202);
    await expect(adminResponse.json()).resolves.toMatchObject({
      data: {
        action: 'settings_update',
        status: 'accepted',
        result: {
          updated: {
            settings: {
              autoAssign: false,
              apiToken: '[redacted]',
            },
            confirmationToken: '[redacted]',
          },
          providerResponse: {
            secretToken: '[redacted]',
            publicStatus: 'applied',
          },
        },
      },
    });
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('handler-result-secret');
    operationalStore.close();
  });

  it('redacts sensitive input values echoed under neutral command result keys', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => ({
      appliedValue: command.inputs.settings && typeof command.inputs.settings === 'object' && 'apiToken' in command.inputs.settings
        ? command.inputs.settings.apiToken
        : undefined,
      providerMessage: `stored ${String((command.inputs.settings as { apiToken?: unknown }).apiToken)}`,
    }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    operationalStore.close();
  });

  it('redacts original sensitive inputs when handlers mutate command inputs before returning', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async (command) => {
      const settings = command.inputs.settings as { apiToken?: unknown };
      const originalToken = settings.apiToken;
      delete settings.apiToken;

      return { message: `applied ${String(originalToken)}` };
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('admin-input-secret');
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    operationalStore.close();
  });

  it('does not dispatch commands when audit storage is unavailable', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    operationalStore.close();
    const commandHandler = vi.fn(async () => ({ applied: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_unavailable' });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it('returns handler success when post-dispatch audit storage fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const originalRecordCommandResult = operationalStore.recordCommandResult.bind(operationalStore);
    vi.spyOn(operationalStore, 'recordCommandResult').mockImplementation((input) => {
      if (input.status === 'accepted') {
        throw new Error('simulated post-dispatch audit failure');
      }

      return originalRecordCommandResult(input);
    });
    const commandHandler = vi.fn(async () => ({ applied: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
        'x-request-id': 'request-post-dispatch-audit-failure',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'accepted',
        auditId: 'cmd_000001',
        auditWarning: 'post_dispatch_audit_failed',
        result: { applied: true },
      },
    });
    expect(commandHandler).toHaveBeenCalledOnce();
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        status: 'dispatching',
      }],
    });
    operationalStore.close();
  });

  it('returns the accepted command audit id when only activity audit storage fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const originalRecordActivityEvent = operationalStore.recordActivityEvent.bind(operationalStore);
    vi.spyOn(operationalStore, 'recordActivityEvent').mockImplementation((input) => {
      if (input.category === 'command' && input.outcome === 'success') {
        throw new Error('simulated post-dispatch activity failure');
      }

      return originalRecordActivityEvent(input);
    });
    const commandHandler = vi.fn(async () => ({ applied: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
        'x-request-id': 'request-post-dispatch-activity-failure',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'accepted',
        auditId: 'cmd_000002',
        auditWarning: 'post_dispatch_audit_failed',
        result: { applied: true },
      },
    });
    expect(commandHandler).toHaveBeenCalledOnce();
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        id: 'cmd_000002',
        status: 'accepted',
      }, {
        id: 'cmd_000001',
        status: 'dispatching',
      }],
    });
    operationalStore.close();
  });

  it('returns handler failure when failed command audit storage fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const originalRecordCommandResult = operationalStore.recordCommandResult.bind(operationalStore);
    vi.spyOn(operationalStore, 'recordCommandResult').mockImplementation((input) => {
      if (input.status === 'failed') {
        throw new Error('simulated failed audit write failure');
      }

      return originalRecordCommandResult(input);
    });
    const commandHandler = vi.fn(async () => {
      throw new Error('provider rejected apiToken=admin-input-secret');
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
        'x-request-id': 'request-failed-audit-failure',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'failed',
        auditId: 'cmd_000001',
        auditWarning: 'post_dispatch_audit_failed',
        error: expect.stringContaining('[redacted]'),
      },
    });
    expect(commandHandler).toHaveBeenCalledOnce();
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('admin-input-secret');
    operationalStore.close();
  });

  it('redacts secret-like audit headers before storing command audit rows', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async () => ({ applied: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      commandHandler,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
        'x-request-id': 'request token=header-secret',
        'x-rainrail-client': 'dashboard Authorization: Basic client-secret',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get('x-request-id')).not.toContain('header-secret');
    const snapshotText = JSON.stringify(operationalStore.snapshot());
    expect(snapshotText).toContain('[redacted]');
    expect(snapshotText).not.toContain('header-secret');
    expect(snapshotText).not.toContain('client-secret');
    operationalStore.close();
  });

  it('records a deterministic client fallback when command callers omit client attribution', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const commandHandler = vi.fn(async () => ({ resumed: true }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      commandHandler,
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_missing_client',
      title: 'Command audit attribution',
      branchName: 'agent/missing-client',
      status: 'stopped',
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_missing_client/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'x-request-id': 'request-missing-client',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(202);
    expect(commandHandler).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'operator',
      client: 'unknown',
      requestId: 'request-missing-client',
    }));
    expect(operationalStore.snapshot()).toMatchObject({
      activityEvents: [{
        metadata: {
          actor: 'operator',
          client: 'unknown',
          requestId: 'request-missing-client',
        },
      }],
      commandResults: [
        { status: 'accepted', actor: 'operator', client: 'unknown', requestId: 'request-missing-client' },
        { status: 'dispatching', actor: 'operator', client: 'unknown', requestId: 'request-missing-client' },
      ],
    });
    operationalStore.close();
  });

  it('does not persist secrets exposed through command result toJSON hooks', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        return {
          publicStatus: 'applied',
          toJSON() {
            return {
              publicStatus: 'serialized',
              secretToken: 'tojson-secret',
            };
          },
        };
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).not.toContain('tojson-secret');
    expect(JSON.parse(bodyText)).toMatchObject({
      data: {
        status: 'accepted',
        result: { publicStatus: 'applied' },
      },
    });
    expect(JSON.stringify(operationalStore.snapshot().commandResults)).not.toContain('tojson-secret');
    operationalStore.close();
  });

  it('redacts sensitive text patterns from successful command result strings', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        return {
          message: 'provider accepted Authorization: Bearer provider-secret-token',
          log: 'created token=provider-log-secret',
        };
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('provider-secret-token');
    expect(bodyText).not.toContain('provider-log-secret');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('provider-secret-token');
    expect(commandResults).not.toContain('provider-log-secret');
    operationalStore.close();
  });

  it('records accepted commands when array result normalization throws', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        return new Proxy(['applied'], {
          get(target, property, receiver) {
            if (property === '0') {
              throw new Error('array getter failed after command dispatch');
            }

            return Reflect.get(target, property, receiver);
          },
        });
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'accepted',
        result: '[unserializable]',
      },
    });
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        status: 'accepted',
        result: '[unserializable]',
      }, {
        status: 'dispatching',
      }],
    });
    operationalStore.close();
  });

  it('records accepted commands when handler results need safe JSON normalization', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        operatorToken: 'operator-token',
      },
      async commandHandler() {
        const result: Record<string, unknown> = {
          publicStatus: 'resumed',
          count: BigInt(1),
          callback() {
            return 'not serializable';
          },
        };
        result.self = result;

        return result;
      },
    });
    operationalStore.recordAgentTask({
      id: 'agent_task_rainrail_111',
      title: 'command API',
      agentSessionId: 'agent:main:rainrail-111',
      branchName: 'agent/reirei-lab-rainrail-111',
      status: 'stopped',
      logPath: 'var/log/rainrail-111.log',
      resumeAttempts: [],
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_rainrail_111/actions/resume', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'accepted',
        result: {
          publicStatus: 'resumed',
          count: '[unserializable]',
          self: '[circular]',
        },
      },
    });
    expect(operationalStore.snapshot()).toMatchObject({
      commandResults: [{
        status: 'accepted',
        result: {
          publicStatus: 'resumed',
          count: '[unserializable]',
          self: '[circular]',
        },
      }, {
        status: 'dispatching',
      }],
      activityEvents: [{
        outcome: 'success',
      }],
    });
    operationalStore.close();
  });

  it('redacts sensitive settings values from failed command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('provider rejected apiToken=admin-input-secret password: handler-password');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          apiToken: 'admin-input-secret',
          password: 'handler-password',
        },
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const body = await response.json() as { data: { error: string } };
    expect(body.data.error).toContain('[redacted]');
    expect(body.data.error).not.toContain('admin-input-secret');
    expect(body.data.error).not.toContain('handler-password');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('admin-input-secret');
    expect(commandResults).not.toContain('handler-password');
    operationalStore.close();
  });

  it('redacts multi-word sensitive headers from failed command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('upstream rejected Authorization: Basic dXNlcjpwYXNz Authorization=Bearer ghp_handler_secret apiToken=Bearer ghp_api_secret Cookie: sessionid=secret_cookie');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('dXNlcjpwYXNz');
    expect(bodyText).not.toContain('ghp_handler_secret');
    expect(bodyText).not.toContain('ghp_api_secret');
    expect(bodyText).not.toContain('secret_cookie');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('dXNlcjpwYXNz');
    expect(commandResults).not.toContain('ghp_handler_secret');
    expect(commandResults).not.toContain('ghp_api_secret');
    expect(commandResults).not.toContain('secret_cookie');
    operationalStore.close();
  });

  it('redacts JSON-formatted sensitive command errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      publishToken: 'publish-token',
      operationalStore,
      dashboardAuth: {
        adminToken: 'admin-token',
      },
      async commandHandler() {
        throw new Error('provider rejected {"accessToken":"ghp_json_secret","password":"json-password"}');
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/v1/settings/actions/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmationToken: 'confirm:settings_update:settings:global',
      }),
    }));

    expect(response.status).toBe(502);
    const bodyText = await response.text();
    expect(bodyText).toContain('[redacted]');
    expect(bodyText).not.toContain('ghp_json_secret');
    expect(bodyText).not.toContain('json-password');
    const commandResults = JSON.stringify(operationalStore.snapshot().commandResults);
    expect(commandResults).not.toContain('ghp_json_secret');
    expect(commandResults).not.toContain('json-password');
    operationalStore.close();
  });
});

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

const queueCard: DashboardCardDefinition = {
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

function createTestApp(options: {
  eventsBearerToken?: string;
  dashboardAuth?: Parameters<typeof createRainrailHttpApp>[0]['dashboardAuth'];
  operationalStore?: OperationalStore;
  runtime?: string;
  intakeAdapters?: Parameters<typeof createRainrailHttpApp>[0]['intakeAdapters'];
  taskQueue?: Parameters<typeof createRainrailHttpApp>[0]['taskQueue'];
  dashboardCardRegistry?: Parameters<typeof createRainrailHttpApp>[0]['dashboardCardRegistry'];
  dashboardCardCatalog?: Parameters<typeof createRainrailHttpApp>[0]['dashboardCardCatalog'];
  dashboardDefaultLayout?: Parameters<typeof createRainrailHttpApp>[0]['dashboardDefaultLayout'];
} = {}) {
  return createRainrailHttpApp({
    room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
    publishToken: 'publish-token',
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    ...(options.dashboardAuth === undefined ? {} : { dashboardAuth: options.dashboardAuth }),
    ...(options.operationalStore === undefined ? {} : { operationalStore: options.operationalStore }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.taskQueue === undefined ? {} : { taskQueue: options.taskQueue }),
    ...(options.dashboardCardRegistry === undefined ? {} : { dashboardCardRegistry: options.dashboardCardRegistry }),
    ...(options.dashboardCardCatalog === undefined ? {} : { dashboardCardCatalog: options.dashboardCardCatalog }),
    ...(options.dashboardDefaultLayout === undefined ? {} : { dashboardDefaultLayout: options.dashboardDefaultLayout }),
    intakeAdapters: options.intakeAdapters ?? [
      createGitHubWebhookIntakeAdapter({ secret: 'secret' }),
    ],
  });
}

function fakeState(): RainrailBridgeRoomState {
  const values = new Map<string, unknown>([['rainrail:recent-events', []]]);
  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };
}
