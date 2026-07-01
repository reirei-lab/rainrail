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
    return runtimeSessionIdFromPayload(JSON.parse(log) as unknown);
  } catch {
    const parsed = parseJsonObjectsFromLog(log);
    for (const payload of parsed.payloads.slice().reverse()) {
      const sessionId = runtimeSessionIdFromPayload(payload);
      if (sessionId !== undefined) {
        return sessionId;
      }
    }
    if (parsed.foundJson) {
      return undefined;
    }
  }
  const matches = [...log.matchAll(/"agentMeta"\s*:\s*\{[\s\S]*?"sessionId"\s*:\s*"([^"]+)"/g)];
  return matches.at(-1)?.[1];
}

export function extractRuntimeFallbackSessionId(log: string): string | undefined {
  if (parseStrictJsonObject(log) !== undefined) {
    return undefined;
  }
  const parsed = parseJsonObjectsFromLog(log);
  if (parsed.payloads.some((payload) => payloadHasCompletionText(payload))) {
    return undefined;
  }
  const matches = [...log.matchAll(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/gi)];
  return matches.at(-1)?.[1];
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
  let fallbackSession: { sessionKey: string } | { sessionId: string } | undefined;
  let logSessionId: string | undefined;
  for (const logPath of runtimeTaskLogPaths(task)) {
    let log: string;
    try {
      log = await readFile(logPath, 'utf8');
    } catch {
      continue;
    }
    const fallbackSessionKey = extractRuntimeFallbackSessionKey(log);
    const fallbackSessionId = extractRuntimeFallbackSessionId(log);
    const sessionId = extractRuntimeSessionId(log);
    logSessionId ??= sessionId;
    if (fallbackSession === undefined) {
      if (fallbackSessionKey !== undefined) {
        fallbackSession = { sessionKey: fallbackSessionKey };
      } else if (fallbackSessionId !== undefined) {
        fallbackSession = { sessionId: fallbackSessionId };
      } else if (sessionId?.startsWith('gateway-fallback-') === true) {
        fallbackSession = { sessionId };
      }
    }
  }
  if (fallbackSession !== undefined) {
    const fallbackSessionKey = 'sessionKey' in fallbackSession
      ? fallbackSession.sessionKey
      : `agent:${options.agentId ?? 'main'}:explicit:${fallbackSession.sessionId}`;
    const fallbackMapped = await resolveTrajectorySession(fallbackSessionKey, options);
    return {
      sessionId: fallbackMapped?.sessionId ?? ('sessionId' in fallbackSession ? fallbackSession.sessionId : fallbackSession.sessionKey),
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
  const paths = [
    ...(task.resumeAttempts ?? []).slice().reverse().flatMap((attempt) => [
      attempt.stderrLogPath ?? stderrLogPathFor(attempt.logPath),
      attempt.logPath,
    ]),
    task.stderrLogPath ?? stderrLogPathFor(task.logPath),
    task.logPath,
  ];
  return [...new Set(paths)];
}

function extractRuntimeFallbackSessionKey(log: string): string | undefined {
  const parsed = parseJsonObjectsFromLog(log);
  if (!parsed.foundJson) {
    return undefined;
  }
  for (const payload of parsed.payloads.slice().reverse()) {
    if (!isRecord(payload)) {
      continue;
    }
    for (const source of [payload, isRecord(payload.result) ? payload.result : undefined]) {
      const key = stringField(
        isRecord(source?.meta) && isRecord(source.meta.agentMeta) ? source.meta.agentMeta : undefined,
        'fallbackSessionKey',
      );
      if (key !== undefined && key.trim() !== '') {
        return key;
      }
    }
  }
  return undefined;
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
      ? { sessionId, sessionFile }
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
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Authorization:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-authorization]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Set-Cookie:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-Za-z]*H)(Cookie:\s*)[\s\S]*?(?=(?:\s+-[A-Za-z]*H(?:Authorization|Cookie|Set-Cookie):)|(?:\s+-[A-Za-z])|[\n\r]|$)/gi, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?[uUE])(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-credential]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?b)(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-cookie]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?[uUE])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-credential]')
    .replace(/(^|\s)(-[A-GI-Za-gi-z]*?b)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-cookie]')
    .replace(/(^|\s)(-[uUE])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-credential]')
    .replace(/(^|\s)(-b)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2[redacted-cookie]')
    .replace(/(^|\s)(-u|--user|-U|--proxy-user|--oauth2-bearer|--pass|--proxy-pass|--tlspassword|--proxy-tlspassword|--ftp-account|-E|--cert|--proxy-cert)(=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-credential]')
    .replace(/(^|\s)(-b|--cookie)(=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/g, '$1$2$3[redacted-cookie]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, '[redacted-token]')
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[redacted-token]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-][A-Za-z0-9._~+/=-]{5,}/gi, '$1[redacted-bearer]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(Authorization:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+(?:Authorization|Cookie|Set-Cookie):|[\n\r]|$)/gi, '$1[redacted-authorization]')
    .replace(/\b(Set-Cookie:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+(?:Authorization|Cookie|Set-Cookie):|[\n\r]|$)/gi, '$1[redacted-cookie]')
    .replace(/\b(Cookie:\s*)[\s\S]*?(?=(?:"\s+-H\s+"(?:Authorization|Cookie|Set-Cookie):)|\s+Set-Cookie:|[\n\r]|$)/gi, '$1[redacted-cookie]')
    .replace(/("[^"]*(?:token|secret|password|api[_-]?key|private[_-]?key|authorization|set-cookie|cookie)[^"]*"\s*:\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)"(?:(?:\\.)|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)'(?:(?:\\.)|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)'(?:(?:\\.)|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)[^\s'",}]+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\s*=\s*)[^\s'",}]+/gi, '$1[redacted]');
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
  const strict = parseStrictJsonObject(raw);
  if (strict !== undefined) {
    return { foundJson: true, payloads: [strict] };
  }
  const payloads: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '{') {
      continue;
    }
    const end = findJsonObjectEnd(raw, index);
    if (end === undefined) {
      continue;
    }
    try {
      payloads.push(JSON.parse(raw.slice(index, end + 1)) as unknown);
      index = end;
    } catch {
      // Logs may contain partial or quoted JSON fragments.
    }
  }
  return { foundJson: payloads.length > 0, payloads };
}

function payloadHasCompletionText(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  if (typeof payload.finalAssistantVisibleText === 'string') {
    return true;
  }
  if (Array.isArray(payload.payloads) && payload.payloads.some((item) => isRecord(item) && typeof item.text === 'string')) {
    return true;
  }
  return payloadHasCompletionText(payload.result);
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
