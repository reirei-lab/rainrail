import type { IncomingMessage, ServerResponse } from 'node:http';

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

export function corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: defaultCorsHeaders,
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

export async function readRequestBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
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

export async function writeFetchResponse(response: ServerResponse, fetchResponse: Response): Promise<void> {
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers));

  if (fetchResponse.body === null) {
    response.end();
    return;
  }

  const reader = fetchResponse.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      response.write(value);
    }
  } finally {
    response.end();
    reader.releaseLock();
  }
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
