import { createEventEnvelope, type RainrailEventEnvelope } from './events.js';
import { defineSourcePlugin, type SourcePlugin, type SourcePluginNormalizeContext } from './source-plugin.js';

const FAILURE_OUTCOMES = new Set([
  'exception',
  'exceededCpu',
  'exceededMemory',
  'scriptNotFound',
  'canceled',
  'responseStreamDisconnected',
]);
const MAX_EXCEPTION_NAME_LENGTH = 200;
const MAX_EXCEPTION_MESSAGE_LENGTH = 512;
const MAX_EXCEPTION_STACK_LENGTH = 1_200;
const MAX_EXCEPTION_STACK_LINES = 8;

export interface CloudflareTailEvent {
  eventTimestamp?: number | string;
  outcome?: unknown;
  scriptName?: unknown;
  scriptVersion?: { id?: unknown } | null;
  exceptions?: unknown[];
  event?: {
    request?: {
      method?: unknown;
      url?: unknown;
      headers?: Record<string, unknown> | null;
    } | null;
    response?: {
      status?: unknown;
    } | null;
  } | null;
}

export interface CloudflareTailException {
  name?: string;
  message?: string;
  stack?: string;
  timestamp?: string;
}

export interface CloudflareTailPayload {
  action: string;
  status: string | null;
  conclusion: 'success' | 'failure' | 'neutral';
  scriptName: string | null;
  scriptVersion: string | null;
  method: string | null;
  url: string | null;
  cfRay: string | null;
  exceptions: CloudflareTailException[];
}

export interface CreateCloudflareTailEventInput {
  tailEvent: CloudflareTailEvent;
  receivedAt?: Date;
  sourceName?: string;
  account?: string;
  environment?: string;
  fallbackDeliveryId?: string;
}

export type CloudflareTailRainrailEvent = RainrailEventEnvelope<
  CloudflareTailPayload,
  'cloudflare.tail' | 'cloudflare.error'
>;

export interface PublishCloudflareTailEventsOptions extends Omit<CreateCloudflareTailEventInput, 'tailEvent'> {
  publish(event: CloudflareTailRainrailEvent): Response | Promise<Response>;
}

export type PublishCloudflareTailEventResult =
  | { ok: true; id: string }
  | { ok: false; id: string; status: number };

export function createCloudflareTailSourcePlugin(name = 'cloudflare-tail'): SourcePlugin<CloudflareTailEvent> {
  return defineSourcePlugin({
    name,
    sourceType: 'cloudflare',
    normalize(input, context) {
      return createCloudflareTailEvent({
        tailEvent: input,
        sourceName: name,
        receivedAt: new Date(context.receivedAt),
        fallbackDeliveryId: context.deliveryId,
        ...metadataFromContext(context),
      });
    },
  });
}

export async function createCloudflareTailEvent({
  tailEvent,
  receivedAt = new Date(),
  sourceName = 'cloudflare-tail',
  account,
  environment,
  fallbackDeliveryId,
}: CreateCloudflareTailEventInput): Promise<CloudflareTailRainrailEvent> {
  const occurredAt = normalizeTimestamp(tailEvent.eventTimestamp, receivedAt);
  const request = tailEvent.event?.request ?? {};
  const response = tailEvent.event?.response ?? {};
  const cfRay = optionalString(findHeader(request.headers, 'cf-ray'));
  const rawScriptName = optionalString(tailEvent.scriptName);
  const scriptName = rawScriptName === null ? null : sanitizeTailWorkerName(rawScriptName);
  const scriptVersion = optionalString(tailEvent.scriptVersion?.id);
  const method = optionalString(request.method);
  const rawUrl = optionalString(request.url);
  const url = rawUrl === null ? null : sanitizeTailUrl(rawUrl);
  const status = optionalStatus(response.status);
  const exceptions = normalizeExceptions(tailEvent.exceptions);
  const action = normalizeAction(tailEvent.outcome, exceptions);
  const name = isCloudflareError(action, exceptions) ? 'cloudflare.error' : 'cloudflare.tail';
  const deliveryId = buildCloudflareTailDeliveryId({
    scriptName,
    occurredAt,
    suffix: cfRay ?? fallbackDeliveryId ?? randomDeliverySuffix(),
    maxLength: maxDeliveryIdLength(),
  });
  const id = buildCloudflareTailEventId(sourceName, deliveryId, name);

  return createEventEnvelope({
    ...(id === undefined ? {} : { id }),
    source: {
      type: 'cloudflare',
      name: sourceName,
      ...(account === undefined ? {} : { account }),
      ...(environment === undefined ? {} : { environment }),
    },
    name,
    delivery: {
      id: deliveryId,
      receivedAt: receivedAt.toISOString(),
    },
    occurredAt: occurredAt.toISOString(),
    subject: {
      type: 'worker',
      id: safeIdentifierSegment(scriptName ?? 'unknown-worker', 'unknown-worker', 128),
    },
    payload: {
      action,
      status,
      conclusion: inferConclusion(action, status, exceptions),
      scriptName,
      scriptVersion,
      method,
      url,
      cfRay,
      exceptions,
    },
    rawPayload: {
      kind: 'external-reference',
      reference: `cloudflare://deliveries/${deliveryId}`,
    },
  });
}

export async function publishCloudflareTailEvents(
  tailEvents: CloudflareTailEvent[],
  options: PublishCloudflareTailEventsOptions,
): Promise<PublishCloudflareTailEventResult[]> {
  const results: PublishCloudflareTailEventResult[] = [];

  for (const [index, tailEvent] of tailEvents.entries()) {
    const event = await createCloudflareTailEvent({
      tailEvent,
      ...(options.receivedAt === undefined ? {} : { receivedAt: options.receivedAt }),
      ...(options.sourceName === undefined ? {} : { sourceName: options.sourceName }),
      ...(options.account === undefined ? {} : { account: options.account }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fallbackDeliveryId === undefined ? {} : {
        fallbackDeliveryId: `${options.fallbackDeliveryId}-${index}`,
      }),
    });
    const response = await options.publish(event);

    results.push(response.ok
      ? { ok: true, id: event.id }
      : { ok: false, id: event.id, status: response.status });
  }

  return results;
}

function metadataFromContext(context: SourcePluginNormalizeContext): Pick<CreateCloudflareTailEventInput, 'account' | 'environment'> {
  return {
    ...(typeof context.metadata.account === 'string' ? { account: context.metadata.account } : {}),
    ...(typeof context.metadata.environment === 'string' ? { environment: context.metadata.environment } : {}),
  };
}

function normalizeTimestamp(value: unknown, fallback: Date): Date {
  if (typeof value === 'number') {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return fallback;
}

function buildCloudflareTailDeliveryId({
  scriptName,
  occurredAt,
  suffix,
  maxLength,
}: {
  scriptName: string | null;
  occurredAt: Date;
  suffix: string;
  maxLength: number;
}): string {
  const compactedTimestamp = compactTimestamp(occurredAt);
  const fixedLength = 'tail'.length + compactedTimestamp.length + 3;
  const remainingLength = Math.max(2, maxLength - fixedLength);
  const suffixLength = Math.min(32, Math.max(1, Math.floor(remainingLength / 2)));
  const scriptLength = Math.max(1, remainingLength - suffixLength);

  return [
    'tail',
    safeDeliveryReferenceSegment(scriptName ?? 'unknown-script', 'unknown-script', scriptLength),
    compactedTimestamp,
    safeDeliveryReferenceSegment(suffix, 'unknown-ray', suffixLength, { preserveEnd: true }),
  ].join('-');
}

function maxDeliveryIdLength(): number {
  return 95;
}

function buildCloudflareTailEventId(
  sourceName: string,
  deliveryId: string,
  name: CloudflareTailRainrailEvent['name'],
): string | undefined {
  const defaultId = `${sourceName}:${deliveryId}:${name}`;
  if (defaultId.length <= 128) return undefined;

  const fixedLength = 'cf'.length + name.length + 3;
  const remainingLength = 128 - fixedLength;
  const sourceLength = Math.max(1, Math.floor(remainingLength / 3));
  const deliveryLength = Math.max(1, remainingLength - sourceLength);

  return [
    'cf',
    safeIdentifierSegment(sourceName, 'source', sourceLength),
    safeIdentifierSegment(deliveryId, 'delivery', deliveryLength),
    name,
  ].join(':');
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function randomDeliverySuffix(): string {
  return globalThis.crypto.randomUUID();
}

function normalizeAction(outcome: unknown, exceptions: CloudflareTailException[]): string {
  if (exceptions.length > 0) return 'exception';

  return safeActionToken(optionalString(outcome) ?? 'invocation', 'unknown');
}

function isCloudflareError(action: string, exceptions: CloudflareTailException[]): boolean {
  return exceptions.length > 0 || FAILURE_OUTCOMES.has(action);
}

function inferConclusion(
  action: string,
  status: string | null,
  exceptions: CloudflareTailException[],
): CloudflareTailPayload['conclusion'] {
  if (isCloudflareError(action, exceptions)) return 'failure';

  const statusCode = status === null ? undefined : Number.parseInt(status, 10);
  if (statusCode !== undefined && statusCode >= 500) return 'failure';
  if (action === 'ok' || (statusCode !== undefined && statusCode < 500)) return 'success';
  return 'neutral';
}

function normalizeExceptions(value: unknown): CloudflareTailException[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((exception) => {
    if (typeof exception !== 'object' || exception === null || Array.isArray(exception)) return [];

    const record = exception as Record<string, unknown>;
    return [{
      ...optionalField(record, 'name'),
      ...optionalField(record, 'message'),
      ...optionalField(record, 'stack'),
      ...optionalTimestampField(record.timestamp),
    }];
  });
}

function optionalField(record: Record<string, unknown>, key: 'name' | 'message' | 'stack'): Record<typeof key, string> | {} {
  const value = optionalString(record[key]);
  if (value === null) return {};
  return { [key]: boundedExceptionField(key, sanitizeTailSecretString(value)) };
}

function boundedExceptionField(key: 'name' | 'message' | 'stack', value: string): string {
  if (key === 'name') return truncateText(value, MAX_EXCEPTION_NAME_LENGTH);
  if (key === 'message') return truncateText(value, MAX_EXCEPTION_MESSAGE_LENGTH);
  return truncateStackText(truncateStackLines(value, MAX_EXCEPTION_STACK_LINES), MAX_EXCEPTION_STACK_LENGTH);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}

function truncateLines(value: string, maxLines: number): string {
  const lines: string[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (lines.length >= maxLines) {
      return `${lines.join('\n')}\n... truncated ...`;
    }
    lines.push(line);
  }
  return value;
}

function truncateStackLines(value: string, maxLines: number): string {
  const fallbackLines: string[] = [];
  const keptLines: string[] = [];
  let frameSeen = false;
  let truncated = false;
  let cursor = 0;

  while (cursor <= value.length) {
    const nextLineBreak = value.indexOf('\n', cursor);
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
    const line = value.slice(cursor, lineEnd).replace(/\r$/u, '');

    if (fallbackLines.length < maxLines) {
      fallbackLines.push(line);
    } else {
      truncated = true;
    }

    if (isUsableStackFrameLine(line)) {
      frameSeen = true;
      if (keptLines.length < maxLines) {
        keptLines.push(line);
      } else {
        truncated = true;
      }
    } else if (!frameSeen) {
      if (keptLines.length < Math.min(2, maxLines)) {
        keptLines.push(truncateStackContextLine(line));
      } else {
        truncated = true;
      }
    } else if (keptLines.length < maxLines) {
      keptLines.push(line);
    } else {
      truncated = true;
    }

    if (nextLineBreak === -1) break;
    cursor = nextLineBreak + 1;
  }

  const lines = frameSeen ? keptLines : fallbackLines;
  if (!truncated) return value;
  return `${lines.join('\n')}\n... truncated ...`;
}

function isUsableStackFrameLine(line: string): boolean {
  return /^\s*at\s+\S+/u.test(line);
}

function truncateStackText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const lines = value.split('\n');
  const kept = lines
    .filter((line, index) => index < 2 || isUsableStackFrameLine(line) || line === '... truncated ...')
    .map((line) => isUsableStackFrameLine(line) || line === '... truncated ...' ? line : truncateStackContextLine(line));
  const output = kept.join('\n');
  if (output.length <= maxLength) return output.includes('... truncated ...') ? output : `${output}\n... truncated ...`;
  return `${output.slice(0, maxLength - '\n... truncated ...'.length)}\n... truncated ...`;
}

function truncateStackContextLine(line: string): string {
  const maxLength = 200;
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength)} ... truncated ...`;
}

function sanitizeTailUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.pathname = sanitizeTailPathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeTailPathname(pathname: string): string {
  const segments = pathname.split('/');
  return segments.map((segment, index) => {
    if (segment.length === 0) return segment;
    const previous = segments[index - 1]?.toLowerCase() ?? '';
    if (/^(token|secret|password|code|reset|magic-link|invite|session|auth|verify|verification)$/iu.test(previous)) {
      return '[redacted]';
    }
    if (/^(token|secret|password|code|reset)$/iu.test(segment)) {
      return '[redacted]';
    }
    return /^[A-Za-z0-9_-]{16,}$/u.test(segment) && /[A-Za-z]/u.test(segment) && /\d/u.test(segment)
      ? '[redacted]'
      : segment;
  }).join('/') || '/';
}

function sanitizeTailSecretString(value: string): string {
  return redactTailSecretStructuredValues(value)
    .replace(/<!--\s*error-fingerprint:[^>\r\n]*(?:-->)?/giu, '<!-- escaped-error-fingerprint: [redacted] -->')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`/@]*@[^\s"'<>`,;)]+/giu, (url) => sanitizeTailCredentialUrl(url))
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`,;)]+/giu, (url) => sanitizeTailCredentialUrl(url))
    .replace(/https?:\/\/[^\s"'<>`]+/giu, (url) => sanitizeTailUrl(url) ?? '[redacted-url]')
    .replace(/(^|[\s"'(<`,;])\/[^\s"'<>`,;)]+/giu, (match, prefix: string) => `${prefix}${sanitizeTailPathname(match.slice(prefix.length))}`)
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/giu, '$1: [redacted]')
    .replace(/\bauthorization\s*:\s*[^\r\n]+/giu, 'authorization: [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*\5/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(?!["'])([^,\s\r\n}\]]+)/giu, '$1$2$3$2$4[redacted]')
    .replace(/(^|[.?&\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;\[(])([A-Za-z0-9_.-]*authorization[A-Za-z0-9_.-]*)\s*=\s*([^\r\n"'<>`,;]*?)(?=(?:\s+[A-Za-z0-9_.-]*(?:authorization|cookie|set-cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*\s*=)|[&\r\n"'<>`,;]|$)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;\[(])([A-Za-z0-9_.-]*(?:cookie|set-cookie)[A-Za-z0-9_.-]*)\s*=\s*([^;\s\r\n"'<>`,]*(?:;\s*[^=;\s\r\n"'<>`,]+=[^;\s\r\n"'<>`,]*)*)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&\s"'<>`,;\[(])([A-Za-z0-9_.-]*(?:token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\s*=\s*([^&\s"'<>`,;]+)/giu, '$1$2=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
}

function sanitizeTailWorkerName(value: string): string {
  return sanitizeTailSecretString(value).replace(/\s+/gu, ' ').trim();
}

function sanitizeTailCredentialUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.pathname = sanitizeTailPathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

function redactTailSecretStructuredValues(value: string): string {
  const keyPattern = /(^|[{\s"'<>`,;])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*[:=]\s*)([\[{])/giu;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchText = match[0];
    const matchIndex = match.index;
    if (matchIndex < cursor) continue;
    const valueStart = matchIndex + matchText.length - 1;
    const valueEnd = findTailBalancedStructuredValueEnd(value, valueStart);
    redacted += value.slice(cursor, matchIndex);
    redacted += `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}${match[2] ?? ''}${match[4] ?? ''}[redacted]`;
    if (valueEnd === undefined) {
      const newlineIndex = value.indexOf('\n', valueStart);
      cursor = newlineIndex === -1 ? value.length : newlineIndex;
    } else {
      cursor = valueEnd + 1;
    }
  }
  return redacted + value.slice(cursor);
}

function findTailBalancedStructuredValueEnd(value: string, valueStart: number): number | undefined {
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

function optionalTimestampField(value: unknown): { timestamp: string } | {} {
  if (value === undefined || value === null) return {};

  return { timestamp: normalizeTimestamp(value, new Date(0)).toISOString() };
}

function optionalStatus(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && /^\d{3}$/u.test(value)) return value;
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function findHeader(headers: Record<string, unknown> | null | undefined, name: string): unknown {
  if (headers === null || headers === undefined) return undefined;

  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function safeIdentifierSegment(value: string, fallback: string, maxLength = 64): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const original = value.trim();
  const needsHash = normalized !== original || normalized.length > maxLength;
  const hash = stableHash(value);
  const hashSuffix = needsHash ? `-${hash}` : '';
  const readableLength = Math.max(0, maxLength - hashSuffix.length);
  const truncatedRaw = readableLength <= 0 ? '' : normalized.slice(0, readableLength);
  const truncated = truncatedRaw
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '');

  if (truncated.length > 0 && /^[a-z0-9]/u.test(truncated)) {
    return `${truncated}${hashSuffix}`;
  }

  if (needsHash) {
    return hash.slice(0, maxLength);
  }

  return fallback;
}

function safeActionToken(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return normalized.length > 0 && /^[A-Za-z0-9]/u.test(normalized) ? normalized : fallback;
}

function safeDeliveryReferenceSegment(
  value: string,
  fallback: string,
  maxLength = 64,
  options: { preserveEnd?: boolean } = {},
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const original = value.trim();
  const normalizedWithoutEdgePunctuation = normalized
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '');
  const needsHash = normalized !== original
    || normalizedWithoutEdgePunctuation !== normalized
    || normalized.length > maxLength;
  const hash = stableHash(value);
  const hashSuffix = needsHash ? `-${hash}` : '';
  const readableLength = Math.max(0, maxLength - hashSuffix.length);
  const truncatedRaw = readableLength <= 0
    ? ''
    : options.preserveEnd === true
      ? normalized.slice(-readableLength)
      : normalized.slice(0, readableLength);
  const truncated = truncatedRaw
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '');

  if (truncated.length > 0 && /^[a-z0-9]/u.test(truncated)) {
    return `${truncated}${hashSuffix}`;
  }

  if (needsHash) {
    return hash.slice(0, maxLength);
  }

  return fallback;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}
