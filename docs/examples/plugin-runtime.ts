import {
  createEventEnvelope,
  defineWorkflowPlugin,
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
