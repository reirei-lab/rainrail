import type { RainrailEventEnvelope } from './events.js';
import type { TaskIssueRef } from './task-provider.js';

export type RuntimeProviderName = 'openclaw' | 'devteam' | 'codex' | (string & {});

export type RuntimeRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | (string & {});

export interface RuntimeRunRequest<TTask extends TaskIssueRef | unknown = unknown> {
  workflow: string;
  event: RainrailEventEnvelope;
  task?: TTask;
  requestedBy: string;
  inputs?: Record<string, unknown>;
}

export interface RuntimeRun {
  id: string;
  provider: RuntimeProviderName;
  status: RuntimeRunStatus;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeProviderContext {
  signal: AbortSignal;
}

export interface RuntimeProvider {
  name: string;
  kind: 'runtime-provider';
  startRun(request: RuntimeRunRequest, context?: RuntimeProviderContext): RuntimeRun | Promise<RuntimeRun>;
}
