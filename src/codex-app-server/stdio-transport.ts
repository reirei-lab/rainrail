import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

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
  #stdoutDecoder = new StringDecoder('utf8');
  #frameHandlers: Array<(frame: CodexAppServerFrame) => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #closed = false;
  #connectPromise: Promise<void> | undefined;

  constructor(options: StdioCodexAppServerTransportOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    if (this.#child !== undefined) {
      return;
    }
    this.#connectPromise = this.#connectChild();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async #connectChild(): Promise<void> {
    const spawnProcess = this.#options.spawnProcess ?? defaultSpawnCodexAppServerProcess;
    const spawnOptions: Parameters<SpawnCodexAppServerProcess>[2] = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (this.#options.cwd !== undefined) spawnOptions.cwd = this.#options.cwd;
    if (this.#options.env !== undefined) spawnOptions.env = { ...process.env, ...this.#options.env };

    const child = spawnProcess(this.#options.command, this.#options.args ?? [], spawnOptions);
    this.#child = child;
    this.#closed = false;
    this.#stdoutBuffer = '';
    this.#stdoutDecoder = new StringDecoder('utf8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.#child !== child) return;
      const text = typeof chunk === 'string' ? chunk : this.#stdoutDecoder.write(chunk);
      this.#readStdoutChunk(text);
    });
    child.stdout?.on('end', () => {
      if (this.#child !== child) return;
      this.#readStdoutChunk(this.#stdoutDecoder.end());
    });
    child.stderr?.on('data', () => {
      // Drain stderr so a chatty app server cannot fill the pipe and block stdout responses.
    });
    child.on('error', (error: Error) => {
      if (this.#child === child) this.#emitError(error);
    });
    child.on('exit', () => {
      if (this.#child === child) this.#emitClose();
    });
    child.on('close', () => {
      if (this.#child === child) this.#emitClose();
    });
    try {
      await waitForInitialChildReadiness(child);
    } catch (error) {
      if (this.#child === child) this.#emitClose();
      throw error;
    }
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
    this.#stdoutBuffer = '';
    this.#stdoutDecoder = new StringDecoder('utf8');
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

function waitForInitialChildReadiness(child: StdioCodexAppServerChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const immediate = setImmediate(() => {
      finish(() => resolve());
    });
    const onError = (error: Error) => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `Codex App Server process exited before stdio transport connected (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
      )));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `Codex App Server process closed before stdio transport connected (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
      )));
    };

    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearImmediate(immediate);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('close', onClose);
      callback();
    }
  });
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
