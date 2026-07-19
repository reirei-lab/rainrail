import { describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerClient,
  type CodexAppServerFrame,
  type CodexAppServerTransport,
} from './client.js';

class FakeTransport implements CodexAppServerTransport {
  readonly sent: CodexAppServerFrame[] = [];
  #frameHandlers: Array<(frame: CodexAppServerFrame) => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];
  #closeHandlers: Array<() => void> = [];

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

describe('Codex App Server protocol client', () => {
  it('sends requests through an injected transport and resolves matching responses', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    const result = client.request('session.start', { repository: 'reirei-lab/rainrail' });

    expect(transport.connect).toHaveBeenCalledOnce();
    expect(transport.sent).toEqual([
      {
        id: 1,
        method: 'session.start',
        params: { repository: 'reirei-lab/rainrail' },
      },
    ]);

    transport.emitFrame({ id: 1, result: { sessionId: 'session-1' } });

    await expect(result).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('exposes server notifications without coupling them to request parsing', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });
    const notifications: CodexAppServerFrame[] = [];

    client.onNotification((frame) => {
      notifications.push(frame);
    });
    await client.connect();

    transport.emitFrame({
      method: 'session.output',
      params: { text: 'hello' },
    });

    expect(notifications).toEqual([
      {
        method: 'session.output',
        params: { text: 'hello' },
      },
    ]);
  });

  it('rejects all pending requests when the transport closes', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    const pending = client.request('session.start');

    await transport.close();

    await expect(pending).rejects.toThrow('Codex App Server transport closed');
  });

  it('removes transport subscriptions when connect fails so retry delivery is not duplicated', async () => {
    const transport = new FakeTransport();
    transport.connect
      .mockRejectedValueOnce(new Error('temporary connect failure'))
      .mockResolvedValueOnce(undefined);
    const client = createCodexAppServerClient({ transport });
    const notifications: CodexAppServerFrame[] = [];

    client.onNotification((frame) => {
      notifications.push(frame);
    });

    await expect(client.connect()).rejects.toThrow('temporary connect failure');
    await client.connect();
    transport.emitFrame({ method: 'session.output' });

    expect(notifications).toEqual([{ method: 'session.output' }]);
  });

  it('shares an in-flight connect so concurrent callers do not duplicate subscriptions', async () => {
    const transport = new FakeTransport();
    let resolveConnect: (() => void) | undefined;
    transport.connect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
    });
    const client = createCodexAppServerClient({ transport });
    const notifications: CodexAppServerFrame[] = [];

    client.onNotification((frame) => {
      notifications.push(frame);
    });
    const firstConnect = client.connect();
    const secondConnect = client.connect();

    expect(transport.connect).toHaveBeenCalledOnce();
    resolveConnect?.();
    await Promise.all([firstConnect, secondConnect]);
    transport.emitFrame({ method: 'session.output' });

    expect(notifications).toEqual([{ method: 'session.output' }]);
  });

  it('does not mark the client connected when close happens before connect resolves', async () => {
    const transport = new FakeTransport();
    let resolveConnect: (() => void) | undefined;
    transport.connect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
    });
    const client = createCodexAppServerClient({ transport });

    const pendingConnect = client.connect();
    await client.close();
    resolveConnect?.();
    await pendingConnect;
    await client.connect();

    expect(transport.connect).toHaveBeenCalledTimes(2);
  });

  it('rejects the matching request when a protocol error response arrives', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    const pending = client.request('session.start');

    transport.emitFrame({
      id: 1,
      error: {
        code: 'invalid_request',
        message: 'missing repository',
      },
    });

    await expect(pending).rejects.toThrow('missing repository');
  });

  it('rejects with numeric JSON-RPC protocol error codes', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    const pending = client.request('thread/start');

    transport.emitFrame({
      id: 1,
      error: {
        code: -32600,
        message: 'Not initialized',
      },
    });

    await expect(pending).rejects.toMatchObject({ code: -32600, message: 'Not initialized' });
  });

  it('responds to unhandled server requests with a JSON-RPC method-not-found error', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    transport.emitFrame({
      id: 99,
      method: 'command/exec/approval',
      params: { approvalId: 'approval-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sent).toEqual([
      {
        id: 99,
        error: {
          code: -32601,
          message: 'Codex App Server client has no handler for server request command/exec/approval',
        },
      },
    ]);
  });

  it('lets callers handle server requests and falls back after unregistering the handler', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });
    const handledRequests: CodexAppServerFrame[] = [];

    const unsubscribe = client.onRequest((frame) => {
      handledRequests.push(frame);
      return { decision: 'approved' };
    });

    await client.connect();
    transport.emitFrame({
      id: 99,
      method: 'command/exec/approval',
      params: { approvalId: 'approval-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    unsubscribe();
    transport.emitFrame({
      id: 100,
      method: 'tool/requestUserInput',
      params: { prompt: 'continue?' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handledRequests).toEqual([
      {
        id: 99,
        method: 'command/exec/approval',
        params: { approvalId: 'approval-1' },
      },
    ]);
    expect(transport.sent).toEqual([
      {
        id: 99,
        result: { decision: 'approved' },
      },
      {
        id: 100,
        error: {
          code: -32601,
          message: 'Codex App Server client has no handler for server request tool/requestUserInput',
        },
      },
    ]);
  });

  it('turns server request handler failures into JSON-RPC error responses', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    client.onRequest(() => {
      throw new Error('approval backend failed');
    });

    await client.connect();
    transport.emitFrame({
      id: 99,
      method: 'command/exec/approval',
      params: { approvalId: 'approval-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sent).toEqual([
      {
        id: 99,
        error: {
          code: -32603,
          message: 'approval backend failed',
        },
      },
    ]);
  });

  it('normalizes undefined server request handler results to JSON-RPC null results', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    client.onRequest(() => undefined);

    await client.connect();
    transport.emitFrame({
      id: 99,
      method: 'command/exec/approval',
      params: { approvalId: 'approval-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sent).toEqual([
      {
        id: 99,
        result: null,
      },
    ]);
  });

  it('removes pending requests when their AbortSignal fires', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });
    const controller = new AbortController();

    await client.connect();
    const aborted = client.request('thread/start', undefined, { signal: controller.signal });
    controller.abort();

    await expect(aborted).rejects.toThrow('Codex App Server request aborted');

    transport.emitFrame({ id: 1, result: { stale: true } });
    const next = client.request('thread/start');
    transport.emitFrame({ id: 2, result: { thread: { id: 'thread-2' } } });

    await expect(next).resolves.toEqual({ thread: { id: 'thread-2' } });
  });

  it('returns the pending request promise before transport send settles', async () => {
    const transport = new FakeTransport();
    let resolveSend: (() => void) | undefined;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    transport.send.mockImplementationOnce(async (frame: CodexAppServerFrame) => {
      transport.sent.push(frame);
      transport.emitFrame({
        id: 1,
        error: {
          code: 'fast_failure',
          message: 'response arrived before send settled',
        },
      });
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
    });
    const client = createCodexAppServerClient({ transport });

    process.on('unhandledRejection', onUnhandledRejection);
    let result: Promise<unknown> | undefined;
    try {
      await client.connect();
      result = client.request('session.start');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      resolveSend?.();

      await expect(result).rejects.toThrow('response arrived before send settled');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      resolveSend?.();
      if (result !== undefined) await result.catch(() => undefined);
    }
  });

  it('sends notifications without allocating request ids', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    await client.notify('session.cancel', { sessionId: 'session-1' });
    void client.request('session.start');

    expect(transport.sent).toEqual([
      {
        method: 'session.cancel',
        params: { sessionId: 'session-1' },
      },
      {
        id: 1,
        method: 'session.start',
      },
    ]);
  });
});
