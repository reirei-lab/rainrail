import { describe, expect, it } from 'vitest';

import { expectGraphQLOperation, getReaderOrThrow, readUntil, waitForValue } from './test-helpers.js';

describe('SSE and HTTP test helpers', () => {
  it('throws a clear error when a response has no readable body', () => {
    expect(() => getReaderOrThrow(new Response(null), { label: 'events response' }))
      .toThrow('events response did not include a readable body');
  });

  it('throws the chunk limit and buffered text when an expected stream event is missing', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': connected\n\n'));
        controller.close();
      },
    });
    const reader = stream.getReader();

    await expect(readUntil(reader, 'github.issue', { maxChunks: 1 }))
      .rejects
      .toThrow('Reached 1 stream chunk(s) without seeing "github.issue". Last buffered text: : connected');
  });

  it('throws the timeout and buffered text when the stream stops producing chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      },
    });
    const reader = stream.getReader();

    await expect(readUntil(reader, 'github.issue', { timeoutMs: 5, maxChunks: 2 }))
      .rejects
      .toThrow('Timed out after 5ms waiting for stream chunk containing "github.issue". Last buffered text: : connected');
  });

  it('throws the last observed value when polling never reaches the expected value', async () => {
    let clients = 3;

    await expect(waitForValue(async () => clients += 1, 0, { attempts: 2, intervalMs: 1, label: 'client count' }))
      .rejects
      .toThrow('Timed out waiting for client count to become 0 after 2 attempt(s). Last observed value: 5');
  });
});

describe('GraphQL test helpers', () => {
  it('throws a clear operation list when an expected GraphQL operation is missing', () => {
    const calls = [
      {
        query: 'query RainrailProjectItemStatus($itemId: ID!) { node(id: $itemId) { id } }',
        variables: { itemId: 'item_21' },
      },
      {
        query: 'mutation RainrailCreateProjectIssueClaimLock($repositoryId: ID!) { createRef(input: { repositoryId: $repositoryId }) { ref { id } } }',
        variables: { repositoryId: 'R_repo', name: 'refs/notes/rainrail/locks/reirei-lab-rainrail-21-item-21' },
      },
    ];

    expect(() => expectGraphQLOperation(calls, 'RainrailDeleteProjectIssueClaimLock'))
      .toThrow([
        'Expected GraphQL operation "RainrailDeleteProjectIssueClaimLock" to be recorded.',
        'Recorded operations:',
        '0: RainrailProjectItemStatus variables={"itemId":"item_21"}',
        '1: RainrailCreateProjectIssueClaimLock variables={"repositoryId":"R_repo","name":"refs/notes/rainrail/locks/reirei-lab-rainrail-21-item-21"}',
      ].join('\n'));
  });
});
