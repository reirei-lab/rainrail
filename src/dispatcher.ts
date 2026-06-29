import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeProvider } from './runtime-provider.js';
import type { TaskProviderRegistry } from './task-provider.js';
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
  policyError?: unknown;
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  const workflows = options.workflows.map(createWorkflowExecutionRecord);

  return {
    async dispatch(event): Promise<WorkflowPluginResult[]> {
      const results: Array<WorkflowPluginResult | undefined> = await Promise.all(
        workflows.map(async ({ workflow, policy, policyError }) => {
          const audit = (action: WorkflowAuditEntry['action'], result: WorkflowAuditResult, reason?: unknown) =>
            recordAudit(options, policy, event, action, result, reason);

          try {
            if (workflow.accepts && !workflow.accepts(event)) {
              return undefined;
            }

            if (policyError !== undefined) {
              throw policyError;
            }

            const abort = createWorkflowAbortController(options.runtime.signal);
            let workflowStarted = false;
            let value: unknown;
            try {
              const context = createWorkflowContext(options, policy, event, abort.controller.signal);
              const timeoutMs = workflow.timeoutMs ?? options.defaultTimeoutMs;
              workflowStarted = true;
              value = await runWorkflow(
                () => Promise.resolve(workflow.handle(event, context)),
                timeoutMs,
                abort,
              );
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

  try {
    return {
      workflow,
      policy: snapshotWorkflowPolicy(workflow),
    };
  } catch (policyError) {
    return {
      workflow,
      policy: fallbackPolicy,
      policyError,
    };
  }
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
  signal: AbortSignal,
): PluginRuntimeContext {
  const context = {} as PluginRuntimeContext;
  const capabilities = createGatedRuntimeCapabilities(options, policy, event, signal);

  defineWorkflowContextAccessor(context, 'runId', () => options.runtime.runId);
  defineWorkflowContextProperty(context, 'now', () => options.runtime.now());

  if (capabilities !== undefined) {
    defineWorkflowContextProperty(context, 'capabilities', capabilities);
  }

  defineWorkflowContextProperty(context, 'providers', createGuardedProviders(options, policy, event, signal));
  defineWorkflowContextProperty(context, 'runtime', createGatedRuntimeProvider(options, policy, event, signal));
  defineWorkflowContextProperty(context, 'signal', signal);
  defineWorkflowContextProperty(context, 'actions', createGatedRuntimeActions(options, policy, event, signal));

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
  signal: AbortSignal,
): RuntimeProvider {
  const runtime = options.runtime.runtime ?? unavailableRuntimeProvider;

  return {
    name: runtime.name,
    kind: runtime.kind,
    startRun: (request, context) =>
      callRuntimeStartRun(options, policy, event, signal, runtime, request, context?.signal),
  };
}

async function callRuntimeStartRun(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  runtime: RuntimeProvider,
  request: Parameters<RuntimeProvider['startRun']>[0],
  callerSignal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<RuntimeProvider['startRun']>>> {
  if (signal.aborted) {
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
    const value = await runtime.startRun(request, { signal: combineAbortSignals(signal, callerSignal) });
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
  signal: AbortSignal,
): PluginRuntimeContext['capabilities'] {
  const capabilities = options.runtime.capabilities;
  if (capabilities === undefined) {
    return undefined;
  }

  if (capabilities.dispatchAgent === undefined) {
    return capabilities;
  }

  const dispatchAgent: DispatchAgentCapability = (request, context) =>
    callDispatchAgent(options, policy, event, signal, request, context?.signal);

  return createDispatchAgentCapabilityProxy(capabilities, dispatchAgent);
}

function createDispatchAgentCapabilityProxy(
  capabilities: NonNullable<PluginRuntimeContext['capabilities']>,
  dispatchAgent: DispatchAgentCapability,
): PluginRuntimeContext['capabilities'] {
  const functionCache = new WeakMap<Function, Function>();
  const viewCache = new WeakMap<object, object>();

  const bindCapabilityFunction = (value: Function): Function => {
    const cached = functionCache.get(value);
    if (cached !== undefined) {
      return cached;
    }

    const bound = value.bind(capabilities);
    functionCache.set(value, bound);
    return bound;
  };

  const readCapabilityProperty = (source: object, property: string | symbol): unknown => {
    if (property === 'constructor') {
      return createCapabilityConstructorView(Reflect.get(source, property, capabilities), capabilities, dispatchAgent);
    }

    const value = Reflect.get(source, property, capabilities);
    if (typeof value === 'function') {
      return bindCapabilityFunction(value);
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
): unknown {
  if (typeof constructorValue !== 'function') {
    return constructorValue;
  }

  const prototype = constructorValue.prototype;
  if (typeof prototype !== 'object' || prototype === null) {
    return constructorValue;
  }

  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property !== 'prototype') {
          return Reflect.get(constructorValue, property, constructorValue);
        }

        return new Proxy(
          {},
          {
            get(_target, prototypeProperty) {
              if (prototypeProperty === 'dispatchAgent') {
                return dispatchAgent;
              }

              if (prototypeProperty === 'constructor') {
                return createCapabilityConstructorView(constructorValue, capabilities, dispatchAgent);
              }

              const value = Reflect.get(prototype, prototypeProperty, capabilities);
              return typeof value === 'function' ? value.bind(capabilities) : value;
            },
            getOwnPropertyDescriptor(_target, prototypeProperty) {
              const descriptor = Reflect.getOwnPropertyDescriptor(prototype, prototypeProperty);
              if (descriptor === undefined) {
                return undefined;
              }

              return {
                configurable: true,
                enumerable: descriptor.enumerable ?? false,
                value:
                  prototypeProperty === 'dispatchAgent'
                    ? dispatchAgent
                    : prototypeProperty === 'constructor'
                      ? createCapabilityConstructorView(constructorValue, capabilities, dispatchAgent)
                    : Reflect.get(prototype, prototypeProperty, capabilities),
                writable: false,
              };
            },
            ownKeys() {
              return Reflect.ownKeys(prototype);
            },
          },
        );
      },
    },
  );
}

async function callDispatchAgent(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  request: Parameters<NonNullable<NonNullable<PluginRuntimeContext['capabilities']>['dispatchAgent']>>[0],
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal.aborted) {
    const reason = new PluginActionAbortedError('startRuntime', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  if (!policy.capabilities.has('runtime:start')) {
    const reason = new CapabilityDeniedError('startRuntime', 'runtime:start', policy.name);
    await recordAudit(options, policy, event, 'startRuntime', 'denied', reason);
    throw reason;
  }

  const capabilities = options.runtime.capabilities;
  const dispatchAgent = capabilities?.dispatchAgent;
  if (dispatchAgent === undefined) {
    const reason = new Error('Runtime capability dispatchAgent is not available');
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }

  try {
    const value = await dispatchAgent.call(capabilities, request, { signal: combineAbortSignals(signal, callerSignal) });
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
  signal: AbortSignal,
): RuntimeActions {
  return {
    mergePullRequest: (request) =>
      callGatedAction(options, policy, event, signal, 'mergePullRequest', 'merge', request),
    startRuntime: (request) =>
      callGatedAction(options, policy, event, signal, 'startRuntime', 'runtime:start', request),
    readSecret: (request) =>
      callGatedAction(options, policy, event, signal, 'readSecret', 'secret:access', request) as Promise<string>,
  };
}

async function callGatedAction<TRequest>(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  action: keyof RuntimeActionImplementations,
  capability: RuntimeCapabilityName,
  request: TRequest,
): Promise<unknown> {
  if (signal.aborted) {
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
    const value = await implementation.call(actions, request as never, { signal });
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
  signal: AbortSignal,
): TaskProviderRegistry {
  const providers = options.runtime.providers ?? unavailableProviders;
  const tasks = providers.tasks;
  const guardedTasks: TaskProviderRegistry['tasks'] = {
    name: tasks.name,
    kind: tasks.kind,
    getIssue: async (ref, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, signal, 'tasks.getIssue');
      if (denied !== undefined) {
        throw denied;
      }

      return tasks.getIssue.call(tasks, ref, { signal: combineAbortSignals(signal, context?.signal) });
    },
    createComment: async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, signal, 'tasks.createComment');
      if (denied !== undefined) {
        throw denied;
      }

      return tasks.createComment.call(tasks, input, { signal: combineAbortSignals(signal, context?.signal) });
    },
  };

  if (tasks.addToProject !== undefined) {
    const addToProject = tasks.addToProject;
    guardedTasks.addToProject = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, signal, 'tasks.addToProject');
      if (denied !== undefined) {
        throw denied;
      }

      return addToProject.call(tasks, input, { signal: combineAbortSignals(signal, context?.signal) });
    };
  }

  if (tasks.setStatus !== undefined) {
    const setStatus = tasks.setStatus;
    guardedTasks.setStatus = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, signal, 'tasks.setStatus');
      if (denied !== undefined) {
        throw denied;
      }

      return setStatus.call(tasks, input, { signal: combineAbortSignals(signal, context?.signal) });
    };
  }

  if (tasks.createProposal !== undefined) {
    const createProposal = tasks.createProposal;
    guardedTasks.createProposal = async (input, context) => {
      const denied = getDeniedProviderCallReason(options, policy, event, signal, 'tasks.createProposal');
      if (denied !== undefined) {
        throw denied;
      }

      return createProposal.call(tasks, input, { signal: combineAbortSignals(signal, context?.signal) });
    };
  }

  return {
    ...providers,
    tasks: guardedTasks,
  };
}

function getDeniedProviderCallReason(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  action: WorkflowAuditEntry['action'],
): Error | undefined {
  if (!signal.aborted) {
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
  start: () => Promise<T>,
  timeoutMs: number | undefined,
  abort: WorkflowAbortController,
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

    const promise = start();

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
