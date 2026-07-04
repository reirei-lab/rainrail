import type { RainrailEventEnvelope } from './events.js';

export interface RainrailIntakePublishResult {
  ok: boolean;
  status: number;
}

export interface RainrailIntakeAdapterContext {
  publish(event: RainrailEventEnvelope): Promise<RainrailIntakePublishResult>;
}

export interface RainrailIntakeRoute {
  path: `/${string}`;
  methods: readonly string[];
  maxBodyBytes?: number;
  handle(request: Request, context: RainrailIntakeAdapterContext): Response | Promise<Response>;
}

export interface RainrailIntakeAdapter {
  name: string;
  routes?: readonly RainrailIntakeRoute[];
  tail?: (events: unknown[], context: RainrailIntakeAdapterContext) => unknown | Promise<unknown>;
}

export interface RainrailIntakeRouteMatch {
  route: RainrailIntakeRoute;
}

export interface RainrailIntakeRouteMethodMismatch {
  allowedMethods: readonly string[];
}

export interface RainrailIntakeRegistry {
  routeFor(request: Request): RainrailIntakeRouteMatch | RainrailIntakeRouteMethodMismatch | undefined;
  allowedMethodsForPath(pathname: string): readonly string[] | undefined;
  routeNeedsBody(pathname: string, method: string): boolean;
  routeBodyLimit(pathname: string, method: string): number | undefined;
  tail?: RainrailIntakeAdapter['tail'];
}

const CORE_ROUTE_PATHS = new Set([
  '/healthz',
  '/events',
  '/api/state',
  '/api/v1/overview',
  '/api/v1/events',
  '/api/v1/workflow-runs',
  '/api/v1/agent-tasks',
]);
const CORE_ROUTE_PREFIXES = [
  '/api/events/',
  '/api/v1/events/',
  '/api/v1/workflow-runs/',
  '/api/v1/agent-tasks/',
] as const;

export function createRainrailIntakeRegistry(adapters: readonly RainrailIntakeAdapter[] = []): RainrailIntakeRegistry {
  const routeHandlers = new Map<string, RainrailIntakeRoute>();
  const routesByPath = new Map<string, Set<string>>();
  let tail: RainrailIntakeAdapter['tail'];
  let tailAdapterName: string | undefined;

  for (const adapter of adapters) {
    for (const route of adapter.routes ?? []) {
      for (const method of normalizedMethods(route.methods)) {
        const key = `${method} ${route.path}`;
        if (isCoreRoutePath(route.path)) {
          throw new Error(`conflicting intake route: ${adapter.name} ${key} is reserved by Rainrail core`);
        }
        if (routeHandlers.has(key)) {
          throw new Error(`conflicting intake route: ${adapter.name} ${key}`);
        }

        routeHandlers.set(key, route);
        const pathMethods = routesByPath.get(route.path) ?? new Set<string>();
        pathMethods.add(method);
        routesByPath.set(route.path, pathMethods);
      }
    }

    if (adapter.tail !== undefined) {
      if (tail !== undefined) {
        throw new Error(`conflicting intake tail handlers: ${tailAdapterName} and ${adapter.name}`);
      }
      tail = adapter.tail;
      tailAdapterName = adapter.name;
    }
  }

  return {
    routeFor(request) {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const route = routeHandlers.get(`${method} ${url.pathname}`);
      if (route !== undefined) return { route };

      const allowedMethods = routesByPath.get(url.pathname);
      if (allowedMethods === undefined) return undefined;

      return { allowedMethods: [...allowedMethods].sort() };
    },
    allowedMethodsForPath(pathname) {
      const allowedMethods = routesByPath.get(pathname);
      return allowedMethods === undefined ? undefined : [...allowedMethods].sort();
    },
    routeNeedsBody(pathname, method) {
      return routeHandlers.has(`${method.toUpperCase()} ${pathname}`);
    },
    routeBodyLimit(pathname, method) {
      return routeHandlers.get(`${method.toUpperCase()} ${pathname}`)?.maxBodyBytes;
    },
    ...(tail === undefined ? {} : { tail }),
  };
}

function normalizedMethods(methods: readonly string[]): string[] {
  return methods.map((method) => method.toUpperCase());
}

function isCoreRoutePath(pathname: string): boolean {
  return CORE_ROUTE_PATHS.has(pathname) || CORE_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
