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
      result: { status: 'ok', meta: { agentMeta: { sessionId: '4920eb13-b75f-4680-8b21-54f40262d2ba' } } },
    }))).toBe('4920eb13-b75f-4680-8b21-54f40262d2ba');
  });

  it('extracts OpenClaw session ids from top-level JSON metadata without scanning quoted payload text', () => {
    expect(extractRuntimeSessionId(JSON.stringify({
      status: 'ok',
      payloads: [{ text: 'tool output quoted {"agentMeta":{"sessionId":"wrong-session"}}' }],
      meta: { agentMeta: { sessionId: 'actual-session' } },
    }))).toBe('actual-session');
  });

  it('extracts OpenClaw session ids from bannered JSON metadata without scanning quoted payload text', () => {
    const log = [
      'OpenClaw agent starting',
      JSON.stringify({
        status: 'ok',
        payloads: [{ text: 'tool output quoted {"agentMeta":{"sessionId":"wrong-session"}}' }],
        meta: { agentMeta: { sessionId: 'actual-session' } },
      }),
      'OpenClaw agent finished',
    ].join('\n');

    expect(extractRuntimeSessionId(log)).toBe('actual-session');
  });

  it('extracts the last OpenClaw session id from appended JSON logs', () => {
    const log = [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { sessionId: 'gateway-fallback-old' } },
      }),
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { sessionId: 'gateway-fallback-new' } },
      }),
    ].join('\n');

    expect(extractRuntimeSessionId(log)).toBe('gateway-fallback-new');
  });

  it('does not use appended diagnostic JSON fragments as session metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-diagnostic-session-id-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { sessionId: 'actual-session' } },
      }),
      'tool result quoted target log:',
      '{"meta":{"agentMeta":{"sessionId":"old-session"}}}',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'old-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use empty completion diagnostic JSON fragments as session metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-empty-completion-session-id-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { sessionId: 'actual-session' } },
      }),
      'tool result quoted target log:',
      '{"completion":{},"meta":{"agentMeta":{"sessionId":"old-session"}}}',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'old-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use strict stderr diagnostic JSON as session metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-strict-stderr-diagnostic-session-id-timeline-'));
    const logPath = join(directory, 'agent.log');
    const stderrLogPath = join(directory, 'agent.stderr.log');
    writeFileSync(stderrLogPath, '{"meta":{"agentMeta":{"sessionId":"old-session"}}}', 'utf8');
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { sessionId: 'actual-session' } },
    }), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'old-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, stderrLogPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use broken diagnostic fragments as session metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-broken-diagnostic-session-id-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'tool result quoted target log:',
      '"agentMeta":{"sessionId":"old-session"',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'old-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBeUndefined();
      expect(timeline.missing).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not extract quoted agentMeta session ids from valid JSON logs without metadata', () => {
    expect(extractRuntimeSessionId(JSON.stringify({
      status: 'ok',
      payloads: [{ text: 'tool output quoted {"agentMeta":{"sessionId":"wrong-session"}}' }],
    }))).toBeUndefined();
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
      JSON.stringify({ result: { status: 'ok', meta: { agentMeta: { sessionId: 'intended-session' } } } }),
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

  it('does not prefer fallback markers quoted inside stdout JSON completion text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-quoted-fallback-json-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'quoted log: EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-quoted',
      meta: { agentMeta: { sessionId: 'actual-session' } },
    }), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not prefer fallback markers quoted inside bannered stdout JSON completion text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-quoted-fallback-banner-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'OpenClaw agent starting',
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'quoted log: EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-banner-quoted',
        meta: { agentMeta: { sessionId: 'actual-session' } },
      }),
      'OpenClaw agent finished',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not prefer fallback markers quoted inside bannered raw completion text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-quoted-fallback-raw-banner-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'OpenClaw agent starting',
      JSON.stringify({
        status: 'ok',
        finalAssistantRawText: 'quoted log: EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-raw-quoted',
        meta: { agentMeta: { sessionId: 'actual-session' } },
      }),
      'OpenClaw agent finished',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'actual-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:routing-key' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('actual-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers fallback session keys from JSON metadata over the original session mapping', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-fallback-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      meta: {
        agentMeta: {
          sessionId: 'gateway-fallback-meta',
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-meta',
        },
      },
    }), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-meta': { sessionId: 'fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('fallback-session');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to metadata session ids when fallback session key mappings are unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-fallback-key-without-mapping-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      meta: {
        agentMeta: {
          sessionId: 'gateway-fallback-unmapped',
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-unmapped',
        },
      },
    }), 'utf8');
    writeFileSync(join(directory, 'gateway-fallback-unmapped.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('gateway-fallback-unmapped');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('derives fallback session ids from explicit fallback session keys when mappings are unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-fallback-key-derived-session-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      meta: {
        agentMeta: {
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-derived',
        },
      },
    }), 'utf8');
    writeFileSync(join(directory, 'gateway-fallback-derived.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('gateway-fallback-derived');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use raw diagnostic JSON fragments as fallback metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-diagnostic-fallback-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'tool result quoted target log:',
      '{"meta":{"agentMeta":{"fallbackSessionKey":"agent:main:explicit:gateway-fallback-quoted"}}}',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-quoted': { sessionId: 'quoted-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'original-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'quoted-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('original-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use result-only diagnostic JSON fragments as fallback metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-result-diagnostic-fallback-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'tool result quoted target log:',
      '{"result":{"meta":{"agentMeta":{"fallbackSessionKey":"agent:main:explicit:gateway-fallback-quoted"}}}}',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-quoted': { sessionId: 'quoted-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'original-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'quoted-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('original-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not use empty completion diagnostic JSON fragments as fallback metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-empty-completion-fallback-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'tool result quoted target log:',
      '{"completion":{},"meta":{"agentMeta":{"fallbackSessionKey":"agent:main:explicit:gateway-fallback-quoted"}}}',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-quoted': { sessionId: 'quoted-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'original-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'quoted-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('original-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers the last fallback session key in an appended completion log', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-last-fallback-key-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-old' } },
      }),
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-new' } },
      }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:explicit:gateway-fallback-old': { sessionId: 'old-fallback-session' },
      'agent:main:explicit:gateway-fallback-new': { sessionId: 'new-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'old-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'new-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('new-fallback-session');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('clears stale fallback metadata after a later normal completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-clear-fallback-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-stale' } },
      }),
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        meta: { agentMeta: { sessionId: 'original-session' } },
      }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-stale': { sessionId: 'stale-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'original-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'stale-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('original-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops fallback lookup when the latest resume log has a normal completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-clear-fallback-across-logs-timeline-'));
    const startLogPath = join(directory, 'agent.log');
    const resumeLogPath = join(directory, 'resume-1.log');
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stale', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'Outcome: implemented',
      meta: { agentMeta: { sessionId: 'original-session' } },
    }), 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:original-session': { sessionId: 'original-session' },
      'agent:main:explicit:gateway-fallback-stale': { sessionId: 'stale-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'original-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'stale-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        {
          logPath: startLogPath,
          agentSessionId: 'agent:main:original-session',
          resumeAttempts: [{ logPath: resumeLogPath }],
        },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('original-session');
      expect(timeline.fallback).toBe(false);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers the last fallback marker in an appended diagnostics log', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-last-fallback-marker-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, [
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-old',
      'retry diagnostics',
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-new',
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'gateway-fallback-new.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        { logPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('gateway-fallback-new');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers the newest fallback log regardless of key or marker source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-newest-fallback-timeline-'));
    const startLogPath = join(directory, 'agent.log');
    const resumeLogPath = join(directory, 'resume.log');
    const resumeStderrLogPath = join(directory, 'resume.stderr.log');
    writeFileSync(startLogPath, JSON.stringify({
      status: 'ok',
      meta: {
        agentMeta: {
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-old',
        },
      },
    }), 'utf8');
    writeFileSync(resumeLogPath, 'resume stdout without fallback marker', 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-newest', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:explicit:gateway-fallback-old': { sessionId: 'old-fallback-session' },
      'agent:main:explicit:gateway-fallback-newest': { sessionId: 'newest-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'old-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'newest-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        {
          logPath: startLogPath,
          agentSessionId: 'agent:main:original-session',
          resumeAttempts: [
            { logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
          ],
        },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('newest-fallback-session');
      expect(timeline.fallback).toBe(true);
      expect(timeline.missing).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers stderr fallback markers over stale stdout fallback metadata in the same resume attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-stderr-over-stdout-timeline-'));
    const startLogPath = join(directory, 'agent.log');
    const resumeLogPath = join(directory, 'resume.log');
    const resumeStderrLogPath = join(directory, 'resume.stderr.log');
    writeFileSync(startLogPath, 'started intended session', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-stale' } },
    }), 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-current', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:explicit:gateway-fallback-stale': { sessionId: 'stale-fallback-session' },
      'agent:main:explicit:gateway-fallback-current': { sessionId: 'current-fallback-session' },
    }), 'utf8');
    writeFileSync(join(directory, 'stale-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, 'current-fallback-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:09:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      const timeline = await readRuntimeTimeline(
        {
          logPath: startLogPath,
          agentSessionId: 'agent:main:original-session',
          resumeAttempts: [
            { logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
          ],
        },
        { sessionsDirectory: directory },
      );
      expect(timeline.sessionId).toBe('current-fallback-session');
      expect(timeline.fallback).toBe(true);
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
      result: { status: 'ok', meta: { agentMeta: { sessionId } } },
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
      result: { status: 'ok', meta: { agentMeta: { sessionId } } },
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

  it('resolves relative sessionFile entries from the sessions directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-relative-session-file-timeline-'));
    const logPath = join(directory, 'agent.log');
    const sessionKey = 'agent:main:routing-key';
    const sessionId = 'actual-session-id';
    const sessionFile = 'relative-session.jsonl';
    const trajectoryFile = join(directory, 'relative-session.trajectory.jsonl');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId, sessionFile },
    }), 'utf8');
    writeFileSync(join(directory, sessionFile), '', 'utf8');
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

  it('keeps ended trajectory status after terminal bookkeeping rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-ended-bookkeeping-timeline-'));
    const logPath = join(directory, 'agent.log');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(join(directory, 'bookkeeping-session.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'session.ended', ts: '2026-06-30T15:58:00.000Z', seq: 2, data: { status: 'success' } }),
      JSON.stringify({ type: 'usage.reported', ts: '2026-06-30T15:58:01.000Z', seq: 3, data: { totalTokens: 1234 } }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimelineStatus(
        { logPath, agentSessionId: 'bookkeeping-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'bookkeeping-session',
        ended: true,
        endedStatus: 'success',
        lastTimestamp: '2026-06-30T15:58:01.000Z',
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

  it('uses stderr fallback markers when resolving runtime timeline sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-stderr-fallback-timeline-'));
    const logPath = join(directory, 'agent.log');
    const stderrLogPath = join(directory, 'agent.stderr.log');
    writeFileSync(logPath, 'Gateway timed out before completion metadata', 'utf8');
    writeFileSync(stderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stderr', 'utf8');
    writeFileSync(join(directory, 'gateway-fallback-stderr.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimeline(
        { logPath, stderrLogPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'gateway-fallback-stderr',
        fallback: true,
        missing: false,
        entries: [expect.objectContaining({ summary: 'session.started' })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses latest resume attempt stderr fallback markers when resolving runtime timeline sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-resume-stderr-fallback-timeline-'));
    const logPath = join(directory, 'agent.log');
    const stderrLogPath = join(directory, 'agent.stderr.log');
    const resumeLogPath = join(directory, 'resume-1.log');
    const resumeStderrLogPath = join(directory, 'resume-1.stderr.log');
    writeFileSync(logPath, JSON.stringify({ result: { status: 'ok', meta: { agentMeta: { sessionId: 'original-session' } } } }), 'utf8');
    writeFileSync(stderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-start', 'utf8');
    writeFileSync(resumeLogPath, 'resume stdout without completion metadata', 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-resume', 'utf8');
    writeFileSync(join(directory, 'gateway-fallback-resume.trajectory.jsonl'), [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T16:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimeline(
        {
          logPath,
          stderrLogPath,
          agentSessionId: 'agent:main:original-session',
          resumeAttempts: [
            { logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
          ],
        },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'gateway-fallback-resume',
        fallback: true,
        missing: false,
        entries: [expect.objectContaining({ summary: 'session.started' })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves fallback marker sessions through explicit session key mappings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-fallback-mapped-timeline-'));
    const storeDirectory = join(directory, 'store');
    const logPath = join(directory, 'agent.log');
    const stderrLogPath = join(directory, 'agent.stderr.log');
    const sessionFile = join(storeDirectory, 'fallback-session.jsonl');
    const trajectoryFile = join(storeDirectory, 'fallback-session.trajectory.jsonl');
    mkdirSync(storeDirectory, { recursive: true });
    writeFileSync(logPath, 'Gateway timed out before completion metadata', 'utf8');
    writeFileSync(stderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-mapped', 'utf8');
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify({
      'agent:main:explicit:gateway-fallback-mapped': {
        sessionId: 'relocated-fallback-session',
        sessionFile,
      },
    }), 'utf8');
    writeFileSync(sessionFile, '', 'utf8');
    writeFileSync(trajectoryFile, [
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T16:08:00.000Z', seq: 1 }),
    ].join('\n'), 'utf8');

    try {
      await expect(readRuntimeTimeline(
        { logPath, stderrLogPath, agentSessionId: 'agent:main:original-session' },
        { sessionsDirectory: directory },
      )).resolves.toMatchObject({
        sessionId: 'relocated-fallback-session',
        fallback: true,
        missing: false,
        trajectoryPath: trajectoryFile,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders trajectory rows and redacts sensitive output for Codex activity display', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({ type: 'session.started', ts: '2026-06-30T15:08:00.000Z', seq: 1 }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:00.000Z', seq: 2, data: { name: 'bash', arguments: { command: 'pnpm test' } } }),
      JSON.stringify({ type: 'tool.call', ts: '2026-06-30T15:09:05.000Z', seq: 3, data: { name: 'bash', arguments: { command: 'curl -uuser:joined-password -Uproxy:joined-proxy-password -b session=inline-cookie --cookie other=other-cookie -u user:curl-password --user other:other-password -U proxy:proxy-password --proxy-user other-proxy:other-proxy-password --oauth2-bearer oauth-secret --pass private-key-pass --proxy-pass proxy-key-pass --tlspassword tls-secret --proxy-tlspassword proxy-tls-secret AUTHORIZATION="Bearer env-secret" token="quoted-secret" password="pa\\"ss" https://user:password@example.com/repo.git -H "Cookie: session=\\"cookie-secret\\"; csrf=def456" -H "Authorization: Digest username=\\"user\\", response=\\"digest-secret\\"" -H "Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20260701/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef123456"' } } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:10.000Z', seq: 4, data: { name: 'bash', status: 'completed', output: "ok curl -Eresult.pem:result-joined-cert-secret --cert result.pem:result-cert-secret --proxy-cert proxy-result.pem:proxy-result-cert-secret --user result:result-password --proxy-user proxy-result:proxy-result-password --oauth2-bearer oauth-result-token --cookie result=result-cookie --pass result-key-pass --tlspassword result-tls-secret https://user:password@example.com/repo.git token=secret-value AWS_SECRET_ACCESS_KEY=cloud-secret AUTHORIZATION=BasicEnvSecret api_key='quoted-output-secret' standalone Bearer opaque-session-token Authorization: Bearer github_pat_outputSecret Authorization: Basic dXNlcjpwYXNz Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20260701/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=resultsignature Cookie: session=abc123 Set-Cookie: refresh=def456\n-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----" } }),
      JSON.stringify({ type: 'tool.result', ts: '2026-06-30T15:09:20.000Z', seq: 5, data: { name: 'bash', status: 'completed', contentItems: [{ token: 'secret-json-token', apiKey: 'secret-json-key', password: 'pa\\"ss', Authorization: 'Basic dXNlcjpwYXNz', Cookie: 'session=json-cookie', 'Set-Cookie': 'refresh=json-refresh', webhookSecret: 'secret-webhook', clientSecret: 'secret-client', apiToken: 'secret-api-token', privateKey: '-----BEGIN PRIVATE KEY-----\\nplaceholder\\n-----END PRIVATE KEY-----', private_key: 'private-key-material' }] } }),
    ].join('\n'));

    expect(timeline.map((entry) => [entry.phase, entry.summary])).toEqual([
      ['session.started', 'session.started'],
      ['確認', 'pnpm test'],
      ['実行', expect.stringContaining('curl -u[redacted-credential]')],
      ['tool.result', 'bash completed'],
      ['tool.result', 'bash completed'],
    ]);
    expect(timeline[2]!.detail).toContain('Authorization: [redacted-authorization]');
    expect(timeline[2]!.detail).toContain('-u[redacted-credential]');
    expect(timeline[2]!.detail).toContain('-U[redacted-credential]');
    expect(timeline[2]!.detail).toContain('-b [redacted-cookie]');
    expect(timeline[2]!.detail).toContain('--cookie [redacted-cookie]');
    expect(timeline[2]!.detail).toContain('-u [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--user [redacted-credential]');
    expect(timeline[2]!.detail).toContain('-U [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--proxy-user [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--oauth2-bearer [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--pass [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--proxy-pass [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--tlspassword [redacted-credential]');
    expect(timeline[2]!.detail).toContain('--proxy-tlspassword [redacted-credential]');
    expect(timeline[2]!.detail).toContain('Cookie: [redacted-cookie]');
    expect(timeline[2]!.detail).toContain('https://[redacted]@example.com/repo.git');
    expect(timeline[2]!.detail).toContain('AUTHORIZATION="[redacted]"');
    expect(timeline[2]!.detail).toContain('token="[redacted]"');
    expect(timeline[2]!.detail).toContain('password="[redacted]"');
    expect(timeline[2]!.detail).not.toContain('user:password');
    expect(timeline[2]!.detail).not.toContain('joined-password');
    expect(timeline[2]!.detail).not.toContain('joined-proxy-password');
    expect(timeline[2]!.detail).not.toContain('inline-cookie');
    expect(timeline[2]!.detail).not.toContain('other-cookie');
    expect(timeline[2]!.detail).not.toContain('curl-password');
    expect(timeline[2]!.detail).not.toContain('other-password');
    expect(timeline[2]!.detail).not.toContain('proxy-password');
    expect(timeline[2]!.detail).not.toContain('other-proxy-password');
    expect(timeline[2]!.detail).not.toContain('oauth-secret');
    expect(timeline[2]!.detail).not.toContain('private-key-pass');
    expect(timeline[2]!.detail).not.toContain('proxy-key-pass');
    expect(timeline[2]!.detail).not.toContain('tls-secret');
    expect(timeline[2]!.detail).not.toContain('proxy-tls-secret');
    expect(timeline[2]!.detail).not.toContain('Signature=abcdef123456');
    expect(timeline[2]!.detail).not.toContain('digest-secret');
    expect(timeline[2]!.detail).not.toContain('cookie-secret');
    expect(timeline[2]!.detail).not.toContain('github_pat_secretValue');
    expect(timeline[2]!.detail).not.toContain('dXNlcjpwYXNz');
    expect(timeline[2]!.detail).not.toContain('env-secret');
    expect(timeline[2]!.detail).not.toContain('abc123');
    expect(timeline[2]!.detail).not.toContain('ss"');
    expect(timeline[3]!.excerpt).toContain('token=[redacted]');
    expect(timeline[3]!.excerpt).toContain('AWS_SECRET_ACCESS_KEY=[redacted]');
    expect(timeline[3]!.excerpt).toContain('AUTHORIZATION=[redacted]');
    expect(timeline[3]!.excerpt).toContain('https://[redacted]@example.com/repo.git');
    expect(timeline[3]!.excerpt).toContain("api_key='[redacted]'");
    expect(timeline[3]!.excerpt).toContain('Authorization: [redacted-authorization]');
    expect(timeline[3]!.excerpt).toContain('Bearer [redacted-bearer]');
    expect(timeline[3]!.excerpt).toContain('--user [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--proxy-user [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--oauth2-bearer [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--cookie [redacted-cookie]');
    expect(timeline[3]!.excerpt).toContain('--pass [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--tlspassword [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('-E[redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--cert [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('--proxy-cert [redacted-credential]');
    expect(timeline[3]!.excerpt).toContain('Cookie: [redacted-cookie]');
    expect(timeline[3]!.excerpt).toContain('Set-Cookie: [redacted-cookie]');
    expect(timeline[3]!.excerpt).toContain('[redacted-private-key]');
    expect(timeline[3]!.excerpt).not.toContain('BasicEnvSecret');
    expect(timeline[3]!.excerpt).not.toContain('user:password');
    expect(timeline[3]!.excerpt).not.toContain('result-password');
    expect(timeline[3]!.excerpt).not.toContain('proxy-result-password');
    expect(timeline[3]!.excerpt).not.toContain('oauth-result-token');
    expect(timeline[3]!.excerpt).not.toContain('opaque-session-token');
    expect(timeline[3]!.excerpt).not.toContain('result-cookie');
    expect(timeline[3]!.excerpt).not.toContain('result-key-pass');
    expect(timeline[3]!.excerpt).not.toContain('result-tls-secret');
    expect(timeline[3]!.excerpt).not.toContain('result-joined-cert-secret');
    expect(timeline[3]!.excerpt).not.toContain('result-cert-secret');
    expect(timeline[3]!.excerpt).not.toContain('proxy-result-cert-secret');
    expect(timeline[3]!.excerpt).not.toContain('Signature=resultsignature');
    expect(timeline[3]!.excerpt).not.toContain('github_pat_outputSecret');
    expect(timeline[3]!.excerpt).not.toContain('dXNlcjpwYXNz');
    expect(timeline[3]!.excerpt).not.toContain('def456');
    expect(timeline[3]!.excerpt).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(timeline[4]!.excerpt).toContain('"token": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiKey": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"password": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"Authorization": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"Cookie": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"Set-Cookie": "[redacted]"');
    expect(timeline[4]!.excerpt).not.toContain('json-cookie');
    expect(timeline[4]!.excerpt).not.toContain('json-refresh');
    expect(timeline[4]!.excerpt).not.toContain('ss"');
    expect(timeline[4]!.excerpt).toContain('"webhookSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"clientSecret": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"apiToken": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"privateKey": "[redacted]"');
    expect(timeline[4]!.excerpt).toContain('"private_key": "[redacted]"');
  });

  it('redacts curl joined headers and clustered credential options', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.call',
        ts: '2026-06-30T15:09:05.000Z',
        seq: 1,
        data: {
          name: 'bash',
          arguments: {
            command: 'curl -sHAuthorization: Basic joined-basic -sHCookie: session=joined-cookie -su user:cluster-password -sb session=cluster-cookie -suuser:joined-cluster-password -sbsession=joined-cluster-cookie -sEclient.pem:joined-cluster-cert-secret https://example.com',
          },
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.detail).toContain('-sHAuthorization: [redacted-authorization]');
    expect(timeline[0]!.detail).toContain('-sHCookie: [redacted-cookie]');
    expect(timeline[0]!.detail).toContain('-su [redacted-credential]');
    expect(timeline[0]!.detail).toContain('-sb [redacted-cookie]');
    expect(timeline[0]!.detail).toContain('-su[redacted-credential]');
    expect(timeline[0]!.detail).toContain('-sb[redacted-cookie]');
    expect(timeline[0]!.detail).toContain('-sE[redacted-credential]');
    expect(timeline[0]!.detail).not.toContain('joined-basic');
    expect(timeline[0]!.detail).not.toContain('joined-cookie');
    expect(timeline[0]!.detail).not.toContain('cluster-password');
    expect(timeline[0]!.detail).not.toContain('cluster-cookie');
    expect(timeline[0]!.detail).not.toContain('joined-cluster-password');
    expect(timeline[0]!.detail).not.toContain('joined-cluster-cookie');
    expect(timeline[0]!.detail).not.toContain('joined-cluster-cert-secret');
  });

  it('redacts API key and token headers', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.call',
        ts: '2026-06-30T15:09:05.000Z',
        seq: 1,
        data: {
          name: 'bash',
          arguments: {
            command: 'curl -H "X-API-Key: live-secret" -H "Private-Token: private-token-secret" https://example.com',
          },
        },
      }),
      JSON.stringify({
        type: 'tool.result',
        ts: '2026-06-30T15:09:10.000Z',
        seq: 2,
        data: {
          name: 'bash',
          status: 'completed',
          output: 'X-Secret-Header: result-secret\nGitLab-Token: result-token-secret',
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.detail).toContain('X-API-Key: [redacted-header]');
    expect(timeline[0]!.detail).toContain('Private-Token: [redacted-header]');
    expect(timeline[0]!.detail).not.toContain('live-secret');
    expect(timeline[0]!.detail).not.toContain('private-token-secret');
    expect(timeline[1]!.excerpt).toContain('X-Secret-Header: [redacted-header]');
    expect(timeline[1]!.excerpt).toContain('GitLab-Token: [redacted-header]');
    expect(timeline[1]!.excerpt).not.toContain('result-secret');
    expect(timeline[1]!.excerpt).not.toContain('result-token-secret');
  });

  it('redacts curl ftp account credentials', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.call',
        ts: '2026-06-30T15:09:05.000Z',
        seq: 1,
        data: {
          name: 'bash',
          arguments: {
            command: 'curl --ftp-account acct-secret ftp://example.com/file',
          },
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.detail).toContain('--ftp-account [redacted-credential]');
    expect(timeline[0]!.detail).not.toContain('acct-secret');
  });

  it('redacts curl proxy URLs with inline credentials', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.call',
        ts: '2026-06-30T15:09:05.000Z',
        seq: 1,
        data: {
          name: 'bash',
          arguments: {
            command: 'curl -x user:proxy-secret@proxy.example --preproxy pre:pre-secret@preproxy.example --proxy1.0 legacy:legacy-proxy-secret@legacy.example -sx user:cluster-proxy-secret@cluster.example -sxjoined:joined-proxy-secret@joined.example https://example.com',
          },
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.detail).toContain('-x [redacted-proxy]');
    expect(timeline[0]!.detail).toContain('--preproxy [redacted-proxy]');
    expect(timeline[0]!.detail).toContain('--proxy1.0 [redacted-proxy]');
    expect(timeline[0]!.detail).toContain('-sx [redacted-proxy]');
    expect(timeline[0]!.detail).toContain('-sx[redacted-proxy]');
    expect(timeline[0]!.detail).not.toContain('proxy-secret');
    expect(timeline[0]!.detail).not.toContain('pre-secret');
    expect(timeline[0]!.detail).not.toContain('legacy-proxy-secret');
    expect(timeline[0]!.detail).not.toContain('cluster-proxy-secret');
    expect(timeline[0]!.detail).not.toContain('joined-proxy-secret');
  });

  it('redacts bearer tokens with underscores and cookie assignments', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.result',
        ts: '2026-06-30T15:09:10.000Z',
        seq: 1,
        data: {
          name: 'bash',
          status: 'completed',
          output: 'standalone Bearer abcdef_secret COOKIE=session=secret-cookie SESSION_COOKIE=session-secret Set-Cookie=refresh-secret',
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.excerpt).toContain('Bearer [redacted-bearer]');
    expect(timeline[0]!.excerpt).toContain('COOKIE=[redacted]');
    expect(timeline[0]!.excerpt).toContain('SESSION_COOKIE=[redacted]');
    expect(timeline[0]!.excerpt).toContain('Set-Cookie=[redacted]');
    expect(timeline[0]!.excerpt).not.toContain('_secret');
    expect(timeline[0]!.excerpt).not.toContain('secret-cookie');
    expect(timeline[0]!.excerpt).not.toContain('session-secret');
    expect(timeline[0]!.excerpt).not.toContain('refresh-secret');
  });

  it('redacts full authorization assignment values', () => {
    const timeline = parseRuntimeTrajectoryTimeline([
      JSON.stringify({
        type: 'tool.result',
        ts: '2026-06-30T15:09:10.000Z',
        seq: 1,
        data: {
          name: 'bash',
          status: 'completed',
          output: 'AUTHORIZATION=Basic dXNlcjpwYXNz\nAUTHORIZATION=Digest username="u", response="secret"',
        },
      }),
    ].join('\n'));

    expect(timeline[0]!.excerpt).toContain('AUTHORIZATION=[redacted]');
    expect(timeline[0]!.excerpt).not.toContain('dXNlcjpwYXNz');
    expect(timeline[0]!.excerpt).not.toContain('username="u"');
    expect(timeline[0]!.excerpt).not.toContain('response="secret"');
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
      result: { status: 'ok', meta: { agentMeta: { sessionId: 'missing-session' } } },
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
