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
    for (const label of ['Overview', 'Event Inbox', 'Workflow Runs', 'Agent Tasks']) {
      expect(dashboardContent).toContain(label);
    }
    for (const label of ['概要', 'イベント受信箱', 'ワークフロー実行', 'エージェントタスク']) {
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

  it('names the Overview, Event Inbox, Workflow Runs, and Agent Tasks work surfaces', () => {
    for (const label of ['Overview', 'Event Inbox', 'Workflow Runs', 'Agent Tasks']) {
      expect(dashboardContent).toContain(label);
    }

    expect(localizedDashboardPage).toContain('data-dashboard-tab="agent-tasks"');
  });

  it('marks existing standard surfaces as core dashboard cards', () => {
    for (const marker of [
      'data-dashboard-core-card="core.operationalTotals"',
      'data-dashboard-core-card="core.eventInbox"',
      'data-dashboard-core-card="core.workflowRuns"',
      'data-dashboard-core-card="core.agentTasks"',
      'data-dashboard-core-card="core.sources"',
      'data-dashboard-core-card="core.queue"',
      'data-dashboard-core-card="core.settings"',
      'data-dashboard-core-card="core.operatorActions"',
    ]) {
      expect(localizedDashboardPage).toContain(marker);
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
      expect(localizedDashboardPage).toContain(marker);
    }

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
    ]) {
      expect(dashboardClient).toContain(method);
      expect(dashboardApp).toContain(method);
    }

    expect(dashboardApp).toContain('renderCardSettingsForm');
    expect(dashboardApp).toContain('settingsSchema');
    expect(dashboardApp).toContain('selectedLayoutItem.config');
    expect(dashboardContent).toContain('Card settings');
    expect(dashboardContent).toContain('カード設定');
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
