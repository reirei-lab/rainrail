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
  assignee?: GitHubWebhookRecord;
  requested_reviewer?: GitHubWebhookRecord;
  requested_team?: GitHubWebhookRecord;
  installation?: GitHubWebhookRecord;
  organization?: GitHubWebhookRecord;
  label?: GitHubWebhookRecord;
  repository?: GitHubWebhookRecord;
  issue?: GitHubWebhookRecord;
  pull_request?: GitHubWebhookRecord;
  comment?: GitHubWebhookRecord;
  thread?: GitHubWebhookRecord;
  requested_action?: GitHubWebhookRecord;
  check_run?: GitHubWebhookRecord;
  check_suite?: GitHubWebhookRecord;
  deployment?: GitHubWebhookRecord;
  deployment_status?: GitHubWebhookRecord;
  merge_group?: GitHubWebhookRecord;
  review?: GitHubWebhookRecord;
  release?: GitHubWebhookRecord;
  workflow_job?: GitHubWebhookRecord;
  workflow_run?: GitHubWebhookRecord;
  projects_v2?: GitHubWebhookRecord;
  projects_v2_status_update?: GitHubWebhookRecord;
  projects_v2_item?: GitHubWebhookRecord;
  alert?: GitHubWebhookRecord;
  blocked_issue?: GitHubWebhookRecord;
  blocking_issue?: GitHubWebhookRecord;
  parent_issue?: GitHubWebhookRecord;
  sub_issue?: GitHubWebhookRecord;
  changes?: GitHubWebhookRecord;
  head_commit?: GitHubWebhookRecord;
  [key: string]: unknown;
}

type GitHubWebhookRecord = Record<string, unknown>;

export interface NormalizedGitHubWebhookPayload {
  provider: 'github';
  event: string;
  action: string;
  repository?: NormalizedGitHubRepository;
  organization?: NormalizedGitHubOrganization;
  actor?: NormalizedGitHubActor;
  assignee?: NormalizedGitHubActor;
  requestedReviewer?: NormalizedGitHubActor;
  requestedTeam?: NormalizedGitHubTeam;
  installation?: NormalizedGitHubInstallation;
  resource: NormalizedGitHubResource;
  label?: NormalizedGitHubLabel;
  milestone?: NormalizedGitHubMilestone;
  pullRequest?: NormalizedGitHubResource;
  pullRequests?: NormalizedGitHubResource[];
  changes?: NormalizedGitHubChange[];
  comment?: NormalizedGitHubComment;
  requestedAction?: NormalizedGitHubRequestedAction;
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

export interface NormalizedGitHubOrganization {
  id?: string;
  login?: string;
  url?: string;
}

export interface NormalizedGitHubTeam {
  id?: string;
  name?: string;
  slug?: string;
  url?: string;
}

export interface NormalizedGitHubInstallation {
  id?: string;
}

export interface NormalizedGitHubLabel {
  id?: string;
  name?: string;
  color?: string;
  description?: string;
}

export interface NormalizedGitHubMilestone {
  id?: string;
  number?: number;
  title?: string;
  dueOn?: string;
  url?: string;
}

export interface NormalizedGitHubChange {
  field: string;
  fieldName?: string;
  fieldType?: string;
  from?: string;
  to?: string;
}

export interface NormalizedGitHubResource {
  type: string;
  id: string;
  number?: number;
  name?: string;
  title?: string;
  state?: string;
  merged?: boolean;
  status?: string;
  conclusion?: string;
  context?: string;
  url?: string;
  headRef?: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  contentType?: string;
  contentNodeId?: string;
  nodeId?: string;
  ref?: string;
  refType?: string;
  beforeSha?: string;
  headCommitMessage?: string;
  body?: string;
  projectNodeId?: string;
  environment?: string;
  statusId?: string;
  runId?: string;
  startDate?: string;
  targetDate?: string;
  tagName?: string;
  draft?: boolean;
  prerelease?: boolean;
  labels?: string[];
  severity?: string;
  relationship?: string;
  issueNumber?: number;
  issueUrl?: string;
  relatedIssueNumber?: number;
  relatedIssueUrl?: string;
  isResolved?: boolean;
  path?: string;
  line?: number;
  side?: string;
  startLine?: number;
  startSide?: string;
}

export interface NormalizedGitHubComment {
  id: string;
  body?: string;
  url?: string;
  author?: string;
  reviewId?: string;
  path?: string;
  line?: number;
  side?: string;
  startLine?: number;
  startSide?: string;
  originalLine?: number;
  originalStartLine?: number;
}

export interface NormalizedGitHubRequestedAction {
  identifier?: string;
  label?: string;
  description?: string;
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
      subjectFromReviewThread(payload) ??
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

  if (payload.projects_v2) {
    return subjectFromProject(payload) ?? subjectFromRepository(payload, name);
  }

  if (payload.projects_v2_status_update) {
    return subjectFromProjectStatusUpdate(payload) ?? subjectFromRepository(payload, name);
  }

  if (payload.release) {
    return subjectFromRelease(payload) ?? subjectFromRepository(payload, name);
  }

  if (isCommitStatusPayload(payload)) {
    return subjectFromResource(resourceFromCommitStatus(payload));
  }

  if (payload.deployment || payload.deployment_status) {
    return subjectFromResource(resourceFromDeployment(payload));
  }

  if (payload.merge_group) {
    return subjectFromResource(resourceFromMergeGroup(payload.merge_group));
  }

  if (payload.workflow_job) {
    return subjectFromResource(resourceFromWorkflowJob(payload.workflow_job));
  }

  if (payload.alert) {
    return subjectFromResource(resourceFromSecurityAlert(payload.alert));
  }

  if (isIssueRelationPayload(payload)) {
    return subjectFromResource(resourceFromIssueRelation(payload));
  }

  if (name === 'github.push') {
    return subjectFromPush(payload) ?? subjectFromRepository(payload, name);
  }

  if (name === 'github.create' || name === 'github.delete') {
    return subjectFromRef(payload) ?? subjectFromRepository(payload, name);
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
  const type = isPullRequestIssue(payload.issue) ? 'pull_request' : 'issue';
  return {
    type,
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

function subjectFromProject(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.projects_v2) {
    return undefined;
  }

  return {
    type: 'project',
    id: String(payload.projects_v2.id ?? payload.projects_v2.number ?? 'unknown'),
    ...(typeof payload.projects_v2.html_url === 'string' ? { url: payload.projects_v2.html_url } : {}),
  };
}

function subjectFromProjectStatusUpdate(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.projects_v2_status_update) {
    return undefined;
  }

  return {
    type: 'project_status_update',
    id: String(payload.projects_v2_status_update.id ?? 'unknown'),
    ...(typeof payload.projects_v2_status_update.html_url === 'string'
      ? { url: payload.projects_v2_status_update.html_url }
      : {}),
  };
}

function subjectFromRelease(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.release) {
    return undefined;
  }

  return {
    type: 'release',
    id: String(payload.release.id ?? payload.release.tag_name ?? 'unknown'),
    ...(typeof payload.release.html_url === 'string' ? { url: payload.release.html_url } : {}),
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

function subjectFromReviewThread(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  if (!payload.thread) {
    return undefined;
  }

  return {
    type: 'review_thread',
    id: String(payload.thread.id ?? 'unknown'),
  };
}

function subjectFromPush(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  const after = stringField(payload, 'after');
  if (!after) {
    return undefined;
  }

  return {
    type: 'push',
    id: after,
    ...(typeof payload.head_commit?.url === 'string' ? { url: payload.head_commit.url } : {}),
  };
}

function subjectFromRef(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  const ref = stringField(payload, 'ref');
  const refType = stringField(payload, 'ref_type');
  if (!ref) {
    return undefined;
  }

  return {
    type: 'ref',
    id: `${refType ?? 'unknown'}:${ref}`,
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

function subjectFromResource(resource: NormalizedGitHubResource): RainrailEventEnvelope['subject'] {
  return {
    type: resource.type,
    id: resource.id,
    ...(resource.url ? { url: resource.url } : {}),
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
  const organization = normalizedOrganization(payload.organization);
  const actor = normalizedActor(payload.sender);
  const assignee = normalizedActor(payload.assignee);
  const requestedReviewer = normalizedActor(payload.requested_reviewer);
  const requestedTeam = normalizedTeam(payload.requested_team);
  const installation = normalizedInstallation(payload.installation);
  const resource = normalizedResource(payload);
  const label = normalizedLabel(payload.label);
  const milestone = normalizedMilestone(
    recordField(payload.issue, 'milestone') ?? recordField(payload.pull_request, 'milestone'),
  );
  const pullRequest = normalizedRelatedPullRequest(payload, resource);
  const pullRequests = normalizedRelatedPullRequests(payload);
  const changes = normalizedChanges(payload.changes);
  const comment = normalizedComment(payload.comment);
  const requestedAction = normalizedRequestedAction(payload.requested_action);

  return {
    provider: 'github',
    event: normalizeToken(githubEvent) || 'unknown',
    action: typeof payload.action === 'string' ? normalizeToken(payload.action) || 'received' : 'received',
    ...(repository ? { repository } : {}),
    ...(organization ? { organization } : {}),
    ...(actor ? { actor } : {}),
    ...(assignee ? { assignee } : {}),
    ...(requestedReviewer ? { requestedReviewer } : {}),
    ...(requestedTeam ? { requestedTeam } : {}),
    ...(installation ? { installation } : {}),
    resource,
    ...(label ? { label } : {}),
    ...(milestone ? { milestone } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(pullRequests.length > 0 ? { pullRequests } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(comment ? { comment } : {}),
    ...(requestedAction ? { requestedAction } : {}),
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

function normalizedOrganization(
  organization: GitHubWebhookRecord | undefined,
): NormalizedGitHubOrganization | undefined {
  if (!organization) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(organization, 'id')),
    ...optionalStringProperty('login', stringField(organization, 'login')),
    ...optionalStringProperty('url', stringField(organization, 'html_url')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedTeam(team: GitHubWebhookRecord | undefined): NormalizedGitHubTeam | undefined {
  if (!team) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(team, 'id')),
    ...optionalStringProperty('name', stringField(team, 'name')),
    ...optionalStringProperty('slug', stringField(team, 'slug')),
    ...optionalStringProperty('url', stringField(team, 'html_url')),
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

function normalizedLabel(label: GitHubWebhookRecord | undefined): NormalizedGitHubLabel | undefined {
  if (!label) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(label, 'id')),
    ...optionalStringProperty('name', stringField(label, 'name')),
    ...optionalStringProperty('color', stringField(label, 'color')),
    ...optionalStringProperty('description', stringField(label, 'description')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedMilestone(milestone: GitHubWebhookRecord | undefined): NormalizedGitHubMilestone | undefined {
  if (!milestone) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('id', idField(milestone, 'id')),
    ...optionalNumberProperty('number', numberField(milestone, 'number')),
    ...optionalStringProperty('title', stringField(milestone, 'title')),
    ...optionalStringProperty('dueOn', stringField(milestone, 'due_on')),
    ...optionalStringProperty('url', stringField(milestone, 'html_url')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function normalizedResource(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  if (isCommitStatusPayload(payload)) {
    return resourceFromCommitStatus(payload);
  }

  if (payload.deployment || payload.deployment_status) {
    return resourceFromDeployment(payload);
  }

  if (payload.merge_group) {
    return resourceFromMergeGroup(payload.merge_group);
  }

  if (payload.workflow_job) {
    return resourceFromWorkflowJob(payload.workflow_job);
  }

  if (payload.alert) {
    return resourceFromSecurityAlert(payload.alert);
  }

  if (isIssueRelationPayload(payload)) {
    return resourceFromIssueRelation(payload);
  }

  if (stringField(payload, 'ref') && stringField(payload, 'after')) {
    return resourceFromPush(payload);
  }

  if (stringField(payload, 'ref') && stringField(payload, 'ref_type')) {
    return resourceFromRef(payload);
  }

  if (payload.thread) {
    return resourceFromReviewThread(payload.thread);
  }

  if (payload.review) {
    return resourceFromReview(payload.review);
  }

  if (payload.pull_request) {
    return resourceFromPullRequest(payload.pull_request);
  }

  if (payload.issue) {
    return resourceFromIssue(payload.issue);
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

  if (payload.projects_v2) {
    return resourceFromProject(payload.projects_v2);
  }

  if (payload.projects_v2_status_update) {
    return resourceFromProjectStatusUpdate(payload.projects_v2_status_update);
  }

  if (payload.release) {
    return resourceFromRelease(payload.release);
  }

  return resourceFromRepository(payload.repository);
}

function resourceFromIssue(issue: GitHubWebhookRecord): NormalizedGitHubResource {
  const number = numberField(issue, 'number');
  return {
    type: isPullRequestIssue(issue) ? 'pull_request' : 'issue',
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
    ...optionalBooleanProperty('merged', booleanField(pullRequest, 'merged')),
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

function resourceFromReviewThread(thread: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'review_thread',
    id: String(thread.id ?? 'unknown'),
    ...optionalBooleanProperty('isResolved', booleanField(thread, 'is_resolved')),
    ...optionalStringProperty('path', stringField(thread, 'path')),
    ...optionalNumberProperty('line', numberField(thread, 'line')),
    ...optionalStringProperty('side', stringField(thread, 'side')),
    ...optionalNumberProperty('startLine', numberField(thread, 'start_line')),
    ...optionalStringProperty('startSide', stringField(thread, 'start_side')),
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

function resourceFromCommitStatus(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const sha = stringField(payload, 'sha') ?? 'unknown';

  return {
    type: 'commit_status',
    id: sha,
    ...optionalStringProperty('headSha', stringField(payload, 'sha')),
    ...optionalStringProperty('state', stringField(payload, 'state')),
    ...optionalStringProperty('context', stringField(payload, 'context')),
    ...optionalStringProperty('url', stringField(payload, 'target_url')),
  };
}

function resourceFromDeployment(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const deployment = payload.deployment;
  const deploymentStatus = payload.deployment_status;

  return {
    type: 'deployment',
    id: String(deployment?.id ?? 'unknown'),
    ...optionalStringProperty('ref', stringField(deployment, 'ref')),
    ...optionalStringProperty('headSha', stringField(deployment, 'sha')),
    ...optionalStringProperty('environment', stringField(deployment, 'environment')),
    ...optionalStringProperty('state', stringField(deploymentStatus, 'state')),
    ...optionalStringProperty('statusId', idField(deploymentStatus, 'id')),
    ...optionalStringProperty('url', stringField(deploymentStatus, 'target_url') ?? stringField(deployment, 'url')),
  };
}

function resourceFromMergeGroup(mergeGroup: GitHubWebhookRecord): NormalizedGitHubResource {
  const headSha = stringField(mergeGroup, 'head_sha') ?? 'unknown';

  return {
    type: 'merge_group',
    id: headSha,
    ...optionalStringProperty('headSha', stringField(mergeGroup, 'head_sha')),
    ...optionalStringProperty('headRef', stringField(mergeGroup, 'head_ref')),
    ...optionalStringProperty('baseRef', stringField(mergeGroup, 'base_ref')),
  };
}

function resourceFromWorkflowJob(workflowJob: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'workflow_job',
    id: String(workflowJob.id ?? 'unknown'),
    ...optionalStringProperty('runId', idField(workflowJob, 'run_id')),
    ...optionalStringProperty('name', stringField(workflowJob, 'name')),
    ...optionalStringProperty('status', stringField(workflowJob, 'status')),
    ...optionalStringProperty('conclusion', stringField(workflowJob, 'conclusion')),
    ...optionalStringArrayProperty('labels', stringArrayField(workflowJob, 'labels')),
    ...optionalStringProperty('url', stringField(workflowJob, 'html_url')),
  };
}

function resourceFromSecurityAlert(alert: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'security_alert',
    id: String(alert.number ?? alert.id ?? 'unknown'),
    ...optionalNumberProperty('number', numberField(alert, 'number')),
    ...optionalStringProperty('state', stringField(alert, 'state')),
    ...optionalStringProperty('severity', alertSeverity(alert)),
    ...optionalStringProperty('ref', stringField(alert, 'ref')),
    ...optionalStringProperty('url', stringField(alert, 'html_url')),
  };
}

function resourceFromIssueRelation(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const issue = payload.blocked_issue ?? payload.parent_issue;
  const relatedIssue = payload.blocking_issue ?? payload.sub_issue;
  const issueNumber = numberField(issue, 'number');
  const relatedIssueNumber = numberField(relatedIssue, 'number');

  return {
    type: 'issue_relation',
    id: `${issueNumber ?? 'unknown'}:${relatedIssueNumber ?? 'unknown'}`,
    ...optionalStringProperty('relationship', relationType(payload)),
    ...optionalNumberProperty('issueNumber', issueNumber),
    ...optionalStringProperty('issueUrl', stringField(issue, 'html_url')),
    ...optionalNumberProperty('relatedIssueNumber', relatedIssueNumber),
    ...optionalStringProperty('relatedIssueUrl', stringField(relatedIssue, 'html_url')),
  };
}

function resourceFromProjectItem(projectItem: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'project_item',
    id: String(projectItem.id ?? 'unknown'),
    ...optionalStringProperty('nodeId', stringField(projectItem, 'node_id')),
    ...optionalStringProperty('projectNodeId', stringField(projectItem, 'project_node_id')),
    ...optionalStringProperty('contentType', stringField(projectItem, 'content_type')),
    ...optionalStringProperty('contentNodeId', stringField(projectItem, 'content_node_id')),
  };
}

function resourceFromProject(project: GitHubWebhookRecord): NormalizedGitHubResource {
  const number = numberField(project, 'number');
  return {
    type: 'project',
    id: String(project.id ?? number ?? 'unknown'),
    ...(number === undefined ? {} : { number }),
    ...optionalStringProperty('title', stringField(project, 'title')),
    ...optionalStringProperty('url', stringField(project, 'html_url')),
  };
}

function resourceFromProjectStatusUpdate(statusUpdate: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'project_status_update',
    id: String(statusUpdate.id ?? 'unknown'),
    ...optionalStringProperty('body', stringField(statusUpdate, 'body')),
    ...optionalStringProperty('status', stringField(statusUpdate, 'status')),
    ...optionalStringProperty('startDate', stringField(statusUpdate, 'start_date')),
    ...optionalStringProperty('targetDate', stringField(statusUpdate, 'target_date')),
    ...optionalStringProperty('url', stringField(statusUpdate, 'html_url')),
    ...optionalStringProperty('projectNodeId', stringField(statusUpdate, 'project_node_id')),
  };
}

function resourceFromRelease(release: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'release',
    id: String(release.id ?? release.tag_name ?? 'unknown'),
    ...optionalStringProperty('tagName', stringField(release, 'tag_name')),
    ...optionalStringProperty('name', stringField(release, 'name')),
    ...optionalBooleanProperty('draft', booleanField(release, 'draft')),
    ...optionalBooleanProperty('prerelease', booleanField(release, 'prerelease')),
    ...optionalStringProperty('url', stringField(release, 'html_url')),
  };
}

function resourceFromPush(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const headCommit = payload.head_commit;
  const after = stringField(payload, 'after') ?? 'unknown';

  return {
    type: 'push',
    id: after,
    ...optionalStringProperty('ref', stringField(payload, 'ref')),
    ...optionalStringProperty('beforeSha', stringField(payload, 'before')),
    ...optionalStringProperty('headSha', stringField(payload, 'after')),
    ...optionalStringProperty('headCommitMessage', stringField(headCommit, 'message')),
    ...optionalStringProperty('url', stringField(headCommit, 'url')),
  };
}

function resourceFromRef(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const ref = stringField(payload, 'ref') ?? 'unknown';
  const refType = stringField(payload, 'ref_type') ?? 'unknown';

  return {
    type: 'ref',
    id: `${refType}:${ref}`,
    ref,
    refType,
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
    ...optionalStringProperty('path', stringField(comment, 'path')),
    ...optionalNumberProperty('line', numberField(comment, 'line')),
    ...optionalStringProperty('side', stringField(comment, 'side')),
    ...optionalNumberProperty('startLine', numberField(comment, 'start_line')),
    ...optionalStringProperty('startSide', stringField(comment, 'start_side')),
    ...optionalNumberProperty('originalLine', numberField(comment, 'original_line')),
    ...optionalNumberProperty('originalStartLine', numberField(comment, 'original_start_line')),
  };
}

function normalizedRelatedPullRequest(
  payload: GitHubWebhookPayload,
  resource: NormalizedGitHubResource,
): NormalizedGitHubResource | undefined {
  if (!payload.pull_request || resource.type === 'pull_request') {
    return undefined;
  }

  return resourceFromPullRequest(payload.pull_request);
}

function normalizedRelatedPullRequests(payload: GitHubWebhookPayload): NormalizedGitHubResource[] {
  const pullRequests = [
    ...arrayField(payload.check_run, 'pull_requests'),
    ...arrayField(payload.check_suite, 'pull_requests'),
    ...arrayField(payload.workflow_run, 'pull_requests'),
  ];

  return pullRequests.map(resourceFromPullRequest);
}

function normalizedChanges(changes: GitHubWebhookRecord | undefined): NormalizedGitHubChange[] {
  if (!changes) {
    return [];
  }

  return Object.entries(changes).map(([field, value]) => {
    const change = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as GitHubWebhookRecord)
      : undefined;

    return {
      field,
      ...optionalStringProperty('fieldName', stringField(change, 'field_name') ?? stringField(change, 'name')),
      ...optionalStringProperty('fieldType', stringField(change, 'field_type') ?? stringField(change, 'type')),
      ...optionalStringProperty('from', normalizedChangeValue(change?.from)),
      ...optionalStringProperty('to', normalizedChangeValue(change?.to)),
    };
  });
}

function normalizedChangeValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as GitHubWebhookRecord;
    return stringField(record, 'name') ?? stringField(record, 'title') ?? stringField(record, 'value') ?? idField(record, 'id');
  }

  return undefined;
}

function normalizedRequestedAction(
  requestedAction: GitHubWebhookRecord | undefined,
): NormalizedGitHubRequestedAction | undefined {
  if (!requestedAction) {
    return undefined;
  }

  const normalized = {
    ...optionalStringProperty('identifier', stringField(requestedAction, 'identifier')),
    ...optionalStringProperty('label', stringField(requestedAction, 'label')),
    ...optionalStringProperty('description', stringField(requestedAction, 'description')),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function recordField(record: GitHubWebhookRecord | undefined, key: string): GitHubWebhookRecord | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as GitHubWebhookRecord) : undefined;
}

function arrayField(record: GitHubWebhookRecord | undefined, key: string): GitHubWebhookRecord[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter(
      (item): item is GitHubWebhookRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    )
    : [];
}

function stringArrayField(record: GitHubWebhookRecord | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringField(record: GitHubWebhookRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(record: GitHubWebhookRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanField(record: GitHubWebhookRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
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

function optionalNumberProperty<TKey extends string>(key: TKey, value: number | undefined): Partial<Record<TKey, number>> {
  return value === undefined ? {} : { [key]: value } as Record<TKey, number>;
}

function optionalBooleanProperty<TKey extends string>(
  key: TKey,
  value: boolean | undefined,
): Partial<Record<TKey, boolean>> {
  return value === undefined ? {} : { [key]: value } as Record<TKey, boolean>;
}

function optionalStringArrayProperty<TKey extends string>(
  key: TKey,
  value: string[],
): Partial<Record<TKey, string[]>> {
  return value.length === 0 ? {} : { [key]: value } as Record<TKey, string[]>;
}

function isPullRequestIssue(issue: GitHubWebhookRecord | undefined): boolean {
  return recordField(issue, 'pull_request') !== undefined;
}

function isCommitStatusPayload(payload: GitHubWebhookPayload): boolean {
  return stringField(payload, 'sha') !== undefined && stringField(payload, 'state') !== undefined;
}

function isIssueRelationPayload(payload: GitHubWebhookPayload): boolean {
  return (
    (payload.blocked_issue !== undefined && payload.blocking_issue !== undefined) ||
    (payload.parent_issue !== undefined && payload.sub_issue !== undefined)
  );
}

function relationType(payload: GitHubWebhookPayload): string | undefined {
  if (payload.blocked_issue && payload.blocking_issue) {
    return 'blocked_by';
  }

  if (payload.parent_issue && payload.sub_issue) {
    return 'sub_issue';
  }

  return undefined;
}

function alertSeverity(alert: GitHubWebhookRecord): string | undefined {
  return (
    stringField(alert, 'severity') ??
    stringField(recordField(alert, 'rule'), 'security_severity_level') ??
    stringField(recordField(alert, 'security_advisory'), 'severity')
  );
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
