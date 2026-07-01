import { createHash } from 'node:crypto';

import type { RainrailEventEnvelope } from './events.js';
import type { RainrailBridgeRoomStorage } from './bridge-room.js';
import type { TaskProvider } from './task-provider.js';
import type { WorkflowPlugin } from './workflow-plugin.js';
import { defineWorkflowPlugin } from './workflow-plugin.js';

export interface CloudflareIssueReporterWorkflowOptions {
  repository: string;
  labels?: string[];
  store: CloudflareErrorIssueStore;
  issues: GitHubIssueClient;
}

export interface StoredCloudflareErrorIssue {
  fingerprint: string;
  eventId: string;
  deliveryId: string;
  repository: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  createdAt: string;
}

export interface CloudflareErrorIssueStore {
  get(input: { repository: string; fingerprint: string }): StoredCloudflareErrorIssue | undefined | Promise<StoredCloudflareErrorIssue | undefined>;
  record(input: Omit<StoredCloudflareErrorIssue, 'createdAt'> & { createdAt?: string }): StoredCloudflareErrorIssue | Promise<StoredCloudflareErrorIssue>;
  withFingerprintLock?<T>(input: { repository: string; fingerprint: string }, fn: () => Promise<T>): Promise<T>;
}

export interface CloudflareIssueReporterStorage extends RainrailBridgeRoomStorage {
  compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>;
}

export interface GitHubIssueClient {
  findOpenIssueByFingerprint(input: {
    repository: string;
    fingerprint: string;
  }): Promise<GitHubIssue | undefined>;
  createIssue(input: {
    repository: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue>;
}

export interface GitHubIssue {
  number: number;
  url: string;
}

export interface CloudflareIssueReporterResult {
  handled: boolean;
  reason:
    | 'created_cloudflare_error_issue'
    | 'cloudflare_error_issue_exists_in_store'
    | 'cloudflare_error_issue_exists_on_github'
    | 'event_is_not_cloudflare_error_with_stack';
  fingerprint?: string;
  issue?: GitHubIssue & {
    created: boolean;
    title: string;
    repository: string;
  };
}

export interface CloudflareErrorCandidate {
  scriptName: string;
  eventName: string;
  exceptionName: string;
  exceptionMessage: string;
  normalizedExceptionMessage: string;
  stackSignature: string[];
  requestMethod?: string;
  requestPath?: string;
  responseStatus?: number;
  rawData: unknown;
}

const fingerprintMarkerPrefix = '<!-- error-fingerprint: ';
const maxRawJsonLength = 50_000;
const maxRawArrayItems = 50;
const maxRawDepth = 8;
const maxRawObjectKeys = 50;
const maxRawStringLength = 2_000;
const maxStackLocationLength = 500;
const maxSummaryExceptionNameLength = 200;
const maxSummaryExceptionMessageLength = 1_000;
const storageKeyPrefix = 'rainrail:cloudflare-error-issue:';
const storeHitGraceMs = 5 * 60 * 1000;
const fingerprintLocks = new Map<string, Promise<void>>();

export function createCloudflareIssueReporterWorkflow(
  options: CloudflareIssueReporterWorkflowOptions,
): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'cloudflare-issue-reporter',
    accepts: (event) => event.name === 'cloudflare.error',
    async handle(event): Promise<CloudflareIssueReporterResult> {
      return handleCloudflareIssueReporterEvent(options, event);
    },
  });
}

export async function handleCloudflareIssueReporterEvent(
  options: CloudflareIssueReporterWorkflowOptions,
  event: RainrailEventEnvelope,
): Promise<CloudflareIssueReporterResult> {
  const candidate = cloudflareErrorCandidateFromEvent(event);
  if (candidate === undefined) {
    return { handled: false, reason: 'event_is_not_cloudflare_error_with_stack' };
  }

  const fingerprint = cloudflareErrorFingerprint(candidate);

  return withFingerprintLock(options.store, { repository: options.repository, fingerprint }, async () =>
    handleCloudflareIssueReporterCandidate(options, event, candidate, fingerprint)
  );
}

async function handleCloudflareIssueReporterCandidate(
  options: CloudflareIssueReporterWorkflowOptions,
  event: RainrailEventEnvelope,
  candidate: CloudflareErrorCandidate,
  fingerprint: string,
): Promise<CloudflareIssueReporterResult> {
  const stored = await options.store.get({ repository: options.repository, fingerprint });
  const title = cloudflareIssueTitle(candidate);
  if (stored !== undefined && isRecentStoreHit(stored)) {
    return {
      handled: false,
      reason: 'cloudflare_error_issue_exists_in_store',
      fingerprint,
      issue: {
        number: stored.issueNumber,
        url: stored.issueUrl,
        title: stored.title,
        repository: stored.repository,
        created: false,
      },
    };
  }

  const existing = await options.issues.findOpenIssueByFingerprint({
    repository: options.repository,
    fingerprint,
  });
  if (stored !== undefined && existing !== undefined) {
    return {
      handled: false,
      reason: 'cloudflare_error_issue_exists_in_store',
      fingerprint,
      issue: {
        number: existing.number,
        url: existing.url,
        title: stored.title,
        repository: stored.repository,
        created: false,
      },
    };
  }

  if (existing !== undefined) {
    await options.store.record({
      fingerprint,
      eventId: event.id,
      deliveryId: event.delivery.id,
      repository: options.repository,
      issueNumber: existing.number,
      issueUrl: existing.url,
      title,
    });
    return {
      handled: false,
      reason: 'cloudflare_error_issue_exists_on_github',
      fingerprint,
      issue: {
        ...existing,
        title,
        repository: options.repository,
        created: false,
      },
    };
  }

  const issue = await options.issues.createIssue({
    repository: options.repository,
    title,
    labels: options.labels ?? [],
    body: cloudflareIssueBody({ candidate, event, fingerprint }),
  });
  await options.store.record({
    fingerprint,
    eventId: event.id,
    deliveryId: event.delivery.id,
    repository: options.repository,
    issueNumber: issue.number,
    issueUrl: issue.url,
    title,
  });

  return {
    handled: true,
    reason: 'created_cloudflare_error_issue',
    fingerprint,
    issue: {
      ...issue,
      title,
      repository: options.repository,
      created: true,
    },
  };
}

export function createTaskProviderGitHubIssueClient(provider: TaskProvider): GitHubIssueClient {
  return {
    async findOpenIssueByFingerprint(input) {
      if (provider.searchIssues === undefined) {
        throw new Error('GitHub issue fingerprint search requires provider.searchIssues');
      }
      const issues = await provider.searchIssues({
        provider: 'github',
        repository: input.repository,
        state: 'open',
        query: `in:body "${fingerprintMarkerPrefix}${input.fingerprint}"`,
      });
      const issue = issues[0];
      if (issue === undefined || issue.number === undefined || issue.url === undefined) {
        return undefined;
      }
      return { number: issue.number, url: issue.url };
    },
    async createIssue(input) {
      if (provider.createIssue === undefined) {
        throw new Error('GitHub issue creation requires provider.createIssue');
      }
      const issue = await provider.createIssue({
        provider: 'github',
        repository: input.repository,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
      if (issue.number === undefined || issue.url === undefined) {
        throw new Error('created GitHub issue is missing number or url');
      }
      return { number: issue.number, url: issue.url };
    },
  };
}

export function createInMemoryCloudflareErrorIssueStore(): CloudflareErrorIssueStore {
  const issues = new Map<string, StoredCloudflareErrorIssue>();
  return {
    get: (input) => issues.get(storageKey(input.repository, input.fingerprint)),
    record(input) {
      const stored = {
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      issues.set(storageKey(input.repository, input.fingerprint), stored);
      return stored;
    },
    withFingerprintLock: (input, fn) => withLocalFingerprintLock(storageKey(input.repository, input.fingerprint), fn),
  };
}

export function createStorageCloudflareErrorIssueStore(storage: CloudflareIssueReporterStorage): CloudflareErrorIssueStore {
  assertCloudflareIssueReporterStorage(storage);
  return {
    async get(input) {
      return storedCloudflareErrorIssue(await storage.get(storageKey(input.repository, input.fingerprint)));
    },
    async record(input) {
      const stored = {
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      await storage.put(storageKey(input.repository, input.fingerprint), stored);
      return stored;
    },
    withFingerprintLock: (input, fn) => withStorageFingerprintLock(storage, input, fn),
  };
}

export function cloudflareErrorFingerprint(candidate: CloudflareErrorCandidate): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    scriptName: candidate.scriptName,
    eventName: candidate.eventName,
    stackSignature: candidate.stackSignature,
  })).digest('hex')}`;
}

export function cloudflareErrorCandidateFromEvent(event: RainrailEventEnvelope): CloudflareErrorCandidate | undefined {
  if (event.source.type !== 'cloudflare' || event.name !== 'cloudflare.error') {
    return undefined;
  }

  const data = recordValue(event.payload);
  const exceptionWithStack = cloudflareExceptionWithUsableStack(data.exceptions);
  if (exceptionWithStack === undefined) {
    return undefined;
  }
  const { exception, stackSignature } = exceptionWithStack;

  const request = recordValue(recordValue(data.event).request);
  const response = recordValue(recordValue(data.event).response);
  const url = stringValue(request.url) ?? stringValue(data.url);
  const requestMethod = stringValue(request.method) ?? stringValue(data.method);
  const requestPath = url === undefined ? undefined : safePathname(url);
  const responseStatus = numberValue(response.status) ?? statusNumber(data.status);

  return {
    scriptName: stringValue(data.scriptName) ?? event.subject.id ?? 'unknown-worker',
    eventName: event.name,
    exceptionName: stringValue(exception.name) ?? 'Error',
    exceptionMessage: stringValue(exception.message) ?? '',
    normalizedExceptionMessage: normalizeExceptionMessage(stringValue(exception.message) ?? ''),
    stackSignature,
    ...(requestMethod === undefined ? {} : { requestMethod }),
    ...(requestPath === undefined ? {} : { requestPath }),
    ...(responseStatus === undefined ? {} : { responseStatus }),
    rawData: event.payload,
  };
}

function cloudflareIssueTitle(candidate: CloudflareErrorCandidate): string {
  const location = sanitizeSecretString(candidate.stackSignature[0]?.split(' @ ')[0] ?? candidate.requestPath ?? '');
  const exceptionName = sanitizeSecretString(candidate.exceptionName);
  const scriptName = sanitizedWorkerName(candidate.scriptName);
  return [
    `[${scriptName}]`,
    exceptionName || 'Error',
    location.length === 0 ? undefined : `in ${location}`,
  ].filter((part): part is string => part !== undefined && part.length > 0).join(' ').slice(0, 180);
}

function cloudflareIssueBody(input: {
  candidate: CloudflareErrorCandidate;
  event: RainrailEventEnvelope;
  fingerprint: string;
}): string {
  const rawJson = truncate(JSON.stringify(redactRawEventData(input.candidate.rawData), null, 2), maxRawJsonLength);
  const exceptionName = truncateSummaryText(
    sanitizeSecretString(input.candidate.exceptionName),
    maxSummaryExceptionNameLength,
  );
  const exceptionMessage = truncateSummaryText(
    sanitizeSecretString(input.candidate.exceptionMessage),
    maxSummaryExceptionMessageLength,
  );
  const stackSignature = input.candidate.stackSignature.map(sanitizeSecretString);
  return [
    'Rainrail detected a new Cloudflare Worker server error.',
    '',
    '## Summary',
    '',
    '- Service: cloudflare',
    `- Worker: ${sanitizedWorkerName(input.candidate.scriptName)}`,
    `- Event: ${input.event.name}`,
    `- Exception: ${exceptionName || 'Error'}`,
    `- Message: ${exceptionMessage || '(empty)'}`,
    `- Request: ${[input.candidate.requestMethod, input.candidate.requestPath].filter(Boolean).join(' ') || '(unknown)'}`,
    `- Status: ${input.candidate.responseStatus ?? '(unknown)'}`,
    `- Delivery: ${input.event.delivery.id}`,
    `- First seen: ${input.event.delivery.receivedAt}`,
    `- Fingerprint: ${input.fingerprint}`,
    '',
    '## Stack Signature',
    '',
    '```text',
    stackSignature.join('\n'),
    '```',
    '',
    '## Raw Event Data',
    '',
    '```json',
    rawJson,
    '```',
    '',
    `${fingerprintMarkerPrefix}${input.fingerprint} -->`,
  ].join('\n');
}

function sanitizedWorkerName(value: string): string {
  const sanitized = sanitizeSecretString(value).replace(/\s+/gu, ' ').trim();
  return truncateSummaryText(sanitized, maxSummaryExceptionNameLength) || 'unknown-worker';
}

function cloudflareExceptionWithUsableStack(value: unknown): {
  exception: Record<string, unknown>;
  stackSignature: string[];
} | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const candidate of value) {
    const exception = recordOrUndefined(candidate);
    if (exception === undefined) {
      continue;
    }
    const stack = stringValue(exception?.stack);
    if (stack === undefined || stack.trim().length === 0) {
      continue;
    }
    const stackSignature = normalizedStackSignature(stack);
    if (stackSignature.length > 0) {
      return { exception, stackSignature };
    }
  }
  return undefined;
}

function normalizedStackSignature(stack: string): string[] {
  const frames: string[] = [];
  let start = 0;
  while (start <= stack.length && frames.length < 3) {
    const newline = stack.indexOf('\n', start);
    const end = newline === -1 ? stack.length : newline;
    const rawLine = stack.slice(start, end).replace(/\r$/u, '');
    const frame = normalizeStackFrame(rawLine);
    if (frame !== undefined) {
      frames.push(frame);
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return frames;
}

function normalizeStackFrame(line: string): string | undefined {
  const raw = line.trim();
  if (!/^at\s+/u.test(raw)) {
    return undefined;
  }
  const trimmed = raw.replace(/^at\s+/u, '');
  if (trimmed.length === 0) {
    return undefined;
  }

  const callMatch = trimmed.match(/^(?<fn>.*?)\s+\((?<location>.*)\)$/u);
  const functionName = normalizeFunctionName(callMatch?.groups?.fn);
  const location = normalizeStackLocation(callMatch?.groups?.location ?? trimmed);
  if (functionName === undefined && location === undefined) return undefined;
  if (functionName === undefined) return location;
  if (location === undefined) return functionName;
  return `${functionName} @ ${location}`;
}

function normalizeFunctionName(value: string | undefined): string | undefined {
  const normalized = sanitizeSecretString(value?.trim() ?? '');
  if (normalized.length === 0) return undefined;
  if (normalized.includes('[redacted]')) return normalized;
  return normalized.replace(/([._][A-Za-z_$][\w$]*?)[_-][A-Za-z0-9][A-Za-z0-9_-]{2,}/gu, '$1_:value');
}

function normalizeStackLocation(value: string): string | undefined {
  const withoutQuery = value.trim().split('?')[0] ?? '';
  const withoutLineColumn = withoutQuery
    .replace(/:\d+:\d+\)?$/u, '')
    .replace(/:\d+\)?$/u, '')
    .replace(/^\(?/u, '');
  return withoutLineColumn.length === 0
    ? undefined
    : truncateSummaryText(sanitizeSecretString(withoutLineColumn), maxStackLocationLength);
}

function normalizeExceptionMessage(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, ':id')
    .replace(/\b[0-9a-f]{24}\b/giu, ':id')
    .replace(/\b\d+\b/gu, ':number')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function withFingerprintLock<T>(
  store: CloudflareErrorIssueStore,
  input: { repository: string; fingerprint: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (store.withFingerprintLock !== undefined) {
    return store.withFingerprintLock(input, fn);
  }
  return withLocalFingerprintLock(storageKey(input.repository, input.fingerprint), fn);
}

async function withLocalFingerprintLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = fingerprintLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  fingerprintLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fingerprintLocks.get(key) === current) {
      fingerprintLocks.delete(key);
    }
  }
}

async function withStorageFingerprintLock<T>(
  storage: CloudflareIssueReporterStorage,
  input: { repository: string; fingerprint: string },
  fn: () => Promise<T>,
): Promise<T> {
  return withLocalFingerprintLock(storageKey(input.repository, input.fingerprint), async () => {
    const key = `${storageKeyPrefix}lock:${input.repository}:${input.fingerprint}`;
    const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const value = { owner, expiresAt: Date.now() + storeHitGraceMs };
    const current = await storage.get(key);
    if (storageLockRecord(current) !== undefined) {
      throw new Error('Cloudflare error fingerprint is already locked');
    }
    if (!await storage.compareAndSet(key, current, value)) {
      throw new Error('Cloudflare error fingerprint is already locked');
    }
    const lock = storageLockRecord(await storage.get(key));
    if (lock?.owner !== owner) {
      throw new Error('Cloudflare error fingerprint is already locked');
    }
    try {
      return await fn();
  } finally {
      const currentValue = await storage.get(key);
      const current = storageLockRecord(currentValue);
      if (current?.owner === owner) {
        await storage.compareAndSet(key, currentValue, { owner, expiresAt: 0 });
      }
    }
  });
}

function storageLockRecord(value: unknown): { owner: string; expiresAt: number } | undefined {
  if (!isRecord(value) || typeof value.owner !== 'string' || typeof value.expiresAt !== 'number') {
    return undefined;
  }
  return value.expiresAt <= Date.now() ? undefined : { owner: value.owner, expiresAt: value.expiresAt };
}

function assertCloudflareIssueReporterStorage(
  storage: RainrailBridgeRoomStorage,
): asserts storage is CloudflareIssueReporterStorage {
  if (typeof storage.compareAndSet !== 'function') {
    throw new TypeError('Cloudflare issue reporter storage requires compareAndSet');
  }
}

function isRecentStoreHit(stored: StoredCloudflareErrorIssue): boolean {
  const createdAt = Date.parse(stored.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt < storeHitGraceMs;
}

function safePathname(url: string): string | undefined {
  try {
    return sanitizePathname(new URL(url).pathname || '/');
  } catch {
    return undefined;
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return sanitizeSecretString(value);
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[redacted]';
    } else if (isUrlKey(key) && typeof nestedValue === 'string') {
      redacted[key] = sanitizeUrlString(nestedValue);
    } else {
      redacted[key] = redact(nestedValue);
    }
  }
  return redacted;
}

function redactRawEventData(value: unknown, depth = 0): unknown {
  if (depth >= maxRawDepth) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxRawArrayItems).map((item) => redactRawEventData(item, depth + 1));
    return value.length > maxRawArrayItems ? [...items, '[... truncated ...]'] : items;
  }
  if (typeof value === 'string') {
    const redacted = sanitizeSecretString(value);
    return redacted.length > maxRawStringLength
      ? `${redacted.slice(0, maxRawStringLength)}\n... truncated ...`
      : redacted;
  }
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, maxRawObjectKeys);
  for (const [key, nestedValue] of entries) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[redacted]';
    } else if (isUrlKey(key) && typeof nestedValue === 'string') {
      redacted[key] = sanitizeUrlString(nestedValue);
    } else {
      redacted[key] = redactRawEventData(nestedValue, depth + 1);
    }
  }
  if (Object.keys(value).length > maxRawObjectKeys) {
    redacted.__truncated = '[... truncated ...]';
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|token|secret|password|key|code|reset|verification/iu.test(key);
}

function isUrlKey(key: string): boolean {
  return /url|uri|href/iu.test(key);
}

function sanitizeSecretString(value: string): string {
  return redactSecretStructuredValues(value)
    .replace(/https?:\/\/[^\s"'<>`]+/giu, (url) => sanitizeUrlString(url))
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/giu, '$1: [redacted]')
    .replace(/\bauthorization\s*:\s*[^\r\n]+/giu, 'authorization: [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*\5/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*$/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*$/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\2(\s*:\s*)(?!["'])([^,\s\r\n}\]]+)/giu, '$1$2$3$2$4[redacted]')
    .replace(/(^|[.?&\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\2=(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;])([A-Za-z0-9_.-]*authorization[A-Za-z0-9_.-]*)=([^\r\n"'<>`,;]*?)(?=(?:\s+[A-Za-z0-9_.-]*(?:authorization|cookie|set-cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*=)|[&\r\n"'<>`,;]|$)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;])([A-Za-z0-9_.-]*(?:cookie|set-cookie)[A-Za-z0-9_.-]*)=([^;\s\r\n"'<>`,]*(?:;\s*[^=;\s\r\n"'<>`,]+=[^;\s\r\n"'<>`,]*)*)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;])([A-Za-z0-9_.-]*(?:token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)=([^&\s"'<>`,;]+)/giu, '$1$2=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
}

function redactSecretStructuredValues(value: string): string {
  const keyPattern = /(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification)[A-Za-z0-9_.-]*)\2(\s*[:=]\s*)([\[{])/giu;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchText = match[0];
    const matchIndex = match.index;
    if (matchIndex < cursor) continue;
    const valueStart = matchIndex + matchText.length - 1;
    const valueEnd = findBalancedStructuredValueEnd(value, valueStart);
    redacted += value.slice(cursor, matchIndex);
    redacted += `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}${match[2] ?? ''}${match[4] ?? ''}[redacted]`;
    cursor = valueEnd === undefined ? value.length : valueEnd + 1;
  }
  return redacted + value.slice(cursor);
}

function findBalancedStructuredValueEnd(value: string, valueStart: number): number | undefined {
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = valueStart; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '{') {
      stack.push('}');
    } else if (char === ']') {
      if (stack.at(-1) !== ']') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    } else if (char === '}') {
      if (stack.at(-1) !== '}') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

function sanitizeUrlString(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.pathname = sanitizePathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

function sanitizePathname(pathname: string): string {
  const segments = pathname.split('/');
  return segments.map((segment, index) => {
    if (segment.length === 0) return segment;
    const previous = segments[index - 1]?.toLowerCase() ?? '';
    return isSecretPathSegment(segment, previous) ? '[redacted]' : segment;
  }).join('/') || '/';
}

function isSecretPathSegment(segment: string, previousSegment: string): boolean {
  if (/^(token|secret|password|code|reset|magic-link|invite|session|auth|verify|verification)$/iu.test(previousSegment)) {
    return true;
  }
  if (/^(token|secret|password|code|reset)$/iu.test(segment)) {
    return true;
  }
  return /^[A-Za-z0-9_-]{16,}$/u.test(segment) && /[A-Za-z]/u.test(segment) && /\d/u.test(segment);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}

function truncateSummaryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)} ... truncated ...`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function statusNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{3}$/u.test(value)) return undefined;
  return Number(value);
}

function storageKey(repository: string, fingerprint: string): string {
  return `${storageKeyPrefix}${repository}:${fingerprint}`;
}

function storedCloudflareErrorIssue(value: unknown): StoredCloudflareErrorIssue | undefined {
  if (!isRecord(value)) return undefined;
  const fingerprint = stringValue(value.fingerprint);
  const eventId = stringValue(value.eventId);
  const deliveryId = stringValue(value.deliveryId);
  const repository = stringValue(value.repository);
  const issueNumber = numberValue(value.issueNumber);
  const issueUrl = stringValue(value.issueUrl);
  const title = stringValue(value.title);
  const createdAt = stringValue(value.createdAt);
  if (
    fingerprint === undefined
    || eventId === undefined
    || deliveryId === undefined
    || repository === undefined
    || issueNumber === undefined
    || issueUrl === undefined
    || title === undefined
    || createdAt === undefined
  ) {
    return undefined;
  }
  return { fingerprint, eventId, deliveryId, repository, issueNumber, issueUrl, title, createdAt };
}
