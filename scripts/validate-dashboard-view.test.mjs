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
  it('names the Overview, Event Inbox, and Workflow Runs work surfaces', () => {
    for (const label of ['Overview', 'Event Inbox', 'Workflow Runs']) {
      expect(dashboardPage).toContain(label);
    }

    expect(dashboardPage).not.toContain('Agent tasks</button>');
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

  it('keeps the dashboard dense and responsive', () => {
    expect(globalStyles).toContain('.dashboard-overview-grid');
    expect(globalStyles).toContain('.dashboard-filterbar');
    expect(globalStyles).toContain('.dashboard-audit-list');
    expect(globalStyles).toContain('@media (max-width: 900px)');
  });
});
