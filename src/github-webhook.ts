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
    payload: normalizeGitHubWebhookPayload(githubEvent, payload),
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
  sender?: GitHubWebhookRecord;
  installation?: GitHubWebhookRecord;
  repository?: GitHubWebhookRecord;
  issue?: GitHubWebhookRecord;
  pull_request?: GitHubWebhookRecord;
  comment?: GitHubWebhookRecord;
  check_run?: GitHubWebhookRecord;
  check_suite?: GitHubWebhookRecord;
  review?: GitHubWebhookRecord;
  workflow_run?: GitHubWebhookRecord;
  projects_v2_item?: GitHubWebhookRecord;
  [key: string]: unknown;
}

type GitHubWebhookRecord = Record<string, unknown>;

export interface NormalizedGitHubWebhookPayload {
  provider: 'github';
  event: string;
  action: string;
  repository?: NormalizedGitHubRepository;
  actor?: NormalizedGitHubActor;
  installation?: NormalizedGitHubInstallation;
  resource: NormalizedGitHubResource;
  comment?: NormalizedGitHubComment;
}

export interface NormalizedGitHubRepository {
  id?: string;
  fullName?: string;
  url?: string;
  owner?: string;
  name?: string;
}

export interface NormalizedGitHubActor {
  id?: string;
  login?: string;
  type?: string;
  url?: string;
}

export interface NormalizedGitHubInstallation {
  id?: string;
}

export interface NormalizedGitHubResource {
  type: string;
  id: string;
  number?: number;
  name?: string;
  title?: string;
  state?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  headRef?: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  contentType?: string;
  contentNodeId?: string;
}

export interface NormalizedGitHubComment {
  id: string;
  body?: string;
  url?: string;
  author?: string;
  reviewId?: string;
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

  if (payload.projects_v2_item) {
    return subjectFromProjectItem(payload) ?? subjectFromRepository(payload, name);
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

function subjectFromProjectItem(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.projects_v2_item) {
    return undefined;
  }

  return {
    type: 'project_item',
    id: String(payload.projects_v2_item.id ?? 'unknown'),
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

function isUrlEncodedForm(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(';', 1)[0]?.trim() === 'application/x-www-form-urlencoded';
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

function normalizeGitHubWebhookPayload(
  githubEvent: string,
  payload: GitHubWebhookPayload,
): NormalizedGitHubWebhookPayload {
  const repository = normalizedRepository(payload.repository);
  const actor = normalizedActor(payload.sender);
  const installation = normalizedInstallation(payload.installation);
  const comment = normalizedComment(payload.comment);

  return {
    provider: 'github',
    event: normalizeToken(githubEvent) || 'unknown',
    action: typeof payload.action === 'string' ? normalizeToken(payload.action) || 'received' : 'received',
    ...(repository ? { repository } : {}),
    ...(actor ? { actor } : {}),
    ...(installation ? { installation } : {}),
    resource: normalizedResource(payload),
    ...(comment ? { comment } : {}),
  };
}

function normalizedRepository(repository: GitHubWebhookRecord | undefined): NormalizedGitHubRepository | undefined {
  if (!repository) {
    return undefined;
  }

  const fullName = stringField(repository, 'full_name');
  const nameParts = fullName?.split('/');
  const normalized = {
    ...optionalStringProperty('id', idField(repository, 'id')),
    ...optionalStringProperty('fullName', fullName),
    ...optionalStringProperty('url', stringField(repository, 'html_url')),
    ...optionalStringProperty('owner', stringField(recordField(repository, 'owner'), 'login') ?? nameParts?.[0]),
    ...optionalStringProperty('name', stringField(repository, 'name') ?? nameParts?.[1]),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedActor(sender: GitHubWebhookRecord | undefined): NormalizedGitHubActor | undefined {
  if (!sender) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(sender, 'id')),
    ...optionalStringProperty('login', stringField(sender, 'login')),
    ...optionalStringProperty('type', stringField(sender, 'type')),
    ...optionalStringProperty('url', stringField(sender, 'html_url')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedInstallation(installation: GitHubWebhookRecord | undefined): NormalizedGitHubInstallation | undefined {
  if (!installation) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(installation, 'id')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedResource(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  if (payload.issue) {
    return resourceFromIssue(payload.issue);
  }

  if (payload.pull_request) {
    return resourceFromPullRequest(payload.pull_request);
  }

  if (payload.review) {
    return resourceFromReview(payload.review);
  }

  if (payload.check_run) {
    return resourceFromCheckRun(payload.check_run);
  }

  if (payload.workflow_run) {
    return resourceFromWorkflowRun(payload.workflow_run);
  }

  if (payload.check_suite) {
    return resourceFromCheckSuite(payload.check_suite);
  }

  if (payload.projects_v2_item) {
    return resourceFromProjectItem(payload.projects_v2_item);
  }

  return resourceFromRepository(payload.repository);
}

function resourceFromIssue(issue: GitHubWebhookRecord): NormalizedGitHubResource {
  const number = numberField(issue, 'number');
  return {
    type: 'issue',
    id: String(number ?? issue.id ?? 'unknown'),
    ...(number === undefined ? {} : { number }),
    ...optionalStringProperty('title', stringField(issue, 'title')),
    ...optionalStringProperty('state', stringField(issue, 'state')),
    ...optionalStringProperty('url', stringField(issue, 'html_url')),
  };
}

function resourceFromPullRequest(pullRequest: GitHubWebhookRecord): NormalizedGitHubResource {
  const number = numberField(pullRequest, 'number');
  const head = recordField(pullRequest, 'head');
  const base = recordField(pullRequest, 'base');

  return {
    type: 'pull_request',
    id: String(number ?? pullRequest.id ?? 'unknown'),
    ...(number === undefined ? {} : { number }),
    ...optionalStringProperty('title', stringField(pullRequest, 'title')),
    ...optionalStringProperty('state', stringField(pullRequest, 'state')),
    ...optionalStringProperty('url', stringField(pullRequest, 'html_url')),
    ...optionalStringProperty('headRef', stringField(head, 'ref')),
    ...optionalStringProperty('headSha', stringField(head, 'sha')),
    ...optionalStringProperty('baseRef', stringField(base, 'ref')),
    ...optionalStringProperty('baseSha', stringField(base, 'sha')),
  };
}

function resourceFromReview(review: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'review',
    id: String(review.id ?? 'unknown'),
    ...optionalStringProperty('state', stringField(review, 'state')),
    ...optionalStringProperty('url', stringField(review, 'html_url')),
  };
}

function resourceFromCheckRun(checkRun: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'check_run',
    id: String(checkRun.id ?? 'unknown'),
    ...optionalStringProperty('name', stringField(checkRun, 'name')),
    ...optionalStringProperty('status', stringField(checkRun, 'status')),
    ...optionalStringProperty('conclusion', stringField(checkRun, 'conclusion')),
    ...optionalStringProperty('headSha', stringField(checkRun, 'head_sha')),
    ...optionalStringProperty('url', stringField(checkRun, 'html_url')),
  };
}

function resourceFromWorkflowRun(workflowRun: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'workflow_run',
    id: String(workflowRun.id ?? 'unknown'),
    ...optionalStringProperty('name', stringField(workflowRun, 'name')),
    ...optionalStringProperty('status', stringField(workflowRun, 'status')),
    ...optionalStringProperty('conclusion', stringField(workflowRun, 'conclusion')),
    ...optionalStringProperty('headRef', stringField(workflowRun, 'head_branch')),
    ...optionalStringProperty('headSha', stringField(workflowRun, 'head_sha')),
    ...optionalStringProperty('url', stringField(workflowRun, 'html_url')),
  };
}

function resourceFromCheckSuite(checkSuite: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'check_suite',
    id: String(checkSuite.id ?? 'unknown'),
    ...optionalStringProperty('status', stringField(checkSuite, 'status')),
    ...optionalStringProperty('conclusion', stringField(checkSuite, 'conclusion')),
    ...optionalStringProperty('headRef', stringField(checkSuite, 'head_branch')),
    ...optionalStringProperty('headSha', stringField(checkSuite, 'head_sha')),
    ...optionalStringProperty('url', stringField(checkSuite, 'html_url')),
  };
}

function resourceFromProjectItem(projectItem: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'project_item',
    id: String(projectItem.id ?? 'unknown'),
    ...optionalStringProperty('contentType', stringField(projectItem, 'content_type')),
    ...optionalStringProperty('contentNodeId', stringField(projectItem, 'content_node_id')),
  };
}

function resourceFromRepository(repository: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  return {
    type: 'repository',
    id: String(repository?.full_name ?? repository?.id ?? 'unknown'),
    ...optionalStringProperty('name', stringField(repository, 'full_name') ?? stringField(repository, 'name')),
    ...optionalStringProperty('url', stringField(repository, 'html_url')),
  };
}

function normalizedComment(comment: GitHubWebhookRecord | undefined): NormalizedGitHubComment | undefined {
  if (!comment) {
    return undefined;
  }

  return {
    id: String(comment.id ?? 'unknown'),
    ...optionalStringProperty('body', stringField(comment, 'body')),
    ...optionalStringProperty('url', stringField(comment, 'html_url')),
    ...optionalStringProperty('author', stringField(recordField(comment, 'user'), 'login')),
    ...optionalStringProperty('reviewId', idField(comment, 'pull_request_review_id')),
  };
}

function recordField(record: GitHubWebhookRecord | undefined, key: string): GitHubWebhookRecord | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as GitHubWebhookRecord) : undefined;
}

function stringField(record: GitHubWebhookRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(record: GitHubWebhookRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function idField(record: GitHubWebhookRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

function optionalStringProperty<TKey extends string>(key: TKey, value: string | undefined): Partial<Record<TKey, string>> {
  return value === undefined ? {} : { [key]: value } as Record<TKey, string>;
}

function objectHasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
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
