import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardPage = readFileSync(
  new URL('../apps/www/src/pages/dashboard.astro', import.meta.url),
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
  it('names the Overview, Event Inbox, Workflow Runs, and Agent Tasks work surfaces', () => {
    for (const label of ['Overview', 'Event Inbox', 'Workflow Runs', 'Agent Tasks']) {
      expect(dashboardPage).toContain(label);
    }

    expect(dashboardPage).toContain('data-dashboard-tab="agent-tasks"');
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
      expect(dashboardPage).toContain(marker);
    }

    expect(dashboardClient).toContain('filter[name]');
    expect(dashboardClient).toContain('filter[source]');
    expect(dashboardApp).toContain('deliveryId');
    expect(dashboardApp).toContain('latestOutcome');
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
      expect(dashboardApp).toContain(label);
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
      expect(dashboardApp).toContain(label);
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
      expect(dashboardPage).toContain(marker);
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

  it('does not mark the whole dashboard empty just because Event Inbox filters hide rows', () => {
    expect(dashboardApp).toContain('hasOperationalRecords(latestData.overview)');
    expect(dashboardApp).not.toContain("setState(hasRows(latestData) ? 'ready' : 'empty'");
  });

  it('keeps the dashboard dense and responsive', () => {
    expect(globalStyles).toContain('.dashboard-overview-grid');
    expect(globalStyles).toContain('.dashboard-filterbar');
    expect(globalStyles).toContain('.dashboard-audit-list');
    expect(globalStyles).toContain('@media (max-width: 900px)');
  });
});
