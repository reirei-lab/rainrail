import type { RainrailEventEnvelope } from './events.js';
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

interface WorkflowExecutionPolicy {
  name: string;
  capabilities: ReadonlySet<RuntimeCapabilityName>;
}

interface WorkflowExecutionRecord {
  workflow: WorkflowPlugin;
  policy: WorkflowExecutionPolicy;
  policySnapshot: boolean;
  policyError?: unknown;
  timeoutSnapshot: boolean;
  timeoutMs?: number;
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
          const audit = (action: WorkflowAuditEntry['action'], result: WorkflowAuditResult, reason?: unknown) =>
            recordAudit(options, policy, event, action, result, reason);

          try {
            if (workflow.accepts && !workflow.accepts(event)) {
              return undefined;
            }

            const metadata = resolveWorkflowExecutionMetadata(record);
            policy = metadata.policy;

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
              const workflowTimeoutMs = metadata.timeoutMs ?? options.defaultTimeoutMs;
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

function createWorkflowExecutionRecord(workflow: WorkflowPlugin): WorkflowExecutionRecord {
  const fallbackPolicy: WorkflowExecutionPolicy = {
    name: readWorkflowName(workflow),
    capabilities: new Set(),
  };
  const record: WorkflowExecutionRecord = {
    workflow,
    policy: fallbackPolicy,
    policySnapshot: false,
    timeoutSnapshot: false,
  };
  const capabilitiesDescriptor = findPropertyDescriptor(workflow, 'capabilities');
  if (capabilitiesDescriptor !== undefined && 'value' in capabilitiesDescriptor) {
    try {
      record.policy = {
        name: readWorkflowName(workflow),
        capabilities: new Set((capabilitiesDescriptor.value as RuntimeCapabilityName[] | undefined) ?? []),
      };
    } catch (policyError) {
      record.policyError = policyError;
    }
    record.policySnapshot = true;
  }

  const timeoutDescriptor = findPropertyDescriptor(workflow, 'timeoutMs');
  if (timeoutDescriptor !== undefined && 'value' in timeoutDescriptor) {
    if (timeoutDescriptor.value !== undefined) {
      record.timeoutMs = timeoutDescriptor.value as number;
    }
    record.timeoutSnapshot = true;
  }

  return record;
}

function resolveWorkflowExecutionMetadata(record: WorkflowExecutionRecord): WorkflowExecutionRecord {
  const resolved: WorkflowExecutionRecord = { ...record };

  if (!resolved.policySnapshot) {
    try {
      resolved.policy = snapshotWorkflowPolicy(record.workflow);
    } catch (policyError) {
      resolved.policyError = policyError;
    }
    resolved.policySnapshot = true;
  }

  if (!resolved.timeoutSnapshot) {
    try {
      const timeoutMs = record.workflow.timeoutMs;
      if (timeoutMs !== undefined) {
        resolved.timeoutMs = timeoutMs;
      }
    } catch (timeoutError) {
      resolved.timeoutError = timeoutError;
    }
    resolved.timeoutSnapshot = true;
  }

  return resolved;
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

function snapshotWorkflowPolicy(workflow: WorkflowPlugin): WorkflowExecutionPolicy {
  return {
    name: workflow.name,
    capabilities: new Set(workflow.capabilities ?? []),
  };
}

function readWorkflowName(workflow: WorkflowPlugin): string {
  try {
    return workflow.name;
  } catch {
    return 'unknown-workflow';
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
  const capabilities = createGatedRuntimeCapabilities(options, policy, event, lifecycle);

  defineWorkflowContextAccessor(context, 'runId', () => options.runtime.runId);
  defineWorkflowContextProperty(context, 'now', () => options.runtime.now());

  if (capabilities !== undefined) {
    defineWorkflowContextProperty(context, 'capabilities', capabilities);
  }

  defineWorkflowContextProperty(context, 'providers', createGuardedProviders(options, policy, event, lifecycle));
  defineWorkflowContextProperty(context, 'runtime', createGatedRuntimeProvider(options, policy, event, lifecycle));
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
  const runtime = options.runtime.runtime ?? unavailableRuntimeProvider;

  return {
    name: runtime.name,
    kind: runtime.kind,
    startRun: (request, context) =>
      callRuntimeStartRun(options, policy, event, lifecycle, runtime, request, context?.signal),
  };
}

async function callRuntimeStartRun(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  runtime: RuntimeProvider,
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
    const value = await runtime.startRun(request, { signal: combineAbortSignals(lifecycle.signal, callerSignal) });
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
  const getRawDispatchAgent = () => {
    if (!rawDispatchAgentResolved) {
      rawDispatchAgent = capabilities.dispatchAgent;
      rawDispatchAgentResolved = true;
    }

    return rawDispatchAgent;
  };

  const dispatchAgent: DispatchAgentCapability = (request, context) =>
    callDispatchAgent(options, policy, event, lifecycle, getRawDispatchAgent(), capabilities, request, context?.signal);

  return createDispatchAgentCapabilityProxy(capabilities, dispatchAgent, getRawDispatchAgent);
}

function createDispatchAgentCapabilityProxy(
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
): PluginRuntimeContext['capabilities'] {
  const viewCache = new WeakMap<object, object>();

  const bindCapabilityFunction = (value: Function, safeReceiver: object): Function => {
    const wrapped = (...args: unknown[]) =>
      callCapabilityFunction(
        value,
        capabilities,
        dispatchAgent,
        getRawDispatchAgent,
        safeReceiver,
        args,
        (object) => createCapabilityView(object),
      );
    return wrapped;
  };

  const readCapabilityProperty = (source: object, property: string | symbol): unknown => {
    if (property === '__lookupGetter__') {
      return (lookupProperty: string | symbol) => (lookupProperty === 'dispatchAgent' ? () => dispatchAgent : undefined);
    }

    if (property === '__lookupSetter__') {
      return () => undefined;
    }

    if (property === 'valueOf') {
      return () => createCapabilityView(source);
    }

    if (property === '__proto__') {
      const prototype = Reflect.getPrototypeOf(source);
      return prototype === null ? null : createCapabilityView(prototype);
    }

    if (property === 'constructor') {
      return createCapabilityConstructorView(
        Reflect.get(source, property, capabilities),
        capabilities,
        dispatchAgent,
        getRawDispatchAgent,
        (object) => createCapabilityView(object),
      );
    }

    const value = Reflect.get(source, property, capabilities);
    const safeReceiver = createCapabilityView(source);
    if (typeof value === 'function') {
      const rawDispatchAgent = getRawDispatchAgent();
      if (value === rawDispatchAgent) {
        return dispatchAgent;
      }

      return bindCapabilityFunction(value, safeReceiver);
    }

    if (typeof value === 'object' && value !== null) {
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
      return {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        value: dispatchAgent,
        writable: false,
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
    const cached = viewCache.get(source);
    if (cached !== undefined) {
      return cached;
    }

    const view = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'dispatchAgent') {
            return dispatchAgent;
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
          return property in source;
        },
        ownKeys() {
          return Reflect.ownKeys(source);
        },
      },
    );

    viewCache.set(source, view);
    return view;
  };

  return createCapabilityView(capabilities) as PluginRuntimeContext['capabilities'];
}

function createCapabilityConstructorView(
  constructorValue: unknown,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  wrapObject: (object: object) => object,
): unknown {
  if (typeof constructorValue !== 'function') {
    return constructorValue;
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

    const value = Reflect.get(prototype, property, capabilities);
    const rawDispatchAgent = getRawDispatchAgent();
    if (value === rawDispatchAgent) {
      return dispatchAgent;
    }

    return typeof value === 'function'
      ? (...args: unknown[]) =>
          callCapabilityFunction(value, capabilities, dispatchAgent, getRawDispatchAgent, prototypeView, args, wrapObject)
      : normalizeCapabilityHelperResult(value, capabilities, prototypeView, rawDispatchAgent, dispatchAgent, wrapObject);
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
          getRawDispatchAgent,
          dispatchAgent,
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
            getRawDispatchAgent,
            dispatchAgent,
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
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  dispatchAgent: DispatchAgentCapability,
): unknown {
  if (property === 'prototype') {
    return prototypeView;
  }

  const value = Reflect.get(constructorValue, property, constructorView);
  const rawDispatchAgent = getRawDispatchAgent();
  if (value === rawDispatchAgent) {
    return dispatchAgent;
  }

  return typeof value === 'function' ? value.bind(constructorView) : value;
}

function callCapabilityFunction(
  helper: Function,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
  getRawDispatchAgent: () => DispatchAgentCapability | undefined,
  safeReceiver: object,
  args: unknown[],
  wrapObject: (object: object) => object,
): unknown {
  const retryWithPrivateReceiver = (reason: unknown) => {
    if (helperMayUsePublicThisProperty(helper)) {
      throw reason;
    }

    const rawDispatchAgent = getRawDispatchAgent();
    return normalizeCapabilityFunctionResult(
      Reflect.apply(helper, capabilities, args),
      capabilities,
      safeReceiver,
      rawDispatchAgent,
      dispatchAgent,
      retryWithPrivateReceiver,
      wrapObject,
    );
  };

  try {
    const rawDispatchAgent = getRawDispatchAgent();
    return normalizeCapabilityFunctionResult(
      Reflect.apply(helper, safeReceiver, args),
      capabilities,
      safeReceiver,
      rawDispatchAgent,
      dispatchAgent,
      retryWithPrivateReceiver,
      wrapObject,
    );
  } catch (reason) {
    if (!isPrivateReceiverError(reason)) {
      throw reason;
    }

    return retryWithPrivateReceiver(reason);
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
  rawDispatchAgent: DispatchAgentCapability | undefined,
  dispatchAgent: DispatchAgentCapability,
  retryPrivateReceiver: (reason: unknown) => unknown,
  wrapObject: (object: object) => object,
): unknown {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then(
      (resolved) =>
        normalizeCapabilityHelperResult(resolved, capabilities, safeReceiver, rawDispatchAgent, dispatchAgent, wrapObject),
      (reason: unknown) => {
        if (!isPrivateReceiverError(reason)) {
          throw reason;
        }

        return retryPrivateReceiver(reason);
      },
    );
  }

  return normalizeCapabilityHelperResult(value, capabilities, safeReceiver, rawDispatchAgent, dispatchAgent, wrapObject);
}

function normalizeCapabilityHelperResult(
  value: unknown,
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  safeReceiver: object,
  rawDispatchAgent: DispatchAgentCapability | undefined,
  dispatchAgent: DispatchAgentCapability,
  wrapObject: (object: object) => object,
): unknown {
  if (value === capabilities) {
    return safeReceiver;
  }

  if (value === rawDispatchAgent) {
    return dispatchAgent;
  }

  if (typeof value === 'object' && value !== null) {
    return wrapObject(value);
  }

  return value;
}

function isPrivateReceiverError(reason: unknown): boolean {
  return reason instanceof TypeError && reason.message.includes('private');
}

function helperMayUsePublicThisProperty(helper: Function): boolean {
  try {
    return /this\s*(?:\.|\[)(?!#)/u.test(Function.prototype.toString.call(helper));
  } catch {
    return true;
  }
}

async function callDispatchAgent(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  dispatchAgent: DispatchAgentCapability | undefined,
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

  if (dispatchAgent === undefined) {
    const reason = new Error('Runtime capability dispatchAgent is not available');
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }

  try {
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

  const actions = options.runtime.actions;
  const implementation = actions?.[action];
  if (!implementation) {
    const reason = new Error(`Runtime action ${action} is not available`);
    await recordAudit(options, policy, event, action, 'rejected', reason);
    throw reason;
  }

  try {
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
  const providers = options.runtime.providers ?? unavailableProviders;
  const guardedProviders: TaskProviderRegistry = {
    ...providers,
    tasks: createGuardedTaskProvider(options, policy, event, lifecycle, providers.tasks, 'tasks'),
  };

  for (const [name, provider] of Object.entries(providers)) {
    if (name !== 'tasks' && isTaskProvider(provider)) {
      guardedProviders[name] = createGuardedTaskProvider(options, policy, event, lifecycle, provider, name);
    }
  }

  return guardedProviders;
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

function createGuardedTaskProvider(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  lifecycle: WorkflowLifecycle,
  tasks: TaskProvider,
  actionPrefix: string,
): TaskProvider {
  const auditAction = (name: string) => `${actionPrefix}.${name}` as WorkflowAuditEntry['action'];
  const guardedTasks: TaskProvider = {
    name: tasks.name,
    kind: tasks.kind,
    getIssue: async (ref, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('getIssue'));
      if (denied !== undefined) {
        throw denied;
      }

      return tasks.getIssue.call(tasks, ref, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
    createComment: async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('createComment'));
      if (denied !== undefined) {
        throw denied;
      }

      return tasks.createComment.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    },
  };

  if (tasks.addToProject !== undefined) {
    const addToProject = tasks.addToProject;
    guardedTasks.addToProject = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('addToProject'));
      if (denied !== undefined) {
        throw denied;
      }

      return addToProject.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    };
  }

  if (tasks.setStatus !== undefined) {
    const setStatus = tasks.setStatus;
    guardedTasks.setStatus = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('setStatus'));
      if (denied !== undefined) {
        throw denied;
      }

      return setStatus.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    };
  }

  if (tasks.createProposal !== undefined) {
    const createProposal = tasks.createProposal;
    guardedTasks.createProposal = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, lifecycle, auditAction('createProposal'));
      if (denied !== undefined) {
        throw denied;
      }

      return createProposal.call(tasks, input, { signal: combineAbortSignals(lifecycle.signal, context?.signal) });
    };
  }

  return guardedTasks;
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
