import { createRuntimeDispatcher, type RuntimeDispatcherContext, type WorkflowAuditSink } from './dispatcher.js';
import type { RainrailEventEnvelope, RainrailEventName } from './events.js';
import type { PluginRuntimeContext, RuntimeCapabilityName, WorkflowPlugin, WorkflowPluginResult } from './plugins.js';

export type LocalEventHandler<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope> = (
  event: TEvent,
  context: PluginRuntimeContext,
) => unknown | Promise<unknown>;

export interface LocalHandlerOptions {
  name?: string;
  capabilities?: RuntimeCapabilityName[];
  timeoutMs?: number;
}

export interface PluginLoaderOptions {
  runtime: RuntimeDispatcherContext;
  audit?: WorkflowAuditSink;
  defaultTimeoutMs?: number;
}

export interface PluginLoader {
  register(plugin: WorkflowPlugin): void;
  on<TEvent extends RainrailEventEnvelope = RainrailEventEnvelope>(
    eventName: RainrailEventName,
    handler: LocalEventHandler<TEvent>,
    options?: LocalHandlerOptions,
  ): void;
  dispatch(event: RainrailEventEnvelope): Promise<WorkflowPluginResult[]>;
  list(): WorkflowPlugin[];
}

export function createPluginLoader(options: PluginLoaderOptions): PluginLoader {
  const workflows: WorkflowPlugin[] = [];
  const localHandlerCounts = new Map<string, number>();

  return {
    register(plugin) {
      workflows.push(createRegisteredWorkflow(plugin));
    },
    on(eventName, handler, handlerOptions = {}) {
      const count = (localHandlerCounts.get(eventName) ?? 0) + 1;
      localHandlerCounts.set(eventName, count);

      const workflow: WorkflowPlugin = {
        name: handlerOptions.name ?? `local:${eventName}:${count}`,
        accepts: (event) => event.name === eventName,
        handle: (event, context) => handler(event as never, context),
      };

      if (handlerOptions.capabilities !== undefined) {
        workflow.capabilities = handlerOptions.capabilities;
      }

      if (handlerOptions.timeoutMs !== undefined) {
        workflow.timeoutMs = handlerOptions.timeoutMs;
      }

      workflows.push(createRegisteredWorkflow(workflow));
    },
    dispatch(event) {
      const dispatcherOptions = {
        workflows,
        runtime: options.runtime,
      };

      if (options.audit !== undefined) {
        Object.assign(dispatcherOptions, { audit: options.audit });
      }

      if (options.defaultTimeoutMs !== undefined) {
        Object.assign(dispatcherOptions, { defaultTimeoutMs: options.defaultTimeoutMs });
      }

      return createRuntimeDispatcher(dispatcherOptions).dispatch(event);
    },
    list() {
      return [...workflows];
    },
  };
}

function createRegisteredWorkflow(plugin: WorkflowPlugin): WorkflowPlugin {
  let capabilities: RuntimeCapabilityName[] | undefined;
  let capabilityError: unknown;

  try {
    capabilities = plugin.capabilities === undefined ? undefined : [...plugin.capabilities];
  } catch (reason) {
    capabilityError = reason;
  }

  const workflow: WorkflowPlugin = {
    name: plugin.name,
    handle: (event, context) => plugin.handle.call(plugin, event, context),
  };

  if (plugin.accepts !== undefined) {
    workflow.accepts = (event) => plugin.accepts?.call(plugin, event) ?? false;
  }

  if (plugin.timeoutMs !== undefined) {
    workflow.timeoutMs = plugin.timeoutMs;
  }

  Object.defineProperty(workflow, 'capabilities', {
    configurable: true,
    enumerable: true,
    get() {
      if (capabilityError !== undefined) {
        throw capabilityError;
      }

      return capabilities === undefined ? undefined : [...capabilities];
    },
  });

  return workflow;
}
