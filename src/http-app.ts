import {
  createDashboardCardRegistry,
  defineDashboardCard,
  type DashboardCardCatalogEntry,
  type DashboardCardDefinition,
  type DashboardCardListOptions,
  type DashboardCardRegistry,
  type DashboardLayoutItem,
} from './dashboard-card-registry.js';
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
  OperationalStore,
  StoredActivityEvent,
  StoredAgentTask,
  StoredCommandResult,
  StoredEventHandlerRetry,
  StoredOperationalEvent,
  StoredStaleProjectClaimWarning,
} from './operational-store.js';
import { getInProgressProjectIssues, getNextProjectIssueToStart, type ProjectIssue } from './project-issues.js';
import type { TaskQueueProvider } from './task-queue.js';

const DEFAULT_MAX_CONCURRENT_AGENT_TASKS = 1;
const USER_DASHBOARD_LAYOUT_ID = 'user.dashboardLayout';
const DEFAULT_DASHBOARD_LAYOUT_ID = 'core.defaultLayout';

const DEFAULT_DASHBOARD_CARDS: readonly DashboardCardDefinition[] = [
  defineDashboardCard({
    id: 'core.overview',
    title: 'Overview',
    description: 'Operational counts and warnings.',
    entry: { type: 'core', name: 'overview' },
    category: 'operations',
    requiredCapabilities: ['dashboard:read'],
    size: {
      default: { columns: 4, rows: 2 },
      min: { columns: 2, rows: 1 },
      max: { columns: 8, rows: 4 },
    },
  }),
  defineDashboardCard({
    id: 'core.recentEvents',
    title: 'Recent events',
    description: 'Recent event deliveries and workflow outcomes.',
    entry: { type: 'core', name: 'recentEvents' },
    category: 'operations',
    requiredCapabilities: ['dashboard:read'],
    size: {
      default: { columns: 4, rows: 2 },
      min: { columns: 2, rows: 1 },
      max: { columns: 8, rows: 4 },
    },
  }),
  defineDashboardCard({
    id: 'core.agentTasks',
    title: 'Agent tasks',
    description: 'Active and recent agent task status.',
    entry: { type: 'core', name: 'agentTasks' },
    category: 'operations',
    requiredCapabilities: ['dashboard:read'],
    size: {
      default: { columns: 4, rows: 2 },
      min: { columns: 2, rows: 1 },
      max: { columns: 8, rows: 4 },
    },
  }),
  defineDashboardCard({
    id: 'core.queue',
    title: 'Queue',
    description: 'Project queue and blocked work.',
    entry: { type: 'core', name: 'queue' },
    category: 'operations',
    requiredCapabilities: ['dashboard:read'],
    size: {
      default: { columns: 4, rows: 2 },
      min: { columns: 2, rows: 1 },
      max: { columns: 8, rows: 4 },
    },
  }),
];

const DEFAULT_DASHBOARD_LAYOUT: readonly DashboardLayoutItem[] = [
  { id: 'overview', cardId: 'core.overview', x: 0, y: 0, columns: 4, rows: 2 },
  { id: 'recent-events', cardId: 'core.recentEvents', x: 4, y: 0, columns: 4, rows: 2 },
  { id: 'agent-tasks', cardId: 'core.agentTasks', x: 0, y: 2, columns: 4, rows: 2 },
  { id: 'queue', cardId: 'core.queue', x: 4, y: 2, columns: 4, rows: 2 },
];

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
  | 'dashboard_layout_update'
  | 'queue_assign_next'
  | 'settings_update';

export type RainrailCommandTargetType = 'agent_task' | 'agent_tasks' | 'dashboard_layout' | 'queue' | 'settings';

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
  operationalStore?: OperationalStore;
  taskQueue?: Pick<TaskQueueProvider, 'listProjectIssues' | 'selection'>;
  dashboardCardRegistry?: DashboardCardRegistry;
  dashboardCardCatalog?: DashboardCardListOptions;
  dashboardDefaultLayout?: readonly DashboardLayoutItem[];
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
  return createRainrailIntakeRegistry(options.intakeAdapters).routeNeedsBody(pathname, method);
}

export function rainrailHttpRequestBodyLimit(
  pathname: string,
  method: string,
  options: RainrailHttpAppOptions,
): number | undefined {
  if (isDashboardBodyRoute(pathname, method)) return options.dashboardCommandMaxBodyBytes;
  return createRainrailIntakeRegistry(options.intakeAdapters).routeBodyLimit(pathname, method);
}

export function shouldStreamRainrailHttpRequestBody(
  pathname: string,
  method: string,
  options: RainrailHttpAppOptions,
): boolean {
  return createRainrailIntakeRegistry(options.intakeAdapters).routeStreamsBody(pathname, method);
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

    const auth = verifyDashboardScopedRequest(request, options, 'read-only');
    if (!auth.ok) return auth.response;

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

  if (url.pathname === '/api/v1/sources') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1SourcesResponse(url, options);
  }

  if (url.pathname === '/api/v1/queue') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1QueueResponse(url, options);
  }

  if (url.pathname === '/api/v1/settings') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardV1SettingsResponse(url, options);
  }

  if (url.pathname === '/api/v1/dashboard/cards') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardScopedRequest(request, options, 'read-only');
    if (!auth.ok) return auth.response;

    return dashboardV1CardsResponse(options);
  }

  if (url.pathname === '/api/v1/dashboard/layout') {
    if (request.method === 'GET') {
      const auth = verifyDashboardReadRequest(request, options);
      if (auth !== undefined) return auth;

      return dashboardV1LayoutResponse(options);
    }

    if (request.method === 'PUT') {
      return handleDashboardLayoutUpdateRequest(request, options);
    }

    return methodNotAllowedResponse(['GET', 'PUT', 'OPTIONS']);
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

    const limitedRequest = await requestWithAppliedBodyLimit(
      request,
      intakeRoute.route.readBodyBeforeHandle === false ? undefined : intakeRoute.route.maxBodyBytes,
    );
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

function isDashboardBodyRoute(pathname: string, method: string): boolean {
  return isDashboardCommandRoute(pathname, method)
    || (method.toUpperCase() === 'PUT' && pathname === '/api/v1/dashboard/layout');
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
      recentActivity: store.listActivityEvents({ hideSkippedActivityEvents: true })
        .filter(isWorkflowRunActivity)
        .slice(0, 5)
        .map(activityToWorkflowRunRow),
      links: {
        events: '/api/v1/events',
        workflowRuns: '/api/v1/workflow-runs',
        agentTasks: '/api/v1/agent-tasks',
        sources: '/api/v1/sources',
        queue: '/api/v1/queue',
        settings: '/api/v1/settings',
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
    .filter(isWorkflowRunActivity)
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
  if (activity === undefined || !isWorkflowRunActivity(activity)) {
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

function dashboardV1SourcesResponse(url: URL, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, ['filter[source]']);
  if (!collection.ok) return collection.response;
  const sort = url.searchParams.get('sort');
  if (sort === 'newest') {
    return jsonResponse({ error: 'unsupported_sort', sort }, { status: 400 });
  }

  const latestBySource = latestEventBySourceName(store.listEvents());
  const adapters = options.intakeAdapters ?? [];
  const duplicateSourceNames = duplicateValues(adapters.map((adapter) => adapter.name));
  const reservedSourceRowIds = new Set(adapters.map((adapter) => adapter.name));
  const assignedSourceRowIds = new Set<string>();
  const rows = adapters
    .map((adapter, index) => intakeAdapterToSourceRow(
      adapter,
      latestBySource.get(adapter.name),
      sourceRowId(adapter.name, index, duplicateSourceNames, reservedSourceRowIds, assignedSourceRowIds),
    ))
    .filter((row) => matchesOptionalFilter(row.sourceType, url.searchParams.get('filter[source]')));
  const page = pageRows(rows, collection.limit, collection.cursor, (row) => row.name);
  if (!page.ok) return page.response;

  return jsonResponse({
    data: page.rows,
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

async function dashboardV1QueueResponse(url: URL, options: RainrailHttpAppOptions): Promise<Response> {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, ['filter[status]']);
  if (!collection.ok) return collection.response;
  const sort = url.searchParams.get('sort');
  if (sort === 'newest') {
    return jsonResponse({ error: 'unsupported_sort', sort }, { status: 400 });
  }

  const snapshot = store.snapshot();
  const tasks = store.listAgentTasks();
  const staleWarningsByTaskId = new Map(snapshot.warnings.staleProjectClaims.map((warning) => [warning.taskId, warning]));
  const taskRows = tasks.map((task) => agentTaskToQueueRow(task, staleWarningsByTaskId.get(task.id)));
  const projectIssueRows = await projectIssueQueueRows(options.taskQueue, tasks, staleWarningsByTaskId);
  const allRows = sortQueueRows([...taskRows, ...projectIssueRows]);
  const rows = allRows
    .filter((row) => matchesOptionalFilter(row.status, url.searchParams.get('filter[status]')));
  const page = pageRows(rows, collection.limit, collection.cursor, queueCursorValue);
  if (!page.ok) return page.response;

  return jsonResponse({
    data: page.rows,
    summary: queueSummary(allRows, store.listEventHandlerRetries(), snapshot.warnings.staleProjectClaims),
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

function dashboardV1SettingsResponse(url: URL, options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const collection = parseCollectionRequest(url, []);
  if (!collection.ok) return collection.response;
  const sort = url.searchParams.get('sort');
  if (sort === 'newest') {
    return jsonResponse({ error: 'unsupported_sort', sort }, { status: 400 });
  }

  const retryCount = store.listEventHandlerRetries().length;
  const rows = [
    settingRow('max-concurrency', 'Max concurrency', formatMaxConcurrentAgentTasksSetting(options.taskQueue)),
    settingRow('auto-start', 'Auto-start', 'not configured'),
    settingRow('retry-policy', 'Retry policy', retryCount === 1 ? '1 retry pending' : `${retryCount} retries pending`),
    settingRow('operational-snapshot-limit', 'Operational snapshot limit', `${store.eventLimit()} events`),
    settingRow('dashboard-auth', 'Dashboard auth', hasConfiguredDashboardToken(options) ? 'bearer token configured' : 'bearer token not configured'),
    settingRow('runtime', 'Runtime', options.runtime ?? 'fetch'),
  ];
  const page = pageRows(rows, collection.limit, collection.cursor, (row) => row.id);
  if (!page.ok) return page.response;

  return jsonResponse({
    data: page.rows,
    updatePolicy: { requiredScope: 'admin', audit: 'required' },
    page: { limit: collection.limit, nextCursor: page.nextCursor },
  });
}

function dashboardV1CardsResponse(options: RainrailHttpAppOptions): Response {
  return jsonResponse({
    data: dashboardCardCatalog(options),
  });
}

function dashboardV1LayoutResponse(options: RainrailHttpAppOptions): Response {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const stored = store.getDashboardLayout();
  if (stored !== undefined) {
    const catalog = dashboardCardCatalog(options);
    return jsonResponse({
      data: {
        id: stored.id,
        source: 'user',
        updatedAt: stored.updatedAt,
        items: filterDashboardLayoutItems(stored.items, catalog),
      },
    });
  }

  return jsonResponse({
    data: {
      id: DEFAULT_DASHBOARD_LAYOUT_ID,
      source: 'default',
      updatedAt: null,
      items: dashboardDefaultLayout(options),
    },
  });
}

async function handleDashboardLayoutUpdateRequest(
  request: Request,
  options: RainrailHttpAppOptions,
): Promise<Response> {
  const store = options.operationalStore;
  if (store === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const auth = verifyDashboardScopedRequest(request, options, 'operator');
  if (!auth.ok) return auth.response;

  const requestId = sanitizeAuditHeaderValue(request.headers.get('x-request-id')) ?? generatedRequestId();
  const client = sanitizeAuditHeaderValue(request.headers.get('x-rainrail-client')) ?? auth.principal.client ?? 'unknown';
  const body = await readJsonObjectBody(request, options.dashboardCommandMaxBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES);
  if (!body.ok) return jsonResponse({ error: body.error }, { status: body.status });

  const parsed = parseDashboardLayoutItems(body.value.items, dashboardCardCatalog(options));
  if (!parsed.ok) return parsed.response;

  let saved;
  let auditId: string;
  try {
    saved = store.saveDashboardLayout(parsed.items);
    const audit = store.recordCommandResult({
      actionType: 'dashboard_layout_update',
      targetType: 'dashboard_layout',
      targetId: USER_DASHBOARD_LAYOUT_ID,
      status: 'accepted',
      actor: auth.principal.actor,
      ...(client === undefined ? {} : { client }),
      requestId,
      dryRun: false,
      result: { itemCount: saved.items.length },
    });
    auditId = audit.id;
    store.recordActivityEvent({
      category: 'command',
      targetType: 'dashboard_layout',
      targetId: USER_DASHBOARD_LAYOUT_ID,
      actionType: 'dashboard_layout_update',
      outcome: 'success',
      summary: `Accepted dashboard_layout_update for dashboard layout ${USER_DASHBOARD_LAYOUT_ID}`,
      metadata: auditMetadata(auth.principal.actor, client, requestId, false),
    });
  } catch {
    return jsonResponse({ error: 'operational_store_unavailable' }, { status: 503 });
  }

  return jsonResponse({
    data: {
      id: USER_DASHBOARD_LAYOUT_ID,
      source: 'user',
      updatedAt: saved.updatedAt,
      items: saved.items,
      auditId,
    },
  });
}

function dashboardCardCatalog(options: RainrailHttpAppOptions): DashboardCardCatalogEntry[] {
  return dashboardCardRegistry(options).list(options.dashboardCardCatalog ?? {
    availableCapabilities: ['dashboard:read'],
  });
}

function dashboardCardRegistry(options: RainrailHttpAppOptions): DashboardCardRegistry {
  if (options.dashboardCardRegistry !== undefined) return options.dashboardCardRegistry;

  const registry = createDashboardCardRegistry();
  for (const card of DEFAULT_DASHBOARD_CARDS) {
    registry.register(card);
  }
  return registry;
}

function dashboardDefaultLayout(options: RainrailHttpAppOptions): DashboardLayoutItem[] {
  return jsonClone([...(options.dashboardDefaultLayout ?? DEFAULT_DASHBOARD_LAYOUT)]);
}

function parseDashboardLayoutItems(
  value: unknown,
  catalog: DashboardCardCatalogEntry[],
): { ok: true; items: DashboardLayoutItem[] } | { ok: false; response: Response } {
  if (!Array.isArray(value)) {
    return { ok: false, response: jsonResponse({ error: 'invalid_dashboard_layout_items' }, { status: 400 }) };
  }

  const definitionsById = new Map(catalog.map((entry) => [entry.definition.id, entry]));
  const seenItemIds = new Set<string>();
  const items: DashboardLayoutItem[] = [];

  for (const rawItem of value) {
    const item = recordValue(rawItem);
    if (item === undefined) {
      return { ok: false, response: jsonResponse({ error: 'invalid_dashboard_layout_item' }, { status: 400 }) };
    }

    const id = strictStringField(item, 'id');
    const cardId = strictStringField(item, 'cardId');
    const x = integerField(item, 'x');
    const y = integerField(item, 'y');
    const columns = integerField(item, 'columns');
    const rows = integerField(item, 'rows');
    if (id === undefined || id.length === 0 || cardId === undefined || cardId.length === 0
      || x === undefined || y === undefined || columns === undefined || rows === undefined
      || x < 0 || y < 0 || columns < 1 || rows < 1) {
      return { ok: false, response: jsonResponse({ error: 'invalid_dashboard_layout_item' }, { status: 400 }) };
    }

    if (seenItemIds.has(id)) {
      return { ok: false, response: jsonResponse({ error: 'duplicate_dashboard_layout_item', itemId: id }, { status: 400 }) };
    }
    seenItemIds.add(id);

    const catalogEntry = definitionsById.get(cardId);
    if (catalogEntry === undefined) {
      return { ok: false, response: jsonResponse({ error: 'unknown_dashboard_card', cardId }, { status: 400 }) };
    }
    if (catalogEntry.availability.status !== 'available') {
      return { ok: false, response: jsonResponse({ error: 'unavailable_dashboard_card', cardId }, { status: 400 }) };
    }
    if (!dashboardCardSizeIsAllowed(catalogEntry.definition, { columns, rows })) {
      return {
        ok: false,
        response: jsonResponse({ error: 'dashboard_card_size_out_of_range', itemId: id, cardId }, { status: 400 }),
      };
    }

    const config = item.config;
    if (config !== undefined && (!isPlainRecord(config) || !isJsonSerializableValue(config))) {
      return { ok: false, response: jsonResponse({ error: 'invalid_dashboard_card_config', itemId: id, cardId }, { status: 400 }) };
    }

    items.push({
      id,
      cardId,
      x,
      y,
      columns,
      rows,
      ...(config === undefined ? {} : { config: jsonClone(config as Record<string, unknown>) }),
    });
  }

  return { ok: true, items };
}

function filterDashboardLayoutItems(
  items: readonly DashboardLayoutItem[],
  catalog: DashboardCardCatalogEntry[],
): DashboardLayoutItem[] {
  const seenItemIds = new Set<string>();
  const filtered: DashboardLayoutItem[] = [];
  for (const item of items) {
    const parsed = parseDashboardLayoutItems([item], catalog);
    if (!parsed.ok) continue;
    const [parsedItem] = parsed.items;
    if (parsedItem === undefined || seenItemIds.has(parsedItem.id)) continue;
    seenItemIds.add(parsedItem.id);
    filtered.push(parsedItem);
  }
  return filtered;
}

function dashboardCardSizeIsAllowed(
  definition: DashboardCardDefinition,
  size: { columns: number; rows: number },
): boolean {
  const min = definition.size.min ?? { columns: 1, rows: 1 };
  const max = definition.size.max;
  return size.columns >= min.columns
    && size.rows >= min.rows
    && (max === undefined || (size.columns <= max.columns && size.rows <= max.rows));
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

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return duplicates;
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

function isWorkflowRunActivity(activity: StoredActivityEvent): boolean {
  return activity.category !== 'command';
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

function latestEventBySourceName(events: StoredOperationalEvent[]): Map<string, StoredOperationalEvent> {
  const latest = new Map<string, StoredOperationalEvent>();
  for (const event of events) {
    if (!latest.has(event.source.name)) latest.set(event.source.name, event);
  }
  return latest;
}

function intakeAdapterToSourceRow(adapter: RainrailIntakeAdapter, latestEvent: StoredOperationalEvent | undefined, id = adapter.name) {
  const route = adapter.routes?.[0];
  const sourceType = adapter.source?.type ?? latestEvent?.source.type ?? 'system';
  const authStatus = adapter.source?.authStatus ?? (route === undefined ? 'not_required' : undefined);
  return {
    id,
    type: 'source',
    status: 'configured',
    sourceType,
    name: adapter.name,
    ...(route === undefined ? {} : { endpoint: route.path }),
    transport: adapter.tail === undefined ? 'http' : 'tail',
    auth: { status: formatSourceAuthStatus(authStatus) },
    ...(latestEvent === undefined ? {} : {
      lastDelivery: {
        id: latestEvent.delivery.id,
        receivedAt: latestEvent.receivedAt,
        subject: latestEvent.subject,
      },
    }),
  };
}

function sourceRowId(
  name: string,
  index: number,
  duplicateSourceNames: Set<string>,
  reservedSourceRowIds: Set<string>,
  assignedSourceRowIds: Set<string>,
): string {
  let candidate = duplicateSourceNames.has(name) ? `${name}:${index}` : name;
  let suffix = 1;
  while (assignedSourceRowIds.has(candidate) || (candidate !== name && reservedSourceRowIds.has(candidate))) {
    candidate = `${name}:${index}:${suffix}`;
    suffix += 1;
  }
  assignedSourceRowIds.add(candidate);
  return candidate;
}

function formatSourceAuthStatus(status: NonNullable<RainrailIntakeAdapter['source']>['authStatus'] | undefined): string {
  if (status === 'not_required') return 'not required';
  return status ?? 'unknown';
}

function agentTaskToQueueRow(task: StoredAgentTask, staleWarning: StoredStaleProjectClaimWarning | undefined) {
  const claim = recordValue(task.claim);
  const activeClaim = taskHasActiveClaimLock(task, staleWarning) ? claim : undefined;
  const staleReason = staleWarning === undefined ? undefined : `stale project claim: ${staleWarning.status}`;
  return {
    id: task.id,
    type: 'queue-item',
    status: staleWarning === undefined ? queueStatusFromTaskStatus(task.status) : 'blocked',
    title: task.title,
    updatedAt: task.updatedAt,
    ...(task.issue === undefined ? {} : { issue: task.issue }),
    ...(task.branchName === undefined ? {} : { branchName: task.branchName }),
    projectStatus: stringField(activeClaim, 'originalStatus') ?? 'unknown',
    ...(activeClaim === undefined ? {} : {
      claimLock: {
        ...(stringField(activeClaim, 'projectItemId') === undefined ? {} : { projectItemId: stringField(activeClaim, 'projectItemId') }),
        ...(task.agentSessionId === undefined ? {} : { heldBy: task.agentSessionId }),
      },
    }),
    ...(staleWarning === undefined ? {} : {
      staleProjectClaim: true,
    }),
    ...(staleReason === undefined && task.projectClaim === undefined ? {} : {
      blockedReason: staleReason ?? task.projectClaim?.reason,
      ...(task.projectClaim === undefined ? {} : { releaseStatus: task.projectClaim.status }),
    }),
  };
}

async function projectIssueQueueRows(
  taskQueue: Pick<TaskQueueProvider, 'listProjectIssues' | 'selection'> | undefined,
  tasks: StoredAgentTask[],
  staleWarningsByTaskId: Map<string, StoredStaleProjectClaimWarning>,
) {
  if (taskQueue === undefined) return [];
  const representedIssueKeys = new Set(tasks.flatMap((task) => taskProjectIssueKeys(task, staleWarningsByTaskId.get(task.id))));
  let issues: ProjectIssue[];
  try {
    issues = await taskQueue.listProjectIssues();
  } catch {
    return [];
  }
  const providerInProgressRows = getInProgressProjectIssues(issues, taskQueue.selection)
    .filter((issue) => !isRepresentedProjectIssue(issue, representedIssueKeys))
    .map((issue) => projectIssueToQueueRow(issue, 'in-progress'));
  const effectiveMaxConcurrentAgentTasks = maxConcurrentAgentTasksForSelection(taskQueue.selection);
  if (localActiveAgentTaskCount(tasks) >= effectiveMaxConcurrentAgentTasks) return providerInProgressRows;

  const nextIssue = nextUnrepresentedProjectIssueToStart(issues, taskQueue.selection, representedIssueKeys);
  if (nextIssue === undefined) return providerInProgressRows;
  return [...providerInProgressRows, projectIssueToQueueRow(nextIssue)];
}

function nextUnrepresentedProjectIssueToStart(
  issues: ProjectIssue[],
  selection: Pick<TaskQueueProvider, 'selection'>['selection'],
  representedIssueKeys: Set<string>,
): ProjectIssue | undefined {
  let candidateIssues = issues;
  while (candidateIssues.length > 0) {
    const nextIssue = getNextProjectIssueToStart(candidateIssues, selection);
    if (nextIssue === undefined) return undefined;
    if (!isRepresentedProjectIssue(nextIssue, representedIssueKeys)) return nextIssue;
    candidateIssues = candidateIssues.filter((issue) => !isSameProjectIssue(issue, nextIssue));
  }
  return undefined;
}

function projectIssueToQueueRow(issue: ProjectIssue, status = 'upcoming') {
  return {
    id: `project:${issue.id}`,
    type: 'queue-item',
    status,
    title: issue.title,
    issue: {
      ...(issue.repository === undefined ? {} : { repository: issue.repository }),
      ...(issue.number === undefined ? {} : { number: issue.number }),
      ...(issue.url === undefined ? {} : { url: issue.url }),
    },
    projectStatus: issue.status ?? 'unknown',
  };
}

function taskProjectIssueKeys(task: StoredAgentTask, staleWarning: StoredStaleProjectClaimWarning | undefined): string[] {
  if (!taskRepresentsProjectIssue(task, staleWarning)) return [];
  return [
    projectIssueKeyFromUnknown(task.issue),
    stringField(recordValue(task.claim), 'projectItemId'),
  ].filter((value): value is string => value !== undefined);
}

function taskRepresentsProjectIssue(task: StoredAgentTask, staleWarning: StoredStaleProjectClaimWarning | undefined): boolean {
  if (taskHasActiveIssue(task)) return true;
  if (taskHasActiveClaimLock(task, staleWarning)) return true;
  return task.claim !== undefined && task.projectClaim?.status === 'release_failed';
}

function taskHasActiveIssue(task: StoredAgentTask): boolean {
  return projectIssueKeyFromUnknown(task.issue) !== undefined
    && (
      task.status === 'queued'
      || task.status === 'pending'
      || task.status === 'running'
    );
}

function taskHasActiveClaimLock(task: StoredAgentTask, staleWarning: StoredStaleProjectClaimWarning | undefined): boolean {
  if (task.claim === undefined) return false;
  if (staleWarning !== undefined) return true;
  return task.status === 'queued'
    || task.status === 'pending'
    || task.status === 'running'
    || task.status === 'needs_human'
    || task.status === 'split_recommended';
}

function localActiveAgentTaskCount(tasks: StoredAgentTask[]): number {
  return tasks.filter((task) =>
    task.status === 'queued'
    || task.status === 'pending'
    || task.status === 'running'
  ).length;
}

function maxConcurrentAgentTasksForSelection(selection: Pick<TaskQueueProvider, 'selection'>['selection']): number {
  return selection?.maxConcurrentAgentTasks ?? DEFAULT_MAX_CONCURRENT_AGENT_TASKS;
}

function projectIssueKey(issue: ProjectIssue): string {
  if (issue.repository !== undefined && issue.number !== undefined) {
    return `${issue.repository}#${issue.number}`;
  }
  return issue.id;
}

function isRepresentedProjectIssue(issue: ProjectIssue, representedIssueKeys: Set<string>): boolean {
  return representedIssueKeys.has(projectIssueKey(issue)) || representedIssueKeys.has(issue.id);
}

function isSameProjectIssue(left: ProjectIssue, right: ProjectIssue): boolean {
  return left.id === right.id || projectIssueKey(left) === projectIssueKey(right);
}

function projectIssueKeyFromUnknown(issue: unknown): string | undefined {
  const record = recordValue(issue);
  const repository = stringField(record, 'repository');
  const number = numberField(record, 'number');
  if (repository === undefined || number === undefined) return undefined;
  return `${repository}#${number}`;
}

function queueStatusFromTaskStatus(status: string): string {
  if (status === 'running') return 'in-progress';
  if (status === 'queued' || status === 'pending') return 'upcoming';
  if (
    status === 'failed'
    || status === 'canceled'
    || status === 'stopped'
    || status === 'timed_out'
    || status === 'compaction_failed'
    || status === 'needs_human'
    || status === 'split_recommended'
  ) return 'blocked';
  return status;
}

function sortQueueRows(rows: Array<ReturnType<typeof agentTaskToQueueRow> | ReturnType<typeof projectIssueToQueueRow>>) {
  return [...rows].sort((left, right) =>
    queueStatusRank(left.status) - queueStatusRank(right.status)
    || queueCursorValue(right).localeCompare(queueCursorValue(left))
    || left.id.localeCompare(right.id)
  );
}

function queueStatusRank(status: string): number {
  if (status === 'in-progress') return 0;
  if (status === 'upcoming') return 1;
  if (status === 'blocked') return 2;
  return 3;
}

function queueSummary(
  rows: Array<ReturnType<typeof agentTaskToQueueRow> | ReturnType<typeof projectIssueToQueueRow>>,
  retries: StoredEventHandlerRetry[],
  staleWarnings: StoredStaleProjectClaimWarning[],
) {
  const blockedReasons = [...new Set([
    ...staleWarnings.map((warning) => `stale project claim: ${warning.status}`),
    ...rows.map((row) => 'blockedReason' in row ? row.blockedReason : undefined).filter((reason): reason is string => reason !== undefined),
    ...retries.map((retry) => retry.lastError),
  ])];
  return {
    upcomingIssues: rows.filter((row) => row.status === 'upcoming').length,
    blockedReasons,
    blockedCount: rows.filter((row) => row.status === 'blocked').length,
    staleClaimCount: staleWarnings.length,
    inProgressCount: rows.filter((row) => row.status === 'in-progress').length,
    claimedCount: rows.filter((row) => 'claimLock' in row && row.claimLock !== undefined).length,
  };
}

function queueCursorValue(row: ReturnType<typeof agentTaskToQueueRow> | ReturnType<typeof projectIssueToQueueRow>): string {
  return 'updatedAt' in row ? row.updatedAt : row.id;
}

function settingRow(id: string, label: string, value: string) {
  return {
    id,
    type: 'setting',
    status: 'read-only',
    label,
    value,
  };
}

function formatMaxConcurrentAgentTasksSetting(taskQueue: Pick<TaskQueueProvider, 'selection'> | undefined): string {
  if (taskQueue === undefined) return 'not configured';
  const maxConcurrentAgentTasks = taskQueue.selection?.maxConcurrentAgentTasks;
  if (maxConcurrentAgentTasks === undefined) return `${formatAgentTaskCount(DEFAULT_MAX_CONCURRENT_AGENT_TASKS)} (default)`;
  return formatAgentTaskCount(maxConcurrentAgentTasks);
}

function formatAgentTaskCount(count: number): string {
  return count === 1 ? '1 agent task' : `${count} agent tasks`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? undefined : String(value);
}

function strictStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function hasConfiguredDashboardToken(options: RainrailHttpAppOptions): boolean {
  return dashboardTokens(options).some((configured) => configured !== undefined && configured.length > 0);
}

function numberField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record?.[field];
  return typeof value === 'number' ? value : undefined;
}

function integerField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = numberField(record, field);
  return value === undefined || !Number.isInteger(value) ? undefined : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonSerializableValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSerializableValue);
  if (isPlainRecord(value)) {
    return Object.values(value).every(isJsonSerializableValue);
  }
  return false;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

  const requestId = sanitizeAuditHeaderValue(request.headers.get('x-request-id')) ?? generatedRequestId();
  const client = sanitizeAuditHeaderValue(request.headers.get('x-rainrail-client')) ?? auth.principal.client ?? 'unknown';
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
    let result: StoredCommandResult;
    try {
      result = options.operationalStore.recordCommandResult({
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
    } catch {
      return commandResponse({ error: 'operational_store_unavailable' }, requestId, 503);
    }

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
  let dispatchAuditId: string;
  try {
    const dispatchResult = options.operationalStore.recordCommandResult({
      actionType: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'dispatching',
      actor: auth.principal.actor,
      ...(client === undefined ? {} : { client }),
      requestId,
      dryRun: false,
    });
    dispatchAuditId = dispatchResult.id;
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
    let auditId = dispatchAuditId;
    let auditWarning: string | undefined;
    try {
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
      auditId = result.id;
      options.operationalStore.recordActivityEvent({
        category: 'command',
        targetType: command.targetType,
        targetId: command.targetId,
        actionType: command.actionType,
        outcome: 'failed',
        summary: `Failed ${command.actionType} for ${command.targetType} ${command.targetId}`,
        metadata: auditMetadata(auth.principal.actor, client, requestId, false),
      });
    } catch {
      auditWarning = 'post_dispatch_audit_failed';
    }

    return commandResponse({
      data: {
        action: command.actionType,
        targetType: command.targetType,
        targetId: command.targetId,
        status: 'failed',
        dryRun: false,
        auditId,
        ...(auditWarning === undefined ? {} : { auditWarning }),
        error: message,
      },
    }, requestId, 502);
  }

  const storedHandlerResult = sanitizeCommandResult(handlerResult, sensitiveInputValues);
  let auditId = dispatchAuditId;
  let auditWarning: string | undefined;
  try {
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
    auditId = result.id;
    options.operationalStore.recordActivityEvent({
      category: 'command',
      targetType: command.targetType,
      targetId: command.targetId,
      actionType: command.actionType,
      outcome: 'success',
      summary: `Accepted ${command.actionType} for ${command.targetType} ${command.targetId}`,
      metadata: auditMetadata(auth.principal.actor, client, requestId, false),
    });
  } catch {
    auditWarning = 'post_dispatch_audit_failed';
  }

  return commandResponse({
    data: {
      action: command.actionType,
      targetType: command.targetType,
      targetId: command.targetId,
      status: 'accepted',
      dryRun: false,
      auditId,
      ...(auditWarning === undefined ? {} : { auditWarning }),
      result: storedHandlerResult,
    },
  }, requestId, 202);
}

type DashboardScopedAuthResult =
  | { ok: true; principal: { actor: string; scope: RainrailDashboardScope; client?: string } }
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
): { actor: string; scope: RainrailDashboardScope; client?: string } | undefined {
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
    } catch {
      return '[unserializable]';
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
  let sanitized = redactSensitiveText(value);
  const orderedValues = [...sensitiveValues]
    .filter((sensitiveValue) => sensitiveValue.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const sensitiveValue of orderedValues) {
    sanitized = sanitized.split(sensitiveValue).join('[redacted]');
  }

  return sanitized;
}

function sanitizeAuditHeaderValue(value: string | null): string | undefined {
  if (value === null) return undefined;

  const sanitized = redactSensitiveText(value)
    .replace(/[\r\n]/gu, ' ')
    .replace(/[^A-Za-z0-9 ._:@/+=\-[\]]/gu, '_')
    .trim()
    .slice(0, 128);

  return sanitized.length === 0 ? undefined : sanitized;
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
