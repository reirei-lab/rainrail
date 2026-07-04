import { readRuntimeTimeline, type RuntimeTimelineResult } from './agent-runtime/timeline.js';
import type { RuntimeAgentResumeAttempt } from './runtime-provider.js';

export interface CodexActivityTask {
  id: string;
  title: string;
  agentSessionId?: string;
  startedAt: string;
  logPath?: string;
  stderrLogPath?: string;
  resumeAttempts?: RuntimeAgentResumeAttempt[];
}

export interface SummarizeCodexActivityOptions {
  task: CodexActivityTask;
  sessionsDirectory?: string;
  readTimeline?: (task: CodexActivityTask) => Promise<RuntimeTimelineResult>;
}

export interface CodexActivitySummary {
  taskId: string;
  sessionId?: string | undefined;
  missing: boolean;
  fallback: boolean;
  trajectoryPath?: string | undefined;
  lastActivity?: string | undefined;
  events: Array<{
    id: string;
    timestamp?: string | undefined;
    phase: string;
    status?: string | undefined;
    summary: string;
    excerpt?: string | undefined;
  }>;
}

export async function summarizeCodexActivity(options: SummarizeCodexActivityOptions): Promise<CodexActivitySummary> {
  const timeline = await (options.readTimeline ?? defaultReadTimeline)(options.task);
  const events = timeline.entries.map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    phase: entry.phase,
    status: entry.status,
    summary: entry.summary,
    excerpt: entry.excerpt,
  }));

  return {
    taskId: options.task.id,
    sessionId: timeline.sessionId,
    missing: timeline.missing,
    fallback: timeline.fallback,
    trajectoryPath: timeline.trajectoryPath,
    lastActivity: events.at(-1)?.timestamp,
    events,
  };

  async function defaultReadTimeline(task: CodexActivityTask): Promise<RuntimeTimelineResult> {
    return readRuntimeTimeline(
      {
        ...(task.agentSessionId === undefined ? {} : { agentSessionId: task.agentSessionId }),
        logPath: task.logPath ?? '',
        ...(task.stderrLogPath === undefined ? {} : { stderrLogPath: task.stderrLogPath }),
        resumeAttempts: task.resumeAttempts ?? [],
      },
      options.sessionsDirectory === undefined ? {} : { sessionsDirectory: options.sessionsDirectory },
    );
  }
}
