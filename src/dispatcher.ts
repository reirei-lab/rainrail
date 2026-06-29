import type { RainrailEventEnvelope } from './events.js';
import type { PluginRuntimeContext, WorkflowPlugin, WorkflowPluginResult } from './workflow-plugin.js';

export interface RuntimeDispatcherOptions {
  workflows: WorkflowPlugin[];
  runtime: PluginRuntimeContext;
}

export interface RuntimeDispatcher {
  dispatch(event: RainrailEventEnvelope): Promise<WorkflowPluginResult[]>;
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions): RuntimeDispatcher {
  return {
    async dispatch(event): Promise<WorkflowPluginResult[]> {
      const results: Array<WorkflowPluginResult | undefined> = await Promise.all(
        options.workflows.map(async (workflow) => {
          try {
            if (workflow.accepts && !workflow.accepts(event)) {
              return undefined;
            }

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

      return results.filter((result): result is WorkflowPluginResult => result !== undefined);
    },
  };
}
