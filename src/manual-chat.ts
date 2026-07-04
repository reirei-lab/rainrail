import { createEventEnvelope, type RainrailEventEnvelope } from './events.js';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  jsonResponse,
  readFetchRequestBody,
} from './http-utils.js';
import type { RainrailIntakeAdapter } from './intake-adapter.js';

const encoder = new TextEncoder();

export type ManualInputChannel = 'manual' | 'chat';

export interface ManualInputActor {
  id?: string;
  displayName?: string;
  type?: string;
}

export interface ManualInputAttachment {
  id?: string;
  name?: string;
  contentType?: string;
  url?: string;
}

export interface ManualInputReplyTarget {
  id: string;
  url?: string;
}

export interface ManualInputPayload {
  provider: 'rainrail';
  channel: ManualInputChannel;
  action: 'message';
  conversation: {
    id: string;
    url?: string;
  };
  message: {
    id?: string;
    text: string;
  };
  actor?: ManualInputActor;
  attachments?: ManualInputAttachment[];
  replyTarget?: ManualInputReplyTarget;
}

export interface CreateManualInputEventInput {
  channel: ManualInputChannel;
  conversationId: string;
  message: string;
  receivedAt?: Date;
  deliveryId?: string;
  messageId?: string;
  sourceName?: string;
  conversationUrl?: string;
  actor?: ManualInputActor;
  attachments?: ManualInputAttachment[];
  replyTarget?: ManualInputReplyTarget;
  rawBody?: string | ArrayBuffer | ArrayBufferView;
  contentType?: string;
}

export interface ManualInputIntakeAdapterOptions {
  channel: ManualInputChannel;
  bearerToken: string;
  routePath?: `/${string}`;
  sourceName?: string;
  maxBodyBytes?: number;
  receivedAt?: () => Date;
  deliveryId?: (input: ManualInputHttpBody, request: Request) => string;
}

export type ManualInputRainrailEvent = RainrailEventEnvelope<
  ManualInputPayload,
  'rainrail.manual.message' | 'rainrail.chat.message'
>;

export interface ManualInputHttpBody {
  conversationId?: unknown;
  conversationUrl?: unknown;
  message?: unknown;
  messageId?: unknown;
  actor?: unknown;
  attachments?: unknown;
  replyTarget?: unknown;
  [key: string]: unknown;
}

export async function createManualInputEvent({
  channel,
  conversationId,
  message,
  receivedAt = new Date(),
  deliveryId,
  messageId,
  sourceName = defaultManualInputSourceName(channel),
  conversationUrl,
  actor,
  attachments,
  replyTarget,
  rawBody = message,
  contentType,
}: CreateManualInputEventInput): Promise<ManualInputRainrailEvent> {
  const normalizedConversationId = safeIdentifierSegment(conversationId, 'conversation');
  const normalizedDeliveryId = deliveryId === undefined
    ? buildManualInputDeliveryId(channel, conversationId, messageId ?? crypto.randomUUID())
    : safeDeliveryReferenceSegment(deliveryId, `${channel}-delivery`);
  const occurredAt = receivedAt.toISOString();
  const safeConversationUrl = safeUrl(conversationUrl);
  const name = channel === 'chat' ? 'rainrail.chat.message' : 'rainrail.manual.message';
  const payload: ManualInputPayload = {
    provider: 'rainrail',
    channel,
    action: 'message',
    conversation: {
      id: normalizedConversationId,
      ...(safeConversationUrl === undefined ? {} : { url: safeConversationUrl }),
    },
    message: {
      ...(messageId === undefined ? {} : { id: safeIdentifierSegment(messageId, 'message') }),
      text: redactUserText(message),
    },
    ...normalizedOptionalActor(actor),
    ...normalizedOptionalAttachments(attachments),
    ...normalizedOptionalReplyTarget(replyTarget),
  };

  return createEventEnvelope({
    ...buildOptionalManualInputEventId(sourceName, normalizedDeliveryId, name),
    source: {
      type: channel,
      name: sourceName,
    },
    name,
    delivery: {
      id: normalizedDeliveryId,
      receivedAt: occurredAt,
    },
    occurredAt,
    subject: {
      type: 'conversation',
      id: normalizedConversationId,
    },
    payload,
    rawPayload: {
      kind: 'inline-redacted',
      reference: `${channel}://deliveries/${normalizedDeliveryId}`,
      ...(contentType === undefined ? {} : { contentType }),
      sha256: await sha256Hex(rawBody),
    },
  });
}

export function createManualInputIntakeAdapter(options: ManualInputIntakeAdapterOptions): RainrailIntakeAdapter {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const sourceName = options.sourceName ?? defaultManualInputSourceName(options.channel);
  const bearerToken = requiredBearerToken(options.bearerToken);

  return {
    name: sourceName,
    routes: [{
      path: options.routePath ?? defaultManualInputRoutePath(options.channel),
      methods: ['POST'],
      maxBodyBytes,
      readBodyBeforeHandle: false,
      async handle(request, context) {
        const auth = verifyBearerToken(request, bearerToken);
        if (!auth.ok) {
          return jsonResponse({ error: auth.reason }, { status: 401 });
        }

        let rawBody: ArrayBuffer;
        try {
          rawBody = await readFetchRequestBody(request, maxBodyBytes);
        } catch (error) {
          if (isStatusCodeError(error) && error.statusCode === 413) {
            return jsonResponse({ error: 'request_body_too_large' }, { status: 413 });
          }

          throw error;
        }

        let body: ManualInputHttpBody;
        try {
          body = JSON.parse(new TextDecoder().decode(rawBody)) as ManualInputHttpBody;
        } catch {
          return jsonResponse({ error: 'invalid_json_payload' }, { status: 400 });
        }

        const parsed = parseManualInputHttpBody(body);
        if (!parsed.ok) {
          return jsonResponse({ error: parsed.reason }, { status: 400 });
        }

        const eventInput: CreateManualInputEventInput = {
          channel: options.channel,
          sourceName,
          receivedAt: options.receivedAt?.() ?? new Date(),
          rawBody,
          ...parsed.input,
        };
        const deliveryId = options.deliveryId?.(body, request);
        if (deliveryId !== undefined) {
          eventInput.deliveryId = deliveryId;
        }
        const contentType = request.headers.get('content-type') ?? undefined;
        if (contentType !== undefined) {
          eventInput.contentType = contentType;
        }

        const event = await createManualInputEvent(eventInput);
        const publish = await context.publish(event);
        if (!publish.ok) {
          return jsonResponse({ error: 'failed_to_publish_event' }, { status: 502 });
        }

        return jsonResponse({
          ok: true,
          id: event.id,
          name: event.name,
          source: options.channel,
        }, { status: 202 });
      },
    }],
  };
}

function parseManualInputHttpBody(body: ManualInputHttpBody):
  | { ok: true; input: Pick<CreateManualInputEventInput, 'conversationId' | 'message' | 'messageId' | 'conversationUrl' | 'actor' | 'attachments' | 'replyTarget'> }
  | { ok: false; reason: string } {
  if (!isRecord(body)) {
    return { ok: false, reason: 'invalid_json_payload' };
  }

  const conversationId = requiredString(body.conversationId);
  if (conversationId === undefined) {
    return { ok: false, reason: 'missing_conversation_id' };
  }

  const message = messageTextFromBody(body.message);
  if (message === undefined) {
    return { ok: false, reason: 'missing_message' };
  }

  return {
    ok: true,
    input: {
      conversationId,
      message,
      ...(typeof body.messageId === 'string' ? { messageId: body.messageId } : {}),
      ...(typeof body.conversationUrl === 'string' ? { conversationUrl: body.conversationUrl } : {}),
      ...normalizedOptionalActor(normalizeActorInput(body.actor)),
      ...normalizedOptionalAttachments(normalizeAttachmentsInput(body.attachments)),
      ...normalizedOptionalReplyTarget(normalizeReplyTargetInput(body.replyTarget)),
    },
  };
}

function messageTextFromBody(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (isRecord(value) && typeof value.text === 'string' && value.text.trim().length > 0) return value.text;
  return undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function defaultManualInputSourceName(channel: ManualInputChannel): string {
  return channel === 'chat' ? 'web-chat' : 'manual-input';
}

function defaultManualInputRoutePath(channel: ManualInputChannel): `/${string}` {
  return channel === 'chat' ? '/intake/chat' : '/intake/manual';
}

function requiredBearerToken(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('manual input bearer token is required');
  }
  return value;
}

function verifyBearerToken(request: Request, bearerToken: string):
  | { ok: true }
  | { ok: false; reason: 'missing_bearer_token' | 'invalid_bearer_token' } {
  const authorization = request.headers.get('authorization');
  if (authorization === null) {
    return { ok: false, reason: 'missing_bearer_token' };
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  if (match === null) {
    return { ok: false, reason: 'missing_bearer_token' };
  }

  return constantTimeStringEqual(match[1] ?? '', bearerToken)
    ? { ok: true }
    : { ok: false, reason: 'invalid_bearer_token' };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function normalizedOptionalActor(actor: ManualInputActor | undefined): { actor?: ManualInputActor } {
  if (actor === undefined) return {};
  const normalized = {
    ...(actor.id === undefined ? {} : { id: safeIdentifierSegment(actor.id, 'actor') }),
    ...(actor.displayName === undefined ? {} : { displayName: redactUserText(actor.displayName) }),
    ...(actor.type === undefined ? {} : { type: safeIdentifierSegment(actor.type, 'user') }),
  };

  return Object.keys(normalized).length === 0 ? {} : { actor: normalized };
}

function normalizedOptionalAttachments(attachments: ManualInputAttachment[] | undefined): { attachments?: ManualInputAttachment[] } {
  if (attachments === undefined || attachments.length === 0) return {};
  const normalized = attachments.flatMap((attachment) => {
    const url = safeUrl(attachment.url);
    const safeAttachment = {
      ...(attachment.id === undefined ? {} : { id: safeIdentifierSegment(attachment.id, 'attachment') }),
      ...(attachment.name === undefined ? {} : { name: redactUserText(attachment.name) }),
      ...(attachment.contentType === undefined ? {} : { contentType: safeContentType(attachment.contentType) }),
      ...(url === undefined ? {} : { url }),
    };
    return Object.keys(safeAttachment).length === 0 ? [] : [safeAttachment];
  });

  return normalized.length === 0 ? {} : { attachments: normalized };
}

function normalizedOptionalReplyTarget(replyTarget: ManualInputReplyTarget | undefined): { replyTarget?: ManualInputReplyTarget } {
  if (replyTarget === undefined) return {};
  const url = safeUrl(replyTarget.url);
  return {
    replyTarget: {
      id: safeIdentifierSegment(replyTarget.id, 'reply'),
      ...(url === undefined ? {} : { url }),
    },
  };
}

function normalizeActorInput(value: unknown): ManualInputActor | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
  };
}

function normalizeAttachmentsInput(value: unknown): ManualInputAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((attachment) => {
    if (!isRecord(attachment)) return [];
    return [{
      ...(typeof attachment.id === 'string' ? { id: attachment.id } : {}),
      ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
      ...(typeof attachment.url === 'string' ? { url: attachment.url } : {}),
    }];
  });
}

function normalizeReplyTargetInput(value: unknown): ManualInputReplyTarget | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  return {
    id: value.id,
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  };
}

function safeIdentifierSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9_.:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  const changedBySanitization = normalized !== trimmed;
  if (normalized.length === 0) {
    return compactIdentifierWithHash(fallback, value, 128, { includeHash: trimmed.length > 0 });
  }
  const safe = /^[A-Za-z0-9]/u.test(normalized) ? normalized : `${fallback}-${normalized}`;
  return compactIdentifierWithHash(safe, value, 128, { includeHash: changedBySanitization });
}

function safeDeliveryReferenceSegment(value: string, fallback: string, maxLength = 128): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  const changedBySanitization = normalized !== trimmed;
  const safe = normalized.length === 0
    ? fallback
    : /^[A-Za-z0-9]/u.test(normalized) ? normalized : `${fallback}-${normalized}`;
  return compactIdentifierWithHash(safe, value, maxLength, {
    includeHash: changedBySanitization || (normalized.length === 0 && trimmed.length > 0),
  });
}

function safeDeliveryReferenceSuffix(value: string, fallback: string, maxLength: number): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  const changedBySanitization = normalized !== trimmed;
  const safe = normalized.length === 0
    ? fallback
    : /^[A-Za-z0-9]/u.test(normalized) ? normalized : `${fallback}-${normalized}`;
  return compactIdentifierWithHash(safe, value, maxLength, {
    includeHash: changedBySanitization || (normalized.length === 0 && trimmed.length > 0),
    keepTail: true,
  });
}

function buildManualInputDeliveryId(channel: ManualInputChannel, conversationId: string, uniqueId: string): string {
  const uniqueSegment = safeDeliveryReferenceSuffix(uniqueId, 'message', 64);
  const separator = '-';
  const maxLength = 128;
  const suffixLength = Math.min(uniqueSegment.length, Math.max(1, maxLength - `${channel}${separator}`.length));
  const suffix = uniqueSegment.slice(Math.max(0, uniqueSegment.length - suffixLength));
  const prefixMaxLength = Math.max(1, maxLength - separator.length - suffix.length);
  const prefix = safeDeliveryReferenceSegment(`${channel}-${conversationId}`, `${channel}-delivery`, prefixMaxLength);
  return `${prefix}${separator}${suffix}`;
}

function buildOptionalManualInputEventId(
  sourceName: string,
  deliveryId: string,
  name: ManualInputRainrailEvent['name'],
): { id?: string } {
  const defaultId = `${sourceName}:${deliveryId}:${name}`;
  if (defaultId.length <= 128) return {};

  const source = safeIdentifierSegment(sourceName, 'source').slice(0, 24);
  const hash = stableHash(defaultId);
  const fixedLength = 'manual'.length + source.length + name.length + hash.length + 4;
  const deliveryLength = Math.max(1, 128 - fixedLength);
  const delivery = compactIdentifierSuffix(deliveryId, 'delivery', deliveryLength);
  return { id: `manual:${source}:${delivery}:${name}:${hash}` };
}

function compactIdentifierSuffix(value: string, fallback: string, maxLength: number): string {
  const safe = safeIdentifierSegment(value, fallback);
  if (safe.length <= maxLength) return safe;

  const hash = stableHash(value);
  const hashSuffix = `-${hash}`;
  const tailLength = Math.max(1, maxLength - hashSuffix.length);
  return `${safe.slice(Math.max(0, safe.length - tailLength))}${hashSuffix}`;
}

function compactIdentifierWithHash(
  safe: string,
  hashInput: string,
  maxLength: number,
  options: { includeHash?: boolean; keepTail?: boolean } = {},
): string {
  if (safe.length <= maxLength && options.includeHash !== true) return safe;

  const hashSuffix = `-${stableHash(hashInput)}`;
  if (safe.length + hashSuffix.length <= maxLength) return `${safe}${hashSuffix}`;

  const keepLength = Math.max(1, maxLength - hashSuffix.length);
  const kept = options.keepTail === true
    ? safe.slice(Math.max(0, safe.length - keepLength))
    : safe.slice(0, keepLength);
  return `${kept}${hashSuffix}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function safeContentType(value: string): string {
  const contentType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
    return 'application/octet-stream';
  }
  return contentType;
}

function safeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function redactUserText(value: string): string {
  return value
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*([^&\s"'<>`,;)]+)/giu, '$1$2$3$2=[redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*\5/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(?!["']|\[redacted\])([^,\s\r\n}\]]+)/giu, '$1$2$3$2$4[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, '[redacted-token]')
    .trim()
    .slice(0, 8_000);
}

async function sha256Hex(value: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = toUint8Array(value);
  const body = bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toUint8Array(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
