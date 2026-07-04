import { rainrailEventsAuthErrorResponse, verifyRainrailEventsBearerToken } from './events-auth.js';
import type { RainrailEventEnvelope } from './events.js';
import {
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
}

export interface RainrailHttpApp {
  fetch(request: Request): Promise<Response>;
  tail?(events: unknown[]): Promise<unknown>;
}

const INTERNAL_ROOM_ORIGIN = 'https://rainrail-room.local';

export function createRainrailHttpApp(options: RainrailHttpAppOptions): RainrailHttpApp {
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

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}

function verifyDashboardReadRequest(request: Request, options: RainrailHttpAppOptions): Response | undefined {
  if (options.operationalStore === undefined) return undefined;

  const auth = verifyRainrailEventsBearerToken(request, options.eventsBearerToken);
  return auth.ok ? undefined : rainrailEventsAuthErrorResponse(auth);
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

  const collection = parseCollectionRequest(url, ['filter[repository]', 'filter[source]', 'filter[subjectType]']);
  if (!collection.ok) return collection.response;

  const filtered = store.listEvents()
    .filter((event) => matchesOptionalFilter(event.source.repository, url.searchParams.get('filter[repository]')))
    .filter((event) => matchesOptionalFilter(event.source.type, url.searchParams.get('filter[source]')))
    .filter((event) => matchesOptionalFilter(event.subject.type, url.searchParams.get('filter[subjectType]')));
  const page = pageRows(filtered, collection.limit, collection.cursor, eventCursorValue);
  if (!page.ok) return page.response;

  return jsonResponse({
    data: page.rows.map(eventToCompactRow),
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

  return jsonResponse({
    data: {
      id: event.id,
      type: 'event',
      compact: eventToCompactRow(event),
      record: {
        name: event.name,
        source: event.source,
        delivery: event.delivery,
        subject: event.subject,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        envelope: event.envelope,
        activityEvents: store.listActivityEvents().filter((activity) => activity.sourceEventId === event.id),
        handlerRetries: store.listEventHandlerRetries().filter((retry) => retry.eventId === event.id),
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

function eventToCompactRow(event: StoredOperationalEvent) {
  return {
    id: event.id,
    type: 'event',
    status: 'received',
    summary: eventSummary(event),
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

async function publishEvent(options: RainrailHttpAppOptions, event: RainrailEventEnvelope): Promise<Response> {
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
