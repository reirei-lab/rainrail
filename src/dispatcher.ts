import type { RainrailEventEnvelope } from './events.js';
import type { GitHubPullRequestProvider } from './pr-lifecycle.js';
import type { RuntimeProvider } from './runtime-provider.js';
import type { TaskProvider, TaskProviderRegistry } from './task-provider.js';
import type {
  PluginRuntimeContext,
  RuntimeActionImplementations,
  RuntimeActions,
  RuntimeCapabilityName,
  WorkflowPlugin,
  WorkflowPluginResult,
} from './plugins.js';

export type WorkflowAuditResult = 'fulfilled' | 'rejected' | 'denied' | 'timeout';

export interface WorkflowAuditEntry {
  pluginId: string;
  eventId: string;
  action: 'plugin.handle' | 'mergePullRequest' | 'startRuntime' | 'readSecret' | (string & {});
  result: WorkflowAuditResult;
  runId: string;
  occurredAt: string;
  reason?: string;
}

export interface WorkflowAuditSink {
  record(entry: WorkflowAuditEntry): void | Promise<void>;
}

export type RuntimeDispatcherContext = Pick<PluginRuntimeContext, 'runId' | 'now'> &
  Partial<Omit<PluginRuntimeContext, 'runId' | 'now' | 'actions' | 'signal'>> & {
  actions?: Partial<RuntimeActionImplementations>;
  signal?: AbortSignal;
};

export interface RuntimeDispatcherOptions {
  workflows: WorkflowPlugin[];
  runtime: RuntimeDispatcherContext;
  audit?: WorkflowAuditSink;
  defaultTimeoutMs?: number;
}

export interface RuntimeDispatcher {
  dispatch(event: RainrailEventEnvelope): Promise<WorkflowPluginResult[]>;
}

type DispatchAgentCapability = NonNullable<NonNullable<PluginRuntimeContext['capabilities']>['dispatchAgent']>;
type DispatchAgentResolver = () => DispatchAgentCapability | undefined;
const maxTimerDelayMs = 2 ** 31 - 1;

interface WorkflowExecutionPolicy {
  name: string;
  capabilities: ReadonlySet<RuntimeCapabilityName>;
}

interface WorkflowExecutionRecord {
  workflow: WorkflowPlugin;
  policy: WorkflowExecutionPolicy;
  policySnapshot: boolean;
  policyAccessor?: () => RuntimeCapabilityName[] | undefined;
  policyError?: unknown;
  timeoutSnapshot: boolean;
  timeoutMs?: number;
  timeoutAccessor?: () => number | undefined;
  timeoutError?: unknown;
}

interface WorkflowLifecycle {
  signal: AbortSignal;
  closeSideEffects: () => void;
  isSideEffectClosed: () => boolean;
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  const workflows = options.workflows.map(createWorkflowExecutionRecord);

  return {
    async dispatch(event): Promise<WorkflowPluginResult[]> {
      const results: Array<WorkflowPluginResult | undefined> = await Promise.all(
        workflows.map(async (record) => {
          const { workflow } = record;
          let policy = record.policy;
          let metadataResolved = false;
          let acceptsStarted = false;
          let acceptsCompleted = false;
          const audit = (action: WorkflowAuditEntry['action'], result: WorkflowAuditResult, reason?: unknown) =>
            recordAudit(options, policy, event, action, result, reason);

          try {
            if (workflow.accepts) {
              acceptsStarted = true;
              const accepted = workflow.accepts(event);
              acceptsCompleted = true;
              if (!accepted) {
                return undefined;
              }
            }

            const metadata = resolveWorkflowExecutionMetadata(record);
            policy = metadata.policy;
            metadataResolved = true;

            if (metadata.policyError !== undefined) {
              throw metadata.policyError;
            }

            if (metadata.timeoutError !== undefined) {
              throw metadata.timeoutError;
            }

            const abort = createWorkflowAbortController(options.runtime.signal);
            let workflowStarted = false;
            let value: unknown;
            try {
              const lifecycle = createWorkflowLifecycle(abort.controller.signal);
              const context = createWorkflowContext(options, policy, event, lifecycle);
              const workflowTimeoutMs = normalizeTimeoutMs(metadata.timeoutMs ?? options.defaultTimeoutMs);
              workflowStarted = true;
              value = await runWorkflow(() => workflow.handle(event, context), workflowTimeoutMs, abort, lifecycle);
            } finally {
              if (!workflowStarted) {
                abort.dispose();
              }
            }

            await audit('plugin.handle', 'fulfilled');

            return {
              pluginName: policy.name,
              eventId: event.id,
              status: 'fulfilled',
              value,
            } satisfies WorkflowPluginResult;
          } catch (reason) {
            if (acceptsStarted && !acceptsCompleted) {
              policy = record.policySnapshot ? policy : withSecretRedactionCapability(policy);
            } else if (!metadataResolved) {
              const metadata = resolveWorkflowExecutionMetadata(record);
              if (metadata.policyError === undefined) {
                policy = metadata.policy;
              }
            }

            await audit('plugin.handle', reason instanceof PluginTimeoutError ? 'timeout' : 'rejected', reason);

            return {
              pluginName: policy.name,
              eventId: event.id,
              status: 'rejected',
              reason,
            } satisfies WorkflowPluginResult;
          }
        }),
      );

      return results.filter((result): result is WorkflowPluginResult => result !== undefined);
    },
  };
}

function withSecretRedactionCapability(policy: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  return policy.capabilities.has('secret:access')
    ? policy
    : {
        ...policy,
        capabilities: new Set([...policy.capabilities, 'secret:access']),
      };
}

function createWorkflowExecutionRecord(workflow: WorkflowPlugin): WorkflowExecutionRecord {
  const nameMetadata = readWorkflowNameMetadata(workflow);
  const fallbackPolicy: WorkflowExecutionPolicy = {
    name: nameMetadata.name,
    capabilities: new Set(),
  };
  const record: WorkflowExecutionRecord = {
    workflow,
    policy: fallbackPolicy,
    policySnapshot: true,
    timeoutSnapshot: true,
  };
  if (nameMetadata.error !== undefined) {
    record.policyError = nameMetadata.error;
  }
  let capabilitiesDescriptor: PropertyDescriptor | undefined;
  try {
    capabilitiesDescriptor = findPropertyDescriptor(workflow, 'capabilities');
  } catch (policyError) {
    record.policyError = policyError;
  }
  if (capabilitiesDescriptor !== undefined) {
    if ('value' in capabilitiesDescriptor) {
      try {
        record.policy = {
          name: nameMetadata.name,
          capabilities: new Set((capabilitiesDescriptor.value as RuntimeCapabilityName[] | undefined) ?? []),
        };
      } catch (policyError) {
        record.policyError = policyError;
      }
    } else {
      record.policyAccessor = () => {
        return capabilitiesDescriptor.get?.call(workflow) as RuntimeCapabilityName[] | undefined;
      };
      record.policySnapshot = false;
    }
  }

  let timeoutDescriptor: PropertyDescriptor | undefined;
  try {
    timeoutDescriptor = findPropertyDescriptor(workflow, 'timeoutMs');
  } catch (timeoutError) {
    record.timeoutError = timeoutError;
  }
  if (timeoutDescriptor !== undefined) {
    if ('value' in timeoutDescriptor) {
      const timeoutMs = normalizeTimeoutMs(timeoutDescriptor.value);
      if (timeoutMs !== undefined) {
        record.timeoutMs = timeoutMs;
      }
    } else {
      record.timeoutAccessor = () => {
        return timeoutDescriptor.get?.call(workflow) as number | undefined;
      };
      record.timeoutSnapshot = false;
    }
  }

  return record;
}

function resolveWorkflowExecutionMetadata(record: WorkflowExecutionRecord): WorkflowExecutionRecord {
  const resolved: WorkflowExecutionRecord = { ...record };

  if (!resolved.policySnapshot) {
    try {
      resolved.policy = snapshotWorkflowPolicy(record.workflow, record.policyAccessor);
    } catch (policyError) {
      resolved.policyError = policyError;
    }
    resolved.policySnapshot = true;
  }

  if (!resolved.timeoutSnapshot) {
    try {
      const timeoutMs = record.timeoutAccessor === undefined ? record.workflow.timeoutMs : record.timeoutAccessor();
      const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
      if (normalizedTimeoutMs !== undefined) {
        resolved.timeoutMs = normalizedTimeoutMs;
      }
    } catch (timeoutError) {
      resolved.timeoutError = timeoutError;
    }
    resolved.timeoutSnapshot = true;
  }

  return resolved;
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maxTimerDelayMs
    ? value
    : undefined;
}

function findPropertyDescriptor(target: object, property: string | symbol): PropertyDescriptor | undefined {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) {
      return descriptor;
    }
    current = Reflect.getPrototypeOf(current);
  }

  return undefined;
}

function snapshotWorkflowPolicy(
  workflow: WorkflowPlugin,
  capabilityAccessor?: () => RuntimeCapabilityName[] | undefined,
): WorkflowExecutionPolicy {
  return {
    name: workflow.name,
    capabilities: new Set((capabilityAccessor === undefined ? workflow.capabilities : capabilityAccessor()) ?? []),
  };
}

function readWorkflowName(workflow: WorkflowPlugin): string {
  return readWorkflowNameMetadata(workflow).name;
}

function readWorkflowNameMetadata(workflow: WorkflowPlugin): { name: string; error?: unknown } {
  try {
    return { name: workflow.name };
  } catch (error) {
    return { name: 'unknown-workflow', error };
  }
}

class PluginTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Plugin timed out after ${timeoutMs}ms`);
    this.name = 'PluginTimeoutError';
  }
}

class CapabilityDeniedError extends Error {
  constructor(action: keyof RuntimeActionImplementations, capability: RuntimeCapabilityName, pluginName: string) {
    super(`Plugin "${pluginName}" needs capability "${capability}" to call ${action}`);
    this.name = 'CapabilityDeniedError';
  }
}

class PluginActionAbortedError extends Error {
  constructor(action: string, pluginName: string) {
    super(`Plugin "${pluginName}" cannot call ${action} after its runtime signal was aborted`);
    this.name = 'PluginActionAbortedError';
  }
}

class PluginLifecycleEndedError extends Error {
  constructor() {
    super('Plugin handler lifecycle has ended');
    this.name = 'PluginLifecycleEndedError';
  }
}

function createWorkflowContext(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
): PluginRuntimeContext {
  const context = {} as PluginRuntimeContext;
  let capabilitiesResolved = false;
  let capabilities: PluginRuntimeContext['capabilities'];
  let providers: PluginRuntimeContext['providers'] | undefined;
  let runtime: PluginRuntimeContext['runtime'] | undefined;
  const getCapabilities = () => {
    if (!capabilitiesResolved) {
      capabilities = createGatedRuntimeCapabilities(options, policy, event, lifecycle);
      capabilitiesResolved = true;
    }

    return capabilities;
  };
  const getProviders = () => {
    providers ??= createGuardedProviders(options, policy, event, lifecycle);
    return providers;
  };
  const getRuntime = () => {
    runtime ??= createGatedRuntimeProvider(options, policy, event, lifecycle);
    return runtime;
  };

  defineWorkflowContextAccessor(context, 'runId', () => options.runtime.runId);
  defineWorkflowContextProperty(context, 'now', () => options.runtime.now());

  defineWorkflowContextAccessor(context, 'capabilities', getCapabilities);
  defineWorkflowContextAccessor(context, 'providers', getProviders);
  defineWorkflowContextAccessor(context, 'runtime', getRuntime);
  defineWorkflowContextProperty(context, 'signal', lifecycle.signal);
  defineWorkflowContextProperty(context, 'actions', createGatedRuntimeActions(options, policy, event, lifecycle));

  return context;
}

function defineWorkflowContextAccessor<TKey extends keyof PluginRuntimeContext>(
  context: PluginRuntimeContext,
  key: TKey,
  get: () => PluginRuntimeContext[TKey],
): void {
  Object.defineProperty(context, key, {
    configurable: true,
    enumerable: true,
    get,
  });
}

function defineWorkflowContextProperty<TKey extends keyof PluginRuntimeContext>(
  context: PluginRuntimeContext,
  key: TKey,
  value: PluginRuntimeContext[TKey],
): void {
  Object.defineProperty(context, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

const unavailableProviders: TaskProviderRegistry = {
  tasks: {
    name: 'unavailable-tasks',
    kind: 'task-provider',
    getIssue: async () => {
      throw new Error('Task provider is not configured');
    },
    createComment: async () => {
      throw new Error('Task provider is not configured');
    },
  },
};

const unavailableRuntimeProvider: RuntimeProvider = {
  name: 'unavailable-runtime',
  kind: 'runtime-provider',
  startRun: async () => {
    throw new Error('Runtime provider is not configured');
  },
};

function createGatedRuntimeProvider(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
): RuntimeProvider {
  let runtime: RuntimeProvider | undefined;
  const getRuntime = () => {
    runtime ??= options.runtime.runtime ?? unavailableRuntimeProvider;
    return runtime;
  };

  const provider: RuntimeProvider = {
    get name() {
      return getRuntime().name;
    },
    get kind() {
      return getRuntime().kind;
    },
    startRun: (request, context) =>
      callRuntimeStartRun(options, policy, event, lifecycle, getRuntime, request, context?.signal),
  };
  Object.defineProperty(provider, 'resumeRun', {
    configurable: true,
    enumerable: true,
    get() {
      const resumeRun = (
        request: Parameters<NonNullable<RuntimeProvider['resumeRun']>>[0],
        context?: Parameters<NonNullable<RuntimeProvider['resumeRun']>>[1],
      ) =>
        callRuntimeResumeRun(options, policy, event, lifecycle, getRuntime, request, context?.signal);
      if (!policy.capabilities.has('runtime:start')) {
        return resumeRun;
      }
      if (lifecycle.isSideEffectClosed()) {
        return resumeRun;
      }
      try {
        if (getRuntime().resumeRun === undefined) {
          return undefined;
        }
      } catch {
        return resumeRun;
      }
      return resumeRun;
    },
  });
  return provider;
}

async function callRuntimeStartRun(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  getRuntime: () => RuntimeProvider,
  request: Parameters<RuntimeProvider['startRun']>[0],
  callerSignal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<RuntimeProvider['startRun']>>> {
  if (lifecycle.isSideEffectClosed()) {
    const reason = new PluginActionAbortedError('startRuntime', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  if (!policy.capabilities.has('runtime:start')) {
    const reason = new CapabilityDeniedError('startRuntime', 'runtime:start', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  try {
    const runtime = getRuntime();
    const value = await runtime.startRun(request, { signal: combineAbortSignals(lifecycle.signal, callerSignal) });
    await recordAudit(options, policy, event, 'startRuntime', 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }
}

async function callRuntimeResumeRun(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  getRuntime: () => RuntimeProvider,
  request: Parameters<NonNullable<RuntimeProvider['resumeRun']>>[0],
  callerSignal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<NonNullable<RuntimeProvider['resumeRun']>>>> {
  if (lifecycle.isSideEffectClosed()) {
    const reason = new PluginActionAbortedError('startRuntime', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  if (!policy.capabilities.has('runtime:start')) {
    const reason = new CapabilityDeniedError('startRuntime', 'runtime:start', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  try {
    const runtime = getRuntime();
    if (runtime.resumeRun === undefined) {
      throw new Error('Runtime provider does not support resumeRun');
    }
    const value = await runtime.resumeRun(request, { signal: combineAbortSignals(lifecycle.signal, callerSignal) });
    await recordAudit(options, policy, event, 'startRuntime', 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }
}

function createGatedRuntimeCapabilities(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
): PluginRuntimeContext['capabilities'] {
  const capabilities = options.runtime.capabilities;
  if (capabilities === undefined) {
    return undefined;
  }

  let rawDispatchAgent: DispatchAgentCapability | undefined;
  let rawDispatchAgentResolved = false;
  const peekRawDispatchAgent = () => {
    if (rawDispatchAgentResolved) {
      return rawDispatchAgent;
    }

    const descriptor = findPropertyDescriptor(capabilities, 'dispatchAgent');
    return descriptor !== undefined && 'value' in descriptor
      ? (descriptor.value as DispatchAgentCapability | undefined)
      : undefined;
  };
  const getRawDispatchAgent = () => {
    if (!rawDispatchAgentResolved) {
      rawDispatchAgent = capabilities.dispatchAgent;
      rawDispatchAgentResolved = true;
    }

    return rawDispatchAgent;
  };

  let normalizeDispatchAgentResult = (value: unknown): unknown => value;
  const dispatchAgent = ((request, context) => {
    if (policy.capabilities.has('runtime:start') && !lifecycle.isSideEffectClosed()) {
      try {
        if (getRawDispatchAgent() === undefined) {
          return undefined;
        }
      } catch {
        // Let callDispatchAgent classify and audit getter failures as startRuntime rejections.
      }
    }

    return Promise.resolve(
      callDispatchAgent(options, policy, event, lifecycle, getRawDispatchAgent, capabilities, request, context?.signal),
    ).then((value) => normalizeDispatchAgentResult(value));
  }) as DispatchAgentCapability;

  const proxy = createDispatchAgentCapabilityProxy(capabilities, dispatchAgent, getRawDispatchAgent, peekRawDispatchAgent);
  normalizeDispatchAgentResult = proxy.normalizeResult;
  return proxy.view;
}

interface DispatchAgentCapabilityProxy {
  view: PluginRuntimeContext['capabilities'];
  normalizeResult: (value: unknown) => unknown;
}

function createDispatchAgentCapabilityProxy(
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  peekRawDispatchAgent: () => DispatchAgentCapability | undefined,
): DispatchAgentCapabilityProxy {
  const viewCache = new WeakMap<object, object>();
  const sourceCache = new WeakMap<object, object>();
  const unwrapCapabilityValue = (value: unknown): unknown =>
    (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? sourceCache.get(value) ?? value
      : value;
  const hasDispatchAgentProperty = (source: object): boolean => {
    const descriptor = findPropertyDescriptor(source, 'dispatchAgent');
    if (descriptor === undefined) {
      return false;
    }

    if ('value' in descriptor) {
      return descriptor.value !== undefined;
    }

    return true;
  };
  const hasDispatchAgentAccessor = (source: object): boolean => {
    const descriptor = findPropertyDescriptor(source, 'dispatchAgent');
    return descriptor !== undefined && !('value' in descriptor);
  };
  const rootHasDispatchAgentAccessor = hasDispatchAgentAccessor(capabilities);

  const isDispatchAgentFunction = (source: object, value: Function, property?: string | symbol): boolean => {
    if (property === 'dispatchAgent') {
      return true;
    }

    if (isDispatchAgentAliasProperty(property)) {
      return false;
    }

    const propertyDescriptor = property === undefined ? undefined : findPropertyDescriptor(source, property);
    const shouldResolveAccessorAlias =
      propertyDescriptor !== undefined && !('value' in propertyDescriptor) && isDispatchAgentLikeProperty(property);
    let rawDispatchAgent: DispatchAgentCapability | undefined;
    try {
      rawDispatchAgent =
        property === 'startAgent' || shouldResolveAccessorAlias ? getRawDispatchAgent() : peekRawDispatchAgent();
    } catch (reason) {
      if (shouldResolveAccessorAlias) {
        return false;
      }

      throw reason;
    }
    if (value === rawDispatchAgent) {
      return true;
    }

    return isBoundDispatchAgentAlias(value, property, rawDispatchAgent);
  };

  const bindCapabilityFunction = (
    source: object,
    value: Function,
    safeReceiver: object,
    property?: string | symbol,
    gateDispatchRequests = false,
  ): Function => {
    if (isDispatchAgentFunction(source, value, property)) {
      return dispatchAgent;
    }

    const receiver = functionSourceMentions(value, 'instanceof') && !helperMayResolveDispatchAgent(value)
      ? source
      : safeReceiver;
    const wrapped = (...args: unknown[]) =>
      callCapabilityFunction(
        value,
        capabilities,
        dispatchAgent,
        getRawDispatchAgent,
        peekRawDispatchAgent,
        source,
        receiver,
        args,
        (object) => createCapabilityView(object),
        property,
        gateDispatchRequests,
        safeReceiver,
      );
    sourceCache.set(wrapped, value);
    return wrapped;
  };

  const readCapabilityProperty = (source: object, property: string | symbol): unknown => {
    if (property === 'then') {
      return undefined;
    }

    if (property === '__lookupGetter__') {
      return (lookupProperty: string | symbol) => (lookupProperty === 'dispatchAgent' ? () => dispatchAgent : undefined);
    }

    if (property === '__lookupSetter__') {
      return () => undefined;
    }

    if (property === 'valueOf') {
      if (isBuiltinCapabilityObject(source)) {
        const valueOf = Reflect.get(source, property, source);
        if (typeof valueOf === 'function') {
          return (...args: unknown[]) => Reflect.apply(valueOf, source, args);
        }
      }

      return () => createCapabilityView(source);
    }

    if (property === '__proto__') {
      const prototype = Reflect.getPrototypeOf(source);
      return prototype === null ? null : createCapabilityView(prototype);
    }

    if (property === 'constructor') {
      const safeReceiver = createCapabilityView(source);
      const constructorValue = readCapabilityValue(source, property, safeReceiver);
      return typeof constructorValue === 'function'
        ? createCapabilityConstructorView(
            constructorValue,
            capabilities,
            dispatchAgent,
            getRawDispatchAgent,
            peekRawDispatchAgent,
            (object) => createCapabilityView(object),
          )
        : normalizeCapabilityHelperResult(
            constructorValue,
            capabilities,
            safeReceiver,
            getRawDispatchAgent,
            dispatchAgent,
            (object) => createCapabilityView(object),
          );
    }

    const safeReceiver = createCapabilityView(source);
    const receiver = isBuiltinCapabilityCollection(source) || isBuiltinCapabilityObject(source) ? source : safeReceiver;
    const value = readCapabilityValue(source, property, receiver);
    if (typeof value === 'function') {
      if (isBuiltinCapabilityCollection(source)) {
        return (...args: unknown[]) => callCapabilityCollectionMethod(
          source,
          property,
          value,
          args,
          capabilities,
          safeReceiver,
          getRawDispatchAgent,
          dispatchAgent,
          (object) => createCapabilityView(object),
          unwrapCapabilityValue,
        );
      }

      if (isBuiltinCapabilityObject(source)) {
        return (...args: unknown[]) =>
          callCapabilityFunction(
            value,
            capabilities,
            dispatchAgent,
            getRawDispatchAgent,
            peekRawDispatchAgent,
            source,
            source,
            args,
            (object) => createCapabilityView(object),
            property,
            rootHasDispatchAgentAccessor || hasDispatchAgentAccessor(source),
          );
      }

      return bindCapabilityFunction(
        source,
        value,
        safeReceiver,
        property,
        rootHasDispatchAgentAccessor || hasDispatchAgentAccessor(source),
      );
    }

    if (isPromiseLike(value)) {
      return normalizeCapabilityHelperResult(
        value,
        capabilities,
        safeReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        (object) => createCapabilityView(object),
      );
    }

    if (shouldWrapCapabilityObject(value)) {
      return createCapabilityView(value);
    }

    return value;
  };

  const describeCapabilityProperty = (source: object, property: string | symbol): PropertyDescriptor | undefined => {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
    if (descriptor === undefined) {
      return undefined;
    }

    if (property === 'dispatchAgent') {
      const dispatchAgentValue = readCapabilityValue(source, property, createCapabilityView(source));
      return {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        value: dispatchAgentValue === undefined ? undefined : dispatchAgent,
        writable: false,
      };
    }

    if (Array.isArray(source) && property === 'length') {
      return {
        configurable: false,
        enumerable: false,
        value: source.length,
        writable: true,
      };
    }

    return {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      value: readCapabilityProperty(source, property),
      writable: false,
    };
  };

  const createCapabilityView = (source: object): object => {
    if (!shouldWrapCapabilityObject(source)) {
      return source;
    }

    const cached = viewCache.get(source);
    if (cached !== undefined) {
      return cached;
    }

    let view: object;
    const viewTarget = typeof source === 'function'
      ? (() => undefined)
      : Array.isArray(source)
        ? new Array(source.length)
        : {};
    const viewHandler: ProxyHandler<object> = {
      get(_target, property) {
        if (property === 'dispatchAgent') {
          const descriptor = findPropertyDescriptor(source, 'dispatchAgent');
          if (descriptor === undefined) {
            return undefined;
          }

          if ('value' in descriptor) {
            return descriptor.value === undefined ? undefined : dispatchAgent;
          }

          return source === capabilities && dispatchAgentAccessorReturnsUndefined(source, descriptor)
            ? undefined
            : dispatchAgent;
        }

        return readCapabilityProperty(source, property);
      },
      getOwnPropertyDescriptor(_target, property) {
        return describeCapabilityProperty(source, property);
      },
      getPrototypeOf() {
        const prototype = Reflect.getPrototypeOf(source);
        return prototype === null ? null : createCapabilityView(prototype);
      },
      has(_target, property) {
        if (property === 'dispatchAgent') {
          return hasDispatchAgentProperty(source);
        }

        return property in source;
      },
      ownKeys() {
        return Reflect.ownKeys(source);
      },
    };
    if (typeof source === 'function') {
      viewHandler.apply = (_target, thisArg, args) =>
        callCapabilityFunction(
          source,
          capabilities,
          dispatchAgent,
          getRawDispatchAgent,
          peekRawDispatchAgent,
          source,
          view,
          args,
          (object) => createCapabilityView(object),
        );
    }
    view = new Proxy(viewTarget, viewHandler);

    viewCache.set(source, view);
    sourceCache.set(view, source);
    return view;
  };

  const rootView = createCapabilityView(capabilities);
  return {
    view: rootView as PluginRuntimeContext['capabilities'],
    normalizeResult: (value) =>
      normalizeCapabilityHelperResult(value, capabilities, rootView, getRawDispatchAgent, dispatchAgent, (object) =>
        createCapabilityView(object),
      ),
  };
}

function isDispatchAgentAliasProperty(property: string | symbol | undefined): boolean {
  return (
    typeof property === 'string' &&
    /^(?:dispatchAgent|startAgent|launchAgent|rawDispatchAgent)$/u.test(property)
  );
}

function isPotentialDispatchAgentAliasProperty(property: string | symbol | undefined): boolean {
  return typeof property === 'string' && /(?:^|[-_])alias(?:$|[-_])/iu.test(property);
}

function isDispatchAgentLikeProperty(property: string | symbol | undefined): boolean {
  return typeof property === 'string' && /(?:dispatch|start|launch|agent)/iu.test(property);
}

function isStarterAliasProperty(property: string | symbol | undefined): boolean {
  return typeof property === 'string' && /^(?:run|start|launch|startRun|runAgent)$/iu.test(property);
}

function createCapabilityConstructorView(
  constructorValue: unknown,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  peekRawDispatchAgent: () => DispatchAgentCapability | undefined,
  wrapObject: (object: object) => object,
): unknown {
  if (typeof constructorValue !== 'function') {
    return constructorValue;
  }

  let rawDispatchAgent: DispatchAgentCapability | undefined;
  try {
    rawDispatchAgent = peekRawDispatchAgent();
  } catch {
    rawDispatchAgent = undefined;
  }
  if (constructorValue === rawDispatchAgent || isBoundDispatchAgentAlias(constructorValue, 'constructor', rawDispatchAgent)) {
    return dispatchAgent;
  }

  const prototype = constructorValue.prototype;
  if (typeof prototype !== 'object' || prototype === null) {
    return constructorValue;
  }

  let constructorView: object;
  const readPrototypeProperty = (property: string | symbol): unknown => {
    if (property === 'dispatchAgent') {
      return dispatchAgent;
    }

    if (property === 'constructor') {
      return constructorView;
    }

    const value = readCapabilityValue(prototype, property, prototypeView, capabilities);
    const shouldResolveDispatchAgent =
      isDispatchAgentAliasProperty(property) || (typeof value === 'function' && isDispatchAgentLikeProperty(property));
    const rawDispatchAgent = shouldResolveDispatchAgent ? getRawDispatchAgent() : peekRawDispatchAgent();
    if (
      value === rawDispatchAgent ||
      (typeof value === 'function' && isBoundDispatchAgentAlias(value, property, rawDispatchAgent))
    ) {
      return dispatchAgent;
    }

    return typeof value === 'function'
      ? (...args: unknown[]) =>
          callCapabilityFunction(
            value,
            capabilities,
            dispatchAgent,
            getRawDispatchAgent,
            shouldResolveDispatchAgent ? getRawDispatchAgent : peekRawDispatchAgent,
            prototype,
            prototypeView,
            args,
            wrapObject,
          )
      : normalizeCapabilityHelperResult(value, capabilities, prototypeView, () => rawDispatchAgent, dispatchAgent, wrapObject);
  };
  const prototypeView: object = new Proxy(
    {},
    {
      get(_target, property) {
        return readPrototypeProperty(property);
      },
      getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
        const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property);
        if (descriptor === undefined) {
          return undefined;
        }

        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          value: readPrototypeProperty(property),
          writable: false,
        };
      },
      ownKeys() {
        return Reflect.ownKeys(prototype);
      },
    },
  );

  constructorView = new Proxy(
    {},
    {
      get(_target, property) {
        return readConstructorProperty(
          constructorValue,
          property,
          constructorView,
          prototypeView,
          capabilities,
          getRawDispatchAgent,
          peekRawDispatchAgent,
          dispatchAgent,
          wrapObject,
        );
      },
      getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
        if (property === 'prototype') {
          return {
            configurable: true,
            enumerable: false,
            value: prototypeView,
            writable: false,
          };
        }

        const descriptor = Reflect.getOwnPropertyDescriptor(constructorValue, property);
        if (descriptor === undefined) {
          return undefined;
        }

        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          value: readConstructorProperty(
            constructorValue,
            property,
            constructorView,
            prototypeView,
            capabilities,
            getRawDispatchAgent,
            peekRawDispatchAgent,
            dispatchAgent,
            wrapObject,
          ),
          writable: false,
        };
      },
      ownKeys() {
        return Reflect.ownKeys(constructorValue);
      },
    },
  );

  return constructorView;
}

function readConstructorProperty(
  constructorValue: Function,
  property: string | symbol,
  constructorView: object,
  prototypeView: object,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  peekRawDispatchAgent: () => DispatchAgentCapability | undefined,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
): unknown {
  if (property === 'prototype') {
    return prototypeView;
  }

  const value = Reflect.get(constructorValue, property, constructorView);
  const shouldResolveDispatchAgent =
    isDispatchAgentAliasProperty(property) || (typeof value === 'function' && isDispatchAgentLikeProperty(property));
  const rawDispatchAgent = shouldResolveDispatchAgent ? getRawDispatchAgent() : peekRawDispatchAgent();
  if (
    value === rawDispatchAgent ||
    (typeof value === 'function' && isBoundDispatchAgentAlias(value, property, rawDispatchAgent))
  ) {
    return dispatchAgent;
  }

  return typeof value === 'function'
    ? (...args: unknown[]) =>
        callCapabilityFunction(
          value,
          capabilities,
          dispatchAgent,
          getRawDispatchAgent,
          shouldResolveDispatchAgent ? getRawDispatchAgent : peekRawDispatchAgent,
          constructorValue,
          constructorView,
          args,
          wrapObject,
        )
    : normalizeCapabilityHelperResult(
        value,
        capabilities,
        constructorView,
        () => rawDispatchAgent,
        dispatchAgent,
        wrapObject,
      );
}

function callCapabilityCollectionMethod(
  source: Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>,
  property: string | symbol,
  method: Function,
  args: unknown[],
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
  unwrapValue: (value: unknown) => unknown,
): unknown {
  const normalize = (value: unknown) =>
    normalizeCapabilityHelperResult(value, capabilities, safeReceiver, getRawDispatchAgent, dispatchAgent, wrapObject);
  const collectionTag = Object.prototype.toString.call(source);

  if (collectionTag === '[object Map]') {
    const map = source as Map<unknown, unknown>;
    if (property === 'get') {
      return normalize(map.get(unwrapValue(args[0])));
    }

    if (property === 'has') {
      return map.has(unwrapValue(args[0]));
    }

    if (property === 'delete') {
      return map.delete(unwrapValue(args[0]));
    }

    if (property === 'forEach') {
      const callback = args[0];
      if (typeof callback !== 'function') {
        return Reflect.apply(method, source, args);
      }

      return map.forEach((value, key) => {
        Reflect.apply(callback, args[1], [normalize(value), normalize(key), safeReceiver]);
      });
    }

    if (property === 'values') {
      return createNormalizingIterator(map.values(), normalize);
    }

    if (property === 'keys') {
      return createNormalizingIterator(map.keys(), normalize);
    }

    if (property === 'entries' || property === Symbol.iterator) {
      return createNormalizingIterator(map.entries(), ([key, value]) => [normalize(key), normalize(value)]);
    }
  }

  if (collectionTag === '[object Set]') {
    const set = source as Set<unknown>;
    if (property === 'has') {
      return set.has(unwrapValue(args[0]));
    }

    if (property === 'delete') {
      return set.delete(unwrapValue(args[0]));
    }

    if (property === 'forEach') {
      const callback = args[0];
      if (typeof callback !== 'function') {
        return Reflect.apply(method, source, args);
      }

      return set.forEach((value) => {
        const normalized = normalize(value);
        Reflect.apply(callback, args[1], [normalized, normalized, safeReceiver]);
      });
    }

    if (property === 'values' || property === 'keys' || property === Symbol.iterator) {
      return createNormalizingIterator(set.values(), normalize);
    }

    if (property === 'entries') {
      return createNormalizingIterator(set.values(), (value) => {
        const normalized = normalize(value);
        return [normalized, normalized];
      });
    }
  }

  if (collectionTag === '[object WeakMap]' && property === 'get') {
    return normalize((source as WeakMap<object, unknown>).get(unwrapValue(args[0]) as object));
  }

  if (collectionTag === '[object WeakMap]' && property === 'has') {
    return (source as WeakMap<object, unknown>).has(unwrapValue(args[0]) as object);
  }

  if (collectionTag === '[object WeakMap]' && property === 'delete') {
    return (source as WeakMap<object, unknown>).delete(unwrapValue(args[0]) as object);
  }

  if (collectionTag === '[object WeakSet]' && property === 'has') {
    return (source as WeakSet<object>).has(unwrapValue(args[0]) as object);
  }

  if (collectionTag === '[object WeakSet]' && property === 'delete') {
    return (source as WeakSet<object>).delete(unwrapValue(args[0]) as object);
  }

  return normalizeCapabilityHelperResult(
    Reflect.apply(method, source, args),
    capabilities,
    safeReceiver,
    getRawDispatchAgent,
    dispatchAgent,
    wrapObject,
  );
}

function createNormalizingIterator<TInput, TOutput>(
  iterator: Iterator<TInput>,
  normalize: (value: TInput) => TOutput,
): IterableIterator<TOutput> {
  return {
    next(...args: [] | [undefined]) {
      const result = iterator.next(...args);
      return result.done === true
        ? { done: true, value: undefined }
        : { done: false, value: normalize(result.value) };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

function isCapabilityIterator(value: unknown): value is Iterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

function isCapabilityAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function normalizeIteratorResult(
  result: IteratorResult<unknown>,
  normalize: (value: unknown) => unknown,
): IteratorResult<unknown> {
  return result.done === true
    ? { done: true, value: normalize(result.value) }
    : { done: false, value: normalize(result.value) };
}

function createNormalizingCapabilityIterator(
  iterator: Iterator<unknown>,
  normalize: (value: unknown) => unknown,
): IterableIterator<unknown> {
  return {
    next(...args: [] | [unknown]) {
      return normalizeIteratorResult(iterator.next(...args), normalize);
    },
    return(value?: unknown) {
      return typeof iterator.return === 'function'
        ? normalizeIteratorResult(iterator.return(value), normalize)
        : { done: true, value: normalize(value) };
    },
    throw(error?: unknown) {
      if (typeof iterator.throw !== 'function') {
        throw error;
      }

      return normalizeIteratorResult(iterator.throw(error), normalize);
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

function createNormalizingAsyncIterator(
  iterator: AsyncIterator<unknown>,
  normalize: (value: unknown) => unknown,
): AsyncIterableIterator<unknown> {
  return {
    async next(...args: [] | [unknown]) {
      return normalizeIteratorResult(await iterator.next(...args), normalize);
    },
    async return(value?: unknown) {
      return typeof iterator.return === 'function'
        ? normalizeIteratorResult(await iterator.return(value), normalize)
        : { done: true, value: normalize(value) };
    },
    async throw(error?: unknown) {
      if (typeof iterator.throw !== 'function') {
        throw error;
      }

      return normalizeIteratorResult(await iterator.throw(error), normalize);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function callCapabilityFunction(
  helper: Function,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  peekRawDispatchAgent: () => DispatchAgentCapability | undefined,
  privateReceiver: object,
  safeReceiver: object,
  args: unknown[],
  wrapObject: (object: object) => object,
  property?: string | symbol,
  gateDispatchRequests = false,
  exposedReceiver: object = safeReceiver,
): unknown {
  const helperIsRawDispatchAgent = () => {
    try {
      const rawDispatchAgent = peekRawDispatchAgent();
      return helper === rawDispatchAgent || isBoundDispatchAgentAlias(helper, property, rawDispatchAgent);
    } catch {
      return false;
    }
  };
  const shouldGateDispatchRequest = () =>
    helperIsRawDispatchAgent() ||
    isDispatchAgentAliasProperty(property) ||
    isPotentialDispatchAgentAliasProperty(property) ||
    isStarterAliasProperty(property) ||
    gateDispatchRequests ||
    helperMayResolveDispatchAgent(helper);
  const retryWithPrivateReceiver = (reason: unknown) => {
    if (isDispatchAgentRequest(args[0]) && shouldGateDispatchRequest()) {
      return normalizeCapabilityFunctionResult(
        dispatchAgent(args[0], args[1] as Parameters<DispatchAgentCapability>[1]),
        capabilities,
        exposedReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        retryWithPrivateReceiver,
        wrapObject,
      );
    }

    if (shouldGateDispatchRequest()) {
      throw reason;
    }

    return normalizeCapabilityFunctionResult(
      Reflect.apply(
        helper,
        privateReceiver,
        sanitizePrivateRetryArgs(
          args,
          capabilities,
          privateReceiver,
          exposedReceiver,
          getRawDispatchAgent,
          dispatchAgent,
          wrapObject,
        ),
      ),
      capabilities,
      exposedReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      retryWithPrivateReceiver,
      wrapObject,
      true,
    );
  };

  try {
    if (args.length > 0 && shouldGateDispatchRequest()) {
      return normalizeCapabilityFunctionResult(
        dispatchAgent(
          args[0] as Parameters<DispatchAgentCapability>[0],
          args[1] as Parameters<DispatchAgentCapability>[1],
        ),
        capabilities,
        exposedReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        retryWithPrivateReceiver,
        wrapObject,
      );
    }

    if (helperMayResolveDispatchAgent(helper)) {
      const rawDispatchAgent = getRawDispatchAgent();
      if (helper === rawDispatchAgent || isBoundDispatchAgentAlias(helper, property, rawDispatchAgent)) {
        return normalizeCapabilityFunctionResult(
          dispatchAgent(
            args[0] as Parameters<DispatchAgentCapability>[0],
            args[1] as Parameters<DispatchAgentCapability>[1],
          ),
          capabilities,
          exposedReceiver,
          getRawDispatchAgent,
          dispatchAgent,
          retryWithPrivateReceiver,
          wrapObject,
        );
      }
    }

    if (isDispatchAgentRequest(args[0]) && shouldGateDispatchRequest()) {
      return normalizeCapabilityFunctionResult(
        dispatchAgent(args[0], args[1] as Parameters<DispatchAgentCapability>[1]),
        capabilities,
        exposedReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        retryWithPrivateReceiver,
        wrapObject,
      );
    }

    return normalizeCapabilityFunctionResult(
      Reflect.apply(helper, safeReceiver, args),
      capabilities,
      exposedReceiver,
      peekRawDispatchAgent,
      dispatchAgent,
      retryWithPrivateReceiver,
      wrapObject,
      true,
    );
  } catch (reason) {
    if (!isPrivateReceiverError(reason)) {
      throw reason;
    }

    return retryWithPrivateReceiver(reason);
  }
}

function sanitizePrivateRetryArgs(
  args: unknown[],
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  privateReceiver: object,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
): unknown[] {
  const normalizeCallbackValue = (value: unknown): unknown => {
    if (value === privateReceiver || value === capabilities) {
      return safeReceiver;
    }

    return normalizeCapabilityHelperResult(
      value,
      capabilities,
      safeReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      wrapObject,
      true,
    );
  };

  return args.map((arg) => {
    if (typeof arg !== 'function') {
      return normalizeCallbackValue(arg);
    }

    return function privateRetryCallback(this: unknown, ...callbackArgs: unknown[]) {
      return Reflect.apply(arg, normalizeCallbackValue(this), callbackArgs.map(normalizeCallbackValue));
    };
  });
}

function prototypeMayExposeDispatchAgent(prototype: object): boolean {
  let current: object | null = prototype;
  while (current !== null) {
    if (Reflect.getOwnPropertyDescriptor(current, 'dispatchAgent') !== undefined) {
      return true;
    }

    const constructorDescriptor = Reflect.getOwnPropertyDescriptor(current, 'constructor');
    if (
      constructorDescriptor !== undefined &&
      'value' in constructorDescriptor &&
      typeof constructorDescriptor.value === 'function' &&
      objectMayExposeDispatchAgent(constructorDescriptor.value)
    ) {
      return true;
    }

    const currentPrototype = current;
    if (
      Reflect.ownKeys(currentPrototype).some((property) => {
        if (!isDispatchAgentLikeProperty(property) && !isStarterAliasProperty(property)) {
          return false;
        }

        const descriptor = Reflect.getOwnPropertyDescriptor(currentPrototype, property);
        return descriptor !== undefined && (typeof descriptor.get === 'function' || typeof descriptor.value === 'function');
      })
    ) {
      return true;
    }

    current = Reflect.getPrototypeOf(current);
  }

  return false;
}


function isDispatchAgentRequest(value: unknown): value is Parameters<DispatchAgentCapability>[0] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    const request = value as { event?: unknown; workflow?: unknown; runId?: unknown };
    return request.event !== undefined && request.workflow !== undefined && request.runId !== undefined;
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function normalizeCapabilityFunctionResult(
  value: unknown,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  retryPrivateReceiver: (reason: unknown) => unknown,
  wrapObject: (object: object) => object,
  gateUnknownDispatchRequests = false,
): unknown {
  if (isPromiseLike(value)) {
    return normalizeCapabilityPromiseResult(
      value,
      capabilities,
      safeReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      wrapObject,
      retryPrivateReceiver,
      gateUnknownDispatchRequests,
    );
  }

  return normalizeCapabilityHelperResult(
    value,
    capabilities,
    safeReceiver,
    getRawDispatchAgent,
    dispatchAgent,
    wrapObject,
    gateUnknownDispatchRequests,
  );
}

function normalizeCapabilityHelperResult(
  value: unknown,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
  gateUnknownDispatchRequests = false,
): unknown {
  if (value === capabilities) {
    return safeReceiver;
  }

  if (value === safeReceiver) {
    return safeReceiver;
  }

  if (typeof value === 'function') {
    return createNormalizedCapabilityFunction(
      value,
      capabilities,
      safeReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      wrapObject,
      gateUnknownDispatchRequests,
    );
  }

  if (isPromiseLike(value)) {
    return normalizeCapabilityPromiseResult(
      value,
      capabilities,
      safeReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      wrapObject,
      undefined,
      gateUnknownDispatchRequests,
    );
  }

  if (isCapabilityAsyncIterator(value)) {
    return createNormalizingAsyncIterator(value, (resolved) =>
      normalizeCapabilityHelperResult(
        resolved,
        capabilities,
        safeReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        wrapObject,
        gateUnknownDispatchRequests,
      ),
    );
  }

  if (isCapabilityIterator(value)) {
    return createNormalizingCapabilityIterator(value, (resolved) =>
      normalizeCapabilityHelperResult(
        resolved,
        capabilities,
        safeReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        wrapObject,
        gateUnknownDispatchRequests,
      ),
    );
  }

  if (shouldWrapCapabilityObject(value)) {
    return wrapObject(value);
  }

  return value;
}

function createNormalizedCapabilityFunction(
  value: Function,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
  gateUnknownDispatchRequests: boolean,
): Function {
  return function normalizedCapabilityFunction(this: unknown, ...args: unknown[]) {
    if (isDispatchAgentRequest(args[0])) {
      let rawDispatchAgent: DispatchAgentCapability | undefined;
      try {
        rawDispatchAgent = getRawDispatchAgent();
      } catch (reason) {
        if (!gateUnknownDispatchRequests) {
          throw reason;
        }
      }
      if (value === rawDispatchAgent || isBoundDispatchAgentAlias(value, undefined, rawDispatchAgent)) {
        return dispatchAgent(args[0], args[1] as Parameters<DispatchAgentCapability>[1]);
      }
      if (gateUnknownDispatchRequests) {
        return dispatchAgent(args[0], args[1] as Parameters<DispatchAgentCapability>[1]);
      }
    }

    return normalizeCapabilityFunctionResult(
      Reflect.apply(value, this, args),
      capabilities,
      safeReceiver,
      getRawDispatchAgent,
      dispatchAgent,
      (reason) => {
        throw reason;
      },
      wrapObject,
      gateUnknownDispatchRequests,
    );
  };
}

function normalizeCapabilityPromiseResult(
  value: Promise<unknown>,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  getRawDispatchAgent: DispatchAgentResolver,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
  retryPrivateReceiver?: (reason: unknown) => unknown,
  gateUnknownDispatchRequests = false,
): Promise<unknown> {
  return Promise.resolve(value).then(
    (resolved) =>
      normalizeCapabilityHelperResult(
        resolved,
        capabilities,
        safeReceiver,
        getRawDispatchAgent,
        dispatchAgent,
        wrapObject,
        gateUnknownDispatchRequests,
      ),
    (reason: unknown) => {
      if (retryPrivateReceiver === undefined || !isPrivateReceiverError(reason)) {
        throw reason;
      }

      return retryPrivateReceiver(reason);
    },
  );
}

function readCapabilityValue(
  source: object,
  property: string | symbol,
  safeReceiver: object,
  privateReceiver: object = source,
): unknown {
  try {
    return Reflect.get(source, property, safeReceiver);
  } catch (reason) {
    if (!isPrivateReceiverError(reason) || capabilityAccessorMayResolveDispatchAgent(source, property)) {
      throw reason;
    }

    return Reflect.get(source, property, privateReceiver);
  }
}

function isPrivateReceiverError(reason: unknown): boolean {
  return (
    reason instanceof TypeError &&
    (reason.message.includes('private') || reason.message.includes('Receiver must be an instance of class'))
  );
}

function capabilityAccessorMayResolveDispatchAgent(source: object, property: string | symbol): boolean {
  const descriptor = findPropertyDescriptor(source, property);
  return typeof descriptor?.get === 'function' && helperMayResolveDispatchAgent(descriptor.get);
}

function helperMayResolveDispatchAgent(helper: Function): boolean {
  try {
    const source = Function.prototype.toString.call(helper);
    return (
      /this\s*(?:(?:\?\.|\.)\s*(?:dispatchAgent|startAgent|runAgent)|(?:\?\.|\s*)\[[^\]]*(?:dispatch|start|run)[^\]]*Agent[^\]]*\])/u.test(
        source,
      ) ||
      (/\bthis\b/u.test(source) && /\b(?:dispatchAgent|startAgent|runAgent)\b/u.test(source)) ||
      (/this\s*(?:\?\.|\s*)\[/u.test(source) && /\b(?:dispatch|start|run)\b/u.test(source) && /\bAgent\b/u.test(source)) ||
      /this\s*(?:\?\.|\.)\s*#[\p{ID_Start}\p{ID_Continue}]*\s*\([^)]*\)\s*\(/u.test(source) ||
      /this\s*(?:\?\.|\s*)\[\s*this\s*\.\s*#[\p{ID_Start}\p{ID_Continue}]*/u.test(source) ||
      /#[\p{ID_Start}\p{ID_Continue}]*(?:(?:dispatch|start|launch)[\p{ID_Continue}]*|run[\p{ID_Continue}]*Agent[\p{ID_Continue}]*)/iu.test(
        source,
      ) ||
      /#[\p{ID_Start}\p{ID_Continue}]*\s*\([^)]*#[\p{ID_Start}\p{ID_Continue}]*/u.test(source) ||
      /#[\p{ID_Start}\p{ID_Continue}]*\s*\([^)]*\bworkflow\b[^)]*\brunId\b/u.test(source)
    );
  } catch {
    return true;
  }
}

function dispatchAgentAccessorReturnsUndefined(receiver: object, descriptor: PropertyDescriptor): boolean {
  if (typeof descriptor.get !== 'function') {
    return false;
  }

  try {
    const getterSource = Function.prototype.toString.call(descriptor.get);
    if (/\breturn\s+(?:undefined|void 0)\b/u.test(getterSource) && !/\bthrow\b/u.test(getterSource)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function functionSourceMentions(helper: Function, token: string): boolean {
  try {
    return Function.prototype.toString.call(helper).includes(token);
  } catch {
    return true;
  }
}

function shouldWrapCapabilityObject(value: unknown): value is object {
  if (value === null) {
    return false;
  }

  if (typeof value === 'function') {
    return objectMayExposeDispatchAgent(value);
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (objectMayExposeDispatchAgent(value)) {
    return true;
  }

  if (
    isBuiltinCapabilityCollection(value) ||
    Array.isArray(value)
  ) {
    return true;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== null && prototypeMayExposeDispatchAgent(prototype)) {
    return true;
  }

  if (isBuiltinCapabilityObject(value)) {
    return true;
  }

  if (value instanceof Promise || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return false;
  }

  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Object]') {
    return true;
  }

  return prototype === Object.prototype || prototype === null;
}

function objectMayExposeDispatchAgent(value: object): boolean {
  if (findPropertyDescriptor(value, 'dispatchAgent') !== undefined) {
    return true;
  }

  return Reflect.ownKeys(value).some((property) => {
    if (!isDispatchAgentLikeProperty(property) && !isStarterAliasProperty(property)) {
      return false;
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    return descriptor !== undefined && (typeof descriptor.get === 'function' || typeof descriptor.value === 'function');
  });
}

function isBuiltinCapabilityCollection(
  value: object,
): value is Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Map]' || tag === '[object Set]' || tag === '[object WeakMap]' || tag === '[object WeakSet]';
}

function isBuiltinCapabilityObject(value: object): boolean {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Date]' || tag === '[object RegExp]' || tag === '[object Error]';
}

function isBoundDispatchAgentAlias(
  value: Function,
  property: string | symbol | undefined,
  rawDispatchAgent: DispatchAgentCapability | undefined,
): boolean {
  if (!value.name.startsWith('bound ')) {
    return false;
  }

  if (rawDispatchAgent?.name && value.name === `bound ${rawDispatchAgent.name}`) {
    return true;
  }

  if (rawDispatchAgent?.name.startsWith('bound ') && value.name === rawDispatchAgent.name) {
    return true;
  }

  if (rawDispatchAgent !== undefined && value.name === 'bound ') {
    return !rawDispatchAgent.name || isDispatchAgentAliasProperty(property);
  }

  return false;
}

async function callDispatchAgent(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  getDispatchAgent: () => DispatchAgentCapability | undefined,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  request: Parameters<NonNullable<NonNullable<PluginRuntimeContext['capabilities']>['dispatchAgent']>>[0],
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  if (lifecycle.isSideEffectClosed()) {
    const reason = new PluginActionAbortedError('startRuntime', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  if (!policy.capabilities.has('runtime:start')) {
    const reason = new CapabilityDeniedError('startRuntime', 'runtime:start', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  try {
    const dispatchAgent = getDispatchAgent();
    if (dispatchAgent === undefined) {
      throw new Error('Runtime capability dispatchAgent is not available');
    }

    const value = await dispatchAgent.call(capabilities, request, {
      signal: combineAbortSignals(lifecycle.signal, callerSignal),
    });
    await recordAudit(options, policy, event, 'startRuntime', 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }
}

function combineAbortSignals(lifecycleSignal: AbortSignal, callerSignal: AbortSignal | undefined): AbortSignal {
  if (callerSignal === undefined || callerSignal === lifecycleSignal) {
    return lifecycleSignal;
  }

  return AbortSignal.any([lifecycleSignal, callerSignal]);
}

function createGatedRuntimeActions(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
): RuntimeActions {
  return {
    mergePullRequest: (request) =>
      callGatedAction(options, policy, event, lifecycle, 'mergePullRequest', 'merge', request),
    startRuntime: (request) =>
      callGatedAction(options, policy, event, lifecycle, 'startRuntime', 'runtime:start', request),
    readSecret: (request) =>
      callGatedAction(options, policy, event, lifecycle, 'readSecret', 'secret:access', request) as Promise<string>,
  };
}

async function callGatedAction<TRequest>(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  action: keyof RuntimeActionImplementations,
  capability: RuntimeCapabilityName,
  request: TRequest,
): Promise<unknown> {
  if (lifecycle.isSideEffectClosed()) {
    const reason = new PluginActionAbortedError(action, policy.name);
    await recordAudit(options, policy, event, action, 'denied', reason);
    throw reason;
  }

  if (!policy.capabilities.has(capability)) {
    const reason = new CapabilityDeniedError(action, capability, policy.name);
    await recordAudit(options, policy, event, action, 'denied', reason);
    throw reason;
  }

  try {
    const actions = options.runtime.actions;
    const implementation = actions?.[action];
    if (!implementation) {
      throw new Error(`Runtime action ${action} is not available`);
    }

    const value = await implementation.call(actions, request as never, { signal: lifecycle.signal });
    await recordAudit(options, policy, event, action, 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, policy, event, action, 'rejected', reason);
    throw reason;
  }
}

function createGuardedProviders(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
): TaskProviderRegistry {
  const guardedProviderCache = new Map<string, unknown>();
  const getProviders = () => options.runtime.providers ?? unavailableProviders;
  const readProvider = (property: string | symbol): unknown => {
    if (property === 'tasks') {
      let guardedTasks = guardedProviderCache.get('tasks') as TaskProvider | undefined;
      if (guardedTasks === undefined) {
        guardedTasks = createGuardedTaskProvider(options, policy, event, lifecycle, () => getProviders().tasks, 'tasks');
        guardedProviderCache.set('tasks', guardedTasks);
      }

      return guardedTasks;
    }

    const providerName = String(property);
    if (guardedProviderCache.has(providerName)) {
      return guardedProviderCache.get(providerName);
    }

    if (lifecycle.isSideEffectClosed()) {
      if (providerName === 'githubPullRequests') {
        const guardedProvider = createGuardedPullRequestProvider(
          options,
          policy,
          event,
          lifecycle,
          () => unavailablePullRequestsProvider,
          providerName,
        );
        guardedProviderCache.set(providerName, guardedProvider);
        return guardedProvider;
      }

      const guardedProvider = createGuardedTaskProvider(
        options,
        policy,
        event,
        lifecycle,
        () => {
          const providers = getProviders();
          const provider = Reflect.get(providers, property, providers);
          return isTaskProvider(provider) ? provider : unavailableProviders.tasks;
        },
        providerName,
      );
      guardedProviderCache.set(providerName, guardedProvider);
      return guardedProvider;
    }

    const providers = getProviders();
    const provider = Reflect.get(providers, property, providers);
    const guardedProvider = isTaskProvider(provider)
      ? createGuardedTaskProvider(options, policy, event, lifecycle, () => provider, providerName)
      : isPullRequestProvider(provider)
        ? createGuardedPullRequestProvider(options, policy, event, lifecycle, () => provider, providerName)
        : provider;
    guardedProviderCache.set(providerName, guardedProvider);
    return guardedProvider;
  };

  return new Proxy(
    {},
    {
      get(_target, property) {
        return readProvider(property);
      },
      getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
        const providers = getProviders();
        const descriptor = Reflect.getOwnPropertyDescriptor(providers, property);
        if (descriptor === undefined) {
          return undefined;
        }

        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          value: readProvider(property),
          writable: false,
        };
      },
      has(_target, property) {
        return property in getProviders();
      },
      ownKeys() {
        return Reflect.ownKeys(getProviders());
      },
    },
  ) as TaskProviderRegistry;
}

function isTaskProvider(provider: unknown): provider is TaskProvider {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    (provider as TaskProvider).kind === 'task-provider' &&
    typeof (provider as TaskProvider).getIssue === 'function' &&
    typeof (provider as TaskProvider).createComment === 'function'
  );
}

const unavailablePullRequestsProvider: GitHubPullRequestProvider = {
  name: 'unavailable-pull-requests',
  kind: 'pull-request-provider',
  async getPullRequest() {
    throw new PluginLifecycleEndedError();
  },
  async findPullRequestByHead() {
    throw new PluginLifecycleEndedError();
  },
  async requestReview() {
    throw new PluginLifecycleEndedError();
  },
};

function isPullRequestProvider(provider: unknown): provider is GitHubPullRequestProvider {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    (provider as GitHubPullRequestProvider).kind === 'pull-request-provider' &&
    typeof (provider as GitHubPullRequestProvider).getPullRequest === 'function' &&
    typeof (provider as GitHubPullRequestProvider).findPullRequestByHead === 'function' &&
    typeof (provider as GitHubPullRequestProvider).requestReview === 'function'
  );
}

function createGuardedPullRequestProvider(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  getPullRequests: () => GitHubPullRequestProvider,
  actionPrefix: string,
): GitHubPullRequestProvider {
  const auditAction = (name: string) => `${actionPrefix}.${name}` as WorkflowAuditEntry['action'];
  const guardedPullRequests: GitHubPullRequestProvider = {
    get name() {
      return getPullRequests().name ?? actionPrefix;
    },
    get kind() {
      return 'pull-request-provider' as const;
    },
    async getPullRequest(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('getPullRequest'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      return pullRequests.getPullRequest.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async findOpenPullRequestsByBase(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('findOpenPullRequestsByBase'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      if (pullRequests.findOpenPullRequestsByBase === undefined) return [];
      return pullRequests.findOpenPullRequestsByBase.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async findPullRequestByHead(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('findPullRequestByHead'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      return pullRequests.findPullRequestByHead.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async findPullRequestsByHead(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('findPullRequestsByHead'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      if (pullRequests.findPullRequestsByHead === undefined) {
        const pullRequest = await pullRequests.findPullRequestByHead.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
        return pullRequest === undefined ? [] : [pullRequest];
      }
      return pullRequests.findPullRequestsByHead.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async requestReview(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('requestReview'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      return pullRequests.requestReview.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async removeReviewRequest(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('removeReviewRequest'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      if (pullRequests.removeReviewRequest === undefined) return undefined;
      return pullRequests.removeReviewRequest.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    async listReviewComments(input, context) {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('listReviewComments'));
      if (denied !== undefined) throw denied;
      const pullRequests = getPullRequests();
      if (pullRequests.listReviewComments === undefined) return [];
      return pullRequests.listReviewComments.call(pullRequests, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
  };
  return guardedPullRequests;
}

function createGuardedTaskProvider(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  getTasks: () => TaskProvider,
  actionPrefix: string,
): TaskProvider {
  const auditAction = (name: string) => `${actionPrefix}.${name}` as WorkflowAuditEntry['action'];
  const guardedTasks: TaskProvider = {
    get name() {
      return getTasks().name;
    },
    get kind() {
      return getTasks().kind;
    },
    getIssue: async (ref, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('getIssue'));
      if (denied !== undefined) {
        throw denied;
      }

      const tasks = getTasks();
      return tasks.getIssue.call(tasks, ref, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    createComment: async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('createComment'));
      if (denied !== undefined) {
        throw denied;
      }

      const tasks = getTasks();
      return tasks.createComment.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
  };

  defineOptionalGuardedTaskMethod(guardedTasks, 'addToProject', getTasks, options, policy, event, lifecycle, auditAction);
  defineOptionalGuardedTaskMethod(guardedTasks, 'setStatus', getTasks, options, policy, event, lifecycle, auditAction);
  defineOptionalGuardedTaskMethod(guardedTasks, 'createProposal', getTasks, options, policy, event, lifecycle, auditAction);

  return new Proxy(guardedTasks, {
    getOwnPropertyDescriptor(target, property) {
      if (isOptionalTaskMethodKey(property)) {
        if (lifecycle.isSideEffectClosed() || getTasks()[property] === undefined) {
          return undefined;
        }
      }

      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      if (isOptionalTaskMethodKey(property)) {
        if (lifecycle.isSideEffectClosed()) {
          return false;
        }

        return getTasks()[property] !== undefined;
      }

      return property in target;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (property) =>
          !isOptionalTaskMethodKey(property) ||
          (!lifecycle.isSideEffectClosed() && getTasks()[property] !== undefined),
      );
    },
  });
}

function isOptionalTaskMethodKey(property: string | symbol): property is 'addToProject' | 'setStatus' | 'createProposal' {
  return property === 'addToProject' || property === 'setStatus' || property === 'createProposal';
}

function defineOptionalGuardedTaskMethod<TKey extends 'addToProject' | 'setStatus' | 'createProposal'>(
  guardedTasks: TaskProvider,
  key: TKey,
  getTasks: () => TaskProvider,
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  auditAction: (name: string) => WorkflowAuditEntry['action'],
): void {
  Object.defineProperty(guardedTasks, key, {
    configurable: true,
    enumerable: true,
    get() {
      if (lifecycle.isSideEffectClosed()) {
        return async () => {
          const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction(key));
          throw denied ?? new PluginLifecycleEndedError();
        };
      }

      const tasks = getTasks();
      const implementation = tasks[key];
      if (implementation === undefined) {
        return undefined;
      }

      return async (input: never, context?: { signal?: AbortSignal }) => {
        const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction(key));
        if (denied !== undefined) {
          throw denied;
        }

        return implementation.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
      };
    },
  });
}

function getDeniedProviderCallReason(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  action: WorkflowAuditEntry['action'],
): Error | undefined {
  if (!lifecycle.isSideEffectClosed()) {
    return undefined;
  }

  const reason = new PluginActionAbortedError(action, policy.name);
  recordAudit(options, policy, event, action, 'denied', reason);
  return reason;
}

function recordAudit(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  action: WorkflowAuditEntry['action'],
  result: WorkflowAuditResult,
  reason?: unknown,
): void {
  if (options.audit === undefined) {
    return;
  }

  try {
    const entry: WorkflowAuditEntry = {
      pluginId: policy.name,
      eventId: event.id,
      action,
      result,
      runId: options.runtime.runId,
      occurredAt: options.runtime.now().toISOString(),
    };

    const auditReason = formatAuditReason(policy, action, result, reason);
    if (auditReason !== undefined) {
      entry.reason = auditReason;
    }

    void Promise.resolve(options.audit.record(entry)).catch(() => {
      // Audit sinks are observability dependencies and must not change plugin/action outcomes.
    });
  } catch {
    // Synchronous audit failures are isolated for the same reason.
  }
}

function formatAuditReason(
  policy: WorkflowExecutionPolicy,
  action: WorkflowAuditEntry['action'],
  result: WorkflowAuditResult,
  reason: unknown,
): string | undefined {
  if (!(reason instanceof Error)) {
    return undefined;
  }

  if (action === 'readSecret') {
    return 'Error: redacted secret action failure';
  }

  if (action === 'plugin.handle' && policy.capabilities.has('secret:access')) {
    return 'Error: redacted secret-capable plugin failure';
  }

  if (result === 'rejected' && action !== 'plugin.handle' && policy.capabilities.has('secret:access')) {
    return 'Error: redacted secret-capable action failure';
  }

  return `${reason.name}: ${reason.message}`;
}

interface WorkflowAbortController {
  controller: AbortController;
  dispose: () => void;
}

function createWorkflowLifecycle(signal: AbortSignal): WorkflowLifecycle {
  let sideEffectsClosed = false;
  return {
    signal,
    closeSideEffects: () => {
      sideEffectsClosed = true;
    },
    isSideEffectClosed: () => sideEffectsClosed || signal.aborted,
  };
}

function createWorkflowAbortController(parentSignal: AbortSignal | undefined): WorkflowAbortController {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, dispose: () => undefined };
  }

  let dispose: () => void = () => undefined;
  if (parentSignal !== undefined) {
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', abort, { once: true });
    dispose = () => parentSignal.removeEventListener('abort', abort);
  }

  return { controller, dispose };
}

async function runWorkflow<T>(
  start: () => T | Promise<T>,
  timeoutMs: number | undefined,
  abort: WorkflowAbortController,
  lifecycle: WorkflowLifecycle,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(abort.controller.signal.reason ?? new Error('Plugin runtime signal aborted'));

      if (abort.controller.signal.aborted) {
        rejectAbort();
        return;
      }

      abort.controller.signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbortListener = () => abort.controller.signal.removeEventListener('abort', rejectAbort);
    });

    if (abort.controller.signal.aborted) {
      return await abortPromise;
    }

    const started = start();
    if (!isPromiseLike(started)) {
      return started;
    }

    const promise = started;

    if (timeoutMs === undefined) {
      return await Promise.race([promise, abortPromise]);
    }

    return await Promise.race([
      promise,
      abortPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const reason = new PluginTimeoutError(timeoutMs);
          reject(reason);
          abort.controller.abort(reason);
        }, timeoutMs);
      }),
    ]);
  } finally {
    lifecycle.closeSideEffects();

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    removeAbortListener?.();

    if (!abort.controller.signal.aborted) {
      abort.controller.abort(new PluginLifecycleEndedError());
    }

    abort.dispose();
  }
}
