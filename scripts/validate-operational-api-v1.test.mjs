import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const apiSpec = readFileSync(
  new URL('../docs/operational-api-v1.md', import.meta.url),
  'utf8',
);
const docsIndex = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
const contractsManifest = JSON.parse(
  readFileSync(new URL('../docs/contracts.manifest.json', import.meta.url), 'utf8'),
);

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
      '`/api/v1/workflow-runs/{runId}`',
      '`GET /api/v1/agent-tasks`',
      '`/api/v1/agent-tasks/{taskId}`',
      '`GET /api/v1/sources`',
      '`GET /api/v1/queue`',
      '`GET /api/v1/settings`',
      '`GET /api/v1/dashboard/status`',
      '`GET /api/v1/dashboard/cards`',
      '`GET /api/v1/dashboard/layout`',
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
      '`lastDurationMs`',
      '`lastSuccessAt`',
      '`lastHttpStatus`',
      '`lastError`',
      '`auth.scope`',
      '`notificationHint`',
      '`SSE_BEARER_TOKEN`',
      'future optimization',
      'does not guarantee',
      'action `POST`',
      'named event listener',
      'polling',
      'SSE',
      'push notification',
      'compact row',
      'detail record',
      '`/api/state`',
      '`src/dashboard-api.test.ts`',
      '`definition.entry`',
      '`definition.category`',
      '`definition.size`',
      '`size.default`',
      '`size.min`',
      '`size.max`',
      'provider / plugin filter',
      'resize guard',
      'API Status Tile',
      'overview が遅い、失敗する、または未取得に戻るとき',
      'overview 本体とは独立して polling',
      'route contract',
    ]) {
      expect(apiSpec).toContain(contractTerm);
    }
  });

  it('links the v1 API note from the docs index', () => {
    expect(docsIndex).toContain('operational-api-v1.md');
  });

  it('registers the operational API contract in the contracts manifest', () => {
    expect(contractsManifest.contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'operational-api-v1',
          docs: expect.arrayContaining(['docs/operational-api-v1.md']),
          tests: expect.arrayContaining([
            'packages/cli/src/commands.test.ts',
            'scripts/validate-operational-api-v1.test.mjs',
            'src/dashboard-api.test.ts',
          ]),
        }),
      ]),
    );
  });
});
