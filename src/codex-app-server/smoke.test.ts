import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type CodexAppServerProtocolClient,
  type CodexAppServerThreadStartResponse,
  createCodexAppServerProtocolClient,
  createStdioCodexAppServerTransport,
} from './index.js';

const runSmoke = process.env.RAINRAIL_CODEX_APP_SERVER_SMOKE === '1';

describe.skipIf(!runSmoke)('Codex App Server smoke', () => {
  it('initializes, starts an ephemeral thread, starts a turn, and observes completion', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rainrail-codex-app-server-smoke-'));
    const transport = createStdioCodexAppServerTransport({
      command: process.env.RAINRAIL_CODEX_APP_SERVER_COMMAND ?? 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd,
      inheritEnv: true,
    });
    const client = createCodexAppServerProtocolClient({ transport, requestTimeoutMs: 120_000 });
    try {
      await client.connect();
      const initialized = await client.initialize({
        clientInfo: { name: 'rainrail-smoke', title: 'Rainrail smoke', version: '0.0.0' },
        capabilities: null,
      });
      expect(initialized.userAgent).toContain('rainrail-smoke');

      const thread = await startSmokeThread(client, cwd);
      expect(thread.thread.id).toEqual(expect.any(String));

      const turn = await client.startTurn({
        threadId: thread.thread.id,
        input: [{
          type: 'text',
          text: 'Reply with exactly RAINRAIL_SMOKE_OK and do not run tools.',
          text_elements: [],
        }],
      });
      expect(turn.turn.id).toEqual(expect.any(String));

      const completed = await client.waitForTurnCompleted({
        threadId: thread.thread.id,
        turnId: turn.turn.id,
        timeoutMs: 120_000,
      });

      expect(completed.turn.id).toBe(turn.turn.id);
      expect(completed.turn.status).toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 130_000);
});

async function startSmokeThread(
  client: CodexAppServerProtocolClient,
  cwd: string,
): Promise<CodexAppServerThreadStartResponse> {
  try {
    return await client.startThread({
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
  } catch (error) {
    if (!isCamelCaseSandboxNameError(error)) throw error;
    return client.startThread({
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'readOnly',
    });
  }
}

function isCamelCaseSandboxNameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('unknown variant `read-only`') ||
    error.message.includes('invalid sandbox');
}
