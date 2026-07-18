export type CodexAppServerFrameId = string | number;

export interface CodexAppServerRequestFrame {
  id: CodexAppServerFrameId;
  method: string;
  params?: unknown;
}

export interface CodexAppServerResponseError {
  code: string | number;
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
  request(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onRequest(handler: (frame: CodexAppServerRequestFrame) => unknown | Promise<unknown>): () => void;
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
  cleanup?: (() => void) | undefined;
}

export function createCodexAppServerClient(options: CodexAppServerClientOptions): CodexAppServerClient {
  return new DefaultCodexAppServerClient(options.transport);
}

class DefaultCodexAppServerClient implements CodexAppServerClient {
  readonly #transport: CodexAppServerTransport;
  readonly #pending = new Map<CodexAppServerFrameId, PendingRequest>();
  #nextRequestId = 1;
  #connected = false;
  #requestHandlers: Array<(frame: CodexAppServerRequestFrame) => unknown | Promise<unknown>> = [];
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

  request(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    if (options?.signal?.aborted) {
      const rejected = Promise.reject(abortErrorFromSignal(options.signal));
      rejected.catch(() => undefined);
      return rejected;
    }
    const id = this.#nextRequestId++;
    const frame: CodexAppServerRequestFrame = { id, method };
    if (params !== undefined) frame.params = params;

    let pendingRequest: PendingRequest | undefined;
    const pending = new Promise<unknown>((resolve, reject) => {
      pendingRequest = { resolve, reject };
      this.#pending.set(id, pendingRequest);
    });
    pending.catch(() => undefined);
    const signal = options?.signal;
    if (signal !== undefined && pendingRequest !== undefined) {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        pendingRequest?.cleanup?.();
        pendingRequest?.reject(abortErrorFromSignal(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pendingRequest.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    try {
      this.#transport.send(frame).catch((error: unknown) => {
        if (this.#pending.delete(id)) {
          pendingRequest?.cleanup?.();
          pendingRequest?.reject(errorFromUnknown(error));
        }
      });
    } catch (error) {
      this.#pending.delete(id);
      pendingRequest?.cleanup?.();
      pendingRequest?.reject(errorFromUnknown(error));
    }
    return pending;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const frame: CodexAppServerNotificationFrame = { method };
    if (params !== undefined) frame.params = params;
    await this.#transport.send(frame);
  }

  onRequest(handler: (frame: CodexAppServerRequestFrame) => unknown | Promise<unknown>): () => void {
    this.#requestHandlers.push(handler);
    return () => {
      this.#requestHandlers = this.#requestHandlers.filter((registered) => registered !== handler);
    };
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
      if (isServerRequestFrame(frame)) {
        void this.#handleServerRequest(frame);
      }
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(frame.id);
    pending.cleanup?.();
    if (frame.error !== undefined) {
      pending.reject(new CodexAppServerProtocolError(frame.error));
      return;
    }
    pending.resolve(frame.result);
  }

  #handleError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }

  async #handleServerRequest(frame: CodexAppServerRequestFrame): Promise<void> {
    const handler = this.#requestHandlers.at(-1);
    if (handler === undefined) {
      await this.#sendResponse({
        id: frame.id,
        error: {
          code: -32601,
          message: `Codex App Server client has no handler for server request ${frame.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(frame);
      await this.#sendResponse({ id: frame.id, result: result ?? null });
    } catch (error) {
      await this.#sendResponse({
        id: frame.id,
        error: {
          code: -32603,
          message: errorFromUnknown(error).message,
        },
      });
    }
  }

  async #sendResponse(frame: CodexAppServerResponseFrame): Promise<void> {
    try {
      await this.#transport.send(frame);
    } catch (error) {
      this.#handleError(errorFromUnknown(error));
    }
  }

  #handleClose(): void {
    if (!this.#connected && this.#pending.size === 0 && this.#unsubscribeTransport.length === 0) return;
    this.#connected = false;
    for (const unsubscribe of this.#unsubscribeTransport) unsubscribe();
    this.#unsubscribeTransport = [];
    const error = new Error('Codex App Server transport closed');
    for (const pending of this.#pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const handler of this.#closeHandlers) handler();
  }
}

export class CodexAppServerProtocolError extends Error {
  readonly code: string | number;
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

function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name !== 'AbortError') return signal.reason;
  return new Error('Codex App Server request aborted');
}

function isNotificationFrame(frame: CodexAppServerFrame): frame is CodexAppServerNotificationFrame {
  return !('id' in frame) && typeof frame.method === 'string';
}

function isResponseFrame(frame: CodexAppServerFrame): frame is CodexAppServerResponseFrame {
  return 'id' in frame && !('method' in frame);
}

function isServerRequestFrame(frame: CodexAppServerFrame): frame is CodexAppServerRequestFrame {
  return 'id' in frame && 'method' in frame && typeof frame.method === 'string';
}
