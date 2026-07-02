import { describe, expect, it } from 'vitest';

import { summarizeCodexActivity } from './codex-activity.js';

describe('summarizeCodexActivity', () => {
  it('projects runtime timeline entries into dashboard-safe Codex activity rows', async () => {
    const seenTasks: unknown[] = [];
    const activity = await summarizeCodexActivity({
      task: {
        id: 'agent_task_rainrail_25',
        title: 'issue 25',
        agentSessionId: 'agent:main:rainrail-25',
        startedAt: '2026-07-02T00:00:00.000Z',
        resumeAttempts: [{
          id: 'agent_task_rainrail_25_resume_01',
          status: 'running',
          logPath: 'var/log/rainrail-25-resume.log',
        }],
      },
      readTimeline: async (task) => {
        seenTasks.push(task);
        return {
          logPath: 'var/log/rainrail-25-resume.log',
          missing: false,
          fallback: false,
          sessionId: 'rainrail-25',
          trajectoryPath: '/tmp/trajectory.jsonl',
          entries: [
            {
              id: 'seq_1',
              timestamp: '2026-07-02T00:00:01.000Z',
              phase: 'tool',
              status: 'running',
              summary: 'gh issue view 25',
              excerpt: 'gh issue view 25 --repo reirei-lab/rainrail',
            },
            {
              id: 'seq_2',
              timestamp: '2026-07-02T00:00:02.000Z',
              phase: 'assistant',
              status: 'completed',
              summary: 'Outcome: implemented',
            },
          ],
        };
      },
    });

    expect(seenTasks).toEqual([
      expect.objectContaining({
        resumeAttempts: [expect.objectContaining({ logPath: 'var/log/rainrail-25-resume.log' })],
      }),
    ]);
    expect(activity).toEqual({
      taskId: 'agent_task_rainrail_25',
      sessionId: 'rainrail-25',
      missing: false,
      fallback: false,
      trajectoryPath: '/tmp/trajectory.jsonl',
      lastActivity: '2026-07-02T00:00:02.000Z',
      events: [
        {
          id: 'seq_1',
          timestamp: '2026-07-02T00:00:01.000Z',
          phase: 'tool',
          status: 'running',
          summary: 'gh issue view 25',
          excerpt: 'gh issue view 25 --repo reirei-lab/rainrail',
        },
        {
          id: 'seq_2',
          timestamp: '2026-07-02T00:00:02.000Z',
          phase: 'assistant',
          status: 'completed',
          summary: 'Outcome: implemented',
        },
      ],
    });
  });
});
