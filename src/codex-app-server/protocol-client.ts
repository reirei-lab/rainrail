import {
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotificationFrame,
} from './client.js';

export interface CodexAppServerProtocolClientOptions extends CodexAppServerClientOptions {
  requestTimeoutMs?: number;
}

export interface CodexAppServerClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface CodexAppServerInitializeParams {
  clientInfo: CodexAppServerClientInfo;
  capabilities: Record<string, unknown> | null;
}

export interface CodexAppServerInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexAppServerThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  config?: Record<string, unknown> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean | null;
  sessionStartSource?: string | null;
  threadSource?: string | null;
}

export interface CodexAppServerThreadSummary {
  id: string;
  sessionId?: string;
  status?: string;
  preview?: string;
  turns?: unknown[];
}

export interface CodexAppServerThreadStartResponse {
  thread: CodexAppServerThreadSummary;
  model?: string;
  modelProvider?: string;
  serviceTier?: string | null;
  cwd?: string;
  instructionSources?: string[];
  approvalPolicy?: string;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  reasoningEffort?: string | null;
}

export interface CodexAppServerTextInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export type CodexAppServerTurnInput =
  | CodexAppServerTextInput
  | { type: 'image'; url: string; detail?: string }
  | { type: 'localImage'; path: string; detail?: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface CodexAppServerTurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: CodexAppServerTurnInput[];
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: string | null;
  personality?: string | null;
  outputSchema?: unknown;
}

export interface CodexAppServerTurnSummary {
  id: string;
  status?: unknown;
  items?: unknown[];
  itemsView?: unknown;
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexAppServerTurnStartResponse {
  turn: CodexAppServerTurnSummary;
}

export interface CodexAppServerAssistantDeltaEvent {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexAppServerTurnCompletedEvent {
  threadId: string;
  turn: CodexAppServerTurnSummary;
}

export interface CodexAppServerTurnWaitTarget {
  threadId: string;
  turnId: string;
  timeoutMs?: number;
}

export interface CodexAppServerProtocolClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  initialize(params: CodexAppServerInitializeParams): Promise<CodexAppServerInitializeResponse>;
  startThread(params?: CodexAppServerThreadStartParams): Promise<CodexAppServerThreadStartResponse>;
  startTurn(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResponse>;
  waitForTurnCompleted(target: CodexAppServerTurnWaitTarget): Promise<CodexAppServerTurnCompletedEvent>;
  onAssistantDelta(handler: (event: CodexAppServerAssistantDeltaEvent) => void): () => void;
  onTurnCompleted(handler: (event: CodexAppServerTurnCompletedEvent) => void): () => void;
}

interface PendingTurnCompletion {
  threadId: string;
  turnId: string;
  timer: NodeJS.Timeout | undefined;
  resolve(event: CodexAppServerTurnCompletedEvent): void;
  reject(error: Error): void;
}

const defaultRequestTimeoutMs = 60_000;

export function createCodexAppServerProtocolClient(
  options: CodexAppServerProtocolClientOptions,
): CodexAppServerProtocolClient {
  return new DefaultCodexAppServerProtocolClient(options);
}

class DefaultCodexAppServerProtocolClient implements CodexAppServerProtocolClient {
  readonly #client: CodexAppServerClient;
  readonly #requestTimeoutMs: number;
  #assistantDeltaHandlers: Array<(event: CodexAppServerAssistantDeltaEvent) => void> = [];
  #turnCompletedHandlers: Array<(event: CodexAppServerTurnCompletedEvent) => void> = [];
  #pendingTurnCompletions: PendingTurnCompletion[] = [];

  constructor(options: CodexAppServerProtocolClientOptions) {
    this.#client = createCodexAppServerClient(options);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.#client.onNotification((frame) => this.#handleNotification(frame));
    this.#client.onClose(() => this.#rejectPendingTurnCompletions(new Error('Codex App Server transport closed')));
    this.#client.onError((error) => this.#rejectPendingTurnCompletions(error));
  }

  connect(): Promise<void> {
    return this.#client.connect();
  }

  close(): Promise<void> {
    return this.#client.close();
  }

  async initialize(params: CodexAppServerInitializeParams): Promise<CodexAppServerInitializeResponse> {
    return expectInitializeResponse(await this.#requestWithTimeout('initialize', params));
  }

  async startThread(params: CodexAppServerThreadStartParams = {}): Promise<CodexAppServerThreadStartResponse> {
    return expectThreadStartResponse(await this.#requestWithTimeout('thread/start', params));
  }

  async startTurn(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResponse> {
    return expectTurnStartResponse(await this.#requestWithTimeout('turn/start', params));
  }

  waitForTurnCompleted(target: CodexAppServerTurnWaitTarget): Promise<CodexAppServerTurnCompletedEvent> {
    const pendingPromise = new Promise<CodexAppServerTurnCompletedEvent>((resolve, reject) => {
      const pending: PendingTurnCompletion = {
        threadId: target.threadId,
        turnId: target.turnId,
        timer: undefined,
        resolve,
        reject,
      };
      pending.timer = setTimeout(() => {
        this.#removePendingTurnCompletion(pending);
        reject(new Error('Timed out waiting for Codex App Server turn/completed'));
      }, target.timeoutMs ?? this.#requestTimeoutMs);
      this.#pendingTurnCompletions.push(pending);
    });
    pendingPromise.catch(() => undefined);
    return pendingPromise;
  }

  onAssistantDelta(handler: (event: CodexAppServerAssistantDeltaEvent) => void): () => void {
    this.#assistantDeltaHandlers.push(handler);
    return () => {
      this.#assistantDeltaHandlers = this.#assistantDeltaHandlers.filter((registered) => registered !== handler);
    };
  }

  onTurnCompleted(handler: (event: CodexAppServerTurnCompletedEvent) => void): () => void {
    this.#turnCompletedHandlers.push(handler);
    return () => {
      this.#turnCompletedHandlers = this.#turnCompletedHandlers.filter((registered) => registered !== handler);
    };
  }

  #requestWithTimeout(method: string, params: unknown): Promise<unknown> {
    return withTimeout(this.#client.request(method, params), this.#requestTimeoutMs, `Codex App Server ${method} timed out`);
  }

  #handleNotification(frame: CodexAppServerNotificationFrame): void {
    if (frame.method === 'item/agentMessage/delta') {
      const event = parseAssistantDelta(frame.params);
      if (event === undefined) return;
      for (const handler of this.#assistantDeltaHandlers) handler(event);
      return;
    }
    if (frame.method !== 'turn/completed') return;
    const event = parseTurnCompleted(frame.params);
    if (event === undefined) return;
    for (const handler of this.#turnCompletedHandlers) handler(event);
    for (const pending of [...this.#pendingTurnCompletions]) {
      if (pending.threadId !== event.threadId || pending.turnId !== event.turn.id) continue;
      this.#removePendingTurnCompletion(pending);
      pending.resolve(event);
    }
  }

  #rejectPendingTurnCompletions(error: Error): void {
    for (const pending of [...this.#pendingTurnCompletions]) {
      this.#removePendingTurnCompletion(pending);
      pending.reject(error);
    }
  }

  #removePendingTurnCompletion(pending: PendingTurnCompletion): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pendingTurnCompletions = this.#pendingTurnCompletions.filter((candidate) => candidate !== pending);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function expectInitializeResponse(value: unknown): CodexAppServerInitializeResponse {
  const record = expectRecord(value, 'initialize response');
  return {
    userAgent: expectString(record.userAgent, 'initialize response userAgent'),
    codexHome: expectString(record.codexHome, 'initialize response codexHome'),
    platformFamily: expectString(record.platformFamily, 'initialize response platformFamily'),
    platformOs: expectString(record.platformOs, 'initialize response platformOs'),
  };
}

function expectThreadStartResponse(value: unknown): CodexAppServerThreadStartResponse {
  const record = expectRecord(value, 'thread/start response');
  const thread = expectThreadSummary(record.thread, 'thread/start response thread');
  return { ...record, thread } as CodexAppServerThreadStartResponse;
}

function expectTurnStartResponse(value: unknown): CodexAppServerTurnStartResponse {
  const record = expectRecord(value, 'turn/start response');
  return {
    turn: expectTurnSummary(record.turn, 'turn/start response turn'),
  };
}

function parseAssistantDelta(value: unknown): CodexAppServerAssistantDeltaEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.threadId !== 'string' || typeof value.turnId !== 'string') return undefined;
  if (typeof value.itemId !== 'string' || typeof value.delta !== 'string') return undefined;
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    delta: value.delta,
  };
}

function parseTurnCompleted(value: unknown): CodexAppServerTurnCompletedEvent | undefined {
  if (!isRecord(value) || typeof value.threadId !== 'string') return undefined;
  const turn = parseTurnSummary(value.turn);
  if (turn === undefined) return undefined;
  return { threadId: value.threadId, turn };
}

function expectThreadSummary(value: unknown, label: string): CodexAppServerThreadSummary {
  const record = expectRecord(value, label);
  return { ...record, id: expectString(record.id, `${label} id`) } as CodexAppServerThreadSummary;
}

function expectTurnSummary(value: unknown, label: string): CodexAppServerTurnSummary {
  const turn = parseTurnSummary(value);
  if (turn === undefined) throw new Error(`Invalid Codex App Server ${label}`);
  return turn;
}

function parseTurnSummary(value: unknown): CodexAppServerTurnSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  return { ...value, id: value.id } as CodexAppServerTurnSummary;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid Codex App Server ${label}`);
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid Codex App Server ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
