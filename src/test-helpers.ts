export type StreamReadOptions = {
  label?: string;
  timeoutMs?: number;
};

export type ReadUntilOptions = StreamReadOptions & {
  maxChunks?: number;
};

export type WaitForValueOptions = {
  attempts?: number;
  intervalMs?: number;
  label?: string;
};

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export function getReaderOrThrow(
  response: Response,
  options: { label?: string } = {},
): ReadableStreamDefaultReader<Uint8Array> {
  if (response.body === null) {
    throw new Error(`${options.label ?? 'response'} did not include a readable body`);
  }

  return response.body.getReader();
}

export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
  options: ReadUntilOptions = {},
): Promise<string> {
  const decoder = new TextDecoder();
  const maxChunks = options.maxChunks ?? 20;
  const timeoutMs = options.timeoutMs ?? 1_000;
  let text = '';

  for (let index = 0; index < maxChunks; index += 1) {
    const { value, done } = await readStreamChunk(reader, {
      label: `stream chunk containing "${expected}"`,
      timeoutMs,
      bufferedText: text,
    });
    if (done) {
      throw new Error(`Stream ended before seeing "${expected}". Last buffered text: ${formatObserved(text)}`);
    }

    text += decoder.decode(value, { stream: true });
    if (text.includes(expected)) {
      return text;
    }
  }

  throw new Error(
    `Reached ${maxChunks} stream chunk(s) without seeing "${expected}". Last buffered text: ${formatObserved(text)}`,
  );
}

export async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: StreamReadOptions = {},
): Promise<string> {
  const { value, done } = await readStreamChunk(reader, {
    label: options.label ?? 'next stream chunk',
    timeoutMs: options.timeoutMs,
    bufferedText: '',
  });
  if (done) {
    throw new Error('Stream ended before the next chunk was available');
  }

  return new TextDecoder().decode(value);
}

export async function waitForValue<T>(
  read: () => T | Promise<T>,
  expected: T,
  options: WaitForValueOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 5;
  const label = options.label ?? 'value';
  let observed: T | undefined;

  for (let index = 0; index < attempts; index += 1) {
    observed = await read();
    if (Object.is(observed, expected)) return;
    await delay(intervalMs);
  }

  throw new Error(
    `Timed out waiting for ${label} to become ${formatObserved(expected)} after ${attempts} attempt(s). `
      + `Last observed value: ${formatObserved(observed)}`,
  );
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { label: string; timeoutMs: number | undefined; bufferedText: string },
): Promise<StreamReadResult> {
  if (options.timeoutMs === undefined) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        `Timed out after ${options.timeoutMs}ms waiting for ${options.label}. `
          + `Last buffered text: ${formatObserved(options.bufferedText)}`,
      ));
    }, options.timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatObserved(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\n/g, '\\n').slice(0, 500);
  }

  return JSON.stringify(value);
}
