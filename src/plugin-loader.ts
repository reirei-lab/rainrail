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
  let capabilitySnapshot = false;
  let timeoutMs: number | undefined;
  let timeoutError: unknown;
  let timeoutSnapshot = false;

  let capabilityDescriptor: PropertyDescriptor | undefined;
  try {
    capabilityDescriptor = findPropertyDescriptor(plugin, 'capabilities');
  } catch (reason) {
    capabilityError = reason;
    capabilitySnapshot = true;
  }
  const hasAccessorCapabilities = capabilityDescriptor !== undefined && !('value' in capabilityDescriptor);
  if (capabilityDescriptor === undefined && capabilityError === undefined) {
    capabilitySnapshot = true;
  } else if (capabilityDescriptor !== undefined && 'value' in capabilityDescriptor) {
    try {
      capabilities = capabilityDescriptor.value === undefined ? undefined : [...capabilityDescriptor.value];
    } catch (reason) {
      capabilityError = reason;
    }
    capabilitySnapshot = true;
  }

  let timeoutDescriptor: PropertyDescriptor | undefined;
  try {
    timeoutDescriptor = findPropertyDescriptor(plugin, 'timeoutMs');
  } catch (reason) {
    timeoutError = reason;
    timeoutSnapshot = true;
  }
  const hasAccessorTimeout = timeoutDescriptor !== undefined && !('value' in timeoutDescriptor);
  if (timeoutDescriptor !== undefined && 'value' in timeoutDescriptor) {
    timeoutMs = timeoutDescriptor.value;
    timeoutSnapshot = true;
  }

  const workflow = {
    handle: (event, context) => plugin.handle.call(plugin, event, context),
  } as WorkflowPlugin;

  Object.defineProperty(workflow, 'name', {
    configurable: true,
    enumerable: true,
    get() {
      return plugin.name;
    },
  });

  if ('accepts' in plugin) {
    workflow.accepts = (event) => {
      const accepts = plugin.accepts;
      return accepts === undefined ? true : accepts.call(plugin, event);
    };
  }

  Object.defineProperty(workflow, 'capabilities', {
    configurable: true,
    enumerable: true,
    get() {
      if (hasAccessorCapabilities) {
        const currentCapabilities = plugin.capabilities;
        return currentCapabilities === undefined ? undefined : [...currentCapabilities];
      }

      if (!capabilitySnapshot) {
        try {
          capabilities = plugin.capabilities === undefined ? undefined : [...plugin.capabilities];
        } catch (reason) {
          capabilityError = reason;
        }
        capabilitySnapshot = true;
      }

      if (capabilityError !== undefined) {
        throw capabilityError;
      }

      return capabilities === undefined ? undefined : [...capabilities];
    },
  });

  Object.defineProperty(workflow, 'timeoutMs', {
    configurable: true,
    enumerable: true,
    get() {
      if (hasAccessorTimeout) {
        return plugin.timeoutMs;
      }

      if (!timeoutSnapshot) {
        try {
          timeoutMs = plugin.timeoutMs;
        } catch (reason) {
          timeoutError = reason;
        }
        timeoutSnapshot = true;
      }

      if (timeoutError !== undefined) {
        throw timeoutError;
      }

      return timeoutMs;
    },
  });

  return workflow;
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
