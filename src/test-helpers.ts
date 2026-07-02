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

export type GraphQLRecordedCall = {
  query?: string;
  variables?: Record<string, unknown>;
};

export type GraphQLOperationExpectation = {
  variables?: Record<string, unknown>;
  query?: string | RegExp;
  occurrence?: number;
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

export function expectGraphQLOperation(
  calls: readonly GraphQLRecordedCall[],
  operationName: string,
  expectation: GraphQLOperationExpectation = {},
): GraphQLRecordedCall {
  const occurrence = expectation.occurrence ?? 0;
  const matches = calls.filter((call) => getGraphQLOperationName(call.query) === operationName);
  const call = matches[occurrence];
  if (call === undefined) {
    throw new Error(
      `Expected GraphQL operation "${operationName}" to be recorded.`
        + `\nRecorded operations:\n${formatGraphQLOperations(calls)}`,
    );
  }

  if (expectation.variables !== undefined && !objectContains(call.variables, expectation.variables)) {
    throw new Error(
      `Expected GraphQL operation "${operationName}" variables to include ${formatObserved(expectation.variables)}.`
        + `\nActual variables: ${formatObserved(call.variables)}`
        + `\nRecorded operations:\n${formatGraphQLOperations(calls)}`,
    );
  }

  if (expectation.query !== undefined && !queryMatches(call.query, expectation.query)) {
    throw new Error(
      `Expected GraphQL operation "${operationName}" query to match ${String(expectation.query)}.`
        + `\nActual query: ${formatObserved(call.query)}`
        + `\nRecorded operations:\n${formatGraphQLOperations(calls)}`,
    );
  }

  return call;
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

function getGraphQLOperationName(query: string | undefined): string {
  const match = query?.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/u);
  return match?.[1] ?? '<anonymous>';
}

function formatGraphQLOperations(calls: readonly GraphQLRecordedCall[]): string {
  if (calls.length === 0) return '<none>';

  return calls
    .map((call, index) => `${index}: ${getGraphQLOperationName(call.query)} variables=${formatObserved(call.variables)}`)
    .join('\n');
}

function queryMatches(query: string | undefined, expected: string | RegExp): boolean {
  if (query === undefined) return false;
  return typeof expected === 'string' ? query.includes(expected) : expected.test(query);
}

function objectContains(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((expectedValue, index) => objectContains(actual[index], expectedValue));
  }

  return Object.entries(expected).every(([key, expectedValue]) =>
    objectContains((actual as Record<string, unknown>)[key], expectedValue)
  );
}
