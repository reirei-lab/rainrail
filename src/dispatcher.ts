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

interface WorkflowExecutionPolicy {
  name: string;
  capabilities: ReadonlySet<RuntimeCapabilityName>;
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  return {
    async dispatch(event): Promise<WorkflowPluginResult[]> {
      const results: Array<WorkflowPluginResult | undefined> = await Promise.all(
        options.workflows.map(async (workflow) => {
          const policy = snapshotWorkflowPolicy(workflow);
          const audit = (action: WorkflowAuditEntry['action'], result: WorkflowAuditResult, reason?: unknown) =>
            recordAudit(options, policy, event, action, result, reason);

          try {
            if (workflow.accepts && !workflow.accepts(event)) {
              return undefined;
            }

            const abort = createWorkflowAbortController(options.runtime.signal);
            const context = createWorkflowContext(options, policy, event, abort.controller.signal);
            const value = await runWorkflow(
              () => Promise.resolve(workflow.handle(event, context)),
              workflow.timeoutMs ?? options.defaultTimeoutMs,
              abort,
            );

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

function snapshotWorkflowPolicy(workflow: WorkflowPlugin): WorkflowExecutionPolicy {
  return {
    name: workflow.name,
    capabilities: new Set(workflow.capabilities ?? []),
  };
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
  return {
    ...options.runtime,
    providers: createGuardedProviders(options, policy, event, signal),
    runtime: createGatedRuntimeProvider(options, policy, event, signal),
    signal,
    actions: createGatedRuntimeActions(options, policy, event, signal),
  };
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
    startRun: (request) => callRuntimeStartRun(options, policy, event, signal, runtime, request),
  };
}

async function callRuntimeStartRun(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  runtime: RuntimeProvider,
  request: Parameters<RuntimeProvider['startRun']>[0],
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
    const value = await runtime.startRun(request, { signal });
    await recordAudit(options, policy, event, 'startRuntime', 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, policy, event, 'startRuntime', 'rejected', reason);
    throw reason;
  }
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

  const implementation = options.runtime.actions?.[action];
  if (!implementation) {
    const reason = new Error(`Runtime action ${action} is not available`);
    await recordAudit(options, policy, event, action, 'rejected', reason);
    throw reason;
  }

  try {
    const value = await implementation(request as never, { signal });
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
    getIssue: (ref) => {
      guardProviderCall(options, policy, event, signal, 'tasks.getIssue');
      return tasks.getIssue(ref);
    },
    createComment: (input) => {
      guardProviderCall(options, policy, event, signal, 'tasks.createComment');
      return tasks.createComment(input);
    },
  };

  if (tasks.addToProject !== undefined) {
    const addToProject = tasks.addToProject;
    guardedTasks.addToProject = (input) => {
      guardProviderCall(options, policy, event, signal, 'tasks.addToProject');
      return addToProject(input);
    };
  }

  if (tasks.setStatus !== undefined) {
    const setStatus = tasks.setStatus;
    guardedTasks.setStatus = (input) => {
      guardProviderCall(options, policy, event, signal, 'tasks.setStatus');
      return setStatus(input);
    };
  }

  if (tasks.createProposal !== undefined) {
    const createProposal = tasks.createProposal;
    guardedTasks.createProposal = (input) => {
      guardProviderCall(options, policy, event, signal, 'tasks.createProposal');
      return createProposal(input);
    };
  }

  return {
    ...providers,
    tasks: guardedTasks,
  };
}

function guardProviderCall(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  action: WorkflowAuditEntry['action'],
): void {
  if (!signal.aborted) {
    return;
  }

  const reason = new PluginActionAbortedError(action, policy.name);
  recordAudit(options, policy, event, action, 'denied', reason);
  throw reason;
}

function recordAudit(
  options: RuntimeDispatcherOptions,
  policy: WorkflowExecutionPolicy,
  event: RainrailEventEnvelope,
  action: WorkflowAuditEntry['action'],
  result: WorkflowAuditResult,
  reason?: unknown,
): void {
  const entry: WorkflowAuditEntry = {
    pluginId: policy.name,
    eventId: event.id,
    action,
    result,
    runId: options.runtime.runId,
    occurredAt: options.runtime.now().toISOString(),
  };

  const auditReason = formatAuditReason(policy, action, reason);
  if (auditReason !== undefined) {
    entry.reason = auditReason;
  }

  try {
    void Promise.resolve(options.audit?.record(entry)).catch(() => {
      // Audit sinks are observability dependencies and must not change plugin/action outcomes.
    });
  } catch {
    // Synchronous audit failures are isolated for the same reason.
  }
}

function formatAuditReason(
  policy: WorkflowExecutionPolicy,
  action: WorkflowAuditEntry['action'],
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
    if (abort.controller.signal.aborted) {
      throw abort.controller.signal.reason ?? new Error('Plugin runtime signal aborted');
    }

    const promise = start();
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(abort.controller.signal.reason ?? new Error('Plugin runtime signal aborted'));

      if (abort.controller.signal.aborted) {
        rejectAbort();
        return;
      }

      abort.controller.signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbortListener = () => abort.controller.signal.removeEventListener('abort', rejectAbort);
    });

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
