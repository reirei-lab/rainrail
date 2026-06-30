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
  client_payload?: unknown;
  inputs?: unknown;
  workflow?: unknown;
  branch?: unknown;
  ref?: unknown;
  installation?: GitHubWebhookRecord;
  organization?: GitHubWebhookRecord;
  label?: GitHubWebhookRecord;
  repository?: GitHubWebhookRecord;
  issue?: GitHubWebhookRecord;
  pull_request?: GitHubWebhookRecord;
  comment?: GitHubWebhookRecord | string;
  thread?: GitHubWebhookRecord;
  requested_action?: GitHubWebhookRecord;
  check_run?: GitHubWebhookRecord;
  check_suite?: GitHubWebhookRecord;
  deployment?: GitHubWebhookRecord;
  deployment_status?: GitHubWebhookRecord;
  workflow_job_run?: GitHubWebhookRecord;
  workflow_job_runs?: GitHubWebhookRecord[];
  reviewers?: GitHubWebhookRecord[];
  approver?: GitHubWebhookRecord;
  merge_group?: GitHubWebhookRecord;
  review?: GitHubWebhookRecord;
  release?: GitHubWebhookRecord;
  workflow_job?: GitHubWebhookRecord;
  workflow_run?: GitHubWebhookRecord;
  projects_v2?: GitHubWebhookRecord;
  projects_v2_status_update?: GitHubWebhookRecord;
  projects_v2_item?: GitHubWebhookRecord;
  project?: GitHubWebhookRecord;
  project_card?: GitHubWebhookRecord;
  project_column?: GitHubWebhookRecord;
  personal_access_token_request?: GitHubWebhookRecord;
  alert?: GitHubWebhookRecord;
  location?: GitHubWebhookRecord;
  security_advisory?: GitHubWebhookRecord;
  repository_advisory?: GitHubWebhookRecord;
  discussion?: GitHubWebhookRecord;
  answer?: GitHubWebhookRecord;
  rule?: GitHubWebhookRecord;
  repository_ruleset?: GitHubWebhookRecord;
  package?: GitHubWebhookRecord;
  registry_package?: GitHubWebhookRecord;
  forkee?: GitHubWebhookRecord;
  key?: GitHubWebhookRecord;
  milestone?: GitHubWebhookRecord;
  member?: GitHubWebhookRecord;
  team?: GitHubWebhookRecord;
  build?: GitHubWebhookRecord;
  blocked_user?: GitHubWebhookRecord;
  definition?: GitHubWebhookRecord;
  membership?: GitHubWebhookRecord;
  account?: GitHubWebhookRecord;
  hook?: GitHubWebhookRecord;
  marketplace_purchase?: GitHubWebhookRecord;
  previous_marketplace_purchase?: GitHubWebhookRecord;
  sponsorship?: GitHubWebhookRecord;
  blocked_issue?: GitHubWebhookRecord;
  blocking_issue?: GitHubWebhookRecord;
  parent_issue?: GitHubWebhookRecord;
  sub_issue?: GitHubWebhookRecord;
  repositories?: GitHubWebhookRecord[];
  repositories_added?: GitHubWebhookRecord[];
  repositories_removed?: GitHubWebhookRecord[];
  pages?: GitHubWebhookRecord[];
  old_property_values?: GitHubWebhookRecord[];
  new_property_values?: GitHubWebhookRecord[];
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
  repositories?: NormalizedGitHubRepository[];
  pages?: NormalizedGitHubWikiPage[];
  changes?: NormalizedGitHubChange[];
  comment?: NormalizedGitHubComment;
  dispatch?: NormalizedGitHubDispatch;
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

export interface NormalizedGitHubWikiPage {
  name?: string;
  title?: string;
  action?: string;
  sha?: string;
  url?: string;
}

export interface NormalizedGitHubChange {
  field: string;
  fieldNodeId?: string;
  fieldName?: string;
  fieldType?: string;
  from?: string;
  to?: string;
}

export interface NormalizedGitHubDispatch {
  eventType?: string;
  ref?: string;
  branch?: string;
  workflow?: string;
  clientPayload?: unknown;
  inputs?: unknown;
}

export interface NormalizedGitHubAffectedPackage {
  ecosystem?: string;
  name?: string;
  vulnerableVersionRange?: string;
  patchedVersions?: string;
}

export interface NormalizedGitHubResource {
  type: string;
  id: string;
  number?: number;
  name?: string;
  title?: string;
  description?: string;
  color?: string;
  dueOn?: string;
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
  jobId?: string;
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
  commitId?: string;
  position?: number;
  callbackUrl?: string;
  locationType?: string;
  endLine?: number;
  ghsaId?: string;
  summary?: string;
  categoryName?: string;
  categorySlug?: string;
  answerId?: string;
  answerUrl?: string;
  action?: string;
  packageType?: string;
  packageName?: string;
  version?: string;
  versionId?: string;
  manifestPath?: string;
  dependencyScope?: string;
  secretType?: string;
  secretTypeDisplayName?: string;
  validity?: string;
  resolution?: string;
  affectedPackages?: NormalizedGitHubAffectedPackage[];
  reviewerLogins?: string[];
  approver?: string;
  requester?: string;
  target?: string;
  enforcement?: string;
  fullName?: string;
  owner?: string;
  permissions?: unknown;
  login?: string;
  email?: string;
  invitationId?: string;
  teamSlug?: string;
  teamName?: string;
  role?: string;
  targetType?: string;
  valueType?: string;
  required?: boolean;
  hookType?: string;
  account?: string;
  planName?: string;
  previousPlanName?: string;
  effectiveDate?: string;
  sponsorLogin?: string;
  sponsorableLogin?: string;
  tierName?: string;
  readOnly?: boolean;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  columnId?: string;
  projectUrl?: string;
  errorMessage?: string;
  scanType?: string;
  source?: string;
  completedAt?: string;
  secretTypes?: string[];
  branches?: string[];
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
  commitId?: string;
  position?: number;
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

  if (isDeploymentProtectionRulePayload(payload)) {
    return subjectFromResource(resourceFromDeploymentProtectionRule(payload));
  }

  if (payload.deployment || payload.deployment_status) {
    return subjectFromResource(resourceFromDeployment(payload));
  }

  if (payload.issue) {
    return subjectFromIssue(payload);
  }

  if (payload.pull_request) {
    return subjectFromPullRequest(payload);
  }

  if (isStandaloneLabelPayload(payload)) {
    return subjectFromResource(resourceFromLabel(payload.label));
  }

  if (payload.milestone && !payload.issue && !payload.pull_request) {
    return subjectFromResource(resourceFromMilestone(payload.milestone));
  }

  if (payload.personal_access_token_request) {
    return subjectFromResource(resourceFromPersonalAccessTokenRequest(payload.personal_access_token_request));
  }

  if (name === 'github.github_app_authorization') {
    return subjectFromResource(resourceFromGitHubAppAuthorization(payload.sender));
  }

  if (isMemberTeamPayload(payload)) {
    return subjectFromResource(resourceFromMemberTeam(payload));
  }

  if (payload.build) {
    return subjectFromResource(resourceFromPageBuild(payload.build));
  }

  if (payload.blocked_user) {
    return subjectFromResource(resourceFromOrgBlock(payload.blocked_user));
  }

  if (payload.definition) {
    return subjectFromResource(resourceFromCustomProperty(payload.definition));
  }

  if (payload.membership) {
    return subjectFromResource(resourceFromOrganizationMembership(payload.membership));
  }

  if (isOrganizationInvitationPayload(payload)) {
    return subjectFromResource(resourceFromOrganizationInvitation(payload));
  }

  if (isInstallationTargetPayload(payload)) {
    return subjectFromResource(resourceFromInstallationTarget(payload));
  }

  if (payload.hook || payload.hook_id !== undefined) {
    return subjectFromResource(resourceFromMetaHook(payload));
  }

  if (payload.marketplace_purchase) {
    return subjectFromResource(resourceFromMarketplacePurchase(payload));
  }

  if (payload.sponsorship) {
    return subjectFromResource(resourceFromSponsorship(payload.sponsorship));
  }

  if (isRepositoryImportPayload(payload)) {
    return subjectFromResource(resourceFromRepositoryImport(payload));
  }

  if (isSecretScanningScanPayload(payload)) {
    return subjectFromResource(resourceFromSecretScanningScan(payload));
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

  if (payload.project || payload.project_card || payload.project_column) {
    return subjectFromResource(resourceFromClassicProject(payload));
  }

  if (payload.release) {
    return subjectFromRelease(payload) ?? subjectFromRepository(payload, name);
  }

  if (payload.discussion) {
    return subjectFromResource(resourceFromDiscussion(payload));
  }

  if (isDeploymentReviewPayload(payload)) {
    return subjectFromResource(resourceFromDeploymentReview(payload));
  }

  if (isCommitStatusPayload(payload)) {
    return subjectFromResource(resourceFromCommitStatus(payload));
  }

  if (payload.merge_group) {
    return subjectFromResource(resourceFromMergeGroup(payload.merge_group));
  }

  if (payload.workflow_job) {
    return subjectFromResource(resourceFromWorkflowJob(payload.workflow_job));
  }

  if (payload.alert) {
    return subjectFromResource(resourceFromSecurityAlert(payload));
  }

  if (payload.security_advisory) {
    return subjectFromResource(resourceFromSecurityAdvisory(payload.security_advisory));
  }

  if (payload.repository_advisory) {
    return subjectFromResource(resourceFromSecurityAdvisory(payload.repository_advisory, 'repository_advisory'));
  }

  if (isCommitCommentPayload(payload)) {
    return subjectFromResource(resourceFromCommitComment(payload.comment));
  }

  if (isDeploymentProtectionRulePayload(payload)) {
    return subjectFromResource(resourceFromDeploymentProtectionRule(payload));
  }

  if (isIssueRelationPayload(payload)) {
    return subjectFromResource(resourceFromIssueRelation(payload));
  }

  if (payload.rule) {
    return subjectFromResource(resourceFromBranchProtectionRule(payload.rule));
  }

  if (payload.repository_ruleset) {
    return subjectFromResource(resourceFromRepositoryRuleset(payload.repository_ruleset));
  }

  if (payload.package || payload.registry_package) {
    return subjectFromResource(resourceFromPackage(payload.package ?? payload.registry_package));
  }

  if (payload.forkee) {
    return subjectFromResource(resourceFromFork(payload.forkee));
  }

  if (payload.key) {
    return subjectFromResource(resourceFromDeployKey(payload.key));
  }

  if (isOrganizationResourcePayload(payload)) {
    return subjectFromResource(resourceFromOrganization(payload.organization));
  }

  if (isInstallationResourcePayload(payload)) {
    return subjectFromResource(resourceFromInstallation(payload.installation));
  }

  if (payload.pages) {
    return subjectFromResource(resourceFromWikiPage(arrayField(payload, 'pages')[0]));
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
    id: String(payload.thread.node_id ?? payload.thread.id ?? 'unknown'),
  };
}

function subjectFromPush(payload: GitHubWebhookPayload): RainrailEventEnvelope['subject'] | undefined {
  const after = stringField(payload, 'after');
  if (!after) {
    return undefined;
  }

  return {
    type: 'push',
    id: pushResourceId(payload, after),
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
  const resource = normalizedResource(githubEvent, payload);
  const label = normalizedLabel(payload.label);
  const milestone = normalizedMilestone(
    payload.milestone ?? recordField(payload.issue, 'milestone') ?? recordField(payload.pull_request, 'milestone'),
  );
  const pullRequest = normalizedRelatedPullRequest(payload, resource);
  const pullRequests = normalizedRelatedPullRequests(payload);
  const repositories = normalizedInstallationRepositories(payload);
  const pages = normalizedWikiPages(payload);
  const changes = [
    ...normalizedChanges(payload.changes),
    ...normalizedCustomPropertyChanges(payload),
  ];
  const comment = normalizedComment(payload.comment);
  const dispatch = normalizedDispatch(githubEvent, payload);
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
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(pages.length > 0 ? { pages } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(comment ? { comment } : {}),
    ...(dispatch ? { dispatch } : {}),
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

function normalizedResource(githubEvent: string, payload: GitHubWebhookPayload): NormalizedGitHubResource {
  if (isDeploymentProtectionRulePayload(payload)) {
    return resourceFromDeploymentProtectionRule(payload);
  }

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

  if (isDeploymentReviewPayload(payload)) {
    return resourceFromDeploymentReview(payload);
  }

  if (payload.alert) {
    return resourceFromSecurityAlert(payload);
  }

  if (payload.security_advisory) {
    return resourceFromSecurityAdvisory(payload.security_advisory);
  }

  if (payload.repository_advisory) {
    return resourceFromSecurityAdvisory(payload.repository_advisory, 'repository_advisory');
  }

  if (isCommitCommentPayload(payload)) {
    return resourceFromCommitComment(payload.comment);
  }

  if (isIssueRelationPayload(payload)) {
    return resourceFromIssueRelation(payload);
  }

  if (payload.milestone && !payload.issue && !payload.pull_request) {
    return resourceFromMilestone(payload.milestone);
  }

  if (isStandaloneLabelPayload(payload)) {
    return resourceFromLabel(payload.label);
  }

  if (payload.personal_access_token_request) {
    return resourceFromPersonalAccessTokenRequest(payload.personal_access_token_request);
  }

  if (normalizeToken(githubEvent) === 'github_app_authorization') {
    return resourceFromGitHubAppAuthorization(payload.sender);
  }

  if (isMemberTeamPayload(payload)) {
    return resourceFromMemberTeam(payload);
  }

  if (payload.build) {
    return resourceFromPageBuild(payload.build);
  }

  if (payload.blocked_user) {
    return resourceFromOrgBlock(payload.blocked_user);
  }

  if (payload.definition) {
    return resourceFromCustomProperty(payload.definition);
  }

  if (payload.membership) {
    return resourceFromOrganizationMembership(payload.membership);
  }

  if (isOrganizationInvitationPayload(payload)) {
    return resourceFromOrganizationInvitation(payload);
  }

  if (isInstallationTargetPayload(payload)) {
    return resourceFromInstallationTarget(payload);
  }

  if (payload.hook || payload.hook_id !== undefined) {
    return resourceFromMetaHook(payload);
  }

  if (payload.marketplace_purchase) {
    return resourceFromMarketplacePurchase(payload);
  }

  if (payload.sponsorship) {
    return resourceFromSponsorship(payload.sponsorship);
  }

  if (isRepositoryImportPayload(payload)) {
    return resourceFromRepositoryImport(payload);
  }

  if (isSecretScanningScanPayload(payload)) {
    return resourceFromSecretScanningScan(payload);
  }

  if (payload.rule) {
    return resourceFromBranchProtectionRule(payload.rule);
  }

  if (payload.repository_ruleset) {
    return resourceFromRepositoryRuleset(payload.repository_ruleset);
  }

  if (payload.package || payload.registry_package) {
    return resourceFromPackage(payload.package ?? payload.registry_package);
  }

  if (payload.forkee) {
    return resourceFromFork(payload.forkee);
  }

  if (payload.key) {
    return resourceFromDeployKey(payload.key);
  }

  if (payload.pages) {
    return resourceFromWikiPage(arrayField(payload, 'pages')[0]);
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
    return resourceFromPullRequest(payload.pull_request, payload);
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

  if (payload.project || payload.project_card || payload.project_column) {
    return resourceFromClassicProject(payload);
  }

  if (payload.release) {
    return resourceFromRelease(payload.release);
  }

  if (payload.discussion) {
    return resourceFromDiscussion(payload);
  }

  if (isOrganizationResourcePayload(payload)) {
    return resourceFromOrganization(payload.organization);
  }

  if (isInstallationResourcePayload(payload)) {
    return resourceFromInstallation(payload.installation);
  }

  return resourceFromRepository(payload.repository);
}

function resourceFromIssue(issue: GitHubWebhookRecord): NormalizedGitHubResource {
  const number = numberField(issue, 'number');
  const labels = arrayField(issue, 'labels')
    .map((label) => stringField(label, 'name'))
    .filter((label): label is string => label !== undefined);

  return {
    type: isPullRequestIssue(issue) ? 'pull_request' : 'issue',
    id: String(number ?? issue.id ?? 'unknown'),
    ...(number === undefined ? {} : { number }),
    ...optionalStringProperty('title', stringField(issue, 'title')),
    ...optionalStringProperty('state', stringField(issue, 'state')),
    ...optionalStringArrayProperty('labels', labels),
    ...optionalStringProperty('url', stringField(issue, 'html_url')),
  };
}

function resourceFromMilestone(milestone: GitHubWebhookRecord): NormalizedGitHubResource {
  const normalized = normalizedMilestone(milestone);

  return {
    type: 'milestone',
    id: normalized?.id ?? String(milestone.id ?? milestone.number ?? 'unknown'),
    ...(normalized?.number === undefined ? {} : { number: normalized.number }),
    ...optionalStringProperty('title', normalized?.title),
    ...optionalStringProperty('dueOn', normalized?.dueOn),
    ...optionalStringProperty('url', normalized?.url),
  };
}

function resourceFromPersonalAccessTokenRequest(request: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'personal_access_token_request',
    id: String(request.id ?? 'unknown'),
    ...optionalStringProperty('owner', stringField(recordField(request, 'owner'), 'login')),
    ...(request.permissions === undefined ? {} : { permissions: request.permissions }),
    ...optionalStringProperty('url', stringField(request, 'html_url')),
  };
}

function resourceFromPullRequest(
  pullRequest: GitHubWebhookRecord,
  payload?: GitHubWebhookPayload,
): NormalizedGitHubResource {
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
    ...optionalBooleanProperty('draft', booleanField(pullRequest, 'draft')),
    ...optionalStringProperty('url', stringField(pullRequest, 'html_url')),
    ...optionalStringProperty('headRef', stringField(head, 'ref')),
    ...optionalStringProperty('beforeSha', stringField(payload, 'before')),
    ...optionalStringProperty('headSha', stringField(payload, 'after') ?? stringField(head, 'sha')),
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
  const firstComment = arrayField(thread, 'comments')[0];

  return {
    type: 'review_thread',
    id: String(thread.node_id ?? thread.id ?? 'unknown'),
    ...optionalStringProperty('nodeId', stringField(thread, 'node_id')),
    ...optionalBooleanProperty('isResolved', booleanField(thread, 'is_resolved')),
    ...optionalStringProperty('path', stringField(thread, 'path') ?? stringField(firstComment, 'path')),
    ...optionalNumberProperty('line', numberField(thread, 'line') ?? numberField(firstComment, 'line')),
    ...optionalStringProperty('side', stringField(thread, 'side') ?? stringField(firstComment, 'side')),
    ...optionalNumberProperty('startLine', numberField(thread, 'start_line') ?? numberField(firstComment, 'start_line')),
    ...optionalStringProperty('startSide', stringField(thread, 'start_side') ?? stringField(firstComment, 'start_side')),
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
  const statusId = idField(payload, 'id');
  const branches = arrayField(payload, 'branches')
    .map((branch) => stringField(branch, 'name'))
    .filter((branch): branch is string => branch !== undefined);

  return {
    type: 'commit_status',
    id: statusId ?? sha,
    ...optionalStringProperty('headSha', stringField(payload, 'sha')),
    ...optionalStringProperty('state', stringField(payload, 'state')),
    ...optionalStringProperty('context', stringField(payload, 'context')),
    ...optionalStringProperty('description', stringField(payload, 'description')),
    ...optionalStringArrayProperty('branches', branches),
    ...optionalStringProperty('url', stringField(payload, 'target_url')),
  };
}

function resourceFromLabel(label: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  const normalized = normalizedLabel(label);

  return {
    type: 'label',
    id: normalized?.id ?? normalized?.name ?? 'unknown',
    ...optionalStringProperty('name', normalized?.name),
    ...optionalStringProperty('color', normalized?.color),
    ...optionalStringProperty('description', normalized?.description),
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
  const deployment = recordField(workflowJob, 'deployment');

  return {
    type: 'workflow_job',
    id: String(workflowJob.id ?? 'unknown'),
    ...optionalStringProperty('runId', idField(workflowJob, 'run_id')),
    ...optionalStringProperty('name', stringField(workflowJob, 'name')),
    ...optionalStringProperty('status', stringField(workflowJob, 'status')),
    ...optionalStringProperty('conclusion', stringField(workflowJob, 'conclusion')),
    ...optionalStringArrayProperty('labels', stringArrayField(workflowJob, 'labels')),
    ...optionalStringProperty('environment', stringField(deployment, 'environment')),
    ...optionalStringProperty('ref', stringField(deployment, 'ref')),
    ...optionalStringProperty('headRef', stringField(workflowJob, 'head_branch')),
    ...optionalStringProperty('headSha', stringField(deployment, 'sha') ?? stringField(workflowJob, 'head_sha')),
    ...optionalStringProperty('url', stringField(workflowJob, 'html_url')),
  };
}

function resourceFromDeploymentReview(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const workflowRun = payload.workflow_run;
  const workflowJobRun = payload.workflow_job_run ?? arrayField(payload, 'workflow_job_runs')[0];
  const jobId = idField(workflowJobRun, 'id');
  const runId = idField(workflowRun, 'id') ?? workflowRunIdFromJobUrl(stringField(workflowJobRun, 'html_url'));
  const environment = stringField(workflowJobRun, 'environment') ?? stringField(payload, 'environment') ?? 'unknown';
  const reviewerLogins = arrayField(payload, 'reviewers')
    .map((wrapper) => {
      const reviewer = recordField(wrapper, 'reviewer') ?? wrapper;
      return stringField(reviewer, 'login') ?? stringField(reviewer, 'slug') ?? stringField(reviewer, 'name');
    })
    .filter((login): login is string => login !== undefined);

  return {
    type: 'deployment_review',
    id: `${runId ?? jobId ?? 'unknown'}:${environment}`,
    ...optionalStringProperty('runId', runId),
    ...optionalStringProperty('jobId', jobId),
    ...optionalStringProperty('environment', environment === 'unknown' ? undefined : environment),
    ...optionalStringArrayProperty('reviewerLogins', reviewerLogins),
    ...optionalStringProperty('approver', stringField(payload.approver, 'login')),
    ...optionalStringProperty('requester', stringField(recordField(payload, 'requester'), 'login')),
    ...optionalStringProperty('body', deploymentReviewComment(payload.comment)),
    ...optionalStringProperty('url', stringField(workflowRun, 'html_url')),
  };
}

function resourceFromSecurityAlert(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const alert = payload.alert ?? {};
  const location = payload.location;
  const locationDetails = recordField(location, 'details');
  const codeScanningLocation =
    recordField(recordField(alert, 'most_recent_instance'), 'location') ??
    recordField(arrayField(alert, 'instances')[0], 'location');
  const dependency = recordField(alert, 'dependency');
  const dependencyPackage = recordField(dependency, 'package');

  return {
    type: 'security_alert',
    id: String(alert.number ?? alert.id ?? 'unknown'),
    ...optionalNumberProperty('number', numberField(alert, 'number')),
    ...optionalStringProperty('state', stringField(alert, 'state')),
    ...optionalStringProperty('severity', alertSeverity(alert)),
    ...optionalStringProperty('ref', stringField(payload, 'ref') ?? stringField(alert, 'ref')),
    ...optionalStringProperty('headSha', stringField(payload, 'commit_oid') ?? stringField(locationDetails, 'commit_sha')),
    ...optionalStringProperty('locationType', stringField(location, 'type')),
    ...optionalStringProperty('path', stringField(locationDetails, 'path') ?? stringField(codeScanningLocation, 'path')),
    ...optionalNumberProperty('startLine', numberField(locationDetails, 'start_line') ?? numberField(codeScanningLocation, 'start_line')),
    ...optionalNumberProperty('endLine', numberField(locationDetails, 'end_line') ?? numberField(codeScanningLocation, 'end_line')),
    ...optionalStringProperty('secretType', stringField(alert, 'secret_type')),
    ...optionalStringProperty('secretTypeDisplayName', stringField(alert, 'secret_type_display_name')),
    ...optionalStringProperty('validity', stringField(alert, 'validity')),
    ...optionalStringProperty('resolution', stringField(alert, 'resolution')),
    ...optionalStringProperty('packageName', stringField(dependencyPackage, 'name')),
    ...optionalStringProperty('packageType', stringField(dependencyPackage, 'ecosystem')),
    ...optionalStringProperty('manifestPath', stringField(dependency, 'manifest_path')),
    ...optionalStringProperty('dependencyScope', stringField(dependency, 'scope')),
    ...optionalStringProperty('url', stringField(alert, 'html_url')),
  };
}

function resourceFromSecurityAdvisory(
  advisory: GitHubWebhookRecord,
  type = 'security_advisory',
): NormalizedGitHubResource {
  const ghsaId = stringField(advisory, 'ghsa_id');
  const affectedPackages = arrayField(advisory, 'vulnerabilities')
    .map(normalizedAffectedPackage)
    .filter((affectedPackage): affectedPackage is NormalizedGitHubAffectedPackage => affectedPackage !== undefined);

  return {
    type,
    id: ghsaId ?? String(advisory.id ?? 'unknown'),
    ...optionalStringProperty('ghsaId', ghsaId),
    ...optionalStringProperty('summary', stringField(advisory, 'summary')),
    ...optionalStringProperty('severity', stringField(advisory, 'severity')),
    ...(affectedPackages.length > 0 ? { affectedPackages } : {}),
    ...optionalStringProperty('url', stringField(advisory, 'html_url')),
  };
}

function normalizedAffectedPackage(vulnerability: GitHubWebhookRecord): NormalizedGitHubAffectedPackage | undefined {
  const advisoryPackage = recordField(vulnerability, 'package');
  const firstPatchedVersion = recordField(vulnerability, 'first_patched_version');
  const normalized = {
    ...optionalStringProperty('ecosystem', stringField(advisoryPackage, 'ecosystem')),
    ...optionalStringProperty('name', stringField(advisoryPackage, 'name')),
    ...optionalStringProperty('vulnerableVersionRange', stringField(vulnerability, 'vulnerable_version_range')),
    ...optionalStringProperty(
      'patchedVersions',
      stringField(vulnerability, 'patched_versions') ?? stringField(firstPatchedVersion, 'identifier'),
    ),
  };

  return objectHasKeys(normalized) ? normalized : undefined;
}

function resourceFromDiscussion(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const discussion = payload.discussion ?? {};
  const number = numberField(discussion, 'number');
  const category = recordField(discussion, 'category');
  const answer = payload.answer;

  return {
    type: 'discussion',
    id: String(number ?? discussion.id ?? 'unknown'),
    ...(number === undefined ? {} : { number }),
    ...optionalStringProperty('title', stringField(discussion, 'title')),
    ...optionalStringProperty('url', stringField(discussion, 'html_url')),
    ...optionalStringProperty('categoryName', stringField(category, 'name')),
    ...optionalStringProperty('categorySlug', stringField(category, 'slug')),
    ...optionalStringProperty('answerId', idField(answer, 'id')),
    ...optionalStringProperty('answerUrl', stringField(answer, 'html_url')),
  };
}

function resourceFromBranchProtectionRule(rule: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'branch_protection_rule',
    id: String(rule.id ?? rule.node_id ?? rule.name ?? 'unknown'),
    ...optionalStringProperty('nodeId', stringField(rule, 'node_id')),
    ...optionalStringProperty('name', stringField(rule, 'name')),
  };
}

function resourceFromRepositoryRuleset(ruleset: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'repository_ruleset',
    id: String(ruleset.id ?? ruleset.node_id ?? 'unknown'),
    ...optionalStringProperty('nodeId', stringField(ruleset, 'node_id')),
    ...optionalStringProperty('name', stringField(ruleset, 'name')),
    ...optionalStringProperty('target', stringField(ruleset, 'target')),
    ...optionalStringProperty('enforcement', stringField(ruleset, 'enforcement')),
    ...optionalStringProperty('url', stringField(ruleset, 'html_url')),
  };
}

function resourceFromPackage(pkg: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  const version = recordField(pkg, 'package_version');

  return {
    type: 'package',
    id: String(pkg?.id ?? 'unknown'),
    ...optionalStringProperty('name', stringField(pkg, 'name')),
    ...optionalStringProperty('packageType', stringField(pkg, 'package_type')),
    ...optionalStringProperty('version', stringField(version, 'name')),
    ...optionalStringProperty('versionId', idField(version, 'id')),
    ...optionalStringProperty('url', stringField(pkg, 'html_url') ?? stringField(version, 'html_url')),
  };
}

function resourceFromFork(forkee: GitHubWebhookRecord): NormalizedGitHubResource {
  const fullName = stringField(forkee, 'full_name');
  const nameParts = fullName?.split('/');

  return {
    type: 'fork',
    id: String(forkee.id ?? fullName ?? 'unknown'),
    ...optionalStringProperty('fullName', fullName),
    ...optionalStringProperty('owner', stringField(recordField(forkee, 'owner'), 'login') ?? nameParts?.[0]),
    ...optionalStringProperty('name', stringField(forkee, 'name') ?? nameParts?.[1]),
    ...optionalStringProperty('url', stringField(forkee, 'html_url')),
  };
}

function resourceFromDeployKey(key: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'deploy_key',
    id: String(key.id ?? 'unknown'),
    ...optionalStringProperty('title', stringField(key, 'title')),
    ...optionalBooleanProperty('readOnly', booleanField(key, 'read_only')),
    ...optionalStringProperty('url', stringField(key, 'url')),
  };
}

function resourceFromMemberTeam(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const member = payload.member;
  const team = payload.team;
  const memberId = idField(member, 'id');
  const teamId = idField(team, 'id');

  if (member && team) {
    return {
      type: 'membership',
      id: `${memberId ?? 'unknown'}:${teamId ?? 'unknown'}`,
      ...optionalStringProperty('login', stringField(member, 'login')),
      ...optionalStringProperty('url', stringField(member, 'html_url')),
      ...optionalStringProperty('teamSlug', stringField(team, 'slug')),
      ...optionalStringProperty('teamName', stringField(team, 'name')),
    };
  }

  if (member) {
    return {
      type: 'member',
      id: memberId ?? 'unknown',
      ...optionalStringProperty('login', stringField(member, 'login')),
      ...optionalStringProperty('url', stringField(member, 'html_url')),
    };
  }

  return {
    type: 'team',
    id: teamId ?? 'unknown',
    ...optionalStringProperty('teamSlug', stringField(team, 'slug')),
    ...optionalStringProperty('teamName', stringField(team, 'name')),
    ...optionalStringProperty('url', stringField(team, 'html_url')),
  };
}

function resourceFromOrgBlock(blockedUser: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'org_block',
    id: idField(blockedUser, 'id') ?? stringField(blockedUser, 'login') ?? 'unknown',
    ...optionalStringProperty('login', stringField(blockedUser, 'login')),
    ...optionalStringProperty('url', stringField(blockedUser, 'html_url')),
  };
}

function resourceFromCustomProperty(definition: GitHubWebhookRecord): NormalizedGitHubResource {
  const name = stringField(definition, 'property_name') ?? stringField(definition, 'name');

  return {
    type: 'custom_property',
    id: name ?? 'unknown',
    ...optionalStringProperty('name', name),
    ...optionalStringProperty('valueType', stringField(definition, 'value_type')),
    ...optionalBooleanProperty('required', booleanField(definition, 'required')),
  };
}

function resourceFromOrganizationMembership(membership: GitHubWebhookRecord): NormalizedGitHubResource {
  const user = recordField(membership, 'user');

  return {
    type: 'organization_membership',
    id: idField(user, 'id') ?? stringField(user, 'login') ?? 'unknown',
    ...optionalStringProperty('login', stringField(user, 'login')),
    ...optionalStringProperty('role', stringField(membership, 'role')),
    ...optionalStringProperty('url', stringField(user, 'html_url')),
  };
}

function resourceFromOrganizationInvitation(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const user = recordField(payload, 'user');
  const invitation = recordField(payload, 'invitation');

  return {
    type: 'organization_invitation',
    id: idField(user, 'id') ?? idField(invitation, 'id') ?? stringField(user, 'login') ?? stringField(invitation, 'email') ?? 'unknown',
    ...optionalStringProperty('invitationId', idField(invitation, 'id')),
    ...optionalStringProperty('login', stringField(user, 'login')),
    ...optionalStringProperty('email', stringField(invitation, 'email')),
    ...optionalStringProperty('url', stringField(user, 'html_url')),
  };
}

function resourceFromOrganization(organization: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  return {
    type: 'organization',
    id: idField(organization, 'id') ?? stringField(organization, 'login') ?? 'unknown',
    ...optionalStringProperty('login', stringField(organization, 'login')),
    ...optionalStringProperty('url', stringField(organization, 'html_url')),
  };
}

function resourceFromGitHubAppAuthorization(sender: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  return {
    type: 'github_app_authorization',
    id: idField(sender, 'id') ?? stringField(sender, 'login') ?? 'unknown',
    ...optionalStringProperty('login', stringField(sender, 'login')),
    ...optionalStringProperty('url', stringField(sender, 'html_url')),
  };
}

function resourceFromInstallationTarget(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const account = payload.account;

  return {
    type: 'installation_target',
    id: idField(account, 'id') ?? stringField(account, 'login') ?? 'unknown',
    ...optionalStringProperty('login', stringField(account, 'login')),
    ...optionalStringProperty('targetType', stringField(payload, 'target_type')),
    ...optionalStringProperty('url', stringField(account, 'html_url')),
  };
}

function resourceFromMetaHook(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  return {
    type: 'webhook',
    id: idField(payload, 'hook_id') ?? idField(payload.hook, 'id') ?? 'unknown',
    ...optionalStringProperty('hookType', stringField(payload.hook, 'type')),
  };
}

function resourceFromMarketplacePurchase(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const purchase = payload.marketplace_purchase ?? {};
  const previousPurchase = payload.previous_marketplace_purchase;
  const account = recordField(purchase, 'account');
  const plan = recordField(purchase, 'plan');
  const previousPlan = recordField(previousPurchase, 'plan');

  return {
    type: 'marketplace_purchase',
    id: stringField(account, 'login') ?? idField(account, 'id') ?? 'unknown',
    ...optionalStringProperty('account', stringField(account, 'login')),
    ...optionalStringProperty('planName', stringField(plan, 'name')),
    ...optionalStringProperty('previousPlanName', stringField(previousPlan, 'name')),
    ...optionalStringProperty('effectiveDate', stringField(payload, 'effective_date')),
  };
}

function resourceFromSponsorship(sponsorship: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'sponsorship',
    id: idField(sponsorship, 'id') ?? idField(sponsorship, 'node_id') ?? 'unknown',
    ...optionalStringProperty('sponsorLogin', stringField(recordField(sponsorship, 'sponsor'), 'login')),
    ...optionalStringProperty('sponsorableLogin', stringField(recordField(sponsorship, 'sponsorable'), 'login')),
    ...optionalStringProperty('tierName', stringField(recordField(sponsorship, 'tier'), 'name')),
  };
}

function resourceFromPageBuild(build: GitHubWebhookRecord): NormalizedGitHubResource {
  return {
    type: 'page_build',
    id: String(build.id ?? 'unknown'),
    ...optionalStringProperty('status', stringField(build, 'status')),
    ...optionalStringProperty('errorMessage', stringField(recordField(build, 'error'), 'message')),
    ...optionalStringProperty('url', stringField(build, 'url')),
  };
}

function resourceFromRepositoryImport(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const repository = normalizedRepository(payload.repository);

  return {
    type: 'repository_import',
    id: repository?.fullName ?? repository?.id ?? 'unknown',
    ...optionalStringProperty('status', stringField(payload, 'status')),
    ...optionalStringProperty('url', stringField(payload, 'url')),
  };
}

function resourceFromSecretScanningScan(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const scanType = stringField(payload, 'type');
  const source = stringField(payload, 'source');
  const secretTypes = Array.isArray(payload.secret_types) ? stringArrayField(payload, 'secret_types') : undefined;

  return {
    type: 'secret_scanning_scan',
    id: `${scanType ?? 'unknown'}:${source ?? 'unknown'}`,
    ...optionalStringProperty('scanType', scanType),
    ...optionalStringProperty('source', source),
    ...optionalStringProperty('completedAt', stringField(payload, 'completed_at')),
    ...(secretTypes === undefined ? {} : { secretTypes }),
  };
}

function resourceFromInstallation(installation: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  return {
    type: 'installation',
    id: String(installation?.id ?? 'unknown'),
  };
}

function resourceFromWikiPage(page: GitHubWebhookRecord | undefined): NormalizedGitHubResource {
  const name = stringField(page, 'page_name') ?? stringField(page, 'title');

  return {
    type: 'wiki_page',
    id: name ?? stringField(page, 'sha') ?? 'unknown',
    ...optionalStringProperty('name', name),
    ...optionalStringProperty('title', stringField(page, 'title')),
    ...optionalStringProperty('action', stringField(page, 'action')),
    ...optionalStringProperty('headSha', stringField(page, 'sha')),
    ...optionalStringProperty('url', stringField(page, 'html_url')),
  };
}

function resourceFromCommitComment(comment: unknown): NormalizedGitHubResource {
  return {
    type: 'commit_comment',
    id: idField(comment, 'id') ?? 'unknown',
    ...optionalStringProperty('commitId', stringField(comment, 'commit_id')),
    ...optionalStringProperty('path', stringField(comment, 'path')),
    ...optionalNumberProperty('position', numberField(comment, 'position')),
    ...optionalStringProperty('url', stringField(comment, 'html_url')),
  };
}

function resourceFromDeploymentProtectionRule(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  const environment = stringField(payload, 'environment') ?? 'unknown';
  const sha = stringField(payload, 'sha') ?? 'unknown';

  return {
    type: 'deployment_protection_rule',
    id: `${environment}:${sha}`,
    ...optionalStringProperty('environment', stringField(payload, 'environment')),
    ...optionalStringProperty('ref', stringField(payload, 'ref')),
    ...optionalStringProperty('headSha', stringField(payload, 'sha')),
    ...optionalStringProperty('callbackUrl', stringField(payload, 'deployment_callback_url')),
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

function resourceFromClassicProject(payload: GitHubWebhookPayload): NormalizedGitHubResource {
  if (payload.project_card) {
    return {
      type: 'project_card',
      id: String(payload.project_card.id ?? 'unknown'),
      ...optionalStringProperty('body', stringField(payload.project_card, 'note')),
      ...optionalStringProperty('columnId', idField(payload.project_card, 'column_id')),
      ...optionalStringProperty('projectUrl', stringField(payload.project_card, 'project_url')),
      ...optionalStringProperty('url', stringField(payload.project_card, 'html_url')),
    };
  }

  if (payload.project_column) {
    return {
      type: 'project_column',
      id: String(payload.project_column.id ?? 'unknown'),
      ...optionalStringProperty('name', stringField(payload.project_column, 'name')),
      ...optionalStringProperty('projectUrl', stringField(payload.project_column, 'project_url')),
      ...optionalStringProperty('url', stringField(payload.project_column, 'html_url')),
    };
  }

  const project = payload.project ?? {};
  return {
    type: 'project',
    id: String(project.id ?? 'unknown'),
    ...optionalStringProperty('name', stringField(project, 'name')),
    ...optionalStringProperty('body', stringField(project, 'body')),
    ...optionalStringProperty('state', stringField(project, 'state')),
    ...optionalStringProperty('url', stringField(project, 'html_url')),
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
  const id = pushResourceId(payload, after);

  return {
    type: 'push',
    id,
    ...optionalStringProperty('ref', stringField(payload, 'ref')),
    ...optionalStringProperty('beforeSha', stringField(payload, 'before')),
    ...optionalStringProperty('headSha', stringField(payload, 'after')),
    ...optionalBooleanProperty('created', booleanField(payload, 'created')),
    ...optionalBooleanProperty('deleted', booleanField(payload, 'deleted')),
    ...optionalBooleanProperty('forced', booleanField(payload, 'forced')),
    ...optionalStringProperty('headCommitMessage', stringField(headCommit, 'message')),
    ...optionalStringProperty('url', stringField(headCommit, 'url')),
  };
}

function pushResourceId(payload: GitHubWebhookPayload, after: string): string {
  if (booleanField(payload, 'deleted')) {
    return stringField(payload, 'ref') ?? stringField(payload, 'before') ?? after;
  }

  return after;
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

function normalizedComment(comment: unknown): NormalizedGitHubComment | undefined {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
    return undefined;
  }
  const record = comment as GitHubWebhookRecord;

  return {
    id: String(record.id ?? 'unknown'),
    ...optionalStringProperty('body', stringField(record, 'body')),
    ...optionalStringProperty('url', stringField(record, 'html_url')),
    ...optionalStringProperty('author', stringField(recordField(record, 'user'), 'login')),
    ...optionalStringProperty('reviewId', idField(record, 'pull_request_review_id')),
    ...optionalStringProperty('path', stringField(record, 'path')),
    ...optionalNumberProperty('line', numberField(record, 'line')),
    ...optionalStringProperty('side', stringField(record, 'side')),
    ...optionalNumberProperty('startLine', numberField(record, 'start_line')),
    ...optionalStringProperty('startSide', stringField(record, 'start_side')),
    ...optionalNumberProperty('originalLine', numberField(record, 'original_line')),
    ...optionalNumberProperty('originalStartLine', numberField(record, 'original_start_line')),
    ...optionalStringProperty('commitId', stringField(record, 'commit_id')),
    ...optionalNumberProperty('position', numberField(record, 'position')),
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
    ...arrayField(payload, 'pull_requests'),
    ...arrayField(payload.check_run, 'pull_requests'),
    ...arrayField(payload.check_suite, 'pull_requests'),
    ...arrayField(payload.workflow_run, 'pull_requests'),
  ];

  return pullRequests.map((pullRequest) => resourceFromPullRequest(pullRequest));
}

function normalizedInstallationRepositories(payload: GitHubWebhookPayload): NormalizedGitHubRepository[] {
  const repositories = [
    ...arrayField(payload, 'repositories'),
    ...arrayField(payload, 'repositories_added'),
    ...arrayField(payload, 'repositories_removed'),
    ...arrayField(payload.personal_access_token_request, 'repositories'),
  ];

  return repositories
    .map(normalizedRepository)
    .filter((repository): repository is NormalizedGitHubRepository => repository !== undefined);
}

function normalizedWikiPages(payload: GitHubWebhookPayload): NormalizedGitHubWikiPage[] {
  return arrayField(payload, 'pages')
    .map((page) => {
      const normalized = {
        ...optionalStringProperty('name', stringField(page, 'page_name')),
        ...optionalStringProperty('title', stringField(page, 'title')),
        ...optionalStringProperty('action', stringField(page, 'action')),
        ...optionalStringProperty('sha', stringField(page, 'sha')),
        ...optionalStringProperty('url', stringField(page, 'html_url')),
      };

      return objectHasKeys(normalized) ? normalized : undefined;
    })
    .filter((page): page is NormalizedGitHubWikiPage => page !== undefined);
}

function normalizedChanges(changes: GitHubWebhookRecord | undefined): NormalizedGitHubChange[] {
  if (!changes) {
    return [];
  }

  return normalizedChangeEntries(changes);
}

function normalizedChangeEntries(changes: GitHubWebhookRecord, prefix?: string): NormalizedGitHubChange[] {
  return Object.entries(changes).flatMap(([field, value]) => {
    const fieldPath = prefix ? `${prefix}.${field}` : field;
    const change = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as GitHubWebhookRecord)
      : undefined;

    if (!change) {
      return [{ field: fieldPath }];
    }

    if (!isChangeLeaf(change)) {
      const nestedChanges = normalizedChangeEntries(change, fieldPath);
      return nestedChanges.length > 0 ? nestedChanges : [{ field: fieldPath }];
    }

    return [{
      field: fieldPath,
      ...optionalStringProperty('fieldNodeId', stringField(change, 'field_node_id')),
      ...optionalStringProperty('fieldName', stringField(change, 'field_name') ?? stringField(change, 'name')),
      ...optionalStringProperty('fieldType', stringField(change, 'field_type') ?? stringField(change, 'type')),
      ...optionalStringProperty('from', normalizedChangeValue(change.from)),
      ...optionalStringProperty('to', normalizedChangeValue(change.to)),
    }];
  });
}

function isChangeLeaf(change: GitHubWebhookRecord): boolean {
  return (
    Object.hasOwn(change, 'from') ||
    Object.hasOwn(change, 'to') ||
    Object.hasOwn(change, 'field_node_id') ||
    Object.hasOwn(change, 'field_name') ||
    Object.hasOwn(change, 'field_type') ||
    Object.hasOwn(change, 'type')
  );
}

function normalizedCustomPropertyChanges(payload: GitHubWebhookPayload): NormalizedGitHubChange[] {
  const oldValues = new Map(
    arrayField(payload, 'old_property_values')
      .map((property) => [
        stringField(property, 'property_name') ?? stringField(property, 'name'),
        normalizedChangeValue(property.value),
      ] as const)
      .filter((entry): entry is readonly [string, string | undefined] => entry[0] !== undefined),
  );

  return arrayField(payload, 'new_property_values')
    .map((property) => {
      const field = stringField(property, 'property_name') ?? stringField(property, 'name');
      if (!field) {
        return undefined;
      }

      return {
        field,
        ...optionalStringProperty('from', oldValues.get(field)),
        ...optionalStringProperty('to', normalizedChangeValue(property.value)),
      };
    })
    .filter((change): change is NormalizedGitHubChange => change !== undefined);
}

function normalizedDispatch(
  githubEvent: string,
  payload: GitHubWebhookPayload,
): NormalizedGitHubDispatch | undefined {
  const normalizedEvent = normalizeToken(githubEvent);
  if (normalizedEvent !== 'repository_dispatch' && normalizedEvent !== 'workflow_dispatch') {
    return undefined;
  }

  return {
    ...optionalStringProperty('eventType', typeof payload.action === 'string' ? payload.action : undefined),
    ...optionalStringProperty('ref', stringField(payload, 'ref') ?? stringField(payload, 'branch')),
    ...optionalStringProperty('branch', stringField(payload, 'branch')),
    ...optionalStringProperty('workflow', stringField(payload, 'workflow')),
    ...(payload.client_payload === undefined ? {} : { clientPayload: payload.client_payload }),
    ...(payload.inputs === undefined ? {} : { inputs: payload.inputs }),
  };
}

function normalizedChangeValue(value: unknown): string | undefined {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as GitHubWebhookRecord;
    return stringField(record, 'name') ??
      stringField(record, 'title') ??
      stringField(record, 'value') ??
      stringField(record, 'login') ??
      stringField(recordField(record, 'user'), 'login') ??
      idField(record, 'id');
  }

  return undefined;
}

function deploymentReviewComment(comment: unknown): string | undefined {
  if (typeof comment === 'string' && comment.trim()) {
    return comment;
  }

  return stringField(comment, 'body');
}

function workflowRunIdFromJobUrl(url: string | undefined): string | undefined {
  return url?.match(/\/actions\/runs\/([^/]+)\/job\//)?.[1];
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

function recordField(record: unknown, key: string): GitHubWebhookRecord | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as GitHubWebhookRecord)[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as GitHubWebhookRecord) : undefined;
}

function arrayField(record: unknown, key: string): GitHubWebhookRecord[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [];
  }
  const value = (record as GitHubWebhookRecord)[key];
  return Array.isArray(value)
    ? value.filter(
      (item): item is GitHubWebhookRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    )
    : [];
}

function stringArrayField(record: unknown, key: string): string[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [];
  }
  const value = (record as GitHubWebhookRecord)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as GitHubWebhookRecord)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as GitHubWebhookRecord)[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanField(record: unknown, key: string): boolean | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as GitHubWebhookRecord)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function idField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as GitHubWebhookRecord)[key];
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

function isCommitCommentPayload(payload: GitHubWebhookPayload): boolean {
  return (
    stringField(payload.comment, 'commit_id') !== undefined &&
    !payload.issue &&
    !payload.pull_request &&
    !payload.review &&
    !payload.thread
  );
}

function isDeploymentProtectionRulePayload(payload: GitHubWebhookPayload): boolean {
  return (
    stringField(payload, 'deployment_callback_url') !== undefined ||
    (stringField(payload, 'environment') !== undefined && stringField(payload, 'sha') !== undefined)
  );
}

function isDeploymentReviewPayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.workflow_run !== undefined &&
    (
      payload.workflow_job_run !== undefined ||
      arrayField(payload, 'workflow_job_runs').length > 0 ||
      arrayField(payload, 'reviewers').length > 0 ||
      payload.approver !== undefined ||
      stringField(payload, 'environment') !== undefined ||
      payload.requester !== undefined
    )
  );
}

function isStandaloneLabelPayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.label !== undefined &&
    payload.issue === undefined &&
    payload.pull_request === undefined &&
    payload.discussion === undefined
  );
}

function isInstallationResourcePayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.installation !== undefined &&
    (
      payload.repository === undefined ||
      arrayField(payload, 'repositories').length > 0 ||
      arrayField(payload, 'repositories_added').length > 0 ||
      arrayField(payload, 'repositories_removed').length > 0
    )
  );
}

function isInstallationRepositoriesPayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.installation !== undefined &&
    (
      arrayField(payload, 'repositories').length > 0 ||
      arrayField(payload, 'repositories_added').length > 0 ||
      arrayField(payload, 'repositories_removed').length > 0
    )
  );
}

function isOrganizationResourcePayload(payload: GitHubWebhookPayload): boolean {
  return payload.organization !== undefined && payload.repository === undefined && payload.membership === undefined;
}

function isOrganizationInvitationPayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.organization !== undefined &&
    payload.repository === undefined &&
    (payload.invitation !== undefined || payload.user !== undefined)
  );
}

function isMemberTeamPayload(payload: GitHubWebhookPayload): boolean {
  return recordField(payload, 'member') !== undefined || recordField(payload, 'team') !== undefined;
}

function isInstallationTargetPayload(payload: GitHubWebhookPayload): boolean {
  return payload.account !== undefined && stringField(payload, 'target_type') !== undefined;
}

function isRepositoryImportPayload(payload: GitHubWebhookPayload): boolean {
  return (
    payload.repository !== undefined &&
    stringField(payload, 'status') !== undefined
  );
}

function isSecretScanningScanPayload(payload: GitHubWebhookPayload): boolean {
  return stringField(payload, 'completed_at') !== undefined;
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
    stringField(recordField(alert, 'rule'), 'severity') ??
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
