import type { RainrailEventEnvelope } from './events.js';
import type {
  PluginRuntimeContext,
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

export type RuntimeDispatcherContext = Omit<PluginRuntimeContext, 'actions'> & {
  actions?: Partial<RuntimeActions>;
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

            const context = createWorkflowContext(options, workflow, event);
            const value = await withTimeout(
              Promise.resolve().then(() => workflow.handle(event, context)),
              workflow.timeoutMs ?? options.defaultTimeoutMs,
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
  constructor(action: keyof RuntimeActions, capability: RuntimeCapabilityName, pluginName: string) {
    super(`Plugin "${pluginName}" needs capability "${capability}" to call ${action}`);
    this.name = 'CapabilityDeniedError';
  }
}

function createWorkflowContext(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
): PluginRuntimeContext {
  return {
    ...options.runtime,
    actions: createGatedRuntimeActions(options, workflow, event),
  };
}

function createGatedRuntimeActions(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
): RuntimeActions {
  return {
    mergePullRequest: (request) => callGatedAction(options, workflow, event, 'mergePullRequest', 'merge', request),
    startRuntime: (request) => callGatedAction(options, workflow, event, 'startRuntime', 'runtime:start', request),
    readSecret: (request) => callGatedAction(options, workflow, event, 'readSecret', 'secret:access', request) as Promise<string>,
  };
}

async function callGatedAction<TRequest>(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  action: keyof RuntimeActions,
  capability: RuntimeCapabilityName,
  request: TRequest,
): Promise<unknown> {
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
    const value = await implementation(request as never);
    await recordAudit(options, workflow, event, action, 'fulfilled');
    return value;
  } catch (reason) {
    await recordAudit(options, workflow, event, action, 'rejected', reason);
    throw reason;
  }
}

async function recordAudit(
  options: RuntimeDispatcherOptions,
  workflow: WorkflowPlugin,
  event: RainrailEventEnvelope,
  action: WorkflowAuditEntry['action'],
  result: WorkflowAuditResult,
  reason?: unknown,
): Promise<void> {
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

  await options.audit?.record(entry);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PluginTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
