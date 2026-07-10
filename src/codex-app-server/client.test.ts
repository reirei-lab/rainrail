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
        type: 'request',
        method: 'session.start',
        params: { repository: 'reirei-lab/rainrail' },
      },
    ]);

    transport.emitFrame({ id: 1, type: 'response', result: { sessionId: 'session-1' } });

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
      type: 'notification',
      method: 'session.output',
      params: { text: 'hello' },
    });

    expect(notifications).toEqual([
      {
        type: 'notification',
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
    transport.emitFrame({ type: 'notification', method: 'session.output' });

    expect(notifications).toEqual([{ type: 'notification', method: 'session.output' }]);
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
    transport.emitFrame({ type: 'notification', method: 'session.output' });

    expect(notifications).toEqual([{ type: 'notification', method: 'session.output' }]);
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
      type: 'response',
      error: {
        code: 'invalid_request',
        message: 'missing repository',
      },
    });

    await expect(pending).rejects.toThrow('missing repository');
  });

  it('sends notifications without allocating request ids', async () => {
    const transport = new FakeTransport();
    const client = createCodexAppServerClient({ transport });

    await client.connect();
    await client.notify('session.cancel', { sessionId: 'session-1' });
    void client.request('session.start');

    expect(transport.sent).toEqual([
      {
        type: 'notification',
        method: 'session.cancel',
        params: { sessionId: 'session-1' },
      },
      {
        id: 1,
        type: 'request',
        method: 'session.start',
      },
    ]);
  });
});
