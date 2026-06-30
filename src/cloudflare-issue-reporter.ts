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

  return withFingerprintLock(fingerprint, async () => handleCloudflareIssueReporterCandidate(options, event, candidate, fingerprint));
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
  };
}

export function createStorageCloudflareErrorIssueStore(storage: RainrailBridgeRoomStorage): CloudflareErrorIssueStore {
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
  };
}

export function cloudflareErrorFingerprint(candidate: CloudflareErrorCandidate): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    scriptName: candidate.scriptName,
    eventName: candidate.eventName,
    exceptionName: candidate.exceptionName,
    stackSignature: candidate.stackSignature,
  })).digest('hex')}`;
}

export function cloudflareErrorCandidateFromEvent(event: RainrailEventEnvelope): CloudflareErrorCandidate | undefined {
  if (event.source.type !== 'cloudflare' || event.name !== 'cloudflare.error') {
    return undefined;
  }

  const data = recordValue(event.payload);
  const exception = Array.isArray(data.exceptions)
    ? data.exceptions.map(recordOrUndefined).find((candidate) => {
      const stack = stringValue(candidate?.stack);
      return stack !== undefined && stack.trim().length > 0;
    })
    : undefined;
  const stack = stringValue(exception?.stack);
  if (exception === undefined || stack === undefined || stack.trim().length === 0) {
    return undefined;
  }

  const stackSignature = normalizedStackSignature(stack);
  if (stackSignature.length === 0) {
    return undefined;
  }

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
  const location = candidate.stackSignature[0]?.split(' @ ')[0] ?? candidate.requestPath;
  const exceptionName = sanitizeSecretString(candidate.exceptionName);
  return [
    `[${candidate.scriptName}]`,
    exceptionName || 'Error',
    location === undefined ? undefined : `in ${location}`,
  ].filter((part): part is string => part !== undefined && part.length > 0).join(' ').slice(0, 180);
}

function cloudflareIssueBody(input: {
  candidate: CloudflareErrorCandidate;
  event: RainrailEventEnvelope;
  fingerprint: string;
}): string {
  const rawJson = truncate(JSON.stringify(redact(input.candidate.rawData), null, 2), maxRawJsonLength);
  const exceptionName = sanitizeSecretString(input.candidate.exceptionName);
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
    `- Worker: ${input.candidate.scriptName}`,
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

function normalizedStackSignature(stack: string): string[] {
  return stack
    .split(/\r?\n/u)
    .map((line) => normalizeStackFrame(line))
    .filter((line): line is string => line !== undefined)
    .slice(0, 3);
}

function normalizeStackFrame(line: string): string | undefined {
  const trimmed = line.trim().replace(/^at\s+/u, '');
  if (trimmed.length === 0 || /^[A-Za-z]+Error[:\s]/u.test(trimmed)) {
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
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function normalizeStackLocation(value: string): string | undefined {
  const withoutQuery = value.trim().split('?')[0] ?? '';
  const withoutLineColumn = withoutQuery
    .replace(/:\d+:\d+\)?$/u, '')
    .replace(/:\d+\)?$/u, '')
    .replace(/^\(?/u, '');
  return withoutLineColumn.length === 0 ? undefined : sanitizeSecretString(withoutLineColumn);
}

function normalizeExceptionMessage(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, ':id')
    .replace(/\b[0-9a-f]{24}\b/giu, ':id')
    .replace(/\b\d+\b/gu, ':number')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function withFingerprintLock<T>(fingerprint: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = fingerprintLocks.get(fingerprint) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  fingerprintLocks.set(fingerprint, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fingerprintLocks.get(fingerprint) === current) {
      fingerprintLocks.delete(fingerprint);
    }
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

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|token|secret|password|key/iu.test(key);
}

function isUrlKey(key: string): boolean {
  return /url|uri|href/iu.test(key);
}

function sanitizeSecretString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>`]+/giu, (url) => sanitizeUrlString(url))
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/giu, '$1: [redacted]')
    .replace(/\bauthorization\s*:\s*[^\r\n]+/giu, 'authorization: [redacted]')
    .replace(/(["'])([A-Za-z0-9_-]*(?:authorization|cookie|token|secret|password|key|code|reset))\1(\s*:\s*)(["'])[^"']*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[?&\s"'<>`,;])([A-Za-z0-9_-]*(?:token|secret|password|code|reset))=([^&\s"'<>`,;]+)/giu, '$1$2=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
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
