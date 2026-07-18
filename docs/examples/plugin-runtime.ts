import {
  createDashboardCardProviderFromManifest,
  createManualInputEvent,
  createEventEnvelope,
  defineWorkflowPlugin,
  type DashboardPluginManifest,
  type ManualInputRainrailEvent,
  type RainrailEventEnvelope,
} from '../../src/index.js';

type IssuePayload = {
  action: 'opened' | 'labeled';
  issueNumber: number;
};

const event: RainrailEventEnvelope<IssuePayload, 'github.issue'> = createEventEnvelope({
  source: {
    type: 'github',
    name: 'github-webhook',
    repository: 'reirei-lab/rainrail',
  },
  name: 'github.issue',
  delivery: {
    id: 'delivery-123',
    receivedAt: '2026-07-01T00:00:00.000Z',
  },
  occurredAt: '2026-07-01T00:00:00.000Z',
  subject: {
    type: 'issue',
    id: '61',
    url: 'https://github.com/reirei-lab/rainrail/issues/61',
  },
  payload: {
    action: 'opened',
    issueNumber: 61,
  },
  rawPayload: {
    kind: 'external-reference',
    reference: 'github://deliveries/delivery-123',
  },
});

export const issueSummaryWorkflow = defineWorkflowPlugin({
  name: 'docs.issue-summary',
  accepts: (candidate) => candidate.name === event.name,
  handle: (candidate, context) => ({
    eventId: candidate.id,
    runId: context.runId,
  }),
});

export const chatMessageEvent: Promise<ManualInputRainrailEvent> = createManualInputEvent({
  channel: 'chat',
  deliveryId: 'chat-delivery-123',
  receivedAt: new Date('2026-07-04T09:20:00.000Z'),
  conversationId: 'conversation-123',
  messageId: 'message-123',
  message: 'Please inspect the latest deployment failure.',
  actor: {
    id: 'user-123',
    displayName: 'hiragram',
    type: 'user',
  },
  rawBody: JSON.stringify({
    conversationId: 'conversation-123',
    message: 'Please inspect the latest deployment failure.',
  }),
  contentType: 'application/json',
});

export const chatRuntimeStartWorkflow = defineWorkflowPlugin<ManualInputRainrailEvent>({
  name: 'docs.chat-runtime-start',
  capabilities: ['runtime:start'],
  accepts: (candidate) => candidate.name === 'rainrail.chat.message',
  handle: (candidate, context) => context.actions.startRuntime({
    runtimeId: 'codex-app-server',
    conversationId: candidate.subject.id,
    prompt: candidate.payload.message.text,
  }),
});

export const codexAppServerRuntimeConfig = {
  sourceBundles: [{
    type: 'eep-bridge',
    name: 'local-chat',
    sources: [{
      type: 'manual-chat',
      name: 'codex-chat',
      sourceType: 'chat',
      runtime: 'codex-app-server',
    }],
  }],
  runtimeProviders: {
    codexAppServer: {
      type: 'plugin',
      enabled: true,
      runtime: 'codex-app-server',
      plugin: '@rainrail/codex-app-server-runtime',
      executor: 'codex-app-server',
      command: '${CODEX_BIN}',
      home: '${CODEX_HOME_PARENT}',
      codexHome: '${CODEX_HOME}',
    },
  },
} as const;

export const issueSummaryManifest: DashboardPluginManifest = {
  name: 'issueSummary',
  version: '1.0.0',
  dashboard: {
    cards: [{
      name: 'queue',
      title: 'Issue summary queue',
      category: 'operations',
      requiredCapabilities: ['dashboard:read'],
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
    }],
  },
};

export const issueSummaryCards = createDashboardCardProviderFromManifest(issueSummaryManifest);
