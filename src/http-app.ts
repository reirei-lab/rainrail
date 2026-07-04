import { rainrailEventsAuthErrorResponse, verifyRainrailEventsBearerToken } from './events-auth.js';
import type { RainrailEventEnvelope } from './events.js';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  corsPreflightResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readFetchRequestBody,
  textResponse,
  withCors,
} from './http-utils.js';
import {
  createRainrailIntakeRegistry,
  type RainrailIntakeAdapter,
  type RainrailIntakeRegistry,
} from './intake-adapter.js';
import type {
  RainrailOperationalStore,
  StoredActivityEvent,
  StoredAgentTask,
  StoredEventHandlerRetry,
  StoredOperationalEvent,
} from './operational-store.js';

export type RainrailDashboardScope = 'read-only' | 'operator' | 'admin';

export interface RainrailDashboardAuthOptions {
  readOnlyToken?: string;
  operatorToken?: string;
  adminToken?: string;
}

export interface RainrailCommandRequest {
  actionType: RainrailCommandActionType;
  targetType: RainrailCommandTargetType;
  targetId: string;
  actor: string;
  client?: string;
  requestId: string;
  dryRun: boolean;
  inputs: Record<string, unknown>;
}

export type RainrailCommandActionType =
  | 'agent_task_resume'
  | 'agent_task_reset'
  | 'agent_task_terminate'
  | 'agent_task_terminate_all'
  | 'queue_assign_next'
  | 'settings_update';

export type RainrailCommandTargetType = 'agent_task' | 'agent_tasks' | 'queue' | 'settings';

export type RainrailCommandHandler = (command: RainrailCommandRequest) => unknown | Promise<unknown>;

export interface RainrailBridgeRoomFetchTarget {
  fetch(request: Request): Response | Promise<Response>;
}

export interface RainrailHttpAppOptions {
  room: RainrailBridgeRoomFetchTarget;
  publishToken: string;
  eventsBearerToken?: string;
  runtime?: string;
  intakeAdapters?: readonly RainrailIntakeAdapter[];
  operationalStore?: RainrailOperationalStore;
  dashboardCommandMaxBodyBytes?: number;
  dashboardAuth?: RainrailDashboardAuthOptions;
  commandHandler?: RainrailCommandHandler;
}

export interface RainrailHttpApp {
  fetch(request: Request): Promise<Response>;
  tail?(events: unknown[]): Promise<unknown>;
}

const INTERNAL_ROOM_ORIGIN = 'https://rainrail-room.local';

export function createRainrailHttpApp(options: RainrailHttpAppOptions): RainrailHttpApp {
  assertUniqueDashboardTokenScopes(options);
  const intakeRegistry = createRainrailIntakeRegistry(options.intakeAdapters);

  return {
    async fetch(request): Promise<Response> {
      try {
        return withCors(await routeRainrailHttpRequest(request, options, intakeRegistry));
      } catch {
        return jsonResponse({ error: 'internal_server_error' }, { status: 500 });
      }
    },

    ...(intakeRegistry.tail === undefined ? {} : {
      async tail(events): Promise<unknown> {
        return intakeRegistry.tail?.(events, {
          publish: (event) => publishEvent(options, event),
        });
      },
    }),
  };
}

export function shouldReadRainrailHttpRequestBody(
  pathname: string,
  method: string,
  options: RainrailHttpAppOptions,
): boolean {
  return isDashboardCommandRoute(pathname, method)
    || createRainrailIntakeRegistry(options.intakeAdapters).routeNeedsBody(pathname, method);
}

export function rainrailHttpRequestBodyLimit(
  pathname: string,
  method: string,
  options: RainrailHttpAppOptions,
): number | undefined {
  if (isDashboardCommandRoute(pathname, method)) return options.dashboardCommandMaxBodyBytes;
  return createRainrailIntakeRegistry(options.intakeAdapters).routeBodyLimit(pathname, method);
}

async function routeRainrailHttpRequest(
  request: Request,
  options: RainrailHttpAppOptions,
  intakeRegistry: RainrailIntakeRegistry,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(preflightMethodsForPath(url.pathname, intakeRegistry));
  }

  if (url.pathname === '/healthz') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const roomResponse = await options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/healthz`));
    if (!roomResponse.ok) {
      return jsonResponse({ error: 'room_health_unavailable' }, { status: 502 });
    }

    return jsonResponse({
      ok: true,
      runtime: options.runtime ?? 'fetch',
      room: await roomResponse.json(),
    });
  }

  if (url.pathname === '/events') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyRainrailEventsBearerToken(request, options.eventsBearerToken);
    if (!auth.ok) return rainrailEventsAuthErrorResponse(auth);

    return options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/events`, {
      headers: bridgeAuthorizationHeaders(request, options.publishToken),
      signal: request.signal,
    }));
  }

  if (url.pathname === '/api/state') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardStateResponse(url, options);
  }

  if (url.pathname === '/api/v1/overview') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1OverviewResponse(options);
  }

  if (url.pathname === '/api/v1/events') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1EventsResponse(url, options);
  }

  const v1EventDetailMatch = /^\/api\/v1\/events\/([^/]+)$/.exec(url.pathname);
  if (v1EventDetailMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    const eventId = safeDecodeURIComponent(v1EventDetailMatch[1]!);
    if (eventId === undefined) {
      return jsonResponse({ error: 'invalid_event_id' }, { status: 400 });
    }

    return dashboardV1EventDetailResponse(eventId, options);
  }

  if (url.pathname === '/api/v1/workflow-runs') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1WorkflowRunsResponse(url, options);
  }

  const v1WorkflowRunDetailMatch = /^\/api\/v1\/workflow-runs\/([^/]+)$/.exec(url.pathname);
  if (v1WorkflowRunDetailMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    const workflowRunId = safeDecodeURIComponent(v1WorkflowRunDetailMatch[1]!);
    if (workflowRunId === undefined) {
      return jsonResponse({ error: 'invalid_workflow_run_id' }, { status: 400 });
    }

    return dashboardV1WorkflowRunDetailResponse(workflowRunId, options);
  }

  if (url.pathname === '/api/v1/agent-tasks') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1AgentTasksResponse(url, options);
  }

  const v1AgentTaskDetailMatch = /^\/api\/v1\/agent-tasks\/([^/]+)$/.exec(url.pathname);
  if (v1AgentTaskDetailMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    const taskId = safeDecodeURIComponent(v1AgentTaskDetailMatch[1]!);
    if (taskId === undefined) {
      return jsonResponse({ error: 'invalid_agent_task_id' }, { status: 400 });
    }

    return dashboardV1AgentTaskDetailResponse(taskId, options);
  }

  const agentTaskActionMatch = /^\/api\/v1\/agent-tasks\/([^/]+)\/actions\/(resume|reset|terminate)$/.exec(url.pathname);
  if (agentTaskActionMatch !== null) {
    if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS']);

    const taskId = safeDecodeURIComponent(agentTaskActionMatch[1]!);
    if (taskId === undefined) {
      return jsonResponse({ error: 'invalid_agent_task_id' }, { status: 400 });
    }

    return handleDashboardCommandRequest(request, options, {
      actionType: `agent_task_${agentTaskActionMatch[2]}` as RainrailCommandActionType,
      targetType: 'agent_task',
      targetId: taskId,
      requiredScope: 'operator',
      confirmationRequired: agentTaskActionMatch[2] !== 'resume',
      validateTarget: () => options.operationalStore?.getAgentTask(taskId) === undefined
        ? jsonResponse({ error: 'agent_task_not_found' }, { status: 404 })
        : undefined,
    });
  }

  if (url.pathname === '/api/v1/agent-tasks/actions/terminate-all') {
    if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS']);

    return handleDashboardCommandRequest(request, options, {
      actionType: 'agent_task_terminate_all',
      targetType: 'agent_tasks',
      targetId: 'all',
      requiredScope: 'operator',
      confirmationRequired: true,
    });
  }

  if (url.pathname === '/api/v1/queue/actions/assign-next') {
    if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS']);

    return handleDashboardCommandRequest(request, options, {
      actionType: 'queue_assign_next',
      targetType: 'queue',
      targetId: 'next',
      requiredScope: 'operator',
      confirmationRequired: false,
    });
  }

  if (url.pathname === '/api/v1/settings/actions/update') {
    if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS']);

    return handleDashboardCommandRequest(request, options, {
      actionType: 'settings_update',
      targetType: 'settings',
      targetId: 'global',
      requiredScope: 'admin',
      confirmationRequired: true,
    });
  }

  const eventDetailMatch = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
  if (eventDetailMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    const eventId = safeDecodeURIComponent(eventDetailMatch[1]!);
    if (eventId === undefined) {
      return jsonResponse({ error: 'invalid_event_id' }, { status: 400 });
    }

    return dashboardEventDetailResponse(eventId, options);
  }

  const intakeRoute = intakeRegistry.routeFor(request);
  if (intakeRoute !== undefined) {
    if ('allowedMethods' in intakeRoute) {
      return methodNotAllowedResponse([...intakeRoute.allowedMethods, 'OPTIONS']);
    }

    const limitedRequest = await requestWithAppliedBodyLimit(request, intakeRoute.route.maxBodyBytes);
    if (limitedRequest instanceof Response) return limitedRequest;

    return intakeRoute.route.handle(limitedRequest, {
      publish: (event) => publishEvent(options, event),
    });
  }

  return textResponse('not found\n', { status: 404 });
}

function preflightMethodsForPath(pathname: string, intakeRegistry: RainrailIntakeRegistry): readonly string[] | undefined {
  const allowedMethods = intakeRegistry.allowedMethodsForPath(pathname);
  return allowedMethods === undefined ? undefined : [...allowedMethods, 'OPTIONS'];
}

async function requestWithAppliedBodyLimit(request: Request, maxBodyBytes: number | undefined): Promise<Request | Response> {
  if (maxBodyBytes === undefined || !methodCanHaveBody(request.method)) {
    return request;
  }

  let body: ArrayBuffer;
  try {
    body = await readFetchRequestBody(request, maxBodyBytes);
  } catch (error) {
    if (isStatusCodeError(error) && error.statusCode === 413) {
      return jsonResponse({ error: 'request_body_too_large' }, { status: 413 });
    }

    throw error;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

function methodCanHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

function isDashboardCommandRoute(pathname: string, method: string): boolean {
  return method.toUpperCase() === 'POST'
    && (/^\/api\/v1\/agent-tasks\/(?:[^/]+\/actions\/(?:resume|reset|terminate)|actions\/terminate-all)$/.test(pathname)
      || pathname === '/api/v1/queue/actions/assign-next'
      || pathname === '/api/v1/settings/actions/update');
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}

function verifyDashboardReadRequest(request: Request, options: RainrailHttpAppOptions): Response | undefined {
  if (options.operationalStore === undefined) return undefined;

  const auth = verifyDashboardScopedRequest(request, options, 'read-only');
  return auth.ok ? undefined : auth.response;
}

function dashboardStateResponse(url: URL, options: RainrailHttpAppOptions): Response {
  if (options.operationalStore === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  return jsonResponse(options.operationalStore.snapshot({
    hideSkippedActivityEvents: url.searchParams.get('hideSkippedActivity') === '1',
  }));
}

function dashboardEventDetailResponse(eventId: string, options: RainrailHttpAppOptions): Response {
  if (options.operationalStore === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const event = options.operationalStore.getEvent(eventId);
  if (event === undefined) {
    return jsonResponse({ error: 'event_not_found' }, { status: 404 });
  }

  return jsonResponse(event);
}

function dashboardV1OverviewResponse(options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const snapshot = store.snapshot({ hideSkippedActivityEvents: true });
  return jsonResponse({
    data: {
      counts: snapshot.counts,
      warnings: snapshot.warnings,
      recentActivity: store.listActivityEvents({ hideSkippedActivityEvents: true, limit: 5 }).map(activityToWorkflowRunRow),
      links: {
        events: '/api/v1/events',
        workflowRuns: '/api/v1/workflow-runs',
        agentTasks: '/api/v1/agent-tasks',
      },
    },
  });
}

function dashboardV1EventsResponse(url: URL, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, ['filter[repository]', 'filter[source]', 'filter[subjectType]', 'filter[name]']);
  if (!collection.ok) return collection.response;

  const filtered = store.listEvents()
    .filter((event) => matchesOptionalFilter(event.source.repository, url.searchParams.get('filter[repository]')))
    .filter((event) => matchesOptionalFilter(event.source.type, url.searchParams.get('filter[source]')))
    .filter((event) => matchesOptionalFilter(event.subject.type, url.searchParams.get('filter[subjectType]')))
    .filter((event) => matchesOptionalFilter(event.name, url.searchParams.get('filter[name]')));
  const page = pageRows(filtered, collection.limit, collection.cursor, eventCursorValue);
  if (!page.ok) return page.response;
  const activityEvents = store.listActivityEvents();
  const handlerRetries = store.listEventHandlerRetries();

  return jsonResponse({
    data: page.rows.map((event) => eventToCompactRow(event, {
      activityEvents: activityEvents.filter((activity) => activity.sourceEventId === event.id),
      handlerRetries: handlerRetries.filter((retry) => retry.eventId === event.id),
    })),
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

function dashboardV1EventDetailResponse(eventId: string, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const event = store.getEvent(eventId);
  if (event === undefined) {
    return jsonResponse({ error: 'event_not_found' }, { status: 404 });
  }
  const activityEvents = store.listActivityEvents().filter((activity) => activity.sourceEventId === event.id);
  const handlerRetries = store.listEventHandlerRetries().filter((retry) => retry.eventId === event.id);

  return jsonResponse({
    data: {
      id: event.id,
      type: 'event',
      compact: eventToCompactRow(event, { activityEvents, handlerRetries }),
      record: {
        name: event.name,
        humanSummary: eventSummary(event),
        source: event.source,
        delivery: event.delivery,
        subject: event.subject,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        envelope: sanitizedEventEnvelope(event),
        activityEvents,
        handlerRetries,
      },
    },
  });
}

function dashboardV1WorkflowRunsResponse(url: URL, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, ['filter[status]']);
  if (!collection.ok) return collection.response;

  const filtered = store.listActivityEvents({ hideSkippedActivityEvents: url.searchParams.get('hideSkippedActivity') === '1' })
    .filter((activity) => matchesOptionalFilter(activity.outcome, url.searchParams.get('filter[status]')));
  const page = pageRows(filtered, collection.limit, collection.cursor, activityCursorValue);
  if (!page.ok) return page.response;

  return jsonResponse({
    data: page.rows.map(activityToWorkflowRunRow),
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

function dashboardV1WorkflowRunDetailResponse(workflowRunId: string, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const activity = store.getActivityEvent(workflowRunId);
  if (activity === undefined) {
    return jsonResponse({ error: 'workflow_run_not_found' }, { status: 404 });
  }

  return jsonResponse({
    data: {
      id: activity.id,
      type: 'workflow-run',
      compact: activityToWorkflowRunRow(activity),
      record: activity,
    },
  });
}

function dashboardV1AgentTasksResponse(url: URL, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, ['filter[status]']);
  if (!collection.ok) return collection.response;

  const filtered = store.listAgentTasks()
    .filter((task) => matchesOptionalFilter(task.status, url.searchParams.get('filter[status]')));
  const page = pageRows(filtered, collection.limit, collection.cursor, agentTaskCursorValue);
  if (!page.ok) return page.response;
  const staleTaskIds = new Set(store.snapshot().warnings.staleProjectClaims.map((warning) => warning.taskId));

  return jsonResponse({
    data: page.rows.map((task) => agentTaskToCompactRow(task, staleTaskIds)),
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

function dashboardV1AgentTaskDetailResponse(taskId: string, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const task = store.getAgentTask(taskId);
  if (task === undefined) {
    return jsonResponse({ error: 'agent_task_not_found' }, { status: 404 });
  }
  const staleTaskIds = new Set(store.snapshot().warnings.staleProjectClaims.map((warning) => warning.taskId));

  return jsonResponse({
    data: {
      id: task.id,
      type: 'agent-task',
      compact: agentTaskToCompactRow(task, staleTaskIds),
      record: task,
    },
  });
}

type CollectionRequest =
  | { ok: true; limit: number; cursor: PageCursor | undefined }
  | { ok: false; response: Response };

interface PageCursor {
  value: string;
  id: string;
}

interface CursorValueRow {
  id: string;
}

function parseCollectionRequest(url: URL, supportedFilters: string[]): CollectionRequest {
  const unsupportedFilter = Array.from(url.searchParams.keys())
    .find((key) => key.startsWith('filter[') && !supportedFilters.includes(key));
  if (unsupportedFilter !== undefined) {
    return { ok: false, response: jsonResponse({ error: 'unsupported_filter', filter: unsupportedFilter }, { status: 400 }) };
  }

  const unsupportedSort = url.searchParams.get('sort');
  if (unsupportedSort !== null && unsupportedSort !== 'newest') {
    return { ok: false, response: jsonResponse({ error: 'unsupported_sort', sort: unsupportedSort }, { status: 400 }) };
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, response: jsonResponse({ error: 'invalid_limit' }, { status: 400 }) };
  }

  const cursorParam = url.searchParams.get('cursor');
  if (cursorParam === null) return { ok: true, limit, cursor: undefined };

  const cursor = decodePageCursor(cursorParam);
  if (cursor === undefined) {
    return { ok: false, response: jsonResponse({ error: 'invalid_cursor' }, { status: 400 }) };
  }

  return { ok: true, limit, cursor };
}

function pageRows<TRow extends CursorValueRow>(
  rows: TRow[],
  limit: number,
  cursor: PageCursor | undefined,
  cursorValue: (row: TRow) => string,
): { ok: true; rows: TRow[]; nextCursor: string | null } | { ok: false; response: Response } {
  const startIndex = cursor === undefined
    ? 0
    : rows.findIndex((row) => cursorValue(row) === cursor.value && row.id === cursor.id) + 1;
  if (cursor !== undefined && startIndex === 0) {
    return { ok: false, response: jsonResponse({ error: 'invalid_cursor' }, { status: 400 }) };
  }

  const page = rows.slice(startIndex, startIndex + limit);
  const last = page.at(-1);
  const hasNext = startIndex + limit < rows.length;

  return {
    ok: true,
    rows: page,
    nextCursor: hasNext && last !== undefined ? encodePageCursor({ value: cursorValue(last), id: last.id }) : null,
  };
}

function eventCursorValue(event: StoredOperationalEvent): string {
  return event.receivedAt;
}

function activityCursorValue(activity: StoredActivityEvent): string {
  return activity.createdAt;
}

function agentTaskCursorValue(task: StoredAgentTask): string {
  return task.updatedAt;
}

function encodePageCursor(cursor: PageCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodePageCursor(value: string): PageCursor | undefined {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as Partial<PageCursor>;
    if (typeof parsed.value !== 'string' || typeof parsed.id !== 'string') return undefined;
    return { value: parsed.value, id: parsed.id };
  } catch {
    return undefined;
  }
}

function matchesOptionalFilter(value: string | undefined, filter: string | null): boolean {
  return filter === null || value === filter;
}

interface EventCompactContext {
  activityEvents?: StoredActivityEvent[];
  handlerRetries?: StoredEventHandlerRetry[];
}

function eventToCompactRow(event: StoredOperationalEvent, context: EventCompactContext = {}) {
  const activityEvents = context.activityEvents ?? [];
  const handlerRetries = context.handlerRetries ?? [];
  const latestActivity = activityEvents[0];

  return {
    id: event.id,
    type: 'event',
    name: event.name,
    status: 'received',
    summary: eventSummary(event),
    deliveryId: event.delivery.id,
    rawPayloadReference: event.envelope.rawPayload.reference,
    workflowRunCount: activityEvents.length,
    handlerRetryCount: handlerRetries.length,
    ...(latestActivity === undefined ? {} : { latestOutcome: latestActivity.outcome }),
    source: {
      type: event.source.type,
      name: event.source.name,
      ...(event.source.repository === undefined ? {} : { repository: event.source.repository }),
    },
    subject: event.subject,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    links: { self: `/api/v1/events/${encodeURIComponent(event.id)}` },
  };
}

function eventSummary(event: StoredOperationalEvent): string {
  const repository = event.source.repository;
  const subjectId = event.subject.id;
  if (repository !== undefined && subjectId !== undefined) {
    return `${event.name} ${repository}#${subjectId}`;
  }
  if (subjectId !== undefined) return `${event.name} ${event.subject.type}#${subjectId}`;
  return event.name;
}

function sanitizedEventEnvelope(event: StoredOperationalEvent) {
  return {
    id: event.envelope.id,
    schemaVersion: event.envelope.schemaVersion,
    source: event.envelope.source,
    name: event.envelope.name,
    delivery: event.envelope.delivery,
    occurredAt: event.envelope.occurredAt,
    subject: event.envelope.subject,
    rawPayload: event.envelope.rawPayload,
    ...(event.envelope.links === undefined ? {} : { links: event.envelope.links }),
  };
}

function activityToWorkflowRunRow(activity: StoredActivityEvent) {
  return {
    id: activity.id,
    type: 'workflow-run',
    status: activity.outcome,
    summary: activity.summary,
    category: activity.category,
    actionType: activity.actionType,
    targetType: activity.targetType,
    ...(activity.targetId === undefined ? {} : { targetId: activity.targetId }),
    ...(activity.targetUrl === undefined ? {} : { targetUrl: activity.targetUrl }),
    ...(activity.sourceEventId === undefined ? {} : { sourceEventId: activity.sourceEventId }),
    ...(activity.sourceEventName === undefined ? {} : { sourceEventName: activity.sourceEventName }),
    createdAt: activity.createdAt,
    links: { self: `/api/v1/workflow-runs/${encodeURIComponent(activity.id)}` },
  };
}

function agentTaskToCompactRow(task: StoredAgentTask, staleTaskIds: Set<string>) {
  return {
    id: task.id,
    type: 'agent-task',
    status: task.status,
    title: task.title,
    branchName: task.branchName,
    ...(task.agentSessionId === undefined ? {} : { agentSessionId: task.agentSessionId }),
    ...(task.issue === undefined ? {} : { issue: task.issue }),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    warnings: {
      staleProjectClaim: staleTaskIds.has(task.id),
    },
    links: { self: `/api/v1/agent-tasks/${encodeURIComponent(task.id)}` },
  };
}

async function handleDashboardCommandRequest(
  request: Request,
  options: RainrailHttpAppOptions,
  command: {
    actionType: RainrailCommandActionType;
    targetType: RainrailCommandTargetType;
    targetId: string;
    requiredScope: RainrailDashboardScope;
    confirmationRequired: boolean;
    validateTarget?: () => Response | undefined;
  },
): Promise<Response> {
  if (options.operationalStore === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const auth = verifyDashboardScopedRequest(request, options, command.requiredScope);
  if (!auth.ok) return auth.response;

  const targetError = command.validateTarget?.();
  if (targetError !== undefined) return targetError;

  const requestId = request.headers.get('x-request-id') ?? generatedRequestId();
  const client = request.headers.get('x-rainrail-client') ?? undefined;
  const body = await readJsonObjectBody(request, options.dashboardCommandMaxBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES);
  if (!body.ok) return commandResponse({ error: body.error }, requestId, body.status);

  const dryRun = body.value.dryRun === true;
  const confirmationToken = confirmationTokenFor(command.actionType, command.targetType, command.targetId);
  const preview = {
    action: command.actionType,
    targetType: command.targetType,
    targetId: command.targetId,
    confirmationRequired: command.confirmationRequired,
    ...(command.confirmationRequired ? { confirmationToken } : {}),
  };

  if (dryRun) {
    const result = options.operationalStore.recordCommandResult({
      actionType: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'preview',
      actor: auth.principal.actor,
      ...(client === undefined ? {} : { client }),
      requestId,
      dryRun: true,
      result: preview,
    });
    options.operationalStore.recordActivityEvent({
      category: 'command',
      targetType: command.targetType,
      targetId: command.targetId,
      actionType: command.actionType,
      outcome: 'skipped',
      summary: `Previewed ${command.actionType} for ${command.targetType} ${command.targetId}`,
      metadata: auditMetadata(auth.principal.actor, client, requestId, true),
    });

    return commandResponse({
      data: {
        action: command.actionType,
        targetType: command.targetType,
        targetId: command.targetId,
        status: 'preview',
        dryRun: true,
        confirmationRequired: command.confirmationRequired,
        ...(command.confirmationRequired ? { confirmationToken } : {}),
        auditId: result.id,
      },
    }, requestId, 200);
  }

  if (command.confirmationRequired && body.value.confirmationToken !== confirmationToken) {
    return commandResponse({
      error: 'action_confirmation_required',
      data: preview,
    }, requestId, 409);
  }

  if (options.commandHandler === undefined) {
    return commandResponse({ error: 'command_handler_not_configured' }, requestId, 503);
  }

  const sensitiveInputValues = sensitiveStringValues(body.value);
  const commandInputs = JSON.parse(JSON.stringify(body.value)) as Record<string, unknown>;
  try {
    options.operationalStore.recordCommandResult({
      actionType: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'dispatching',
      actor: auth.principal.actor,
      ...(client === undefined ? {} : { client }),
      requestId,
      dryRun: false,
    });
  } catch {
    return commandResponse({ error: 'operational_store_unavailable' }, requestId, 503);
  }

  const commandRequest: RainrailCommandRequest = {
    actionType: command.actionType,
    targetType: command.targetType,
    targetId: command.targetId,
    actor: auth.principal.actor,
    ...(client === undefined ? {} : { client }),
    requestId,
    dryRun: false,
    inputs: commandInputs,
  };

  let handlerResult: unknown;
  try {
    handlerResult = await options.commandHandler(commandRequest);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeCommandErrorMessage(rawMessage, sensitiveInputValues);
    const result = options.operationalStore.recordCommandResult({
      actionType: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'failed',
      actor: auth.principal.actor,
      ...(client === undefined ? {} : { client }),
      requestId,
      dryRun: false,
      error: message,
    });
    options.operationalStore.recordActivityEvent({
      category: 'command',
      targetType: command.targetType,
      targetId: command.targetId,
      actionType: command.actionType,
      outcome: 'failed',
      summary: `Failed ${command.actionType} for ${command.targetType} ${command.targetId}`,
      metadata: auditMetadata(auth.principal.actor, client, requestId, false),
    });

    return commandResponse({
      data: {
        action: command.actionType,
        targetType: command.targetType,
        targetId: command.targetId,
        status: 'failed',
        dryRun: false,
        auditId: result.id,
        error: message,
      },
    }, requestId, 502);
  }

  const storedHandlerResult = sanitizeCommandResult(handlerResult, sensitiveInputValues);
  const result = options.operationalStore.recordCommandResult({
    actionType: command.actionType,
    targetType: command.targetType,
    targetId: command.targetId,
    status: 'accepted',
    actor: auth.principal.actor,
    ...(client === undefined ? {} : { client }),
    requestId,
    dryRun: false,
    result: storedHandlerResult,
  });
  options.operationalStore.recordActivityEvent({
    category: 'command',
    targetType: command.targetType,
    targetId: command.targetId,
    actionType: command.actionType,
    outcome: 'success',
    summary: `Accepted ${command.actionType} for ${command.targetType} ${command.targetId}`,
    metadata: auditMetadata(auth.principal.actor, client, requestId, false),
  });

  return commandResponse({
    data: {
      action: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'accepted',
      dryRun: false,
      auditId: result.id,
      result: storedHandlerResult,
    },
  }, requestId, 202);
}

type DashboardScopedAuthResult =
  | { ok: true; principal: { actor: string; scope: RainrailDashboardScope } }
  | { ok: false; response: Response };

function verifyDashboardScopedRequest(
  request: Request,
  options: RainrailHttpAppOptions,
  requiredScope: RainrailDashboardScope,
): DashboardScopedAuthResult {
  const hasConfiguredToken = dashboardTokens(options).some((configured) => configured !== undefined && configured.length > 0);
  if (!hasConfiguredToken) {
    return { ok: false, response: jsonResponse({ error: 'events_auth_not_configured' }, { status: 503 }) };
  }

  const authorization = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return { ok: false, response: jsonResponse({ error: 'missing_bearer_token' }, { status: 401 }) };
  }

  const token = authorization.slice(prefix.length);
  const principal = principalForDashboardToken(token, options);
  if (principal === undefined) {
    return { ok: false, response: jsonResponse({ error: 'invalid_bearer_token' }, { status: 403 }) };
  }

  if (!scopeIncludes(principal.scope, requiredScope)) {
    return {
      ok: false,
      response: jsonResponse({ error: 'insufficient_scope', requiredScope }, { status: 403 }),
    };
  }

  return { ok: true, principal };
}

function principalForDashboardToken(
  token: string,
  options: RainrailHttpAppOptions,
): { actor: string; scope: RainrailDashboardScope } | undefined {
  if (matchesToken(token, options.dashboardAuth?.adminToken)) {
    return { actor: 'admin', scope: 'admin' };
  }
  if (matchesToken(token, options.dashboardAuth?.operatorToken)) {
    return { actor: 'operator', scope: 'operator' };
  }
  if (matchesToken(token, options.dashboardAuth?.readOnlyToken) || matchesToken(token, options.eventsBearerToken)) {
    return { actor: 'read-only', scope: 'read-only' };
  }

  return undefined;
}

function matchesToken(token: string, expectedToken: string | undefined): boolean {
  return expectedToken !== undefined && expectedToken.length > 0 && constantTimeStringEqual(token, expectedToken);
}

function dashboardTokens(options: RainrailHttpAppOptions): Array<string | undefined> {
  return dashboardTokenEntries(options).map((entry) => entry.token);
}

function assertUniqueDashboardTokenScopes(options: RainrailHttpAppOptions): void {
  const scopesByToken = new Map<string, Set<RainrailDashboardScope>>();
  for (const { token, scope } of dashboardTokenEntries(options)) {
    if (token === undefined || token.length === 0) continue;

    const scopes = scopesByToken.get(token) ?? new Set<RainrailDashboardScope>();
    scopes.add(scope);
    scopesByToken.set(token, scopes);
  }

  for (const scopes of scopesByToken.values()) {
    if (scopes.size > 1) {
      throw new Error('duplicate dashboard token scopes are not allowed');
    }
  }
}

function dashboardTokenEntries(options: RainrailHttpAppOptions): Array<{ token: string | undefined; scope: RainrailDashboardScope }> {
  return [
    { token: options.dashboardAuth?.adminToken, scope: 'admin' },
    { token: options.dashboardAuth?.operatorToken, scope: 'operator' },
    { token: options.dashboardAuth?.readOnlyToken, scope: 'read-only' },
    { token: options.eventsBearerToken, scope: 'read-only' },
  ];
}

function scopeIncludes(actual: RainrailDashboardScope, required: RainrailDashboardScope): boolean {
  const rank: Record<RainrailDashboardScope, number> = {
    'read-only': 1,
    operator: 2,
    admin: 3,
  };
  return rank[actual] >= rank[required];
}

function confirmationTokenFor(actionType: RainrailCommandActionType, targetType: RainrailCommandTargetType, targetId: string): string {
  return `confirm:${actionType}:${targetType}:${targetId}`;
}

function generatedRequestId(): string {
  return `req_${globalThis.crypto.randomUUID()}`;
}

async function readJsonObjectBody(request: Request, maxBytes: number): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; status: number }
> {
  if (request.body === null) return { ok: true, value: {} };

  let rawBody: ArrayBuffer;
  try {
    rawBody = await readFetchRequestBody(request, maxBytes);
  } catch (error) {
    if (isStatusCodeError(error) && error.statusCode === 413) {
      return { ok: false, error: 'request_body_too_large', status: 413 };
    }

    throw error;
  }

  if (rawBody.byteLength === 0) return { ok: true, value: {} };

  try {
    const value = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'invalid_json_body', status: 400 };
    }

    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json_body', status: 400 };
  }
}

function sanitizeCommandResult(value: unknown, sensitiveValues: readonly string[] = [], seen = new WeakSet<object>()): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return '[unserializable]';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : '[unserializable]';
  }
  if (typeof value === 'string') {
    return redactKnownSensitiveValues(value, sensitiveValues);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    try {
      return value.map((item) => {
        const sanitized = sanitizeCommandResult(item, sensitiveValues, seen);
        return sanitized === undefined ? null : sanitized;
      });
    } finally {
      seen.delete(value);
    }
  }

  const sanitized: Record<string, unknown> = {};
  try {
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveCommandResultKey(key)) {
        sanitized[key] = '[redacted]';
        continue;
      }

      const sanitizedNested = sanitizeCommandResult(nested, sensitiveValues, seen);
      if (sanitizedNested !== undefined) {
        sanitized[key] = sanitizedNested;
      }
    }
  } catch {
    return '[unserializable]';
  } finally {
    seen.delete(value);
  }

  return sanitized;
}

function sanitizeCommandErrorMessage(message: string, sensitiveValues: readonly string[]): string {
  let sanitized = redactSensitiveText(message);
  const orderedValues = [...sensitiveValues]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const value of orderedValues) {
    sanitized = sanitized.split(value).join('[redacted]');
  }

  return sanitized;
}

function redactKnownSensitiveValues(value: string, sensitiveValues: readonly string[]): string {
  let sanitized = value;
  const orderedValues = [...sensitiveValues]
    .filter((sensitiveValue) => sensitiveValue.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const sensitiveValue of orderedValues) {
    sanitized = sanitized.split(sensitiveValue).join('[redacted]');
  }

  return sanitized;
}

function sensitiveStringValues(value: unknown, sensitiveContext = false): string[] {
  if (typeof value === 'string') {
    return sensitiveContext ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => sensitiveStringValues(item, sensitiveContext));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => (
    sensitiveStringValues(nested, sensitiveContext || isSensitiveCommandResultKey(key))
  ));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/\b([\w.-]*(?:authorization|token|secret|password|key|code|reset|verification|session|confirmation)[\w.-]*\b\s*[:=]\s*)(?:bearer|token)\s+[^\s"',}]+/giu, '$1[redacted]')
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(
      /((["'])[\w.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session|confirmation)[\w.-]*\2\s*:\s*)(["'])(?:\\.|(?!\3).)*\3/giu,
      '$1$3[redacted]$3',
    )
    .replace(
      /(\b[\w.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session|confirmation)[\w.-]*\b\s*[:=]\s*)(["']?)([^\s"',}]+)/giu,
      '$1$2[redacted]',
    );
}

function isSensitiveCommandResultKey(key: string): boolean {
  return /(?:authorization|cookie|token|secret|password|key|code|reset|verification|session|confirmation)/iu.test(key);
}

function auditMetadata(actor: string, client: string | undefined, requestId: string, dryRun: boolean): Record<string, unknown> {
  return {
    actor,
    ...(client === undefined ? {} : { client }),
    requestId,
    dryRun,
  };
}

function commandResponse(body: unknown, requestId: string, status: number): Response {
  return jsonResponse(body, {
    status,
    headers: { 'X-Request-ID': requestId },
  });
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

async function publishEvent(options: RainrailHttpAppOptions, event: unknown): Promise<Response> {
  const response = await options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.publishToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  }));

  if (response.ok) {
    try {
      const publishedEvent = await readPublishedEvent(response);
      if (publishedEvent !== undefined) {
        options.operationalStore?.recordEvent(publishedEvent);
      }
    } catch {
      // Event delivery already succeeded. Operational dashboard persistence must not turn
      // an accepted external delivery into a provider-visible failure and duplicate retry.
    }
  }

  return response;
}

async function readPublishedEvent(response: Response): Promise<RainrailEventEnvelope | undefined> {
  const body = await response.clone().json() as unknown;
  if (typeof body !== 'object' || body === null || !('event' in body)) {
    return undefined;
  }

  const { event } = body;
  return isRainrailEventEnvelope(event) ? event : undefined;
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isRainrailEventEnvelope(value: unknown): value is RainrailEventEnvelope {
  return typeof value === 'object'
    && value !== null
    && 'schemaVersion' in value
    && value.schemaVersion === 'rainrail.event.v1';
}

function bridgeAuthorizationHeaders(request: Request, publishToken: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${publishToken}`,
  });
  const lastEventId = request.headers.get('Last-Event-ID');
  if (lastEventId !== null) {
    headers.set('Last-Event-ID', lastEventId);
  }

  return headers;
}

export async function stableIntakeFallbackDeliveryId(events: unknown[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableStringify(events)),
  );

  return `tail-batch-${toHex(new Uint8Array(digest)).slice(0, 32)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
