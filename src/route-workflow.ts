import type { RainrailEventEnvelope } from './events.js';
import type { PluginRuntimeContext, RuntimeCapabilityName, WorkflowPlugin } from './plugins.js';
import { defineWorkflowPlugin } from './workflow-plugin.js';

export interface RouteEventContext {
  sourceId: string;
  sourceName: string;
  eventName: string;
  messageId: string;
  message: RainrailEventEnvelope;
  event: unknown;
  source: RainrailEventEnvelope['source'];
  subject: RainrailEventEnvelope['subject'];
  delivery: RainrailEventEnvelope['delivery'];
  rawPayload: RainrailEventEnvelope['rawPayload'];
}

export type Matcher =
  | { always: boolean }
  | { and: readonly Matcher[] }
  | { or: readonly Matcher[] }
  | { not: Matcher }
  | { source: string }
  | { eventName: string }
  | { path: string; equals: unknown }
  | { path: string; notEquals: unknown }
  | { path: string; exists: boolean }
  | { path: string; includes: unknown };

export interface NoopActionDefinition {
  type: 'noop';
  reason?: string;
}

export type ActionDefinition = NoopActionDefinition;
export type ActionStatus = 'completed' | 'failed';

export interface ActionExecution {
  actionType: ActionDefinition['type'];
  status: ActionStatus;
  reason?: string;
  error?: string;
}

export interface RouteDefinition {
  id: string;
  description?: string;
  match: Matcher;
  action: ActionDefinition;
}

export interface RouteExecution {
  routeId: string;
  action: ActionExecution;
}

export interface RouteDecision {
  action: 'matched' | 'noop';
  sourceId: string;
  sourceName: string;
  eventName: string;
  messageId: string;
  matchedRoutes: RouteExecution[];
  unmatchedRouteIds: string[];
  reason?: string;
}

export interface RouteInput {
  event: RainrailEventEnvelope;
  routes?: readonly RouteDefinition[];
}

export interface RouteWorkflowOptions {
  name?: string;
  routes?: readonly RouteDefinition[];
  capabilities?: RuntimeCapabilityName[];
  timeoutMs?: number;
}

export interface RouteLocalHandlerOptions {
  routes?: readonly RouteDefinition[];
}

const missing = Symbol('missing');

export const defaultRouteDefinitions: readonly RouteDefinition[] = [
  {
    id: 'baseline-noop',
    description: 'Keep the initial Rainrail behavior by dropping all events.',
    match: { always: true },
    action: {
      type: 'noop',
      reason: 'baseline Rainrail route drops all events',
    },
  },
];

export function createRouteEventContext(event: RainrailEventEnvelope): RouteEventContext {
  return {
    sourceId: event.source.type,
    sourceName: event.source.name,
    eventName: event.name,
    messageId: event.id,
    message: event,
    event: event.payload,
    source: event.source,
    subject: event.subject,
    delivery: event.delivery,
    rawPayload: event.rawPayload,
  };
}

export function matchesRoute(matcher: Matcher, eventOrContext: RainrailEventEnvelope | RouteEventContext): boolean {
  const context = isRouteEventContext(eventOrContext) ? eventOrContext : createRouteEventContext(eventOrContext);
  return matchesRouteContext(matcher, context);
}

export function routeRainrailEvent(input: RouteInput): RouteDecision {
  const context = createRouteEventContext(input.event);
  const routes = input.routes ?? defaultRouteDefinitions;
  const matchedRoutes: RouteExecution[] = [];
  const unmatchedRouteIds: string[] = [];

  for (const route of routes) {
    if (!matchesRouteContext(route.match, context)) {
      unmatchedRouteIds.push(route.id);
      continue;
    }

    matchedRoutes.push({
      routeId: route.id,
      action: executeRouteAction(route.action),
    });
  }

  const decision: RouteDecision = {
    action: matchedRoutes.length > 0 ? 'matched' : 'noop',
    sourceId: context.sourceId,
    sourceName: context.sourceName,
    eventName: context.eventName,
    messageId: context.messageId,
    matchedRoutes,
    unmatchedRouteIds,
  };

  if (matchedRoutes.length === 0) {
    decision.reason = 'no routes matched';
  }

  return decision;
}

export function createRouteWorkflow(options: RouteWorkflowOptions = {}): WorkflowPlugin {
  const workflow: WorkflowPlugin = defineWorkflowPlugin({
    name: options.name ?? 'route-dispatch',
    accepts: () => true,
    handle: (event) => routeRainrailEvent(createRouteInput(event, options.routes)),
  });

  if (options.capabilities !== undefined) {
    workflow.capabilities = options.capabilities;
  }

  if (options.timeoutMs !== undefined) {
    workflow.timeoutMs = options.timeoutMs;
  }

  return workflow;
}

export function createRouteLocalHandler(options: RouteLocalHandlerOptions = {}) {
  return (event: RainrailEventEnvelope, _context: PluginRuntimeContext): RouteDecision =>
    routeRainrailEvent(createRouteInput(event, options.routes));
}

function createRouteInput(event: RainrailEventEnvelope, routes: readonly RouteDefinition[] | undefined): RouteInput {
  return routes === undefined ? { event } : { event, routes };
}

function matchesRouteContext(matcher: Matcher, context: RouteEventContext): boolean {
  if ('always' in matcher) {
    return matcher.always;
  }
  if ('and' in matcher) {
    return matcher.and.every((child) => matchesRouteContext(child, context));
  }
  if ('or' in matcher) {
    return matcher.or.some((child) => matchesRouteContext(child, context));
  }
  if ('not' in matcher) {
    return !matchesRouteContext(matcher.not, context);
  }
  if ('source' in matcher) {
    return context.sourceId === matcher.source || context.sourceName === matcher.source;
  }
  if ('eventName' in matcher) {
    return context.eventName === matcher.eventName;
  }
  if ('equals' in matcher) {
    return valueEquals(resolvePath(context, matcher.path), matcher.equals);
  }
  if ('notEquals' in matcher) {
    const value = resolvePath(context, matcher.path);
    return value !== missing && !valueEquals(value, matcher.notEquals);
  }
  if ('exists' in matcher) {
    return (resolvePath(context, matcher.path) !== missing) === matcher.exists;
  }
  if ('includes' in matcher) {
    const value = resolvePath(context, matcher.path);
    if (Array.isArray(value)) {
      return value.some((item) => valueEquals(item, matcher.includes));
    }
    if (typeof value === 'string' && typeof matcher.includes === 'string') {
      return value.includes(matcher.includes);
    }
    return false;
  }

  return false;
}

function executeRouteAction(action: ActionDefinition): ActionExecution {
  switch (action.type) {
    case 'noop':
      return {
        actionType: 'noop',
        status: 'completed',
        reason: action.reason ?? 'noop action completed',
      };
  }
}

function resolvePath(context: RouteEventContext, path: string): unknown | typeof missing {
  const segments = path.split('.');
  let current: unknown = context;

  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return missing;
    }
    current = current[segment];
  }

  return current;
}

function valueEquals(left: unknown | typeof missing, right: unknown): boolean {
  if (left === missing) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRouteEventContext(value: RainrailEventEnvelope | RouteEventContext): value is RouteEventContext {
  return 'message' in value && 'messageId' in value && 'eventName' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
