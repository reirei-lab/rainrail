export type CodexAppServerFrameId = string | number;

export interface CodexAppServerRequestFrame {
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
  id: CodexAppServerFrameId;
  result?: unknown;
  error?: CodexAppServerResponseError;
}

export interface CodexAppServerNotificationFrame {
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

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    const frame: CodexAppServerRequestFrame = { id, method };
    if (params !== undefined) frame.params = params;

    let pendingRequest: PendingRequest | undefined;
    const pending = new Promise<unknown>((resolve, reject) => {
      pendingRequest = { resolve, reject };
      this.#pending.set(id, pendingRequest);
    });
    pending.catch(() => undefined);
    try {
      this.#transport.send(frame).catch((error: unknown) => {
        if (this.#pending.delete(id)) {
          pendingRequest?.reject(errorFromUnknown(error));
        }
      });
    } catch (error) {
      this.#pending.delete(id);
      pendingRequest?.reject(errorFromUnknown(error));
    }
    return pending;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const frame: CodexAppServerNotificationFrame = { method };
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
    if (isNotificationFrame(frame)) {
      for (const handler of this.#notificationHandlers) handler(frame);
      return;
    }

    if (!isResponseFrame(frame)) {
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

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotificationFrame(frame: CodexAppServerFrame): frame is CodexAppServerNotificationFrame {
  return !('id' in frame) && typeof frame.method === 'string';
}

function isResponseFrame(frame: CodexAppServerFrame): frame is CodexAppServerResponseFrame {
  return 'id' in frame && !('method' in frame);
}
