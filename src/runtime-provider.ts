import type { RainrailEventEnvelope } from './events.js';
import type { TaskIssueRef } from './task-provider.js';

export type RuntimeProviderName = 'openclaw' | 'devteam' | 'codex' | (string & {});

export type RuntimeRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'stopped'
  | 'timed_out'
  | 'compaction_failed'
  | 'needs_human'
  | 'split_recommended'
  | (string & {});

export interface RuntimeAgentResumeAttempt {
  id: string;
  status: 'running' | 'stopped' | 'succeeded' | 'failed' | RuntimeRunStatus;
  pid?: number;
  sessionKey?: string;
  logPath: string;
  timeoutSeconds?: number;
}

export interface RuntimeAgentTask {
  id: string;
  title: string;
  agentSessionId: string;
  branchName: string;
  logPath: string;
  pid?: number;
  issue?: unknown;
  claim?: unknown;
  resumeAttempts: RuntimeAgentResumeAttempt[];
}

export interface RuntimeResumeRequest {
  run: RuntimeRun;
  task: RuntimeAgentTask;
  attemptId: string;
  requestedBy: string;
  inputs?: Record<string, unknown>;
}

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
  resumeRun?: (request: RuntimeResumeRequest) => RuntimeRun | Promise<RuntimeRun>;
}
