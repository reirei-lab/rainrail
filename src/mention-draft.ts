import type { RainrailEventEnvelope } from './events.js';
import type { ProjectMentionDraftInput, ProjectMentionDraftItem } from './task-queue.js';
import type { PluginRuntimeContext, WorkflowPlugin } from './workflow-plugin.js';
import { defineWorkflowPlugin } from './workflow-plugin.js';

export const mentionDraftMarker = '<!-- rainrail mention-draft -->';

export interface MentionDraftWorkflowOptions {
  assigneeLogin: string;
  addMentionDraftItem?: AddMentionDraftItem;
}

export interface MentionDraftRequest {
  commentUrl: string;
  body?: string;
  title: string;
  sourceTitle?: string;
  repository?: string;
  number?: number;
}

export type MentionDraftItemInput = ProjectMentionDraftInput;

export type MentionDraftItem = ProjectMentionDraftItem;

export type AddMentionDraftItem = (input: MentionDraftItemInput, context: PluginRuntimeContext) =>
  MentionDraftItem | Promise<MentionDraftItem>;

export interface MentionDraftResult {
  handled: boolean;
  reason: 'mention_draft_created' | 'mention_draft_already_exists' | 'event_does_not_mention_agent';
  mention?: MentionDraftRequest;
  draftItem?: MentionDraftItem;
}

export function createMentionDraftWorkflow(options: MentionDraftWorkflowOptions): WorkflowPlugin {
  return defineWorkflowPlugin({
    name: 'mention-draft',
    accepts: (event) => event.source.type === 'github'
      && (event.name === 'github.issue' || event.name === 'github.review'),
    async handle(event, context): Promise<MentionDraftResult> {
      const mention = mentionDraftRequestFromEvent(event, options.assigneeLogin);
      if (mention === undefined) {
        return { handled: false, reason: 'event_does_not_mention_agent' };
      }

      const draftItem = await addMentionDraftItem({
        title: mention.title,
        body: draftBody(mention, options.assigneeLogin),
        commentUrl: mention.commentUrl,
        targetAgentLogin: options.assigneeLogin,
        ...(mention.repository === undefined ? {} : { repository: mention.repository }),
        ...(mention.number === undefined ? {} : { number: mention.number }),
      }, context, options.addMentionDraftItem);

      return {
        handled: true,
        reason: draftItem.created ? 'mention_draft_created' : 'mention_draft_already_exists',
        mention,
        draftItem,
      };
    },
  });
}

export function mentionDraftRequestFromEvent(
  event: RainrailEventEnvelope,
  agentLogin: string,
): MentionDraftRequest | undefined {
  const payload = recordValue(event.payload);
  const actorLogin = loginFromRecord(recordValue(payload.actor));
  if (sameLogin(actorLogin, agentLogin)) {
    return undefined;
  }

  if (
    event.name === 'github.issue'
    && payload.event === 'issue_comment'
    && payload.action === 'created'
  ) {
    return requestFromComment({ event, payload, agentLogin });
  }

  if (
    event.name === 'github.review'
    && (payload.event === 'pull_request_review' || payload.event === 'pull_request_review_comment')
    && (payload.action === 'created' || payload.action === 'submitted')
  ) {
    return requestFromComment({ event, payload, agentLogin });
  }

  return undefined;
}

function requestFromComment(input: {
  event: RainrailEventEnvelope;
  payload: Record<string, unknown>;
  agentLogin: string;
}): MentionDraftRequest | undefined {
  const comment = commentRecord(input.payload);
  const resource = sourceResource(input.payload);
  const body = stringValue(comment.body);
  const commentUrl = stringValue(comment.url);
  const mentionedLogins = stringArrayValue(comment.mentionedLogins);
  const mentionsAgent = body === undefined
    ? mentionedLogins.some((login) => sameLogin(login, input.agentLogin))
    : mentionsLogin(body, input.agentLogin);
  if (commentUrl === undefined || !mentionsAgent) {
    return undefined;
  }

  const repository = repositoryName(input.payload) ?? input.event.source.repository;
  const number = numberValue(resource.number) ?? numberFromSubject(input.event);
  const sourceTitle = stringValue(resource.title);
  const titlePrefix = repository !== undefined && number !== undefined
    ? `${repository}#${number}`
    : 'GitHub mention';
  const title = sourceTitle === undefined
    ? `Respond to ${titlePrefix}`
    : `Respond to ${titlePrefix}: ${sourceTitle}`;

  return {
    commentUrl,
    ...(body === undefined ? {} : { body }),
    title: title.slice(0, 256),
    ...(sourceTitle === undefined ? {} : { sourceTitle }),
    ...(repository === undefined ? {} : { repository }),
    ...(number === undefined ? {} : { number }),
  };
}

function commentRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const comment = recordValue(payload.comment);
  if (Object.keys(comment).length > 0) return comment;
  const review = recordValue(payload.review);
  if (Object.keys(review).length > 0) return review;
  const resource = recordValue(payload.resource);
  if (resource.type === 'review') return resource;
  return {};
}

function sourceResource(payload: Record<string, unknown>): Record<string, unknown> {
  const resource = recordValue(payload.resource);
  if (resource.type === 'review') {
    const pullRequest = recordValue(payload.pullRequest);
    if (Object.keys(pullRequest).length > 0) return pullRequest;
  }
  return resource;
}

function draftBody(mention: MentionDraftRequest, targetAgentLogin: string): string {
  return [
    mentionDraftMarker,
    `Mention URL: ${mention.commentUrl}`,
    `Agent: ${targetAgentLogin}`,
    mention.repository === undefined ? undefined : `Repository: ${mention.repository}`,
    mention.number === undefined ? undefined : `Number: ${mention.number}`,
    mention.sourceTitle === undefined ? undefined : `Source title: ${mention.sourceTitle}`,
    '',
    mention.body,
  ].flatMap((line) => line === undefined ? [] : [line]).join('\n');
}

function defaultAddMentionDraftItem(_input: MentionDraftItemInput): never {
  throw new Error('mention draft workflow requires addMentionDraftItem or providers.queue.addMentionDraftItem');
}

async function addMentionDraftItem(
  input: MentionDraftItemInput,
  context: PluginRuntimeContext,
  override: AddMentionDraftItem | undefined,
): Promise<MentionDraftItem> {
  if (override !== undefined) {
    return override(input, context);
  }
  if (context.providers.queue?.addMentionDraftItem !== undefined) {
    return context.providers.queue.addMentionDraftItem(input);
  }
  return defaultAddMentionDraftItem(input);
}

function mentionsLogin(body: string, login: string): boolean {
  const pattern = new RegExp(`(^|[^\\w-])@${escapeRegExp(login)}($|[^\\w-])`, 'iu');
  return pattern.test(body);
}

function repositoryName(payload: Record<string, unknown>): string | undefined {
  const repository = recordValue(payload.repository);
  return stringValue(repository.fullName)
    ?? stringValue(repository.full_name)
    ?? stringValue(repository.nameWithOwner);
}

function numberFromSubject(event: RainrailEventEnvelope): number | undefined {
  return /^\d+$/u.test(event.subject.id) ? Number(event.subject.id) : undefined;
}

function sameLogin(left: string | undefined, right: string): boolean {
  return left !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function loginFromRecord(record: Record<string, unknown>): string | undefined {
  return stringValue(record.login);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
