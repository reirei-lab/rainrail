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
  codexHome?: string;
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
  text_elements?: unknown[];
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
  threadId?: string;
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
const maxCompletedTurnCacheEntries = 32;

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
  #completedTurns = new Map<string, CodexAppServerTurnCompletedEvent>();

  constructor(options: CodexAppServerProtocolClientOptions) {
    this.#client = createCodexAppServerClient(options);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.#client.onNotification((frame) => this.#handleNotification(frame));
    this.#client.onClose(() => this.#rejectPendingTurnCompletions(new Error('Codex App Server transport closed')));
  }

  connect(): Promise<void> {
    return this.#client.connect();
  }

  close(): Promise<void> {
    return this.#client.close();
  }

  async initialize(params: CodexAppServerInitializeParams): Promise<CodexAppServerInitializeResponse> {
    const response = expectInitializeResponse(await this.#requestWithTimeout('initialize', params));
    await this.#client.notify('initialized');
    return response;
  }

  async startThread(params: CodexAppServerThreadStartParams = {}): Promise<CodexAppServerThreadStartResponse> {
    return expectThreadStartResponse(await this.#requestWithTimeout('thread/start', params));
  }

  async startTurn(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResponse> {
    return expectTurnStartResponse(await this.#requestWithTimeout('turn/start', params));
  }

  waitForTurnCompleted(target: CodexAppServerTurnWaitTarget): Promise<CodexAppServerTurnCompletedEvent> {
    const cached = this.#completedTurns.get(target.turnId);
    if (cached !== undefined && eventMatchesTurnWaitTarget(cached, target)) {
      return Promise.resolve(cached);
    }
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
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Codex App Server ${method} timed out`));
    }, this.#requestTimeoutMs);
    return this.#client.request(method, params, { signal: controller.signal }).finally(() => {
      clearTimeout(timer);
    });
  }

  #handleNotification(frame: CodexAppServerNotificationFrame): void {
    if (frame.method === 'item/agentMessage/delta') {
      const event = parseAssistantDelta(frame.params);
      if (event === undefined) return;
      for (const handler of this.#assistantDeltaHandlers) {
        try {
          handler(event);
        } catch {
          // Observer callbacks must not break turn lifecycle waiters.
        }
      }
      return;
    }
    if (frame.method !== 'turn/completed') return;
    const event = parseTurnCompleted(frame.params);
    if (event === undefined) return;
    this.#cacheCompletedTurn(event);
    for (const pending of [...this.#pendingTurnCompletions]) {
      if (!eventMatchesTurnWaitTarget(event, pending)) continue;
      this.#removePendingTurnCompletion(pending);
      pending.resolve(event);
    }
    for (const handler of this.#turnCompletedHandlers) {
      try {
        handler(event);
      } catch {
        // Observer callbacks must not break turn lifecycle waiters.
      }
    }
  }

  #cacheCompletedTurn(event: CodexAppServerTurnCompletedEvent): void {
    this.#completedTurns.delete(event.turn.id);
    this.#completedTurns.set(event.turn.id, event);
    while (this.#completedTurns.size > maxCompletedTurnCacheEntries) {
      const oldestKey = this.#completedTurns.keys().next().value;
      if (typeof oldestKey !== 'string') return;
      this.#completedTurns.delete(oldestKey);
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

function expectInitializeResponse(value: unknown): CodexAppServerInitializeResponse {
  const record = expectRecord(value, 'initialize response');
  const response: CodexAppServerInitializeResponse = {
    userAgent: expectString(record.userAgent, 'initialize response userAgent'),
    platformFamily: expectString(record.platformFamily, 'initialize response platformFamily'),
    platformOs: expectString(record.platformOs, 'initialize response platformOs'),
  };
  if (record.codexHome !== undefined) {
    response.codexHome = expectString(record.codexHome, 'initialize response codexHome');
  }
  return response;
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
  if (!isRecord(value)) return undefined;
  const turn = parseTurnSummary(value.turn);
  if (turn === undefined) return undefined;
  if (typeof value.threadId === 'string') {
    return { threadId: value.threadId, turn };
  }
  return { turn };
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

function eventMatchesTurnWaitTarget(
  event: CodexAppServerTurnCompletedEvent,
  target: Pick<CodexAppServerTurnWaitTarget, 'threadId' | 'turnId'>,
): boolean {
  if (event.turn.id !== target.turnId) return false;
  return event.threadId === undefined || event.threadId === target.threadId;
}
