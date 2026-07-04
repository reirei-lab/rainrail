import type { IncomingMessage, ServerResponse } from 'node:http';

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

export const defaultCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID, X-GitHub-Delivery, X-GitHub-Event, X-Hub-Signature-256, X-Rainrail-Publish-Token',
  'Access-Control-Max-Age': '86400',
} as const;

export interface JsonResponseInit extends ResponseInit {
  cors?: boolean;
}

export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: responseHeaders(init.headers, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.cors === false ? {} : defaultCorsHeaders),
    }),
  });
}

export function textResponse(body: string, init: JsonResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: responseHeaders(init.headers, {
      'Content-Type': 'text/plain; charset=utf-8',
      ...(init.cors === false ? {} : defaultCorsHeaders),
    }),
  });
}

export function corsPreflightResponse(allowedMethods?: readonly string[]): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...defaultCorsHeaders,
      ...(allowedMethods === undefined ? {} : {
        'Access-Control-Allow-Methods': allowedMethods.join(', '),
      }),
    },
  });
}

export function methodNotAllowedResponse(allowedMethods: readonly string[]): Response {
  return jsonResponse(
    { error: 'method_not_allowed' },
    {
      status: 405,
      headers: {
        Allow: allowedMethods.join(', '),
      },
    },
  );
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(defaultCorsHeaders)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readRequestBody(request: IncomingMessage, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export async function readFetchRequestBody(request: Request, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES): Promise<ArrayBuffer> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
    throw Object.assign(new Error('request body too large'), { statusCode: 413 });
  }

  if (request.body === null) {
    return new ArrayBuffer(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('request body too large'), { statusCode: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return concatenateChunks(chunks, total);
}

export async function writeFetchResponse(
  response: ServerResponse,
  fetchResponse: Response,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers));

  if (fetchResponse.body === null) {
    response.end();
    return;
  }

  const reader = fetchResponse.body.getReader();
  const cancelReader = (): void => {
    void reader.cancel().catch(() => {
      // The reader may already be closed by normal response completion.
    });
  };

  options.signal?.addEventListener('abort', cancelReader, { once: true });
  response.once('close', cancelReader);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!response.write(value)) {
        await waitForDrain(response, options.signal);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelReader);
    response.off('close', cancelReader);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
    reader.releaseLock();
  }
}

function concatenateChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

function waitForDrain(response: ServerResponse, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted || response.destroyed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };

    response.once('drain', done);
    response.once('close', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function responseHeaders(input: ConstructorParameters<typeof Headers>[0] | undefined, defaults: Record<string, string>): Headers {
  const headers = new Headers(defaults);
  if (input === undefined) return headers;

  const overrides = new Headers(input);
  for (const [key, value] of overrides) {
    headers.set(key, value);
  }

  return headers;
}
