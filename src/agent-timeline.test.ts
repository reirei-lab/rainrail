import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyRuntimeToolCall,
  extractRuntimeSessionId,
  parseRuntimeTrajectoryTimeline,
  readRuntimeTimeline,
  readRuntimeTimelineStatus,
} from './agent-timeline.js';

describe('agent timeline', () => {
  it('extracts OpenClaw session ids from JSON logs', () => {
    expect(extractRuntimeSessionId(JSON.stringify({
      result: { meta: { agentMeta: { sessionId: '4920eb13-b75f-4680-8b21-54f40262d2ba' } } },
    }))).toBe('4920eb13-b75f-4680-8b21-54f40262d2ba');
  });

  it('prefers embedded fallback session ids from timeout logs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-fallback-timeline-'));
    const fallbackSessionId = 'gateway-fallback-9a554b06-0a49-4aab-ab8b-8d585c604283';
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      `EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session ${fallbackSessionId}`,
      JSON.stringify({ result: { meta: { agentMeta: { sessionId: 'intended-session' } } } }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, `${fallbackSessionId}.trajectory.jsonl`), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:00.000Z', seq: 2, data: { name: 'bash', arguments: { command: 'gh issue view 22' } } }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:intended-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe(fallbackSessionId);
      expect(timeline.fallback).toBe(true);
      expect(timeline.entries.map((entry) => entry.summary)).toContain('gh issue view 22');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports ended trajectory status for stale process detection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-ended-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(directory, 'normal-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'session.ended', ts: '2026-06-30T15:58:00.000Z', seq: 2, data: { status: 'success' } }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimelineStatus(
        { logPath, agentSessionId: 'normal-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'normal-session',
        ended: true,
        endedStatus: 'success',
        lastTimestamp: '2026-06-30T15:58:00.000Z',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the latest lifecycle event when reporting ended trajectory status', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-resumed-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(directory, 'resumed-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'session.ended', ts: '2026-06-30T15:58:00.000Z', seq: 2, data: { status: 'success' } }),
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T16:08:00.000Z', seq: 3 }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T16:09:00.000Z', seq: 4, data: { name: 'bash', arguments: { command: 'pnpm test' } } }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimelineStatus(
        { logPath, agentSessionId: 'resumed-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'resumed-session',
        ended: false,
        endedStatus: undefined,
        lastTimestamp: '2026-06-30T16:09:00.000Z',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the configured agent id when deriving the default trajectory directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-agent-id-timeline-'));
    const openClawHome = join(directory, '.openclaw');
    const sessionsDirectory = join(openClawHome, 'agents', 'worker-a', 'sessions');
    const logPath = join(directory, 'agent.log');
    mkdirSync(sessionsDirectory, { recursive: true });
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(sessionsDirectory, 'worker-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimeline(
        { logPath, agentSessionId: 'worker-session' },
        { agentId: 'worker-a', openClawHome },
      )).resolves.toMatchObject({
        sessionId: 'worker-session',
        missing: false,
        entries: [expect.objectContaining({ summary: 'session.started' })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders trajectory rows and redacts sensitive output for Codex activity display', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:00.000Z', seq: 2, data: { name: 'bash', arguments: { command: 'pnpm test' } } }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:05.000Z', seq: 3, data: { name: 'bash', arguments: { command: 'gh api -H "Authorization: Bearer github_pat_secretValue" repos/reirei-lab/rainrail token="quoted-secret"' } } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:10.000Z', seq: 4, data: { name: 'bash', status: 'completed', output: "ok token=secret-value api_key='quoted-output-secret' Authorization: Bearer github_pat_outputSecret" } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:20.000Z', seq: 5, data: { name: 'bash', status: 'completed', contentItems: [{ token: 'secret-json-token', apiKey: 'secret-json-key', password: 'secret-json-password', webhookSecret: 'secret-webhook', clientSecret: 'secret-client', apiToken: 'secret-api-token' }] } }),
    ].join('\n'));

    expect(timeline.map((entry) => [entry.phase, entry.summary])).toEqual([
      ['session.started', 'session.started'],
      ['確認', 'pnpm test'],
      ['調査', 'gh api -H "Authorization: Bearer [redacted-token]" repos/reirei-lab/rainrail token="[redacted]"'],
      ['tool.result', 'bash completed'],
      ['tool.result', 'bash completed'],
    ]);
    expect(timeline[2]!.detail).toContain('Bearer [redacted-token]');
    expect(timeline[2]!.detail).toContain('token="[redacted]"');
    expect(timeline[3]!.excerpt).toContain('token=[redacted]');
    expect(timeline[3]!.excerpt).toContain("api_key='[redacted]'");
    expect(timeline[3]!.excerpt).toContain('Bearer [redacted-token]');
    expect(timeline[4]!.excerpt).toContain('"token": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiKey": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"password": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"webhookSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"clientSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiToken": "[redacted]"');
  });

  it('classifies common commands into dashboard phases', () => {
    expect(classifyRuntimeToolCall('bash', 'gh issue view 22 --repo reirei-lab/rainrail')).toEqual({
      phase: '調査',
      summary: 'GitHub issue / PR を確認',
    });
    expect(classifyRuntimeToolCall('apply_patch', '')).toEqual({
      phase: '実装',
      summary: 'ファイルを変更',
    });
    expect(classifyRuntimeToolCall('bash', 'pnpm test')).toEqual({
      phase: '確認',
      summary: 'テスト / build / check を実行',
    });
  });

  it('returns a missing result when the trajectory cannot be read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-missing-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, JSON.stringify({
      result: { meta: { agentMeta: { sessionId: 'missing-session' } } },
    }), 'utf8');

    try {
      await expect(readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:missing-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'missing-session',
        missing: true,
        entries: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
