import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_CARD_STORAGE_KEY,
  createDefaultOverviewCardLayout,
  moveOverviewCard,
  overviewCardRegistry,
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
});
