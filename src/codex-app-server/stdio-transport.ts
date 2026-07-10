import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import type { CodexAppServerFrame, CodexAppServerTransport } from './client.js';

export interface StdioCodexAppServerTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  spawnProcess?: SpawnCodexAppServerProcess;
}

export type SpawnCodexAppServerProcess = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => StdioCodexAppServerChildProcess;

export interface StdioCodexAppServerChildProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function createStdioCodexAppServerTransport(
  options: StdioCodexAppServerTransportOptions,
): CodexAppServerTransport {
  return new StdioCodexAppServerTransport(options);
}

class StdioCodexAppServerTransport implements CodexAppServerTransport {
  readonly #options: StdioCodexAppServerTransportOptions;
  #child: StdioCodexAppServerChildProcess | undefined;
  #stdoutBuffer = '';
  #frameHandlers: Array<(frame: CodexAppServerFrame) => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #closed = false;

  constructor(options: StdioCodexAppServerTransportOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#child !== undefined) {
      return;
    }
    const spawnProcess = this.#options.spawnProcess ?? defaultSpawnCodexAppServerProcess;
    const spawnOptions: Parameters<SpawnCodexAppServerProcess>[2] = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (this.#options.cwd !== undefined) spawnOptions.cwd = this.#options.cwd;
    if (this.#options.env !== undefined) spawnOptions.env = this.#options.env;

    const child = spawnProcess(this.#options.command, this.#options.args ?? [], spawnOptions);
    this.#child = child;
    this.#closed = false;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.#readStdoutChunk(chunk.toString());
    });
    child.on('error', (error: Error) => {
      this.#emitError(error);
    });
    child.on('exit', () => {
      this.#emitClose();
    });
    child.on('close', () => {
      this.#emitClose();
    });
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      this.#emitClose();
      return;
    }
    child.kill();
    this.#emitClose();
  }

  async send(frame: CodexAppServerFrame): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin === null) {
      throw new Error('Codex App Server stdio transport is not connected');
    }
    await writeLine(stdin, JSON.stringify(frame));
  }

  onFrame(handler: (frame: CodexAppServerFrame) => void): () => void {
    this.#frameHandlers.push(handler);
    return () => {
      this.#frameHandlers = this.#frameHandlers.filter((registered) => registered !== handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.#errorHandlers.push(handler);
    return () => {
      this.#errorHandlers = this.#errorHandlers.filter((registered) => registered !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.push(handler);
    return () => {
      this.#closeHandlers = this.#closeHandlers.filter((registered) => registered !== handler);
    };
  }

  #readStdoutChunk(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.#stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      this.#parseLine(line);
    }
  }

  #parseLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#emitError(new Error('Failed to parse Codex App Server stdio frame'));
      return;
    }
    if (!isCodexAppServerFrame(parsed)) {
      this.#emitError(new Error('Invalid Codex App Server stdio frame'));
      return;
    }
    for (const handler of this.#frameHandlers) handler(parsed);
  }

  #emitError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }

  #emitClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child = undefined;
    for (const handler of this.#closeHandlers) handler();
  }
}

function defaultSpawnCodexAppServerProcess(
  command: string,
  args: string[],
  options: Parameters<SpawnCodexAppServerProcess>[2],
): StdioCodexAppServerChildProcess {
  return spawn(command, args, options) as StdioCodexAppServerChildProcess;
}

function writeLine(stream: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${line}\n`, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isCodexAppServerFrame(value: unknown): value is CodexAppServerFrame {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'request') {
    return isFrameId(value.id) && typeof value.method === 'string';
  }
  if (value.type === 'response') {
    if (!isFrameId(value.id)) return false;
    if (value.error === undefined) return true;
    return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string';
  }
  if (value.type === 'notification') {
    return typeof value.method === 'string';
  }
  return false;
}

function isFrameId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
