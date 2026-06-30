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
  const scriptName = optionalString(tailEvent.scriptName);
  const scriptVersion = optionalString(tailEvent.scriptVersion?.id);
  const method = optionalString(request.method);
  const url = optionalString(request.url);
  const status = optionalStatus(response.status);
  const exceptions = normalizeExceptions(tailEvent.exceptions);
  const action = normalizeAction(tailEvent.outcome, exceptions);
  const name = isCloudflareError(action, exceptions) ? 'cloudflare.error' : 'cloudflare.tail';
  const deliveryId = buildCloudflareTailDeliveryId({
    scriptName,
    occurredAt,
    suffix: cfRay ?? fallbackDeliveryId ?? randomDeliverySuffix(),
    maxLength: maxDeliveryIdLength(sourceName, name),
  });

  return createEventEnvelope({
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
      id: safeIdentifierSegment(scriptName ?? 'unknown-worker', 'unknown-worker'),
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
  const suffixLength = Math.min(32, Math.max(8, Math.floor(remainingLength / 2)));
  const scriptLength = Math.max(1, remainingLength - suffixLength);

  return [
    'tail',
    safeDeliveryReferenceSegment(scriptName ?? 'unknown-script', 'unknown-script', scriptLength),
    compactedTimestamp,
    safeDeliveryReferenceSegment(suffix, 'unknown-ray', suffixLength, { preserveEnd: true }),
  ].join('-');
}

function maxDeliveryIdLength(sourceName: string, name: CloudflareTailRainrailEvent['name']): number {
  const minimumDeliveryIdLength = 'tail'.length + compactTimestamp(new Date(0)).length + 1 + 1 + 3;
  return Math.min(95, Math.max(minimumDeliveryIdLength, 128 - sourceName.length - name.length - 2));
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
      ...optionalTimestampField(record.timestamp),
    }];
  });
}

function optionalField(record: Record<string, unknown>, key: 'name' | 'message'): Record<typeof key, string> | {} {
  const value = optionalString(record[key]);
  return value === null ? {} : { [key]: value };
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
    .replace(/^-+|-+$/gu, '')
    .slice(0, maxLength);

  return normalized.length > 0 && /^[a-z0-9]/u.test(normalized) ? normalized : fallback;
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
  const truncatedRaw = options.preserveEnd === true
    ? normalized.slice(-maxLength)
    : normalized.slice(0, maxLength);
  const truncated = truncatedRaw
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '');

  return truncated.length > 0 && /^[a-z0-9]/u.test(truncated) ? truncated : fallback;
}
