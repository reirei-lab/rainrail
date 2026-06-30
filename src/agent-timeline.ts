import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RuntimeTimelinePhase = '調査' | '準備' | '実装' | '確認' | '完了処理' | '実行' | string;

export interface RuntimeTimelineEntry {
  id: string;
  timestamp: string;
  phase: RuntimeTimelinePhase;
  summary: string;
  detail?: string | undefined;
  excerpt?: string | undefined;
  status?: string | undefined;
}

export interface RuntimeTimelineResult {
  logPath: string;
  sessionId?: string | undefined;
  fallback: boolean;
  trajectoryPath?: string | undefined;
  entries: RuntimeTimelineEntry[];
  missing: boolean;
  error?: string | undefined;
}

export interface RuntimeTimelineStatus {
  sessionId?: string | undefined;
  fallback: boolean;
  trajectoryPath?: string | undefined;
  ended: boolean;
  endedStatus?: string | undefined;
  lastTimestamp?: string | undefined;
}

interface RuntimeTaskForTimeline {
  logPath: string;
  agentSessionId?: string;
}

interface RuntimeTimelineReadOptions {
  sessionsDirectory?: string;
  agentId?: string;
  openClawHome?: string;
}

interface TrajectoryEvent {
  type?: string;
  ts?: string;
  seq?: number;
  data?: Record<string, unknown>;
}

const excerptLength = 1200;
const detailLength = 600;
const maxJsonlBytes = 400 * 1024;

export async function readRuntimeTimeline(
  task: RuntimeTaskForTimeline,
  options: RuntimeTimelineReadOptions = {},
): Promise<RuntimeTimelineResult> {
  const session = await readRuntimeSession(task, options);
  const result: RuntimeTimelineResult = {
    logPath: task.logPath,
    sessionId: session.sessionId,
    fallback: session.fallback,
    entries: [],
    missing: false,
  };
  if (session.sessionId === undefined) {
    return { ...result, missing: true, error: 'agent session id was not found in the task log' };
  }

  const trajectoryPath = await resolveRuntimeTrajectoryPathForSessionId(session.sessionId, options);
  try {
    return {
      ...result,
      trajectoryPath,
      entries: parseRuntimeTrajectoryTimeline(await readFile(trajectoryPath, 'utf8')),
    };
  } catch (error) {
    return {
      ...result,
      trajectoryPath,
      missing: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readRuntimeTimelineStatus(
  task: RuntimeTaskForTimeline,
  options: RuntimeTimelineReadOptions = {},
): Promise<RuntimeTimelineStatus> {
  const session = await readRuntimeSession(task, options);
  const status: RuntimeTimelineStatus = {
    sessionId: session.sessionId,
    fallback: session.fallback,
    ended: false,
  };
  if (session.sessionId === undefined) {
    return status;
  }
  const trajectoryPath = await resolveRuntimeTrajectoryPathForSessionId(session.sessionId, options);
  status.trajectoryPath = trajectoryPath;
  let contents: string;
  try {
    contents = await readFile(trajectoryPath, 'utf8');
  } catch {
    return status;
  }
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const event = parseTrajectoryLine(line);
    if (event === undefined) {
      continue;
    }
    status.lastTimestamp = event.ts ?? status.lastTimestamp;
    if (event.type === 'session.ended') {
      status.ended = true;
      status.endedStatus = stringField(event.data, 'status');
    } else {
      status.ended = false;
      status.endedStatus = undefined;
    }
  }
  return status;
}

export async function readRuntimeJsonl(
  task: RuntimeTaskForTimeline,
  options: RuntimeTimelineReadOptions & { maxBytes?: number } = {},
): Promise<{ logPath: string; sessionId?: string | undefined; fallback: boolean; trajectoryPath?: string | undefined; raw: string; missing: boolean; truncated: boolean; error?: string | undefined }> {
  const session = await readRuntimeSession(task, options);
  const result = {
    logPath: task.logPath,
    sessionId: session.sessionId,
    fallback: session.fallback,
    raw: '',
    missing: false,
    truncated: false,
  };
  if (session.sessionId === undefined) {
    return { ...result, missing: true, error: 'agent session id was not found in the task log' };
  }
  const trajectoryPath = await resolveRuntimeTrajectoryPathForSessionId(session.sessionId, options);
  try {
    const tail = await readTailText(trajectoryPath, options.maxBytes ?? maxJsonlBytes);
    return { ...result, trajectoryPath, raw: tail.text, truncated: tail.truncated };
  } catch (error) {
    return {
      ...result,
      trajectoryPath,
      missing: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extractRuntimeSessionId(log: string): string | undefined {
  try {
    const parsed = JSON.parse(log) as { result?: { meta?: { agentMeta?: { sessionId?: unknown } } } };
    const sessionId = parsed.result?.meta?.agentMeta?.sessionId;
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      return sessionId;
    }
  } catch {
    // Partial logs are common, regex fallback handles them.
  }
  const match = log.match(/"agentMeta"\s*:\s*\{[\s\S]*?"sessionId"\s*:\s*"([^"]+)"/)
    ?? log.match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

export function extractRuntimeFallbackSessionId(log: string): string | undefined {
  const match = log.match(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/i);
  return match?.[1];
}

export function runtimeTrajectoryPathForSessionId(
  sessionId: string,
  options: string | RuntimeTimelineReadOptions = {},
): string {
  const sessionsDirectory = typeof options === 'string' ? options : runtimeSessionsDirectory(options);
  return join(sessionsDirectory, `${sessionId.replace(/[^A-Za-z0-9._:-]/g, '_')}.trajectory.jsonl`);
}

export function parseRuntimeTrajectoryTimeline(contents: string): RuntimeTimelineEntry[] {
  const entries: RuntimeTimelineEntry[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const event = parseTrajectoryLine(line);
    if (event !== undefined) {
      entries.push(timelineEntryForEvent(event, entries.length));
    }
  }
  return entries;
}

export function classifyRuntimeToolCall(toolName: string, command: string): {
  phase: RuntimeTimelinePhase;
  summary: string;
} {
  const commandLower = command.toLowerCase();
  const normalizedCommand = command.replace(/\s+/g, ' ').trim();
  if (toolName === 'apply_patch' || commandLower.includes('apply_patch')) {
    return { phase: '実装', summary: 'ファイルを変更' };
  }
  if (/\b(git\s+(add|commit|push)|gh\s+pr\s+create|gh\s+issue\s+comment|gh\s+pr\s+comment|gh\s+pr\s+ready)\b/.test(commandLower)) {
    return { phase: '完了処理', summary: 'commit / push / PR / issue コメントを処理' };
  }
  if (/\b(gh\s+issue|gh\s+pr\s+(view|list|diff)|gh\s+api|gh\s+repo\s+view)\b/.test(commandLower)) {
    return { phase: '調査', summary: 'GitHub issue / PR を確認' };
  }
  if (/\b(git\s+(fetch|status|branch|worktree|remote|ls-remote|show))\b/.test(commandLower)) {
    return { phase: '準備', summary: 'git / worktree 状態を確認' };
  }
  if (/\b(npm\s+(test|run\s+(test|typecheck|build|ci)|audit)|vitest|tsc|eslint|pnpm\s+test|pnpm\s+typecheck|pnpm\s+build|yarn\s+test|gh\s+pr\s+checks)\b/.test(commandLower)) {
    return { phase: '確認', summary: 'テスト / build / check を実行' };
  }
  if (/\b(rg|sed|cat|ls|find|head|tail|wc|jq|node)\b/.test(commandLower)) {
    return { phase: '調査', summary: '関連コード / ログを確認' };
  }
  if (toolName !== '') {
    return { phase: '実行', summary: `${toolName} を実行` };
  }
  return { phase: '実行', summary: normalizedCommand === '' ? '処理を実行' : truncate(normalizedCommand, 80) };
}

async function readRuntimeSession(
  task: RuntimeTaskForTimeline,
  options: RuntimeTimelineReadOptions,
): Promise<{ sessionId?: string | undefined; fallback: boolean }> {
  try {
    const log = await readFile(task.logPath, 'utf8');
    const fallbackSessionId = extractRuntimeFallbackSessionId(log);
    return {
      sessionId: fallbackSessionId ?? extractRuntimeSessionId(log) ?? await resolveTrajectorySessionId(task.agentSessionId, options),
      fallback: fallbackSessionId !== undefined,
    };
  } catch {
    return { sessionId: await resolveTrajectorySessionId(task.agentSessionId, options), fallback: false };
  }
}

async function resolveRuntimeTrajectoryPathForSessionId(
  sessionId: string,
  options: RuntimeTimelineReadOptions = {},
): Promise<string> {
  const directPath = runtimeTrajectoryPathForSessionId(sessionId, options);
  const pointerPath = directPath.replace(/\.trajectory\.jsonl$/, '.trajectory-path.json');
  try {
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as unknown;
    if (isRecord(pointer) && typeof pointer.runtimeFile === 'string' && pointer.runtimeFile.trim() !== '') {
      return pointer.runtimeFile;
    }
  } catch {
    // Older OpenClaw runs store the trajectory directly beside the session file.
  }
  return directPath;
}

async function readTailText(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const fileStat = await stat(path);
  const start = Math.max(0, fileStat.size - maxBytes);
  const length = fileStat.size - start;
  const buffer = Buffer.alloc(length);
  const file = await open(path, 'r');
  try {
    const { bytesRead } = await file.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return { text, truncated: start > 0 };
  } finally {
    await file.close();
  }
}

function timelineEntryForEvent(event: TrajectoryEvent, index: number): RuntimeTimelineEntry {
  if (event.type === 'tool.call') {
    return timelineEntryForToolCall(event, index);
  }
  if (event.type === 'tool.result') {
    return timelineEntryForToolResult(event, index);
  }
  const status = stringField(event.data, 'status');
  const detail = event.data === undefined ? undefined : JSON.stringify(event.data);
  return {
    id: timelineEntryId(event, index),
    timestamp: event.ts ?? '',
    phase: event.type ?? 'event',
    summary: event.type ?? 'event',
    detail: detail === undefined ? undefined : truncate(redactSensitiveText(detail), detailLength),
    status,
  };
}

function timelineEntryForToolCall(event: TrajectoryEvent, index: number): RuntimeTimelineEntry {
  const toolName = stringField(event.data, 'name') ?? '';
  const command = extractToolCommand(event.data);
  const classified = classifyRuntimeToolCall(toolName, command);
  const detailParts = [toolName, command].filter((part) => part.trim() !== '');
  return {
    id: timelineEntryId(event, index),
    timestamp: event.ts ?? '',
    phase: classified.phase,
    summary: formatToolCallSummary(toolName, command),
    detail: detailParts.length === 0 ? undefined : truncate(redactSensitiveText(detailParts.join(': ')), detailLength),
  };
}

function timelineEntryForToolResult(event: TrajectoryEvent, index: number): RuntimeTimelineEntry {
  const toolName = stringField(event.data, 'name') ?? '';
  const isError = booleanField(event.data, 'isError');
  const status = isError ? 'error' : stringField(event.data, 'status');
  const output = stringField(event.data, 'output') ?? stringifyField(event.data, 'contentItems');
  return {
    id: timelineEntryId(event, index),
    timestamp: event.ts ?? '',
    phase: event.type ?? 'tool.result',
    summary: [toolName.trim() === '' ? 'tool' : toolName, status].filter(Boolean).join(' '),
    detail: toolName.trim() === '' ? undefined : toolName,
    status,
    excerpt: output === undefined || output.trim() === '' ? undefined : truncate(redactSensitiveText(output), excerptLength),
  };
}

function parseTrajectoryLine(line: string): TrajectoryEvent | undefined {
  try {
    return JSON.parse(line) as TrajectoryEvent;
  } catch {
    return undefined;
  }
}

function extractToolCommand(data: Record<string, unknown> | undefined): string {
  const argumentsValue = data?.arguments;
  if (typeof argumentsValue === 'string') {
    return argumentsValue;
  }
  if (argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    const argumentsRecord = argumentsValue as Record<string, unknown>;
    const command = stringField(argumentsRecord, 'command') ?? stringField(argumentsRecord, 'cmd');
    return command ?? JSON.stringify(argumentsRecord);
  }
  return '';
}

function formatToolCallSummary(toolName: string, command: string): string {
  const normalizedCommand = command.replace(/\s+/g, ' ').trim();
  if (normalizedCommand !== '') {
    return truncate(redactSensitiveText(normalizedCommand), 140);
  }
  return toolName.trim() === '' ? 'tool.call' : `${toolName} call`;
}

async function resolveTrajectorySessionId(
  value: string | undefined,
  options: RuntimeTimelineReadOptions,
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  const mapped = await readMappedRuntimeSessionId(value, options);
  if (mapped !== undefined) {
    return mapped;
  }
  const runMatch = value.match(/:run:([^:]+)$/);
  if (runMatch !== null) {
    return runMatch[1];
  }
  if (value.includes(':')) {
    return undefined;
  }
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

async function readMappedRuntimeSessionId(
  sessionKey: string,
  options: RuntimeTimelineReadOptions,
): Promise<string | undefined> {
  try {
    const sessions = JSON.parse(await readFile(join(runtimeSessionsDirectory(options), 'sessions.json'), 'utf8')) as unknown;
    if (!isRecord(sessions)) {
      return undefined;
    }
    const entry = sessions[sessionKey];
    if (!isRecord(entry)) {
      return undefined;
    }
    const sessionId = entry.sessionId;
    return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function timelineEntryId(event: TrajectoryEvent, index: number): string {
  return event.seq === undefined ? `timeline_${index + 1}` : `seq_${event.seq}`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringifyField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return value === undefined ? undefined : JSON.stringify(value, null, 2);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, '[redacted-token]')
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[redacted-token]')
    .replace(/(Authorization:\s*[A-Za-z][A-Za-z0-9._-]*\s+)[^\s'",}]+/gi, '$1[redacted-token]')
    .replace(/("[^"]*(?:token|secret|password|api[_-]?key|private[_-]?key)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)[^\s'",}]+/gi, '$1[redacted]');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function runtimeSessionsDirectory(options: RuntimeTimelineReadOptions): string {
  if (options.sessionsDirectory !== undefined) {
    return options.sessionsDirectory;
  }
  return join(options.openClawHome ?? join(homedir(), '.openclaw'), 'agents', options.agentId ?? 'main', 'sessions');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
