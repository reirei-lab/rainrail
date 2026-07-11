import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardPage = readFileSync(
  new URL('../apps/www/src/pages/dashboard.astro', import.meta.url),
  'utf8',
);
const localizedDashboardPage = readFileSync(
  new URL('../apps/www/src/pages/[locale]/dashboard.astro', import.meta.url),
  'utf8',
);
const localizedDashboardRoutePage = readFileSync(
  new URL('../apps/www/src/pages/[locale]/dashboard/[view].astro', import.meta.url),
  'utf8',
);
const dashboardLayout = readFileSync(
  new URL('../apps/www/src/layouts/DashboardLayout.astro', import.meta.url),
  'utf8',
);
const dashboardContent = readFileSync(
  new URL('../apps/www/src/lib/dashboard-content.ts', import.meta.url),
  'utf8',
);
const dashboardApp = readFileSync(
  new URL('../apps/www/src/lib/dashboard-app.ts', import.meta.url),
  'utf8',
);
const dashboardClient = readFileSync(
  new URL('../apps/www/src/lib/dashboard-client.ts', import.meta.url),
  'utf8',
);
const dashboardControllers = readFileSync(
  new URL('../apps/www/src/lib/dashboard-controllers.ts', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../apps/www/src/styles/global.css', import.meta.url),
  'utf8',
);

describe('dashboard operational views', () => {
  it('serves the dashboard through localized /ja/ and /en/ routes', () => {
    expect(dashboardPage).toContain("getDefaultLocaleRedirect('dashboard')");
    expect(localizedDashboardPage).toContain('supportedLocales.map');
    expect(localizedDashboardPage).toContain('getDashboardContent(locale)');
    expect(localizedDashboardPage).toContain('JSON.stringify(content.app)');
    expect(localizedDashboardPage).toContain('locale={locale}');
    expect(dashboardContent).toContain('ja:');
    expect(dashboardContent).toContain('en:');
    expect(dashboardContent).toContain('Rainrail Operations');
    expect(dashboardContent).toContain('Rainrail 運用');
  });

  it('localizes dashboard shell labels and browser-rendered UI messages', () => {
    for (const label of ['Overview', 'Event Inbox', 'Runs', 'Agent Tasks']) {
      expect(dashboardContent).toContain(label);
    }
    for (const label of ['概要', 'イベント受信箱', '実行履歴', 'エージェントタスク']) {
      expect(dashboardContent).toContain(label);
    }

    expect(localizedDashboardPage).not.toContain('Bearer token required');
    expect(localizedDashboardPage).not.toContain('Operational API unavailable');
    expect(dashboardApp).toContain('dashboardCopy');
    expect(dashboardApp).toContain('copy.status.authMissing');
    expect(dashboardApp).toContain('copy.detailLabels.humanSummary');
    expect(dashboardApp).toContain('copy.command.confirm');
  });

  it('keeps Japanese dashboard operation labels translated instead of mixed with English UI', () => {
    const japaneseBlock = dashboardContent.slice(dashboardContent.indexOf('  ja: {'));

    for (const label of [
      '操作権限',
      'イベント受信箱フィルター',
      '一致ワークフロー',
      'エージェントタスク',
      '実行中ワークフロー',
      '人間向け要約',
      '正規化済み envelope',
      '操作履歴',
      'コマンド失敗',
    ]) {
      expect(dashboardContent).toContain(label);
    }

    for (const staleCopy of [
      "operatorControls: 'Operator controls'",
      "filtersLabel: 'Event inbox filters'",
      "workflowMatches: 'Workflow matches'",
      "agentTasks: 'Agent tasks'",
      "humanSummary: 'Human summary'",
      "sanitizedEnvelope: 'Sanitized envelope'",
      "failed: 'Command failed'",
    ]) {
      expect(japaneseBlock).not.toContain(staleCopy);
    }
  });

  it('localizes dashboard dynamic helper copy and placeholders', () => {
    for (const marker of [
      'sourceBundles',
      'queueSignals',
      'settingsSignals',
      '次の issue',
      '最大並列数',
      '詳細を読み込み中',
      '詳細を利用できません',
      '詳細取得に失敗しました',
      'この入力元イベントの handler retry 行を確認してください。',
      '未予定',
      'リトライ待ち',
      '開始',
      '最新 trajectory 参照',
      '該当なし',
      '不明',
      'なし',
    ]) {
      expect(dashboardContent).toContain(marker);
    }

    expect(dashboardApp).toContain('copy.empty.sourceBundles.join');
    expect(dashboardApp).toContain('copy.detailStates.loading');
    expect(dashboardApp).toContain('copy.detailHints.checkHandlerRetryRows');
    expect(dashboardApp).toContain('copy.placeholders.notAvailable');
    expect(dashboardApp).not.toContain("'Check handler retry rows for this source event.'");
    expect(dashboardApp).not.toContain("renderBasicDetail(row, 'Loading detail')");
    expect(dashboardApp).not.toContain("?? 'unknown'");
    expect(dashboardApp).not.toContain("?? 'none'");
    expect(dashboardApp).not.toContain("?? 'handler'");
    expect(dashboardApp).not.toContain("?? 'unscheduled'");
    expect(dashboardApp).not.toContain("?? 'retry pending'");
    expect(dashboardApp).not.toContain('`started: ${');
    expect(dashboardApp).not.toContain('`latest trajectory source: ${');
  });

  it('formats operator command status and confirmation from localized templates', () => {
    for (const marker of [
      'formatCommandTemplate',
      'copy.command.actions[action]',
      'copy.command.targets.allRunningTasks',
      'sendingTemplate',
      'confirmTemplate',
      '一括対象の実行中タスク',
    ]) {
      expect(dashboardApp + dashboardContent).toContain(marker);
    }

    expect(dashboardApp).not.toContain(' for ${targetId}');
    expect(dashboardApp).not.toContain("'all running tasks'");
  });

  it('names the Overview, Event Inbox, Runs, and Agent Tasks work surfaces', () => {
    for (const label of ['Overview', 'Event Inbox', 'Runs', 'Agent Tasks', '実行履歴']) {
      expect(dashboardContent).toContain(label);
    }

    expect(dashboardLayout).toContain('data-dashboard-tab={route.id}');
  });

  it('links workflow run details back to the source event context', () => {
    expect(dashboardApp).toContain('workflowRunSourceEventHref');
    expect(dashboardApp).toContain('data-source-event-link');
    expect(dashboardApp).toContain("target.pathname = target.pathname.replace(/\\/dashboard(?:\\/[^/?#]+)?\\/?$/, '/dashboard/events')");
    expect(dashboardApp).toContain("target.searchParams.set('event', sourceEventId)");
    expect(dashboardApp).toContain("target.searchParams.delete('source')");
    expect(dashboardApp).toContain("target.searchParams.delete('name')");
  });

  it('marks existing standard surfaces as core dashboard cards', () => {
    for (const marker of [
      'data-dashboard-core-card="core.operationalTotals"',
    ]) {
      expect(localizedDashboardPage).toContain(marker);
    }
    expect(localizedDashboardRoutePage).toContain('data-dashboard-core-card="core.operatorActions"');

    for (const marker of [
      'data-dashboard-core-card="core.eventInbox"',
      'data-dashboard-core-card="core.workflowRuns"',
      'data-dashboard-core-card="core.agentTasks"',
      'data-dashboard-core-card="core.sources"',
      'data-dashboard-core-card="core.queue"',
      'data-dashboard-core-card="core.settings"',
    ]) {
      const cardId = marker.match(/"([^"]+)"/)?.[1];
      expect(cardId).toBeDefined();
      expect(dashboardLayout).toContain(cardId);
    }
  });

  it('renders event inbox filters and delivery/result columns', () => {
    for (const marker of [
      'data-event-source-filter',
      'data-event-name-filter',
      'data-filter-apply',
      'Delivery',
      'Publish result',
      'Workflow matches',
    ]) {
      expect(marker.startsWith('data-') ? localizedDashboardPage : dashboardContent).toContain(marker);
    }

    expect(dashboardClient).toContain('filter[name]');
    expect(dashboardClient).toContain('filter[source]');
    expect(dashboardApp).toContain('deliveryId');
    expect(dashboardApp).toContain('latestOutcome');
  });

  it('localizes dashboard assistive labels and source filter option labels', () => {
    expect(localizedDashboardPage).toContain('aria-label={content.shell.statsLabel}');
    expect(localizedDashboardPage).toContain('content.shell.sourceOptions.manual');
    expect(localizedDashboardPage).toContain('content.shell.sourceOptions.system');
    expect(dashboardContent).toContain('運用集計');
    expect(dashboardContent).toContain('手動');
    expect(dashboardContent).toContain('システム');
    expect(localizedDashboardPage).not.toContain('Operational totals');
    expect(localizedDashboardPage).not.toContain('>Manual<');
    expect(localizedDashboardPage).not.toContain('>System<');
    expect(localizedDashboardPage).not.toContain('<dd>n/a</dd>');
  });

  it('loads detail records for human summaries, sanitized envelopes, matched workflows, and audit', () => {
    expect(dashboardApp).toContain('eventDetail(row.id)');
    expect(dashboardApp).toContain('workflowRunDetail(row.id)');
    expect(dashboardApp).toContain('agentTaskDetail(row.id)');
    expect(dashboardApp).toContain('detailRequestSequence');
    expect(dashboardApp).toContain('selectedDetailRowId');
    expect(dashboardApp).toContain('isCurrentDetailRequest(activeClient, detailRequestId, row.id)');

    for (const label of [
      'Human summary',
      'Sanitized envelope',
      'Raw payload reference',
      'Matched workflows',
      'Action audit',
      'Retry schedule',
    ]) {
      expect(dashboardContent).toContain(label);
    }

    expect(dashboardApp).not.toContain('JSON.stringify(record.envelope.payload');
  });

  it('renders agent task tabs, runtime metadata, logs, Codex activity, and raw detail', () => {
    for (const label of [
      'Summary',
      'Timeline',
      'Codex activity',
      'stdout log',
      'stderr log',
      'JSONL/raw detail',
      'Runtime pid',
      'Resume count',
      'Project claim',
    ]) {
      expect(dashboardContent).toContain(label);
    }

    expect(dashboardApp).toContain('renderAgentTaskDetail');
    expect(dashboardApp).toContain('resumeAttempts');
    expect(dashboardApp).toContain('latestResumeAttempt');
    expect(dashboardApp).toContain('formatAgentTimeline');
    expect(dashboardApp).toContain('formatAgentLogReference');
    expect(dashboardApp).toContain('JSON.stringify(record, null, 2)');
  });

  it('wires agent task command buttons through the dashboard client and operator confirmation UI', () => {
    for (const marker of [
      'data-agent-action="resume"',
      'data-agent-action="reset"',
      'data-agent-action="terminate"',
      'data-agent-action="terminate-all"',
      'data-command-status',
    ]) {
      expect(localizedDashboardRoutePage).toContain(marker);
      expect(localizedDashboardPage).not.toContain(marker);
    }
    expect(localizedDashboardRoutePage).toContain("route.id === 'agent-tasks'");
    expect(localizedDashboardRoutePage).toContain('content.shell.tasksActionsLabel');

    for (const method of [
      'resumeAgentTask',
      'resetAgentTask',
      'terminateAgentTask',
      'terminateAllAgentTasks',
    ]) {
      expect(dashboardClient).toContain(method);
      expect(dashboardApp).toContain(method);
    }
    expect(dashboardClient).toContain('postCommand');

    expect(dashboardApp).toContain('action_confirmation_required');
    expect(dashboardApp).toContain('confirmationToken');
    expect(dashboardApp).toContain('window.confirm');
    expect(dashboardApp).toContain('setCommandStatus');
  });

  it('wires card settings editing through the dashboard layout API', () => {
    for (const marker of [
      'data-card-settings-select',
      'data-card-settings-form',
      'data-card-settings-save',
      'data-card-settings-status',
    ]) {
      expect(localizedDashboardPage).toContain(marker);
    }

    for (const method of [
      'dashboardCards()',
      'dashboardLayout()',
      'saveDashboardLayout',
      'saveDashboardLayoutItemConfig',
    ]) {
      expect(dashboardClient).toContain(method);
    }
    expect(dashboardControllers).toContain('dashboardCards()');
    expect(dashboardControllers).toContain('dashboardLayout()');
    expect(dashboardApp).toContain('saveDashboardLayout');
    expect(dashboardApp).toContain('saveDashboardLayoutItemConfig');

    expect(dashboardClient).toContain('DashboardLayoutUpdateResponse');
    expect(dashboardClient).toContain('/api/v1/dashboard/layout/items/${encodeURIComponent(itemId)}/config');
    expect(dashboardApp).toContain('renderCardSettingsForm');
    expect(dashboardApp).toContain('settingsSchema');
    expect(dashboardApp).toContain('selectedLayoutItem.config');
    expect(dashboardApp).toContain('mergeCardSettingsConfig');
    expect(dashboardApp).toContain('updateLatestCardSettingsConfig');
    expect(dashboardApp).toContain('cardSettingInputType');
    expect(dashboardApp).toContain('cardSettingValueType');
    expect(dashboardApp).toContain('cardSettingChanged');
    expect(dashboardApp).toContain("input.dataset.cardSettingChanged !== 'true'");
    expect(dashboardApp).toContain('invalidCardSettingsConfig');
    expect(dashboardApp).toContain('Number.isInteger');
    expect(dashboardApp).toContain("input.step = '1'");
    expect(dashboardApp).toContain('setCardSettingsStatus(copy.cardSettings.invalid)');
    expect(dashboardApp).toContain('delete config[name]');
    expect(dashboardApp).toContain("currentValue !== null");
    expect(dashboardApp).toContain('cardSettingsDirty');
    expect(dashboardApp).toContain('cardSettingsSaving');
    expect(dashboardApp).toContain('if (cardSettingsDirty && options.quiet) return;');
    expect(dashboardApp).toContain('if (dashboardLayoutSaving) return;');
    expect(dashboardApp).toContain("if (latestData?.layout.source === 'user' && !dashboardCoreCardIsVisible(cardId))");
    expect(dashboardApp).toContain('event.preventDefault();');
    expect(dashboardApp).toContain('const activeClient = client;');
    expect(dashboardApp).toContain('await activeClient.saveDashboardLayoutItemConfig(selectedLayoutItem.id, config);');
    expect(dashboardApp).toContain('action.disabled = dashboardLayoutSaving || cardSettingsSaving || !enabled');
    expect(dashboardApp).toContain('void refresh({ quiet: true });');
    expect(dashboardApp).not.toContain('await refresh({ quiet: true });');
    expect(dashboardContent).toContain('Card settings');
    expect(dashboardContent).toContain('カード設定');
  });

  it('renders a card picker and editable dashboard layout grid', () => {
    for (const marker of [
      'data-card-picker-search',
      'data-card-picker-category',
      'data-card-picker-provider',
      'data-card-picker-list',
      'data-dashboard-layout-grid',
      'data-dashboard-layout-status',
    ]) {
      expect(localizedDashboardPage).toContain(marker);
    }

    for (const marker of [
      'renderDashboardLayout()',
      'applyDashboardLayoutVisibility()',
      'dashboardCoreCardElements',
      'dashboardCoreCardIsVisible',
      'dashboardCoreCardLayoutIds',
      'ensureVisibleDashboardTab',
      'renderCardPicker()',
      'saveDashboardLayoutItems',
      'discardInFlightDashboardRefreshes',
      'filteredItemCount',
      'draggable = true',
      'dragend',
      'application/x-rainrail-dashboard-layout-item',
      'hasDashboardLayoutDragPayload',
      'data-layout-item-id',
      'data-dashboard-card-id',
      'data-dashboard-card-menu',
      'data-dashboard-card-resize',
      'data-action-permission',
      'removeDashboardLayoutItem',
      'moveDashboardLayoutItem',
      'movedDashboardLayoutItems',
      'isFirstLayoutItem',
      'resizeDashboardLayoutItem',
      'nextDashboardLayoutResizeCandidate',
      'effectiveMaxColumns',
      'createDashboardLayoutItem',
      'dashboardCardGridInitialSize',
      'dashboardCardCanBeAdded',
      'unknownDashboardCard',
      'cardAvailabilityLabel',
      'copy.cardLayout.open',
      'dashboardLayoutSaving',
      'isOperatorModeEnabled()',
      'currentLayoutCardIds',
      'hasUnavailableDashboardCards',
      'layoutFilteredItemCountIsUnknown',
      'layoutSaveWouldDropHiddenCards',
      'dashboardLayoutItemInGridBounds',
      'dashboardLayoutItemsOverlap',
      'dashboardLayoutItemBounds',
    ]) {
      expect(dashboardApp).toContain(marker);
    }

    expect(dashboardApp.indexOf('syncCardPickerFilters(latestData.cards);')).toBeLessThan(
      dashboardApp.indexOf("const categoryFilter = cardPickerCategory?.value ?? '';"),
    );

    expect(dashboardClient).toContain('entry: { type:');
    expect(dashboardClient).toContain('size: {');
    expect(dashboardApp).toContain('category / provider / plugin');
    expect(dashboardApp).toContain('activeClient.saveDashboardLayout(items)');
    expect(dashboardApp).toContain("article.style.setProperty('--dashboard-card-row-start', String(Math.max(1, item.y + 1)));");
    expect(dashboardApp).toContain("article.style.setProperty('--dashboard-card-rows', String(Math.max(1, item.rows)));");
    expect(dashboardApp).not.toContain('clampDashboardCardSize(item.y + 1, 1, 99)');
    expect(dashboardApp).not.toContain('clampDashboardCardSize(item.rows, 1, 12)');
    expect(dashboardApp).toContain("element.hidden = latestData !== undefined && latestData.layout.source === 'user' && cardId !== undefined && !dashboardCoreCardIsVisible(cardId);");
    expect(dashboardApp).toContain('!dashboardCoreCardIsVisible(cardId)');
    expect(dashboardApp).toContain("new Set(['core.eventInbox', 'core.recentEvents'])");
    expect(dashboardApp).toContain('if (dashboardLayoutSaving) return;');
    expect(dashboardApp).toContain('if (cardSettingsSaving) return;');
    expect(dashboardApp).toContain('discardInFlightDashboardRefreshes(activeClient);');
    expect(dashboardApp).toContain('if (client !== activeClient) return;');
    expect(dashboardApp).toContain('renderCardSettingsPicker({ quiet: true });\n      renderCurrentList();');
    expect(dashboardApp).toContain('renderCardSettingsPicker({ quiet: true });');
    expect(dashboardApp).not.toContain('setDashboardLayoutStatus(copy.cardLayout.saved);');
    expect(dashboardApp).not.toContain('return dashboardTabForCard(cardId) === undefined ? copy.cardLayout.settings : copy.cardLayout.move;');
    expect(dashboardContent).toContain('Card picker');
    expect(dashboardContent).toContain('カードピッカー');
    expect(dashboardContent).toContain("open: 'Open'");
    expect(dashboardContent).toContain("open: '表示'");
    expect(dashboardContent).toContain('Hidden cards may be omitted');
    expect(dashboardContent).toContain('非表示のカードが保存から除外される可能性があります。');
    expect(dashboardContent).not.toContain("hiddenCardsWarning: 'Hidden cards may be omitted by this save。");
    expect(dashboardContent).toContain('Move would place a card outside the grid');
    expect(globalStyles).toContain('.dashboard-layout-grid');
    expect(globalStyles).toContain('grid-template-columns: repeat(12, minmax(0, 1fr))');
    expect(globalStyles).toContain('grid-auto-rows: 88px');
    expect(globalStyles).toContain('grid-column: var(--dashboard-card-column-start) / span var(--dashboard-card-columns)');
    expect(globalStyles).toContain('grid-row: var(--dashboard-card-row-start) / span var(--dashboard-card-rows)');
    expect(globalStyles).toContain('min-height: calc(var(--dashboard-card-rows) * 88px)');
    expect(globalStyles).toContain('.dashboard-card-picker-list');
    expect(globalStyles).toContain('@media (max-width: 900px)');
    expect(globalStyles).toContain('--dashboard-card-columns: 1');
  });

  it('does not mark the whole dashboard empty just because Event Inbox filters hide rows', () => {
    expect(dashboardApp).toContain('hasDashboardRecords(latestData)');
    expect(dashboardApp).not.toContain("setState(hasRows(latestData) ? 'ready' : 'empty'");
    expect(dashboardApp).not.toContain('|| data.settings.length > 0');
  });

  it('uses event summaries before source names for row titles', () => {
    expect(dashboardApp.indexOf("if ('summary' in row && typeof row.summary === 'string') return row.summary;"))
      .toBeLessThan(dashboardApp.indexOf("if (row.type !== 'event' && 'name' in row && typeof row.name === 'string') return row.name;"));
  });

  it('keeps the dashboard dense and responsive', () => {
    expect(globalStyles).toContain('.dashboard-overview-grid');
    expect(globalStyles).toContain('.dashboard-filterbar');
    expect(globalStyles).toContain('.dashboard-audit-list');
    expect(globalStyles).toContain('@media (max-width: 900px)');
  });
});
