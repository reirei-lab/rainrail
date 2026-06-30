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

  it('does not prefer fallback-looking text without the embedded fallback marker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-non-fallback-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'issue body mentioned gateway-fallback-example but no runtime fallback happened',
      JSON.stringify({ result: { meta: { agentMeta: { sessionId: 'intended-session' } } } }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'intended-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('intended-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('follows relocated trajectory pointers for timeline reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-relocated-timeline-'));
    const relocatedDirectory = join(directory, 'runtime-sidecar');
    const sessionId = 'relocated-session';
    const logPath = join(directory, 'agent.log');
    const runtimeFile = join(relocatedDirectory, `${sessionId}.trajectory.jsonl`);
    mkdirSync(relocatedDirectory, { recursive: true });
    writeFileSync(logPath, JSON.stringify({
      result: { meta: { agentMeta: { sessionId } } },
    }), 'utf8');
    writeFileSync(join(directory, `${sessionId}.trajectory-path.json`), JSON.stringify({
      traceSchema: 'openclaw-trajectory-pointer',
      schemaVersion: 1,
      sessionId,
      runtimeFile,
    }), 'utf8');
    writeFileSync(runtimeFile, [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: sessionId },
        { sessionsDirectory: directory },
      );
      expect(timeline.trajectoryPath).toBe(runtimeFile);
      expect(timeline.missing).toBe(false);
      expect(timeline.entries).toEqual([expect.objectContaining({ summary: 'session.started' })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores relocated trajectory pointers for a different session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-wrong-pointer-timeline-'));
    const otherDirectory = join(directory, 'other-sidecar');
    const sessionId = 'requested-session';
    const logPath = join(directory, 'agent.log');
    const requestedFile = join(directory, `${sessionId}.trajectory.jsonl`);
    const otherFile = join(otherDirectory, 'other-session.trajectory.jsonl');
    mkdirSync(otherDirectory, { recursive: true });
    writeFileSync(logPath, JSON.stringify({
      result: { meta: { agentMeta: { sessionId } } },
    }), 'utf8');
    writeFileSync(join(directory, `${sessionId}.trajectory-path.json`), JSON.stringify({
      traceSchema: 'openclaw-trajectory-pointer',
      schemaVersion: 1,
      sessionId: 'other-session',
      runtimeFile: otherFile,
    }), 'utf8');
    writeFileSync(requestedFile, [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(otherFile, [
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:00.000Z', seq: 1, data: { name: 'bash', arguments: { command: 'echo wrong session' } } }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: sessionId },
        { sessionsDirectory: directory },
      );
      expect(timeline.trajectoryPath).toBe(requestedFile);
      expect(timeline.entries).toEqual([expect.objectContaining({ summary: 'session.started' })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves session keys through sessions.json before reading live trajectories', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-session-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    const sessionKey = 'agent:main:routing-key';
    const sessionId = 'actual-session-id';
    writeFileSync(logPath, 'tool output: {"sessionId":"unrelated-session-id"}', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId },
    }), 'utf8');
    writeFileSync(join(directory, `${sessionId}.trajectory.jsonl`), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: sessionKey },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe(sessionId);
      expect(timeline.missing).toBe(false);
      await expect(readRuntimeTimelineStatus(
        { logPath, agentSessionId: sessionKey },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId,
        ended: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses sessionFile from sessions.json to locate trajectory sidecars', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-session-file-timeline-'));
    const storeDirectory = join(directory, 'store');
    const logPath = join(directory, 'agent.log');
    const sessionKey = 'agent:main:routing-key';
    const sessionId = 'actual-session-id';
    const sessionFile = join(storeDirectory, 'custom-session.jsonl');
    const trajectoryFile = join(storeDirectory, 'custom-session.trajectory.jsonl');
    mkdirSync(storeDirectory, { recursive: true });
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId, sessionFile },
    }), 'utf8');
    writeFileSync(sessionFile, '', 'utf8');
    writeFileSync(trajectoryFile, [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: sessionKey },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe(sessionId);
      expect(timeline.trajectoryPath).toBe(trajectoryFile);
      expect(timeline.missing).toBe(false);
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
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:05.000Z', seq: 3, data: { name: 'bash', arguments: { command: 'curl https://user:password@example.com/repo.git -H "Authorization: Bearer github_pat_secretValue" -H "Authorization: Basic dXNlcjpwYXNz" -H "Cookie: session=abc123; csrf=def456" AUTHORIZATION="Bearer env-secret" token="quoted-secret" password="pa\\"ss"' } } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:10.000Z', seq: 4, data: { name: 'bash', status: 'completed', output: "ok https://user:password@example.com/repo.git token=secret-value AWS_SECRET_ACCESS_KEY=cloud-secret AUTHORIZATION=BasicEnvSecret api_key='quoted-output-secret' Authorization: Bearer github_pat_outputSecret Authorization: Basic dXNlcjpwYXNz Cookie: session=abc123 Set-Cookie: refresh=def456\n-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----" } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:20.000Z', seq: 5, data: { name: 'bash', status: 'completed', contentItems: [{ token: 'secret-json-token', apiKey: 'secret-json-key', password: 'pa\\"ss', Authorization: 'Basic dXNlcjpwYXNz', webhookSecret: 'secret-webhook', clientSecret: 'secret-client', apiToken: 'secret-api-token', privateKey: '-----BEGIN PRIVATE KEY-----\\nplaceholder\\n-----END PRIVATE KEY-----', private_key: 'private-key-material' }] } }),
    ].join('\n'));

    expect(timeline.map((entry) => [entry.phase, entry.summary])).toEqual([
      ['session.started', 'session.started'],
      ['確認', 'pnpm test'],
      ['実行', expect.stringContaining('curl https://[redacted]@example.com/repo.git')],
      ['tool.result', 'bash completed'],
      ['tool.result', 'bash completed'],
    ]);
    expect(timeline[2]!.detail).toContain('Bearer [redacted-token]');
    expect(timeline[2]!.detail).toContain('Basic [redacted-token]');
    expect(timeline[2]!.detail).toContain('Cookie: [redacted-cookie]');
    expect(timeline[2]!.detail).toContain('https://[redacted]@example.com/repo.git');
    expect(timeline[2]!.detail).toContain('AUTHORIZATION="[redacted]"');
    expect(timeline[2]!.detail).toContain('token="[redacted]"');
    expect(timeline[2]!.detail).toContain('password="[redacted]"');
    expect(timeline[2]!.detail).not.toContain('user:password');
    expect(timeline[2]!.detail).not.toContain('env-secret');
    expect(timeline[2]!.detail).not.toContain('abc123');
    expect(timeline[2]!.detail).not.toContain('ss"');
    expect(timeline[3]!.excerpt).toContain('token=[redacted]');
    expect(timeline[3]!.excerpt).toContain('AWS_SECRET_ACCESS_KEY=[redacted]');
    expect(timeline[3]!.excerpt).toContain('AUTHORIZATION=[redacted]');
    expect(timeline[3]!.excerpt).toContain('https://[redacted]@example.com/repo.git');
    expect(timeline[3]!.excerpt).toContain("api_key='[redacted]'");
    expect(timeline[3]!.excerpt).toContain('Bearer [redacted-token]');
    expect(timeline[3]!.excerpt).toContain('Basic [redacted-token]');
    expect(timeline[3]!.excerpt).toContain('Cookie: [redacted-cookie]');
    expect(timeline[3]!.excerpt).toContain('Set-Cookie: [redacted-cookie]');
    expect(timeline[3]!.excerpt).toContain('[redacted-private-key]');
    expect(timeline[3]!.excerpt).not.toContain('BasicEnvSecret');
    expect(timeline[3]!.excerpt).not.toContain('user:password');
    expect(timeline[3]!.excerpt).not.toContain('def456');
    expect(timeline[3]!.excerpt).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(timeline[4]!.excerpt).toContain('"token": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiKey": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"password": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"Authorization": "[redacted]"');
    expect(timeline[4]!.excerpt).not.toContain('ss"');
    expect(timeline[4]!.excerpt).toContain('"webhookSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"clientSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiToken": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"privateKey": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"private_key": "[redacted]"');
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
