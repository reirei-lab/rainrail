import { createEventEnvelope } from './index.js';

// @ts-expect-error subject is required by the routing contract.
createEventEnvelope({
  source: { type: 'github', name: 'github-webhook' },
  name: 'github.issue',
  delivery: {
    id: 'delivery-12',
    receivedAt: '2026-06-29T13:00:44.000Z',
  },
  occurredAt: '2026-06-29T13:00:44.000Z',
  payload: { action: 'opened' },
  rawPayload: {
    kind: 'external-reference',
    reference: 'github://deliveries/delivery-12',
  },
});
