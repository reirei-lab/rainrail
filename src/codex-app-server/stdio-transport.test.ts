import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createStdioCodexAppServerTransport, type SpawnCodexAppServerProcess } from './stdio-transport.js';
import type { CodexAppServerFrame } from './client.js';

class RecordingWritable extends Writable {
  readonly writes: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk.toString('utf8'));
    callback();
  }
}

function createChildProcessFixture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new RecordingWritable();
  const child = new EventEmitter() as EventEmitter & {
    stdin: RecordingWritable;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  const spawnProcess = vi.fn<SpawnCodexAppServerProcess>(() => child);
  return { child, spawnProcess, stdin, stdout, stderr };
}

describe('stdio Codex App Server transport', () => {
  it('spawns the configured command and writes JSON-line framed messages', async () => {
    const { spawnProcess, stdin } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({
      command: 'codex-app-server',
      args: ['--stdio'],
      cwd: '/repo',
      env: { NODE_ENV: 'test' },
      spawnProcess,
    });
    const frame: CodexAppServerFrame = {
      id: 1,
      type: 'request',
      method: 'session.start',
      params: { repository: 'reirei-lab/rainrail' },
    };

    await transport.connect();
    await transport.send(frame);

    expect(spawnProcess).toHaveBeenCalledWith('codex-app-server', ['--stdio'], {
      cwd: '/repo',
      env: { NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(stdin.writes).toEqual([`${JSON.stringify(frame)}\n`]);
  });

  it('parses newline-delimited stdout frames independently of chunk boundaries', async () => {
    const { spawnProcess, stdout } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const frames: CodexAppServerFrame[] = [];

    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();

    stdout.write('{"type":"notification","method":"session.');
    stdout.write('output","params":{"text":"one"}}\n{"id":1,"type":"response","result":');
    stdout.write('{"ok":true}}\n');

    expect(frames).toEqual([
      {
        type: 'notification',
        method: 'session.output',
        params: { text: 'one' },
      },
      {
        id: 1,
        type: 'response',
        result: { ok: true },
      },
    ]);
  });

  it('drains stderr so verbose child logs cannot block protocol responses', async () => {
    const { spawnProcess, stderr } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });

    await transport.connect();
    stderr.write('warning: noisy app server log\n');

    expect(stderr.readableLength).toBe(0);
  });

  it('decodes stdout with streaming UTF-8 state across chunk boundaries', async () => {
    const { spawnProcess, stdout } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const frames: CodexAppServerFrame[] = [];
    const line = Buffer.from('{"type":"notification","method":"session.output","params":{"text":"こんにちは"}}\n');
    const splitInsideMultibyteCharacter = line.indexOf(Buffer.from('ん')) + 1;

    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();
    stdout.write(line.subarray(0, splitInsideMultibyteCharacter));
    stdout.write(line.subarray(splitInsideMultibyteCharacter));

    expect(frames).toEqual([
      {
        type: 'notification',
        method: 'session.output',
        params: { text: 'こんにちは' },
      },
    ]);
  });

  it('emits parse errors without closing the transport or dropping later valid frames', async () => {
    const { spawnProcess, stdout } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const errors: string[] = [];
    const frames: CodexAppServerFrame[] = [];

    transport.onError((error) => errors.push(error.message));
    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();

    stdout.write('{not json}\n');
    stdout.write('{"type":"notification","method":"session.output"}\n');

    expect(errors).toEqual(['Failed to parse Codex App Server stdio frame']);
    expect(frames).toEqual([{ type: 'notification', method: 'session.output' }]);
  });

  it('emits close when the child process exits', async () => {
    const { child, spawnProcess } = createChildProcessFixture();
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const close = vi.fn();

    transport.onClose(close);
    await transport.connect();
    child.emit('exit', 0, null);

    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close a reconnected child when the previous child exits late', async () => {
    const first = createChildProcessFixture();
    const second = createChildProcessFixture();
    const spawnProcess = vi.fn<SpawnCodexAppServerProcess>()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const close = vi.fn();

    transport.onClose(close);
    await transport.connect();
    await transport.close();
    await transport.connect();
    close.mockClear();

    first.child.emit('exit', 0, null);
    await transport.send({ type: 'notification', method: 'session.ping' });

    expect(close).not.toHaveBeenCalled();
    expect(second.stdin.writes).toEqual(['{"type":"notification","method":"session.ping"}\n']);
  });

  it('resets partial stdout framing state before reconnecting', async () => {
    const first = createChildProcessFixture();
    const second = createChildProcessFixture();
    const spawnProcess = vi.fn<SpawnCodexAppServerProcess>()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const transport = createStdioCodexAppServerTransport({ command: 'codex-app-server', spawnProcess });
    const errors: string[] = [];
    const frames: CodexAppServerFrame[] = [];

    transport.onError((error) => errors.push(error.message));
    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();
    first.stdout.write('{"type":"notification","method":"partial"');
    await transport.close();
    await transport.connect();
    second.stdout.write('{"type":"notification","method":"session.output"}\n');

    expect(errors).toEqual([]);
    expect(frames).toEqual([{ type: 'notification', method: 'session.output' }]);
  });
});
