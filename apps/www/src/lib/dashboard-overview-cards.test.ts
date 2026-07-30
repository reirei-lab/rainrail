import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_CARD_STORAGE_KEY,
  createDefaultOverviewCardLayout,
  moveOverviewCard,
  overviewApiStatusSummary,
  overviewCountLabel,
  overviewCardRegistry,
  overviewHealthStatusLabel,
  overviewWarningSummary,
  parseOverviewCardLayout,
  serializeOverviewCardLayout,
  setOverviewCardVisibility,
} from './dashboard-overview-cards';

describe('dashboard overview cards', () => {
  it('defines a stable built-in registry for overview-api cards', () => {
    expect(OVERVIEW_CARD_STORAGE_KEY).toBe('rainrail-dashboard-overview-card-layout');
    expect(overviewCardRegistry.map((card) => card.id)).toEqual([
      'apiStatus',
      'health',
      'counts',
      'recentActivity',
      'warnings',
    ]);
  });

  it('creates a visible default layout in registry order', () => {
    expect(createDefaultOverviewCardLayout(overviewCardRegistry)).toEqual([
      { id: 'apiStatus', visible: true },
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
      { id: 'apiStatus', visible: true },
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
      { id: 'apiStatus', visible: true },
      { id: 'health', visible: true },
      { id: 'counts', visible: false },
      { id: 'recentActivity', visible: true },
      { id: 'warnings', visible: true },
    ]);
  });

  it('moves cards up or down one slot and keeps edge cards stable', () => {
    const layout = createDefaultOverviewCardLayout(overviewCardRegistry);

    expect(moveOverviewCard(layout, 'recentActivity', 'up').map((item) => item.id)).toEqual([
      'apiStatus',
      'health',
      'recentActivity',
      'counts',
      'warnings',
    ]);
    expect(moveOverviewCard(layout, 'recentActivity', 'down').map((item) => item.id)).toEqual([
      'apiStatus',
      'health',
      'counts',
      'warnings',
      'recentActivity',
    ]);
    expect(moveOverviewCard(layout, 'apiStatus', 'up')).toEqual(layout);
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
      commandResults: 'コマンド結果',
      providerStatus: 'プロバイダー状態',
      agentTasks: 'エージェントタスク',
      sources: '入力元',
      queue: 'キュー',
    };

    expect(overviewCountLabel('events', labels)).toBe('イベント');
    expect(overviewCountLabel('activityEvents', labels)).toBe('実行中ワークフロー');
    expect(overviewCountLabel('eventHandlerRetries', labels)).toBe('リトライ中ハンドラー');
    expect(overviewCountLabel('commandResults', labels)).toBe('コマンド結果');
    expect(overviewCountLabel('providers', labels)).toBe('プロバイダー状態');
    expect(overviewCountLabel('agentTasks', labels)).toBe('エージェントタスク');
    expect(overviewCountLabel('sources', labels)).toBe('入力元');
    expect(overviewCountLabel('queue', labels)).toBe('キュー');
    expect(overviewCountLabel('customMetric', labels)).toBe('customMetric');
  });

  it('summarizes stale project claim warnings without raw keys or JSON', () => {
    expect(overviewWarningSummary([{ taskId: 'task-1' }, { taskId: 'task-2' }], {
      staleProjectClaim: '古い Project 取得状態',
      warningCount: '警告',
    })).toEqual({
      label: '古い Project 取得状態',
      value: '2',
      detail: '警告 2',
    });

    const summary = overviewWarningSummary([], {
      staleProjectClaim: 'stale project claim',
      warningCount: 'warnings',
    });
    expect(summary.detail).not.toContain('staleProjectClaims');
    expect(summary.detail).not.toContain('{');
  });

  it('summarizes the independent API status contract for the overview tile', () => {
    const labels = {
      connected: 'Connected',
      degraded: 'Degraded',
      error: 'Error',
      authMissing: 'Bearer token required',
      authRejected: 'Token rejected by operational API',
      unavailable: 'Operational API unavailable',
      notAvailable: 'n/a',
      unknownAuthScope: 'unknown',
      overview: 'Overview',
      duration: 'Duration',
      lastSuccess: 'Last success',
      authScope: 'Auth scope',
      store: 'Store',
      overviewStatuses: {
        ok: 'OK',
        unknown: 'Unknown',
        loading: 'Loading',
        slow: 'Slow',
        error: 'Error',
      },
      storeStatuses: {
        configured: 'Configured',
        missing: 'Missing',
        unavailable: 'Unavailable',
      },
      errorSummaries: {
        operational_store_unavailable: 'Operational store unavailable',
      },
      justNow: 'just now',
      minutesAgo: '{value}m ago',
      hoursAgo: '{value}h ago',
      daysAgo: '{value}d ago',
    };

    expect(overviewApiStatusSummary({
      data: {
        status: 'degraded',
        runtime: 'node',
        store: { status: 'configured' },
        overview: {
          status: 'error',
          lastAttemptAt: '2026-07-09T05:00:10.000Z',
          lastSuccessAt: '2026-07-09T05:00:00.000Z',
          lastDurationMs: 42.4,
          lastHttpStatus: 500,
          lastError: { code: 'operational_store_unavailable', summary: 'Operational store unavailable' },
          links: { self: '/api/v1/overview' },
        },
        auth: { scope: 'read-only' },
        links: { overview: '/api/v1/overview' },
      },
    }, labels, { nowMs: Date.parse('2026-07-09T05:05:00.000Z') })).toEqual({
      status: 'Degraded',
      tone: 'degraded',
      metrics: {
        overview: 'Error',
        duration: '42 ms',
        lastSuccess: '5m ago',
        authScope: 'read-only',
        store: 'Configured',
      },
      note: 'operational_store_unavailable: Operational store unavailable',
    });
  });

  it('keeps auth missing and unavailable status readable before status loads', () => {
    const labels = {
      connected: 'Connected',
      degraded: 'Degraded',
      error: 'Error',
      authMissing: 'Bearer token required',
      authRejected: 'Token rejected by operational API',
      unavailable: 'Operational API unavailable',
      notAvailable: 'n/a',
      unknownAuthScope: 'unknown',
      overview: 'Overview',
      duration: 'Duration',
      lastSuccess: 'Last success',
      authScope: 'Auth scope',
      store: 'Store',
      overviewStatuses: {
        ok: 'OK',
        unknown: 'Unknown',
        loading: 'Loading',
        slow: 'Slow',
        error: 'Error',
      },
      storeStatuses: {
        configured: 'Configured',
        missing: 'Missing',
        unavailable: 'Unavailable',
      },
      justNow: 'just now',
      minutesAgo: '{value}m ago',
      hoursAgo: '{value}h ago',
      daysAgo: '{value}d ago',
    };

    expect(overviewApiStatusSummary(undefined, labels, { dashboardState: 'auth-missing' }).status).toBe('Bearer token required');
    expect(overviewApiStatusSummary(undefined, labels, {
      dashboardState: 'error',
      currentStatusMessage: 'Token rejected by operational API',
    }).tone).toBe('auth-rejected');
    expect(overviewApiStatusSummary(undefined, labels, {
      dashboardState: 'ready',
      statusPending: true,
    })).toMatchObject({
      status: 'Loading',
      tone: 'loading',
      metrics: {
        overview: 'Loading',
        duration: 'n/a',
        lastSuccess: 'n/a',
        authScope: 'n/a',
        store: 'n/a',
      },
      note: 'Loading',
    });
  });

  it('localizes relative last success labels and avoids guessing missing auth scope', () => {
    const labels = {
      connected: '接続中',
      degraded: '縮退',
      error: 'エラー',
      authMissing: 'Bearer トークンが必要です',
      authRejected: '運用 API がトークンを拒否しました',
      unavailable: '運用 API を利用できません',
      notAvailable: '該当なし',
      unknownAuthScope: '不明',
      overview: '概要',
      duration: '所要時間',
      lastSuccess: '最終成功',
      authScope: '認証スコープ',
      store: 'ストア',
      overviewStatuses: {
        ok: '正常',
        unknown: '不明',
        loading: '読み込み中',
        slow: '低速',
        error: 'エラー',
      },
      storeStatuses: {
        configured: '設定済み',
        missing: '未設定',
        unavailable: '利用不可',
      },
      errorSummaries: {
        operational_store_not_configured: '運用ストアが設定されていません。',
      },
      justNow: 'たった今',
      minutesAgo: '{value}分前',
      hoursAgo: '{value}時間前',
      daysAgo: '{value}日前',
    };

    expect(overviewApiStatusSummary({
      data: {
        status: 'ok',
        runtime: 'node',
        store: { status: 'configured' },
        overview: {
          status: 'ok',
          lastAttemptAt: '2026-07-09T05:00:00.000Z',
          lastSuccessAt: '2026-07-09T04:58:00.000Z',
          lastDurationMs: null,
          lastHttpStatus: 200,
          lastError: null,
          links: { self: '/api/v1/overview' },
        },
        links: { overview: '/api/v1/overview' },
      },
    }, labels, { nowMs: Date.parse('2026-07-09T05:05:00.000Z') })).toMatchObject({
      metrics: {
        duration: '該当なし',
        lastSuccess: '7分前',
        authScope: '不明',
        overview: '正常',
        store: '設定済み',
      },
      note: '概要: 正常',
    });

    expect(overviewApiStatusSummary({
      data: {
        status: 'degraded',
        runtime: 'node',
        store: { status: 'missing' },
        overview: {
          status: 'error',
          lastAttemptAt: '2026-07-09T05:00:00.000Z',
          lastSuccessAt: null,
          lastDurationMs: null,
          lastHttpStatus: 503,
          lastError: { code: 'operational_store_not_configured', summary: 'Operational store is not configured.' },
          links: { self: '/api/v1/overview' },
        },
        links: { overview: '/api/v1/overview' },
      },
    }, labels, { nowMs: Date.parse('2026-07-09T05:05:00.000Z') })).toMatchObject({
      note: 'operational_store_not_configured: 運用ストアが設定されていません。',
    });
  });
});
