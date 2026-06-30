import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { writeFetchResponse } from './index.js';

describe('HTTP utilities', () => {
  it('waits for Node response drain before reading the next Fetch chunk', async () => {
    const response = new FakeServerResponse();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'));
        controller.enqueue(new TextEncoder().encode('second'));
        controller.close();
      },
    });

    const writing = writeFetchResponse(response as unknown as ServerResponse, new Response(stream));
    await flushMicrotasks();

    expect(response.writes.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['first']);

    response.emit('drain');
    await writing;

    expect(response.writes.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['first', 'second']);
    expect(response.writableEnded).toBe(true);
  });
});

class FakeServerResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: Uint8Array[] = [];

  writeHead(): void {}

  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk);

    return this.writes.length > 1;
  }

  end(): void {
    this.writableEnded = true;
    this.emit('close');
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
