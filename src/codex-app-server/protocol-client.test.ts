import { describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerProtocolClient,
  type CodexAppServerFrame,
  type CodexAppServerTransport,
} from './index.js';

class FakeTransport implements CodexAppServerTransport {
  readonly sent: CodexAppServerFrame[] = [];
  #frameHandlers: Array<(frame: CodexAppServerFrame) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];

  connect = vi.fn(async () => {});
  close = vi.fn(async () => {
    for (const handler of this.#closeHandlers) handler();
  });
  send = vi.fn(async (frame: CodexAppServerFrame) => {
    this.sent.push(frame);
  });

  onFrame(handler: (frame: CodexAppServerFrame) => void): () => void {
    this.#frameHandlers.push(handler);
    return () => {
      this.#frameHandlers = this.#frameHandlers.filter((registered) => registered !== handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.#errorHandlers.push(handler);
    return () => {
      this.#errorHandlers = this.#errorHandlers.filter((registered) => registered !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.push(handler);
    return () => {
      this.#closeHandlers = this.#closeHandlers.filter((registered) => registered !== handler);
    };
  }

  emitFrame(frame: CodexAppServerFrame): void {
    for (const handler of this.#frameHandlers) handler(frame);
  }

  emitError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }
}

describe('Codex App Server protocol wrapper', () => {
  it('wraps initialize, thread/start, and turn/start with minimal stable types', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    await client.connect();
    const initialize = client.initialize({
      clientInfo: { name: 'rainrail', title: 'Rainrail', version: '0.2.0' },
      capabilities: null,
    });
    transport.emitFrame({
      id: 1,
      result: {
        userAgent: 'codex-cli/0.139.0',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    await expect(initialize).resolves.toMatchObject({ userAgent: 'codex-cli/0.139.0' });

    const threadStart = client.startThread({ cwd: '/repo', ephemeral: true });
    transport.emitFrame({
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          sessionId: 'session-1',
          status: 'idle',
          preview: '',
          turns: [],
        },
        model: 'gpt-5',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: null,
        sandbox: { mode: 'read-only' },
        reasoningEffort: null,
      },
    });
    await expect(threadStart).resolves.toMatchObject({ thread: { id: 'thread-1' } });

    const turnStart = client.startTurn({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'reply ok', text_elements: [] }],
    });
    transport.emitFrame({
      id: 3,
      result: {
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    });

    await expect(turnStart).resolves.toMatchObject({ turn: { id: 'turn-1' } });
    expect(transport.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'rainrail', title: 'Rainrail', version: '0.2.0' },
          capabilities: null,
        },
      },
      {
        method: 'initialized',
      },
      {
        id: 2,
        method: 'thread/start',
        params: { cwd: '/repo', ephemeral: true },
      },
      {
        id: 3,
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'reply ok', text_elements: [] }],
        },
      },
    ]);
  });

  it('accepts initialize responses without optional codexHome', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    await client.connect();
    const initialize = client.initialize({
      clientInfo: { name: 'rainrail', title: 'Rainrail', version: '0.2.0' },
      capabilities: null,
    });
    transport.emitFrame({
      id: 1,
      result: {
        userAgent: 'codex-cli/0.139.0',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    await expect(initialize).resolves.toEqual({
      userAgent: 'codex-cli/0.139.0',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
    expect(transport.sent).toContainEqual({ method: 'initialized' });
  });

  it('collects assistant deltas and resolves when the matching turn completes', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });
    const deltas: string[] = [];

    client.onAssistantDelta((event) => deltas.push(event.delta));
    await client.connect();
    const completed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });

    transport.emitFrame({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'OK' },
    });
    transport.emitFrame({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
      },
    });

    expect(deltas).toEqual(['OK']);
    await expect(completed).resolves.toMatchObject({ turn: { id: 'turn-1', status: 'completed' } });
  });

  it('matches turn/completed without requiring threadId in the notification payload', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    await client.connect();
    const completed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
    transport.emitFrame({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
      },
    });

    await expect(completed).resolves.toMatchObject({ turn: { id: 'turn-1', status: 'completed' } });
  });

  it('resolves waiters registered after a fast turn/completed notification', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    await client.connect();
    const turnStart = client.startTurn({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'reply ok' }],
    });
    transport.emitFrame({
      id: 1,
      result: {
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    transport.emitFrame({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 100,
        },
      },
    });

    await expect(turnStart).resolves.toMatchObject({ turn: { id: 'turn-1' } });
    await expect(client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' }))
      .resolves.toMatchObject({ turn: { id: 'turn-1', status: 'completed' } });
    expect(transport.sent).toEqual([
      {
        id: 1,
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'reply ok' }],
        },
      },
    ]);
  });

  it('keeps turn waiters alive after a non-fatal transport error', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    await client.connect();
    const completed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
    transport.emitError(new Error('Failed to parse Codex App Server stdio frame'));
    transport.emitFrame({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 100,
        },
      },
    });

    await expect(completed).resolves.toMatchObject({ turn: { id: 'turn-1' } });
  });

  it('resolves waiters even when a turn completed handler throws', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });
    client.onTurnCompleted(() => {
      throw new Error('dashboard callback failed');
    });

    await client.connect();
    const completed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(() => transport.emitFrame({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 100,
        },
      },
    })).not.toThrow();

    await expect(completed).resolves.toMatchObject({ turn: { id: 'turn-1' } });
  });

  it('keeps turn waiters alive when an assistant delta handler throws', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerProtocolClient({ transport });

    client.onAssistantDelta(() => {
      throw new Error('stream renderer failed');
    });

    await client.connect();
    const completed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(() => transport.emitFrame({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'OK' },
    })).not.toThrow();
    transport.emitFrame({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          itemsView: { type: 'complete' },
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 100,
        },
      },
    });

    await expect(completed).resolves.toMatchObject({ turn: { id: 'turn-1' } });
  });

  it('evicts old turn completion cache entries', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const client = createCodexAppServerProtocolClient({ transport, requestTimeoutMs: 50 });

      await client.connect();
      for (let index = 1; index <= 33; index += 1) {
        transport.emitFrame({
          method: 'turn/completed',
          params: {
            turn: {
              id: `turn-${index}`,
              status: 'completed',
              items: [],
              itemsView: { type: 'complete' },
              error: null,
              startedAt: index,
              completedAt: index + 1,
              durationMs: 10,
            },
          },
        });
      }

      const evicted = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
      await vi.advanceTimersByTimeAsync(50);
      await expect(evicted).rejects.toThrow('Timed out waiting for Codex App Server turn/completed');
      await expect(client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-33' }))
        .resolves.toMatchObject({ turn: { id: 'turn-33' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects waiting for turn completion on timeout and transport close', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const client = createCodexAppServerProtocolClient({ transport, requestTimeoutMs: 50 });

      await client.connect();
      const timedOut = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' });
      await vi.advanceTimersByTimeAsync(50);

      await expect(timedOut).rejects.toThrow('Timed out waiting for Codex App Server turn/completed');

      const closed = client.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-2' });
      await transport.close();

      await expect(closed).rejects.toThrow('Codex App Server transport closed');
    } finally {
      vi.useRealTimers();
    }
  });
});
