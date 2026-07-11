import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_CARD_STORAGE_KEY,
  createDefaultOverviewCardLayout,
  moveOverviewCard,
  overviewCountLabel,
  overviewCardRegistry,
  overviewHealthStatusLabel,
  parseOverviewCardLayout,
  serializeOverviewCardLayout,
  setOverviewCardVisibility,
} from './dashboard-overview-cards';

describe('dashboard overview cards', () => {
  it('defines a stable built-in registry for overview-api cards', () => {
    expect(OVERVIEW_CARD_STORAGE_KEY).toBe('rainrail-dashboard-overview-card-layout');
    expect(overviewCardRegistry.map((card) => card.id)).toEqual([
      'health',
      'counts',
      'recentActivity',
      'warnings',
    ]);
  });

  it('creates a visible default layout in registry order', () => {
    expect(createDefaultOverviewCardLayout(overviewCardRegistry)).toEqual([
      { id: 'health', visible: true },
      { id: 'counts', visible: true },
      { id: 'recentActivity', visible: true },
      { id: 'warnings', visible: true },
    ]);
  });

  it('restores saved visibility and order while dropping unknown and duplicate cards', () => {
    const saved = JSON.stringify([
      { id: 'warnings', visible: false },
      { id: 'unknown', visible: true },
      { id: 'counts', visible: true },
      { id: 'warnings', visible: true },
    ]);

    expect(parseOverviewCardLayout(saved, overviewCardRegistry)).toEqual([
      { id: 'warnings', visible: false },
      { id: 'counts', visible: true },
      { id: 'health', visible: true },
      { id: 'recentActivity', visible: true },
    ]);
  });

  it('falls back to the default layout for invalid storage payloads', () => {
    expect(parseOverviewCardLayout('{bad json', overviewCardRegistry)).toEqual(createDefaultOverviewCardLayout(overviewCardRegistry));
    expect(parseOverviewCardLayout('{"id":"counts"}', overviewCardRegistry)).toEqual(createDefaultOverviewCardLayout(overviewCardRegistry));
  });

  it('toggles card visibility without changing order', () => {
    const layout = createDefaultOverviewCardLayout(overviewCardRegistry);

    expect(setOverviewCardVisibility(layout, 'counts', false)).toEqual([
      { id: 'health', visible: true },
      { id: 'counts', visible: false },
      { id: 'recentActivity', visible: true },
      { id: 'warnings', visible: true },
    ]);
  });

  it('moves cards up or down one slot and keeps edge cards stable', () => {
    const layout = createDefaultOverviewCardLayout(overviewCardRegistry);

    expect(moveOverviewCard(layout, 'recentActivity', 'up').map((item) => item.id)).toEqual([
      'health',
      'recentActivity',
      'counts',
      'warnings',
    ]);
    expect(moveOverviewCard(layout, 'recentActivity', 'down').map((item) => item.id)).toEqual([
      'health',
      'counts',
      'warnings',
      'recentActivity',
    ]);
    expect(moveOverviewCard(layout, 'health', 'up')).toEqual(layout);
    expect(moveOverviewCard(layout, 'warnings', 'down')).toEqual(layout);
  });

  it('serializes only the durable layout fields', () => {
    const saved = serializeOverviewCardLayout([
      { id: 'counts', visible: false },
      { id: 'health', visible: true },
    ]);

    expect(JSON.parse(saved)).toEqual([
      { id: 'counts', visible: false },
      { id: 'health', visible: true },
    ]);
  });

  it('labels overview health without hiding unavailable or auth states', () => {
    const labels = {
      ready: 'Live operational state',
      empty: 'No operational records yet',
      error: 'Operational API unavailable',
      authMissing: 'Bearer token required',
      loading: 'Loading operational state',
      connected: 'Connected',
    };

    expect(overviewHealthStatusLabel('ready', labels)).toBe('Live operational state');
    expect(overviewHealthStatusLabel('empty', labels)).toBe('No operational records yet');
    expect(overviewHealthStatusLabel('error', labels)).toBe('Operational API unavailable');
    expect(overviewHealthStatusLabel('error', labels, 'Token rejected by operational API')).toBe('Token rejected by operational API');
    expect(overviewHealthStatusLabel('auth-missing', labels)).toBe('Bearer token required');
    expect(overviewHealthStatusLabel('loading', labels)).toBe('Loading operational state');
    expect(overviewHealthStatusLabel('custom', labels)).toBe('Connected');
  });

  it('maps overview count API keys to localized dashboard stat labels', () => {
    const labels = {
      events: 'イベント',
      activeRuns: '実行中ワークフロー',
      retryingHandlers: 'リトライ中ハンドラー',
      providerStatus: 'プロバイダー状態',
      agentTasks: 'エージェントタスク',
      sources: '入力元',
      queue: 'キュー',
    };

    expect(overviewCountLabel('events', labels)).toBe('イベント');
    expect(overviewCountLabel('activityEvents', labels)).toBe('実行中ワークフロー');
    expect(overviewCountLabel('eventHandlerRetries', labels)).toBe('リトライ中ハンドラー');
    expect(overviewCountLabel('providers', labels)).toBe('プロバイダー状態');
    expect(overviewCountLabel('agentTasks', labels)).toBe('エージェントタスク');
    expect(overviewCountLabel('sources', labels)).toBe('入力元');
    expect(overviewCountLabel('queue', labels)).toBe('キュー');
    expect(overviewCountLabel('customMetric', labels)).toBe('customMetric');
  });
});
