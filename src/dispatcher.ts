import type { RainrailEventEnvelope } from './events.js';
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

export type RuntimeDispatcherContext = Omit<PluginRuntimeContext, 'actions' | 'signal'> & {
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

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  return {
    async dispatch(event): Promise<WorkflowPluginResult[]> {
      const results: Array<WorkflowPluginResult | undefined> = await Promise.all(
        options.workflows.map(async (workflow) => {
          const audit = (action: WorkflowAuditEntry['action'], result: WorkflowAuditResult, reason?: unknown) =>
            recordAudit(options, workflow, event, action, result, reason);

          try {
            if (workflow.accepts && !workflow.accepts(event)) {
              return undefined;
            }

            const abort = createWorkflowAbortController(options.runtime.signal);
            const context = createWorkflowContext(options, workflow, event, abort.controller.signal);
            const value = await runWorkflow(
              Promise.resolve().then(() => workflow.handle(event, context)),
              workflow.timeoutMs ?? options.defaultTimeoutMs,
              abort,
            );

            await audit('plugin.handle', 'fulfilled');

            return {
              pluginName: workflow.name,
              eventId: event.id,
              status: 'fulfilled',
              value,
            } satisfies WorkflowPluginResult;
          } catch (reason) {
            await audit('plugin.handle', reason instanceof PluginTimeoutError ? 'timeout' : 'rejected', reason);

            return {
              pluginName: workflow.name,
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
  constructor(action: keyof RuntimeActionImplementations, pluginName: string) {
    super(`Plugin "${pluginName}" cannot call ${action} after its runtime signal was aborted`);
    this.name = 'PluginActionAbortedError';
  }
}

class SecretActionError extends Error {
  constructor() {
    super('redacted secret action failure');
    this.name = 'Error';
  }
}

function createWorkflowContext(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
): PluginRuntimeContext {
  return {
    ...options.runtime,
    signal,
    actions: createGatedRuntimeActions(options, workflow, event, signal),
  };
}

function createGatedRuntimeActions(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
): RuntimeActions {
  return {
    mergePullRequest: (request) =>
      callGatedAction(options, workflow, event, signal, 'mergePullRequest', 'merge', request),
    startRuntime: (request) =>
      callGatedAction(options, workflow, event, signal, 'startRuntime', 'runtime:start', request),
    readSecret: (request) =>
      callGatedAction(options, workflow, event, signal, 'readSecret', 'secret:access', request) as Promise<string>,
  };
}

async function callGatedAction<TRequest>(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  signal: AbortSignal,
  action: keyof RuntimeActionImplementations,
  capability: RuntimeCapabilityName,
  request: TRequest,
): Promise<unknown> {
  if (signal.aborted) {
    const reason = new PluginActionAbortedError(action, workflow.name);
    await recordAudit(options, workflow, event, action, 'denied', reason);
    throw reason;
  }

  if (!workflow.capabilities?.includes(capability)) {
    const reason = new CapabilityDeniedError(action, capability, workflow.name);
    await recordAudit(options, workflow, event, action, 'denied', reason);
    throw reason;
  }

  const implementation = options.runtime.actions?.[action];
  if (!implementation) {
    const reason = new Error(`Runtime action ${action} is not available`);
    await recordAudit(options, workflow, event, action, 'rejected', reason);
    throw reason;
  }

  try {
    const value = await implementation(request as never, { signal });
    await recordAudit(options, workflow, event, action, 'fulfilled');
    return value;
  } catch (reason) {
    const auditedReason = action === 'readSecret' ? new SecretActionError() : reason;
    await recordAudit(options, workflow, event, action, 'rejected', auditedReason);
    throw auditedReason;
  }
}

function recordAudit(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  action: WorkflowAuditEntry['action'],
  result: WorkflowAuditResult,
  reason?: unknown,
): void {
  const entry: WorkflowAuditEntry = {
    pluginId: workflow.name,
    eventId: event.id,
    action,
    result,
    runId: options.runtime.runId,
    occurredAt: options.runtime.now().toISOString(),
  };

  if (reason instanceof Error) {
    entry.reason = `${reason.name}: ${reason.message}`;
  }

  try {
    void Promise.resolve(options.audit?.record(entry)).catch(() => {
      // Audit sinks are observability dependencies and must not change plugin/action outcomes.
    });
  } catch {
    // Synchronous audit failures are isolated for the same reason.
  }
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
  promise: Promise<T>,
  timeoutMs: number | undefined,
  abort: WorkflowAbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    if (timeoutMs === undefined) {
      return await promise;
    }

    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const reason = new PluginTimeoutError(timeoutMs);
          abort.controller.abort(reason);
          reject(reason);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    abort.dispose();
  }
}
