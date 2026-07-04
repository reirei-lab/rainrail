import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const apiSpec = readFileSync(
  new URL('../docs/operational-api-v1.md', import.meta.url),
  'utf8',
);
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('operational API v1 design note', () => {
  it('defines the shared dashboard/mobile API surface and migration path', () => {
    for (const heading of [
      '# Operational API v1',
      '## Goals',
      '## Resources',
      '## Compact rows and detail records',
      '## Pagination, filtering, and sorting',
      '## Mobile client contract',
      '## Realtime delivery strategy',
      '## Authentication and authorization',
      '## Action audit',
      '## Migration from `/api/state`',
      '## Validation plan',
    ]) {
      expect(apiSpec).toContain(heading);
    }

    for (const resource of [
      '`GET /api/v1/overview`',
      '`GET /api/v1/events`',
      '`GET /api/v1/events/{eventId}`',
      '`GET /api/v1/workflow-runs`',
      '`GET /api/v1/agent-tasks`',
      '`GET /api/v1/sources`',
      '`GET /api/v1/queue`',
      '`GET /api/v1/settings`',
    ]) {
      expect(apiSpec).toContain(resource);
    }

    for (const contractTerm of [
      '`read-only`',
      '`operator`',
      '`admin`',
      '`actor`',
      '`client`',
      '`requestId`',
      '`nextCursor`',
      '`If-None-Match`',
      '`ETag`',
      '`X-Request-ID`',
      '`Last-Event-ID`',
      '`notificationHint`',
      'polling',
      'SSE',
      'push notification',
      'compact row',
      'detail record',
      '`/api/state`',
      '`src/dashboard-api.test.ts`',
    ]) {
      expect(apiSpec).toContain(contractTerm);
    }
  });

  it('links the v1 API note from the docs index', () => {
    expect(docsIndex).toContain('operational-api-v1.md');
  });
});
