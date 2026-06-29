import { createEventEnvelope, type RainrailEventEnvelope, type RainrailEventName } from './events.js';
import { defineSourcePlugin, type SourcePlugin } from './source-plugin.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type GitHubWebhookSignatureFailureReason =
  | 'missing_secret'
  | 'missing_signature'
  | 'unsupported_signature'
  | 'signature_mismatch';

export type GitHubWebhookSignatureResult =
  | { ok: true; reason: 'signature_mismatch' }
  | { ok: false; reason: GitHubWebhookSignatureFailureReason };

export type GitHubWebhookRawBody = string | ArrayBuffer | ArrayBufferView;

export interface GitHubWebhookSignatureInput {
  secret: string;
  rawBody: GitHubWebhookRawBody;
  signature: string | null | undefined;
}

export async function createGitHubWebhookSignature(
  secret: string,
  rawBody: GitHubWebhookRawBody,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await globalThis.crypto.subtle.sign('HMAC', key, toUint8Array(rawBody));

  return `sha256=${toHex(new Uint8Array(digest))}`;
}

export async function verifyGitHubWebhookSignature({
  secret,
  rawBody,
  signature,
}: GitHubWebhookSignatureInput): Promise<GitHubWebhookSignatureResult> {
  if (!secret) {
    return { ok: false, reason: 'missing_secret' };
  }

  if (!signature) {
    return { ok: false, reason: 'missing_signature' };
  }

  if (!signature.startsWith('sha256=')) {
    return { ok: false, reason: 'unsupported_signature' };
  }

  const expected = await createGitHubWebhookSignature(secret, rawBody);

  return {
    ok: constantTimeStringEqual(expected, signature),
    reason: 'signature_mismatch',
  };
}

export interface GitHubWebhookRequestOptions {
  secret: string;
  receivedAt?: Date;
  sourceName?: string;
}

export type GitHubWebhookRequestResult =
  | { ok: true; event: RainrailEventEnvelope }
  | { ok: false; status: 400 | 401; reason: string };

export async function handleGitHubWebhookRequest(
  request: Request,
  options: GitHubWebhookRequestOptions,
): Promise<GitHubWebhookRequestResult> {
  const githubEvent = request.headers.get('x-github-event');
  const deliveryId = request.headers.get('x-github-delivery');

  if (!githubEvent || !deliveryId) {
    return { ok: false, status: 400, reason: 'missing_github_headers' };
  }

  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256');
  const verification = await verifyGitHubWebhookSignature({
    secret: options.secret,
    rawBody,
    signature,
  });

  if (!verification.ok) {
    return { ok: false, status: 401, reason: verification.reason };
  }

  const contentType = request.headers.get('content-type');
  let payload: GitHubWebhookPayload;
  try {
    payload = parseGitHubWebhookPayload(rawBody, contentType);
  } catch {
    return { ok: false, status: 400, reason: 'invalid_json_payload' };
  }

  const receivedAt = options.receivedAt ?? new Date();
  const event = await createGitHubWebhookEvent({
    githubEvent,
    deliveryId,
    payload,
    rawBody,
    receivedAt,
    ...(options.sourceName ? { sourceName: options.sourceName } : {}),
    ...(contentType ? { contentType } : {}),
  });

  return { ok: true, event };
}

export interface CreateGitHubWebhookEventInput {
  githubEvent: string;
  deliveryId: string;
  payload: GitHubWebhookPayload;
  rawBody: GitHubWebhookRawBody;
  receivedAt: Date;
  sourceName?: string;
  contentType?: string;
}

export type GitHubWebhookSourcePluginInput = CreateGitHubWebhookEventInput;

export function createGitHubWebhookSourcePlugin(name = 'github-webhook'): SourcePlugin<GitHubWebhookSourcePluginInput> {
  return defineSourcePlugin({
    name,
    sourceType: 'github',
    normalize(input) {
      return createGitHubWebhookEvent({
        ...input,
        sourceName: name,
      });
    },
  });
}

export async function createGitHubWebhookEvent({
  githubEvent,
  deliveryId,
  payload,
  rawBody,
  receivedAt,
  sourceName = 'github-webhook',
  contentType,
}: CreateGitHubWebhookEventInput): Promise<RainrailEventEnvelope> {
  const name = toRainrailGitHubEventName(githubEvent);
  const subject = findGitHubSubject(payload, name);
  const repository = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name : undefined;
  const account = typeof payload.sender?.login === 'string' ? payload.sender.login : undefined;
  const receivedAtIso = receivedAt.toISOString();

  return createEventEnvelope({
    source: {
      type: 'github',
      name: sourceName,
      ...(repository ? { repository } : {}),
      ...(account ? { account } : {}),
    },
    name,
    delivery: {
      id: deliveryId,
      receivedAt: receivedAtIso,
    },
    occurredAt: receivedAtIso,
    subject,
    payload: normalizeGitHubWebhookPayload(payload),
    rawPayload: {
      kind: 'inline-redacted',
      reference: `github://deliveries/${deliveryId}`,
      ...(contentType ? { contentType } : {}),
      sha256: await sha256Hex(rawBody),
    },
  });
}

export interface GitHubWebhookPayload {
  action?: unknown;
  sender?: { login?: unknown };
  repository?: { full_name?: unknown; html_url?: unknown; id?: unknown };
  issue?: { number?: unknown; html_url?: unknown; title?: unknown; body?: unknown };
  pull_request?: { number?: unknown; html_url?: unknown; title?: unknown; body?: unknown };
  check_run?: { id?: unknown; html_url?: unknown; status?: unknown; conclusion?: unknown };
  check_suite?: { id?: unknown; html_url?: unknown; status?: unknown; conclusion?: unknown };
  review?: { id?: unknown; html_url?: unknown };
  workflow_run?: { id?: unknown; html_url?: unknown; status?: unknown; conclusion?: unknown };
  [key: string]: unknown;
}

function toRainrailGitHubEventName(githubEvent: string): RainrailEventName {
  const normalized = normalizeToken(githubEvent);

  if (normalized === 'issues' || normalized === 'issue_comment') {
    return 'github.issue';
  }

  if (normalized === 'pull_request') {
    return 'github.pull_request';
  }

  if (normalized === 'check_run' || normalized === 'check_suite' || normalized === 'workflow_run') {
    return 'github.check_run';
  }

  if (
    normalized === 'pull_request_review' ||
    normalized === 'pull_request_review_comment' ||
    normalized === 'pull_request_review_thread'
  ) {
    return 'github.review';
  }

  return `github.${normalized || 'unknown'}`;
}

function findGitHubSubject(payload: GitHubWebhookPayload, name: RainrailEventName): RainrailEventEnvelope['subject'] {
  if (name === 'github.review') {
    return (
      subjectFromReview(payload) ??
      subjectFromPullRequest(payload) ??
      subjectFromIssue(payload) ??
      subjectFromRepository(payload, name)
    );
  }

  if (name === 'github.check_run') {
    return (
      subjectFromCheckRun(payload) ??
      subjectFromWorkflowRun(payload) ??
      subjectFromCheckSuite(payload) ??
      subjectFromRepository(payload, name)
    );
  }

  if (payload.issue) {
    return subjectFromIssue(payload);
  }

  if (payload.pull_request) {
    return subjectFromPullRequest(payload);
  }

  if (payload.check_run) {
    return subjectFromCheckRun(payload) ?? subjectFromRepository(payload, name);
  }

  if (payload.review) {
    return subjectFromReview(payload) ?? subjectFromRepository(payload, name);
  }

  return subjectFromRepository(payload, name);
}

function parseGitHubWebhookPayload(rawBody: ArrayBuffer, contentType: string | null): GitHubWebhookPayload {
  const bodyText = decoder.decode(rawBody);
  const jsonText = isUrlEncodedForm(contentType) ? new URLSearchParams(bodyText).get('payload') : bodyText;

  if (!jsonText) {
    throw new SyntaxError('Missing GitHub payload');
  }

  return JSON.parse(jsonText) as GitHubWebhookPayload;
}

function subjectFromIssue(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] {
  return {
    type: 'issue',
    id: String(payload.issue?.number ?? 'unknown'),
    ...(typeof payload.issue?.html_url === 'string' ? { url: payload.issue.html_url } : {}),
  };
}

function subjectFromPullRequest(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] {
  return {
    type: 'pull_request',
    id: String(payload.pull_request?.number ?? 'unknown'),
    ...(typeof payload.pull_request?.html_url === 'string' ? { url: payload.pull_request.html_url } : {}),
  };
}

function subjectFromCheckRun(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.check_run) {
    return undefined;
  }

  return {
    type: 'check_run',
    id: String(payload.check_run.id ?? 'unknown'),
    ...(typeof payload.check_run.html_url === 'string' ? { url: payload.check_run.html_url } : {}),
  };
}

function subjectFromWorkflowRun(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.workflow_run) {
    return undefined;
  }

  return {
    type: 'workflow_run',
    id: String(payload.workflow_run.id ?? 'unknown'),
    ...(typeof payload.workflow_run.html_url === 'string' ? { url: payload.workflow_run.html_url } : {}),
  };
}

function subjectFromCheckSuite(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.check_suite) {
    return undefined;
  }

  return {
    type: 'check_suite',
    id: String(payload.check_suite.id ?? 'unknown'),
    ...(typeof payload.check_suite.html_url === 'string' ? { url: payload.check_suite.html_url } : {}),
  };
}

function subjectFromReview(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.review) {
    return undefined;
  }

  return {
    type: 'review',
    id: String(payload.review.id ?? 'unknown'),
    ...(typeof payload.review.html_url === 'string' ? { url: payload.review.html_url } : {}),
  };
}

function subjectFromRepository(
  payload: GitHubWebhookPayload,
  name: RainrailEventName,
): RainrailEventEnvelope['subject'] {
  const repositoryId = payload.repository?.full_name ?? payload.repository?.id ?? name;

  return {
    type: 'repository',
    id: String(repositoryId),
    ...(typeof payload.repository?.html_url === 'string' ? { url: payload.repository.html_url } : {}),
  };
}

function normalizeGitHubWebhookPayload(payload: GitHubWebhookPayload): Record<string, string | number | boolean | null> {
  const normalized: Record<string, string | number | boolean | null> = {};

  if (isJsonScalar(payload.action)) {
    normalized.action = payload.action;
  }

  const checkMetadata = payload.check_run ?? payload.check_suite ?? payload.workflow_run;
  if (checkMetadata !== undefined) {
    if (isJsonScalar(checkMetadata.status)) {
      normalized.status = checkMetadata.status;
    }
    if (isJsonScalar(checkMetadata.conclusion)) {
      normalized.conclusion = checkMetadata.conclusion;
    }
  }

  return normalized;
}

function isUrlEncodedForm(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(';', 1)[0]?.trim() === 'application/x-www-form-urlencoded';
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

async function sha256Hex(value: GitHubWebhookRawBody): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toUint8Array(value));

  return toHex(new Uint8Array(digest));
}

function toUint8Array(value: GitHubWebhookRawBody): Uint8Array {
  if (typeof value === 'string') {
    return encoder.encode(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeToken(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function constantTimeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}
