import { jsonResponse } from './http-utils.js';

export type RainrailEventsAuthFailureReason =
  | 'events_auth_not_configured'
  | 'missing_bearer_token'
  | 'invalid_bearer_token';

export type RainrailEventsAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; reason: RainrailEventsAuthFailureReason };

export function verifyRainrailEventsBearerToken(
  request: Request,
  expectedToken: string | undefined,
): RainrailEventsAuthResult {
  if (expectedToken === undefined || expectedToken.length === 0) {
    return { ok: false, status: 503, reason: 'events_auth_not_configured' };
  }

  const authorization = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return { ok: false, status: 401, reason: 'missing_bearer_token' };
  }

  const token = authorization.slice(prefix.length);
  if (!constantTimeStringEqual(token, expectedToken)) {
    return { ok: false, status: 403, reason: 'invalid_bearer_token' };
  }

  return { ok: true };
}

export function rainrailEventsAuthErrorResponse(result: Exclude<RainrailEventsAuthResult, { ok: true }>): Response {
  return jsonResponse({ error: result.reason }, { status: result.status });
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}
