import type { RainrailEventEnvelope } from './events.js';
import type { PluginRuntimeContext, WorkflowPlugin, WorkflowPluginResult } from './plugins.js';

export interface RuntimeDispatcherOptions {
  workflows: WorkflowPlugin[];
  runtime: PluginRuntimeContext;
}

export interface RuntimeDispatcher {
  dispatch(event: RainrailEventEnvelope): Promise<WorkflowPluginResult[]>;
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  return {
    async dispatch(event) {
      const matchingWorkflows = options.workflows.filter((workflow) => workflow.accepts?.(event) ?? true);

      return Promise.all(
        matchingWorkflows.map(async (workflow) => {
          try {
            const value = await workflow.handle(event, options.runtime);

            return {
              pluginName: workflow.name,
              eventId: event.id,
              status: 'fulfilled',
              value,
            } satisfies WorkflowPluginResult;
          } catch (reason) {
            return {
              pluginName: workflow.name,
              eventId: event.id,
              status: 'rejected',
              reason,
            } satisfies WorkflowPluginResult;
          }
        }),
      );
    },
  };
}
