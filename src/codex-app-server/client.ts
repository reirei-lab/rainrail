export type CodexAppServerFrameId = string | number;

export interface CodexAppServerRequestFrame {
  type: 'request';
  id: CodexAppServerFrameId;
  method: string;
  params?: unknown;
}

export interface CodexAppServerResponseError {
  code: string;
  message: string;
  data?: unknown;
}

export interface CodexAppServerResponseFrame {
  type: 'response';
  id: CodexAppServerFrameId;
  result?: unknown;
  error?: CodexAppServerResponseError;
}

export interface CodexAppServerNotificationFrame {
  type: 'notification';
  method: string;
  params?: unknown;
}

export type CodexAppServerFrame =
  | CodexAppServerRequestFrame
  | CodexAppServerResponseFrame
  | CodexAppServerNotificationFrame;

export interface CodexAppServerTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(frame: CodexAppServerFrame): Promise<void>;
  onFrame(handler: (frame: CodexAppServerFrame) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface CodexAppServerClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: (frame: CodexAppServerNotificationFrame) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface CodexAppServerClientOptions {
  transport: CodexAppServerTransport;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function createCodexAppServerClient(options: CodexAppServerClientOptions): CodexAppServerClient {
  return new DefaultCodexAppServerClient(options.transport);
}

class DefaultCodexAppServerClient implements CodexAppServerClient {
  readonly #transport: CodexAppServerTransport;
  readonly #pending = new Map<CodexAppServerFrameId, PendingRequest>();
  #nextRequestId = 1;
  #connected = false;
  #notificationHandlers: Array<(frame: CodexAppServerNotificationFrame) => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #unsubscribeTransport: Array<() => void> = [];
  #connectPromise: Promise<void> | undefined;

  constructor(transport: CodexAppServerTransport) {
    this.#transport = transport;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    this.#connectPromise = this.#connectTransport();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async #connectTransport(): Promise<void> {
    const unsubscribeTransport = [
      this.#transport.onFrame((frame) => this.#handleFrame(frame)),
      this.#transport.onError((error) => this.#handleError(error)),
      this.#transport.onClose(() => this.#handleClose()),
    ];
    this.#unsubscribeTransport = unsubscribeTransport;
    try {
      await this.#transport.connect();
    } catch (error) {
      for (const unsubscribe of unsubscribeTransport) unsubscribe();
      if (this.#unsubscribeTransport === unsubscribeTransport) {
        this.#unsubscribeTransport = [];
      }
      throw error;
    }
    if (this.#unsubscribeTransport !== unsubscribeTransport) {
      return;
    }
    this.#connected = true;
  }

  async close(): Promise<void> {
    await this.#transport.close();
    this.#handleClose();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    const frame: CodexAppServerRequestFrame = { id, type: 'request', method };
    if (params !== undefined) frame.params = params;

    const pending = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#transport.send(frame);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return pending;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const frame: CodexAppServerNotificationFrame = { type: 'notification', method };
    if (params !== undefined) frame.params = params;
    await this.#transport.send(frame);
  }

  onNotification(handler: (frame: CodexAppServerNotificationFrame) => void): () => void {
    this.#notificationHandlers.push(handler);
    return () => {
      this.#notificationHandlers = this.#notificationHandlers.filter((registered) => registered !== handler);
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

  #handleFrame(frame: CodexAppServerFrame): void {
    if (frame.type === 'notification') {
      for (const handler of this.#notificationHandlers) handler(frame);
      return;
    }

    if (frame.type !== 'response') {
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(frame.id);
    if (frame.error !== undefined) {
      pending.reject(new CodexAppServerProtocolError(frame.error));
      return;
    }
    pending.resolve(frame.result);
  }

  #handleError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }

  #handleClose(): void {
    if (!this.#connected && this.#pending.size === 0 && this.#unsubscribeTransport.length === 0) return;
    this.#connected = false;
    for (const unsubscribe of this.#unsubscribeTransport) unsubscribe();
    this.#unsubscribeTransport = [];
    const error = new Error('Codex App Server transport closed');
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const handler of this.#closeHandlers) handler();
  }
}

export class CodexAppServerProtocolError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(error: CodexAppServerResponseError) {
    super(error.message);
    this.name = 'CodexAppServerProtocolError';
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}
