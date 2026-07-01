import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
  stderrLogPath?: string | undefined;
  agentSessionId?: string;
  resumeAttempts?: Array<{
    logPath: string;
    stderrLogPath?: string | undefined;
  }> | undefined;
}

interface RuntimeTimelineReadOptions {
  sessionsDirectory?: string;
  agentId?: string;
  openClawHome?: string;
}

interface RuntimeSessionResolution {
  sessionId?: string | undefined;
  sessionFile?: string | undefined;
  fallback: boolean;
}

interface RuntimeFallbackMetadata {
  sessionKey?: string | undefined;
  sessionId?: string | undefined;
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

  const trajectoryPath = await resolveRuntimeTrajectoryPathForSession(session, options);
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
  const trajectoryPath = await resolveRuntimeTrajectoryPathForSession(session, options);
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
    } else if (event.type === 'session.started') {
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
  const trajectoryPath = await resolveRuntimeTrajectoryPathForSession(session, options);
  try {
    const tail = await readTailText(trajectoryPath, options.maxBytes ?? maxJsonlBytes);
    return { ...result, trajectoryPath, raw: redactSensitiveText(tail.text), truncated: tail.truncated };
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
    const payload = JSON.parse(log) as unknown;
    return isTrustedRuntimeCompletionPayload(payload) ? runtimeSessionIdFromPayload(payload) : undefined;
  } catch {
    const objects = parseJsonObjectsFromLogWithPositions(log);
    for (const object of objects.slice().reverse()) {
      if (!isTrustedRuntimeCompletionLogObject(log, object)) {
        continue;
      }
      const sessionId = runtimeSessionIdFromPayload(object.payload);
      if (sessionId !== undefined) {
        return sessionId;
      }
    }
    if (objects.length > 0) {
      return undefined;
    }
  }
  return undefined;
}

function extractRuntimeNonFallbackSessionId(log: string): string | undefined {
  try {
    const payload = JSON.parse(log) as unknown;
    const sessionId = isTrustedRuntimeCompletionPayload(payload) ? runtimeSessionIdFromPayload(payload) : undefined;
    return sessionId?.startsWith('gateway-fallback-') === true ? undefined : sessionId;
  } catch {
    const objects = parseJsonObjectsFromLogWithPositions(log);
    for (const object of objects.slice().reverse()) {
      if (!isTrustedRuntimeCompletionLogObject(log, object)) {
        continue;
      }
      const sessionId = runtimeSessionIdFromPayload(object.payload);
      if (sessionId !== undefined && !sessionId.startsWith('gateway-fallback-')) {
        return sessionId;
      }
    }
  }
  return undefined;
}

export function extractRuntimeFallbackSessionId(log: string): string | undefined {
  const fallbackMetadata = extractRuntimeFallbackMetadata(log);
  if (fallbackMetadata === null) {
    return undefined;
  }
  if (fallbackMetadata !== undefined && fallbackMetadata !== null) {
    if (fallbackMetadata.sessionId !== undefined) {
      return fallbackMetadata.sessionId;
    }
    const explicitFallbackMatch = fallbackMetadata.sessionKey?.match(/^agent:[^:]+:explicit:(gateway-fallback-.+)$/);
    if (explicitFallbackMatch != null) {
      return explicitFallbackMatch[1];
    }
  }
  const ignoredRanges = [
    ...parseJsonObjectsFromLogWithPositions(log).map((object) => ({ start: object.index, end: object.end })),
    ...parseJsonStringRangesFromLog(log),
  ];
  let latest: string | undefined;
  for (const match of log.matchAll(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/gi)) {
    const index = match.index ?? 0;
    if (ignoredRanges.some((range) => index >= range.start && index <= range.end)) {
      continue;
    }
    latest = match[1];
  }
  return latest;
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
): Promise<RuntimeSessionResolution> {
  const mapped = await resolveTrajectorySession(task.agentSessionId, options);
  let fallbackSession: RuntimeFallbackMetadata | undefined;
  let fallbackLookupCleared = false;
  let logSessionId: string | undefined;
  for (const logPaths of runtimeTaskLogPathGroups(task)) {
    let groupFallbackSession: RuntimeFallbackMetadata | undefined;
    let groupFallbackCleared = false;
    for (const logPath of logPaths) {
      let log: string;
      try {
        log = await readFile(logPath, 'utf8');
      } catch {
        continue;
      }
      const fallbackMetadata = extractRuntimeFallbackMetadata(log);
      const fallbackSessionId = extractRuntimeSessionId(log);
      logSessionId ??= extractRuntimeNonFallbackSessionId(log);
      if (fallbackMetadata === null) {
        groupFallbackSession = undefined;
        groupFallbackCleared = true;
        continue;
      }
      if (!fallbackLookupCleared && !groupFallbackCleared && groupFallbackSession === undefined) {
        if (fallbackMetadata !== undefined) {
          groupFallbackSession = fallbackMetadata;
        } else if (fallbackSessionId?.startsWith('gateway-fallback-') === true) {
          groupFallbackSession = { sessionId: fallbackSessionId };
        }
      }
    }
    if (groupFallbackSession !== undefined) {
      fallbackSession = groupFallbackSession;
      break;
    }
    if (groupFallbackCleared) {
      fallbackLookupCleared = true;
    }
  }
  if (fallbackSession !== undefined) {
    const fallbackSessionKey = fallbackSession.sessionKey
      ?? `agent:${options.agentId ?? 'main'}:explicit:${fallbackSession.sessionId}`;
    const fallbackMapped = await resolveTrajectorySession(fallbackSessionKey, options);
    return {
      sessionId: fallbackMapped?.sessionId ?? fallbackSession.sessionId ?? fallbackSession.sessionKey,
      sessionFile: fallbackMapped?.sessionFile,
      fallback: true,
    };
  }
  if (mapped !== undefined || logSessionId !== undefined) {
    const sessionId = mapped?.sessionId ?? logSessionId;
    return {
      sessionId,
      sessionFile: sessionId === mapped?.sessionId ? mapped?.sessionFile : undefined,
      fallback: false,
    };
  }
  return { fallback: false };
}

function runtimeTaskLogPaths(task: RuntimeTaskForTimeline): string[] {
  return [...new Set(runtimeTaskLogPathGroups(task).flat())];
}

function runtimeTaskLogPathGroups(task: RuntimeTaskForTimeline): string[][] {
  const pathGroups = [
    ...(task.resumeAttempts ?? []).slice().reverse().map((attempt) => [
      attempt.stderrLogPath ?? stderrLogPathFor(attempt.logPath),
      attempt.logPath,
    ]),
    [
      task.stderrLogPath ?? stderrLogPathFor(task.logPath),
      task.logPath,
    ],
  ];
  return pathGroups.map((paths) => [...new Set(paths)]);
}

function extractRuntimeFallbackMetadata(log: string): RuntimeFallbackMetadata | null | undefined {
  let latest: { index: number; metadata: RuntimeFallbackMetadata | undefined } | undefined;
  const jsonObjects = parseJsonObjectsFromLogWithPositions(log);
  const ignoredRanges = [
    ...jsonObjects.map((object) => ({ start: object.index, end: object.end })),
    ...parseJsonStringRangesFromLog(log),
  ];
  for (const object of jsonObjects) {
    if (!isTrustedRuntimeCompletionLogObject(log, object)) {
      continue;
    }
    const metadata = fallbackMetadataFromPayload(object.payload);
    if (metadata === undefined && !isFallbackClearingRuntimeCompletionPayload(object.payload)) {
      continue;
    }
    if (latest === undefined || object.index > latest.index) {
      latest = { index: object.index, metadata };
    }
  }
  for (const match of log.matchAll(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/gi)) {
    const index = match.index ?? 0;
    if (ignoredRanges.some((range) => index >= range.start && index <= range.end)) {
      continue;
    }
    if (latest === undefined || index > latest.index) {
      latest = { index, metadata: { sessionId: match[1] } };
    }
  }
  return latest === undefined ? undefined : latest.metadata ?? null;
}

async function resolveRuntimeTrajectoryPathForSession(
  session: RuntimeSessionResolution,
  options: RuntimeTimelineReadOptions = {},
): Promise<string> {
  if (session.sessionId === undefined) {
    throw new Error('agent session id was not found in the task log');
  }
  const directPath = session.sessionFile === undefined
    ? runtimeTrajectoryPathForSessionId(session.sessionId, options)
    : runtimeTrajectoryPathForSessionFile(session.sessionFile);
  const pointerPath = directPath.replace(/\.trajectory\.jsonl$/, '.trajectory-path.json');
  try {
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as unknown;
    if (
      isRecord(pointer)
      && pointer.sessionId === session.sessionId
      && typeof pointer.runtimeFile === 'string'
      && pointer.runtimeFile.trim() !== ''
    ) {
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
      text = firstNewline === -1 ? text : text.slice(firstNewline + 1);
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

async function resolveTrajectorySession(
  value: string | undefined,
  options: RuntimeTimelineReadOptions,
): Promise<{ sessionId: string; sessionFile?: string | undefined } | undefined> {
  if (value === undefined) {
    return undefined;
  }
  const mapped = await readMappedRuntimeSession(value, options);
  if (mapped !== undefined) {
    return mapped;
  }
  const runMatch = value.match(/:run:([^:]+)$/);
  if (runMatch !== null) {
    return { sessionId: runMatch[1]! };
  }
  const explicitFallbackMatch = value.match(/:explicit:(gateway-fallback-[A-Za-z0-9._-]+)$/);
  if (explicitFallbackMatch !== null) {
    return { sessionId: explicitFallbackMatch[1]! };
  }
  if (value.includes(':')) {
    return undefined;
  }
  return /^[A-Za-z0-9._-]+$/.test(value) ? { sessionId: value } : undefined;
}

async function readMappedRuntimeSession(
  sessionKey: string,
  options: RuntimeTimelineReadOptions,
): Promise<{ sessionId: string; sessionFile?: string | undefined } | undefined> {
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
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return undefined;
    }
    const sessionFile = entry.sessionFile;
    return typeof sessionFile === 'string' && sessionFile.trim() !== ''
      ? { sessionId, sessionFile: isAbsolute(sessionFile) ? sessionFile : join(runtimeSessionsDirectory(options), sessionFile) }
      : { sessionId };
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
  return redactSensitiveJsonKeyValues(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '[redacted-private-key]')
    .replace(/(^|[\n\r])[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '$1[redacted-private-key]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Authorization:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-authorization]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Set-Cookie:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Cookie:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?[uUE])(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-credential]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?b)(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?[uUE])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-credential]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?b)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-cookie]')
    .replace(/(^|\s)(-[A-WY-Za-wy-z]*?x)(\s+)(?:"[^"\s]*:[^"@\s]+@[^"\s]+"|'[^'\s]*:[^'@\s]+@[^'\s]+'|[^\s'"]*:[^\s'"]+@[^\s'"]+)/g, '$1$2$3[redacted-proxy]')
    .replace(/(^|\s)(-[A-WY-Za-wy-z]*?x)(?:"[^"\s]*:[^"@\s]+@[^"\s]+"|'[^'\s]*:[^'@\s]+@[^'\s]+'|[^\s'"]*:[^\s'"]+@[^\s'"]+)/g, '$1$2[redacted-proxy]')
    .replace(/(^|\s)(-[uUE])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-credential]')
    .replace(/(^|\s)(-b)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-cookie]')
    .replace(/(^|\s)(-x|--proxy|--preproxy|--proxy1\.0)(=|\s+)(?:"[^"\s]*:[^"@\s]+@[^"\s]+"|'[^'\s]*:[^'@\s]+@[^'\s]+'|[^\s'"]*:[^\s'"]+@[^\s'"]+)/g, '$1$2$3[redacted-proxy]')
    .replace(/(^|\s)(-x)(?:"[^"\s]*:[^"@\s]+@[^"\s]+"|'[^'\s]*:[^'@\s]+@[^'\s]+'|[^\s'"]*:[^\s'"]+@[^\s'"]+)/g, '$1$2[redacted-proxy]')
    .replace(/(^|\s)(-u|--user|-U|--proxy-user|--oauth2-bearer|--pass|--proxy-pass|--tlspassword|--proxy-tlspassword|--ftp-account|-E|--cert|--proxy-cert)(=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-credential]')
    .replace(/(^|\s)(-b|--cookie)(=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-cookie]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, '[redacted-token]')
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[redacted-token]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-][A-Za-z0-9._~+/=_-]{5,}/gi, '$1[redacted-bearer]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(Authorization:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+(?:Authorization|Cookie|Set-Cookie):|[\n\r]|$)/gi, '$1[redacted-authorization]')
    .replace(/\b(Set-Cookie:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+(?:Authorization|Cookie|Set-Cookie):|[\n\r]|$)/gi, '$1[redacted-cookie]')
    .replace(/\b(Cookie:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+Set-Cookie:|[\n\r]|$)/gi, '$1[redacted-cookie]')
    .replace(/\b([A-Za-z0-9_-]*(?:api[-_]?key|token|secret)[A-Za-z0-9_-]*:\s*)[\s\S]*?(?=(?:"\s+-H\s+"[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|authorization|cookie):)|\s+[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|authorization|cookie):|[\n\r]|$)/gi, '$1[redacted-header]')
    .replace(/(^|[\n\r])(\s*[A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*[:=]\s*)(?!\[redacted)[^\n\r]*/gi, '$1$2[redacted]')
    .replace(/(^|[\n\r])(\s*[A-Za-z0-9_-]*(?:set[-_]?cookie|cookie)[A-Za-z0-9_-]*\s*[:=]\s*)(?!\[redacted)[^\n\r]*/gi, '$1$2[redacted]')
    .replace(/(^|[\n\r])(\s*[A-Za-z0-9_-]*(?:password|passphrase)[A-Za-z0-9_-]*\s*[:=]\s*)(?!\[redacted)[^\n\r]*/gi, '$1$2[redacted]')
    .replace(/(^|[\n\r])(\s*[A-Za-z0-9_-]*(?:api[-_]?key|token|secret)[A-Za-z0-9_-]*\s*=\s*)(?!\[redacted)[^\n\r]*/gi, '$1$2[redacted]')
    .replace(/(^|[\n\r])(\s*(?:(?:\/\/[^\s:=]+\/)?:)?_auth\s*[:=]\s*)(?!\[redacted)[^\s'",}]+/gi, '$1$2[redacted]')
    .replace(/(^|\s)((?!(?:no_proxy)\b)[A-Za-z0-9_-]*(?:https?|all)_proxy[A-Za-z0-9_-]*\s*[:=]\s*)(?:"[^"\s]*:[^"@\s]+@[^"\s]+"|'[^'\s]*:[^'@\s]+@[^'\s]+'|[^\s'"]*:[^\s'"]+@[^\s'"]+)/gi, '$1$2[redacted-proxy]')
    .replace(/("[^"]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|authorization|set-cookie|cookie)[^"]*"\s*:\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|set-cookie|cookie)[A-Za-z0-9_-]*\s*[:=]\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|set-cookie|cookie)[A-Za-z0-9_-]*\s*[:=]\s*)'(?:(?:\\.)|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)'(?:(?:\\.)|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)(?:Basic|Digest|NTLM|Negotiate|AWS4-HMAC-SHA256|[A-Za-z0-9]+-[A-Za-z0-9-]+)\s+[^\n\r]*/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_-]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|set-cookie|cookie)[A-Za-z0-9_-]*\s*[:=]\s*)(?!\[redacted)[^\s'",}]+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)(?!\[redacted)[^\s'",}]+/gi, '$1[redacted]');
}

function redactSensitiveJsonKeyValues(value: string): string {
  return redactEscapedSensitiveJsonKeyValues(redactUnescapedSensitiveJsonKeyValues(value));
}

function redactUnescapedSensitiveJsonKeyValues(value: string): string {
  const keyPattern = /(?<!\\)"[^"]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|authorization|set-cookie|cookie)[^"]*"\s*:\s*/gi;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex < cursor) {
      continue;
    }
    const valueStart = matchIndex + match[0].length;
    const valueEnd = findJsonValueEnd(value, valueStart);
    redacted += value.slice(cursor, valueStart);
    redacted += '"[redacted]"';
    cursor = valueEnd;
  }
  return cursor === 0 ? value : redacted + value.slice(cursor);
}

function redactEscapedSensitiveJsonKeyValues(value: string): string {
  const keyPattern = /\\"[^"\\]*(?:_auth|token|secret|password|api[_-]?key|private[_-]?key|authorization|set-cookie|cookie)[^"\\]*\\"\s*:\s*/gi;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex < cursor) {
      continue;
    }
    const valueStart = matchIndex + match[0].length;
    const valueEnd = findEscapedJsonValueEnd(value, valueStart);
    redacted += value.slice(cursor, valueStart);
    redacted += '\\"[redacted]\\"';
    cursor = valueEnd;
  }
  return cursor === 0 ? value : redacted + value.slice(cursor);
}

function findEscapedJsonValueEnd(value: string, start: number): number {
  let index = start;
  while (/\s/.test(value[index] ?? '')) {
    index += 1;
  }
  const opener = value[index];
  if (opener === '\\' && value[index + 1] === '"') {
    return findEscapedJsonStringEnd(value, index) ?? value.length;
  }
  if (opener === '[' || opener === '{') {
    return findBalancedEscapedJsonEnd(value, index, opener) ?? value.length;
  }
  while (index < value.length && !/[\s,}\]]/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}

function findEscapedJsonStringEnd(value: string, start: number): number | undefined {
  for (let index = start + 2; index < value.length; index += 1) {
    if (
      value[index] === '\\'
      && value[index + 1] === '"'
      && countConsecutiveBackslashesBefore(value, index + 1) === 1
    ) {
      return index + 2;
    }
  }
  return undefined;
}

function findBalancedEscapedJsonEnd(value: string, start: number, opener: string): number | undefined {
  const stack = [opener === '[' ? ']' : '}'];
  let inString = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (
        char === '\\'
        && value[index + 1] === '"'
        && countConsecutiveBackslashesBefore(value, index + 1) === 1
      ) {
        inString = false;
        index += 1;
      }
      continue;
    }
    if (char === '\\' && value[index + 1] === '"') {
      inString = true;
      index += 1;
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '{') {
      stack.push('}');
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function countConsecutiveBackslashesBefore(value: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    count += 1;
  }
  return count;
}

function findJsonValueEnd(value: string, start: number): number {
  let index = start;
  while (/\s/.test(value[index] ?? '')) {
    index += 1;
  }
  const opener = value[index];
  if (opener === '"') {
    return findJsonStringEnd(value, index) ?? value.length;
  }
  if (opener === '[' || opener === '{') {
    return findBalancedJsonEnd(value, index, opener) ?? value.length;
  }
  while (index < value.length && !/[\s,}\]]/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}

function findJsonStringEnd(value: string, start: number): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return index + 1;
    }
  }
  return undefined;
}

function findBalancedJsonEnd(value: string, start: number, opener: string): number | undefined {
  const closer = opener === '[' ? ']' : '}';
  const stack = [closer];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '{') {
      stack.push('}');
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
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

function runtimeTrajectoryPathForSessionFile(sessionFile: string): string {
  return sessionFile.endsWith('.jsonl')
    ? sessionFile.replace(/\.jsonl$/, '.trajectory.jsonl')
    : `${sessionFile}.trajectory.jsonl`;
}

function stderrLogPathFor(logPath: string): string {
  return logPath.endsWith('.log') ? logPath.replace(/\.log$/, '.stderr.log') : `${logPath}.stderr`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeSessionIdFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  for (const source of [payload, isRecord(payload.result) ? payload.result : undefined]) {
    const sessionId = stringField(
      isRecord(source?.meta) && isRecord(source.meta.agentMeta) ? source.meta.agentMeta : undefined,
      'sessionId',
    );
    if (sessionId !== undefined && sessionId.trim() !== '') {
      return sessionId;
    }
  }
  return undefined;
}

function parseStrictJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(raw) as unknown;
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObjectsFromLog(raw: string): { foundJson: boolean; payloads: unknown[] } {
  const objects = parseJsonObjectsFromLogWithPositions(raw);
  return { foundJson: objects.length > 0, payloads: objects.map((object) => object.payload) };
}

function parseJsonObjectsFromLogWithPositions(raw: string): Array<{ payload: unknown; index: number; end: number }> {
  const strict = parseStrictJsonObject(raw);
  if (strict !== undefined) {
    return [{ payload: strict, index: 0, end: raw.length - 1 }];
  }
  const payloads: Array<{ payload: unknown; index: number; end: number }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '{') {
      continue;
    }
    const end = findJsonObjectEnd(raw, index);
    if (end === undefined) {
      continue;
    }
    try {
      payloads.push({ payload: JSON.parse(raw.slice(index, end + 1)) as unknown, index, end });
      index = end;
    } catch {
      // Logs may contain partial or quoted JSON fragments.
    }
  }
  return payloads;
}

function parseJsonStringRangesFromLog(raw: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') {
      continue;
    }
    let escaped = false;
    for (let end = index + 1; end < raw.length; end += 1) {
      const char = raw[end];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        ranges.push({ start: index, end });
        index = end;
        break;
      }
    }
  }
  return ranges;
}

function payloadHasCompletionText(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  if (typeof payload.finalAssistantVisibleText === 'string' || typeof payload.finalAssistantRawText === 'string') {
    return true;
  }
  if (Array.isArray(payload.payloads) && payload.payloads.some((item) => isRecord(item) && typeof item.text === 'string')) {
    return true;
  }
  return payloadHasCompletionText(payload.result);
}

function isTrustedRuntimeCompletionPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) {
    return false;
  }
  if (
    payloadHasCompletionText(payload)
    || hasRuntimeCompletionObjectSignal(payload.completion)
    || hasRuntimeExecutionTraceSignal(payload.executionTrace)
    || (stringField(payload, 'status') !== undefined && runtimeAgentMetaFromPayload(payload) !== undefined)
  ) {
    return true;
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  return payloadHasCompletionText(result)
    || hasRuntimeCompletionObjectSignal(result?.completion)
    || hasRuntimeExecutionTraceSignal(result?.executionTrace)
    || (stringField(payload, 'status') !== undefined && runtimeAgentMetaFromPayload(result) !== undefined)
    || (stringField(result, 'status') !== undefined && runtimeAgentMetaFromPayload(result) !== undefined);
}

function isTrustedRuntimeCompletionLogObject(
  raw: string,
  object: { payload: unknown; index: number; end: number },
): object is { payload: Record<string, unknown>; index: number; end: number } {
  if (!isRecord(object.payload) || hasDiagnosticPrefixBeforeJsonObject(raw, object.index)) {
    return false;
  }
  return isTrustedRuntimeCompletionPayload(object.payload)
    || isStatusOnlyTerminalCompletionPayload(object.payload);
}

function isStatusOnlyTerminalCompletionPayload(payload: Record<string, unknown>): boolean {
  const status = runtimeCompletionStatusFromPayload(payload);
  return status !== undefined
    && status !== 'queued'
    && status !== 'running'
    && ['succeeded', 'failed', 'canceled', 'stopped', 'timed_out', 'compaction_failed', 'needs_human', 'split_recommended'].includes(status);
}

function isRuntimeInFlightPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  return stringField(payload, 'status') === 'in_flight' || stringField(result, 'status') === 'in_flight';
}

function isFallbackClearingRuntimeCompletionPayload(payload: Record<string, unknown>): boolean {
  const status = runtimeCompletionStatusFromPayload(payload);
  return status !== undefined
    && !['queued', 'running', 'in_flight'].includes(status)
    && !['failed', 'canceled', 'stopped', 'timed_out', 'compaction_failed'].includes(status);
}

function runtimeCompletionStatusFromPayload(payload: Record<string, unknown>): string | undefined {
  const topLevelStatus = stringField(payload, 'status');
  const result = isRecord(payload.result) ? payload.result : undefined;
  const resultStatus = stringField(result, 'status');
  if (topLevelStatus === 'error') {
    return 'failed';
  }
  if (topLevelStatus === 'timeout') {
    return 'timed_out';
  }
  if (isTerminalRuntimeStatus(topLevelStatus)) {
    return topLevelStatus;
  }
  if (topLevelStatus === 'ok' && resultStatus === undefined) {
    return 'succeeded';
  }
  if (topLevelStatus === 'in_flight' && resultStatus === undefined) {
    return 'running';
  }
  if (resultStatus === 'error') {
    return 'failed';
  }
  if (resultStatus === 'timeout') {
    return 'timed_out';
  }
  if (resultStatus === 'in_flight') {
    return 'running';
  }
  if (resultStatus === 'ok') {
    return 'succeeded';
  }
  if (isCanonicalRuntimeStatus(resultStatus)) {
    return resultStatus;
  }
  if (isCanonicalRuntimeStatus(topLevelStatus)) {
    return topLevelStatus;
  }
  if (hasStatuslessSuccessfulCompletion(payload) || hasStatuslessSuccessfulCompletion(result)) {
    return 'succeeded';
  }
  return undefined;
}

function hasStatuslessSuccessfulCompletion(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const executionTrace = isRecord(payload.executionTrace) ? payload.executionTrace : undefined;
  const completion = isRecord(payload.completion) ? payload.completion : undefined;
  return payloadHasCompletionText(payload)
    && stringField(executionTrace, 'result') === 'success'
    && stringField(completion, 'finishReason') === 'stop';
}

function isTerminalRuntimeStatus(status: string | undefined): boolean {
  return status !== 'queued' && status !== 'running' && isCanonicalRuntimeStatus(status);
}

function isCanonicalRuntimeStatus(status: string | undefined): boolean {
  return status === 'queued'
    || status === 'running'
    || status === 'succeeded'
    || status === 'failed'
    || status === 'canceled'
    || status === 'stopped'
    || status === 'timed_out'
    || status === 'compaction_failed'
    || status === 'needs_human'
    || status === 'split_recommended';
}

function hasDiagnosticPrefixBeforeJsonObject(raw: string, index: number): boolean {
  const lineStart = Math.max(raw.lastIndexOf('\n', index - 1), raw.lastIndexOf('\r', index - 1)) + 1;
  const sameLinePrefix = raw.slice(lineStart, index).trim();
  if (/\b(?:diag|diagnostic|quoted|tool result)\b/i.test(sameLinePrefix)) {
    return true;
  }
  const previousText = raw.slice(0, lineStart).trimEnd();
  const previousLineStart = Math.max(previousText.lastIndexOf('\n'), previousText.lastIndexOf('\r')) + 1;
  const previousLine = previousText.slice(previousLineStart).trim();
  return /(?:quoted|diagnostic|tool result)[^{}]*:\s*$/i.test(previousLine);
}

function hasRuntimeCompletionObjectSignal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return stringField(value, 'finishReason') !== undefined
    || stringField(value, 'stopReason') !== undefined;
}

function hasRuntimeExecutionTraceSignal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return stringField(value, 'result') !== undefined
    || stringField(value, 'status') !== undefined;
}

function runtimeAgentMetaFromPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return isRecord(payload?.meta) && isRecord(payload.meta.agentMeta) ? payload.meta.agentMeta : undefined;
}

function fallbackMetadataFromPayload(payload: Record<string, unknown>): RuntimeFallbackMetadata | undefined {
  for (const source of [payload, isRecord(payload.result) ? payload.result : undefined]) {
    const agentMeta = isRecord(source?.meta) && isRecord(source.meta.agentMeta) ? source.meta.agentMeta : undefined;
    const sessionKey = stringField(agentMeta, 'fallbackSessionKey');
    const sessionId = stringField(agentMeta, 'sessionId');
    if ((sessionKey !== undefined && sessionKey.trim() !== '') || sessionId?.startsWith('gateway-fallback-') === true) {
      return {
        sessionKey: sessionKey !== undefined && sessionKey.trim() !== '' ? sessionKey : undefined,
        sessionId: sessionId?.startsWith('gateway-fallback-') === true ? sessionId : undefined,
      };
    }
  }
  return undefined;
}

function findJsonObjectEnd(raw: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}
