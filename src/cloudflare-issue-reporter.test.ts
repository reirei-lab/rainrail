import { describe, expect, it, vi } from 'vitest';

import {
  createCloudflareIssueReporterWorkflow,
  createEventEnvelope,
  createInMemoryCloudflareErrorIssueStore,
  createStorageCloudflareErrorIssueStore,
  createTaskProviderGitHubIssueClient,
  cloudflareErrorCandidateFromEvent,
  cloudflareErrorFingerprint,
  type CloudflareIssueReporterResult,
  type CloudflareIssueReporterStorage,
  type GitHubIssueClient,
} from './index.js';

describe('cloudflare issue reporter workflow', () => {
  it('creates an issue for the first Cloudflare error fingerprint', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const createdIssues: Array<{ title: string; body: string; labels: string[] }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      labels: ['automated-error'],
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 123,
            url: 'https://github.com/reirei-lab/rainrail/issues/123',
          };
        },
      },
    });

    const result = await workflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;

    expect(result).toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
      issue: {
        created: true,
        number: 123,
        repository: 'reirei-lab/rainrail',
      },
    });
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]?.title).toBe('[asme-site] TypeError in resolveCurrentHumanAccount');
    expect(createdIssues[0]?.labels).toEqual(['automated-error']);
    expect(createdIssues[0]?.body).toContain('## Raw Event Data');
    expect(createdIssues[0]?.body).toContain('resolveCurrentHumanAccount @ worker.js');
    expect(createdIssues[0]?.body).toContain('<!-- error-fingerprint: sha256:');
    expect(createdIssues[0]?.body).toContain('"authorization": "[redacted]"');
    expect(createdIssues[0]?.body).not.toContain('secret-token');
    expect(createdIssues[0]?.body).not.toContain('reset=secret-reset-code');
    expect(result.fingerprint === undefined ? undefined : store.get({
      repository: 'reirei-lab/rainrail',
      fingerprint: result.fingerprint,
    })).toMatchObject({
      issueNumber: 123,
      issueUrl: 'https://github.com/reirei-lab/rainrail/issues/123',
    });
  });

  it('deduplicates repeat events by stored stack fingerprint', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const createIssue = vi.fn(async () => ({
      number: 123,
      url: 'https://github.com/reirei-lab/rainrail/issues/123',
    }));
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue,
      },
    });

    const first = await workflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;
    const second = await workflow.handle(cloudflareErrorEvent({
      id: 'event-2',
      deliveryId: 'tail-asme-site-2',
      url: 'https://asme.dev/api/identities/abc',
    }), runtimeContext()) as CloudflareIssueReporterResult;

    expect(first.handled).toBe(true);
    expect(second).toMatchObject({
      handled: false,
      reason: 'cloudflare_error_issue_exists_in_store',
      issue: {
        number: 123,
        created: false,
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it('creates a fresh issue when a stored fingerprint no longer has an open GitHub issue', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const firstWorkflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async () => ({
          number: 123,
          url: 'https://github.com/reirei-lab/rainrail/issues/123',
        }),
      },
    });
    const first = await firstWorkflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;
    if (first.fingerprint !== undefined && first.issue !== undefined) {
      store.record({
        fingerprint: first.fingerprint,
        eventId: 'old-event',
        deliveryId: 'old-delivery',
        repository: 'reirei-lab/rainrail',
        issueNumber: first.issue.number,
        issueUrl: first.issue.url,
        title: first.issue.title,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const createIssue = vi.fn(async () => ({
      number: 124,
      url: 'https://github.com/reirei-lab/rainrail/issues/124',
    }));
    const secondWorkflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue,
      },
    });

    const second = await secondWorkflow.handle(cloudflareErrorEvent({
      id: 'event-after-close',
      deliveryId: 'tail-asme-site-after-close',
    }), runtimeContext()) as CloudflareIssueReporterResult;

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(second).toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
      issue: {
        number: 124,
        created: true,
      },
    });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(first.fingerprint === undefined ? undefined : store.get({
      repository: 'reirei-lab/rainrail',
      fingerprint: first.fingerprint,
    })).toMatchObject({
      issueNumber: 124,
    });
  });

  it('does not let recent store hits suppress another repository', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const firstWorkflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async () => ({
          number: 123,
          url: 'https://github.com/reirei-lab/rainrail/issues/123',
        }),
      },
    });
    const otherRepositoryCreateIssue = vi.fn(async () => ({
      number: 456,
      url: 'https://github.com/reirei-lab/other/issues/456',
    }));
    const otherRepositoryWorkflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/other',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: otherRepositoryCreateIssue,
      },
    });

    const first = await firstWorkflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;
    const second = await otherRepositoryWorkflow.handle(cloudflareErrorEvent({
      id: 'event-other-repository',
      deliveryId: 'tail-other-repository',
    }), runtimeContext()) as CloudflareIssueReporterResult;

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(second).toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
      issue: {
        repository: 'reirei-lab/other',
        number: 456,
      },
    });
    expect(otherRepositoryCreateIssue).toHaveBeenCalledOnce();
  });

  it('keeps a stored fingerprint quiet when the GitHub issue is still open', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const firstWorkflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async () => ({
          number: 123,
          url: 'https://github.com/reirei-lab/rainrail/issues/123',
        }),
      },
    });
    await firstWorkflow.handle(cloudflareErrorEvent(), runtimeContext());
    const createIssue = vi.fn(async () => {
      throw new Error('not used');
    });
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => ({
          number: 123,
          url: 'https://github.com/reirei-lab/rainrail/issues/123',
        }),
        createIssue,
      },
    });

    const result = await workflow.handle(cloudflareErrorEvent({
      id: 'event-open-duplicate',
      deliveryId: 'tail-asme-site-open-duplicate',
    }), runtimeContext()) as CloudflareIssueReporterResult;

    expect(result).toMatchObject({
      handled: false,
      reason: 'cloudflare_error_issue_exists_in_store',
      issue: {
        number: 123,
        created: false,
      },
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('serializes concurrent creation for the same fingerprint', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    let createCount = 0;
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async () => {
          createCount += 1;
          await delay(5);
          return {
            number: 123,
            url: 'https://github.com/reirei-lab/rainrail/issues/123',
          };
        },
      },
    });

    const [first, second] = await Promise.all([
      workflow.handle(cloudflareErrorEvent({ id: 'event-concurrent-1', deliveryId: 'tail-concurrent-1' }), runtimeContext()),
      workflow.handle(cloudflareErrorEvent({ id: 'event-concurrent-2', deliveryId: 'tail-concurrent-2' }), runtimeContext()),
    ]) as [CloudflareIssueReporterResult, CloudflareIssueReporterResult];

    expect(createCount).toBe(1);
    expect([first.reason, second.reason]).toContain('created_cloudflare_error_issue');
    expect([first.reason, second.reason]).toContain('cloudflare_error_issue_exists_in_store');
  });

  it('uses an existing GitHub issue marker before creating a duplicate', async () => {
    const store = createInMemoryCloudflareErrorIssueStore();
    const createIssue = vi.fn(async () => {
      throw new Error('not used');
    });
    const issues: GitHubIssueClient = {
      findOpenIssueByFingerprint: async (input) => {
        expect(input.fingerprint).toMatch(/^sha256:/u);
        return {
          number: 99,
          url: 'https://github.com/reirei-lab/rainrail/issues/99',
        };
      },
      createIssue,
    };
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues,
    });

    const result = await workflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;

    expect(result).toMatchObject({
      handled: false,
      reason: 'cloudflare_error_issue_exists_on_github',
      issue: {
        number: 99,
        created: false,
      },
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('can use Rainrail storage and the generic task provider for duplicate detection and issue creation', async () => {
    const values = new Map<string, unknown>();
    const store = createStorageCloudflareErrorIssueStore({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value);
      },
      compareAndSet: async (key, expected, value) => {
        if (!Object.is(values.get(key), expected)) return false;
        values.set(key, value);
        return true;
      },
    });
    const searchIssues = vi.fn(async () => []);
    const createIssue = vi.fn(async () => ({
      id: 'issue-node-id',
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      number: 124,
      title: 'Created issue',
      url: 'https://github.com/reirei-lab/rainrail/issues/124',
    }));
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store,
      issues: createTaskProviderGitHubIssueClient({
        name: 'github',
        kind: 'task-provider',
        getIssue: async () => {
          throw new Error('not used');
        },
        createComment: async () => {
          throw new Error('not used');
        },
        searchIssues,
        createIssue,
      }),
    });

    const result = await workflow.handle(cloudflareErrorEvent(), runtimeContext()) as CloudflareIssueReporterResult;

    expect(result).toMatchObject({
      handled: true,
      issue: {
        number: 124,
      },
    });
    expect(searchIssues).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      state: 'open',
      query: expect.stringContaining('in:body'),
    }));
    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
    }));
    expect([...values.keys()].find((key) => !key.includes(':lock:'))).toMatch(/^rainrail:cloudflare-error-issue:reirei-lab\/rainrail:sha256:/u);
  });

  it('keeps fingerprint locks in the storage-backed store', async () => {
    const values = new Map<string, unknown>();
    const lockKey = 'rainrail:cloudflare-error-issue:lock:reirei-lab/rainrail:sha256:storage-lock';
    const store = createStorageCloudflareErrorIssueStore({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value);
      },
      compareAndSet: async (key, expected, value) => {
        if (!Object.is(values.get(key), expected)) return false;
        values.set(key, value);
        return true;
      },
    });

    values.set(lockKey, { owner: 'other-runner', expiresAt: Date.now() + 60_000 });
    await expect(store.withFingerprintLock?.({
      repository: 'reirei-lab/rainrail',
      fingerprint: 'sha256:storage-lock',
    }, async () => 'locked')).rejects.toThrow('already locked');

    values.set(lockKey, { owner: 'expired-runner', expiresAt: 0 });
    await expect(store.withFingerprintLock?.({
      repository: 'reirei-lab/rainrail',
      fingerprint: 'sha256:storage-lock',
    }, async () => 'released')).resolves.toBe('released');
  });

  it('does not enter a storage fingerprint lock when atomic reservation loses the race', async () => {
    const values = new Map<string, unknown>();
    const lockKey = 'rainrail:cloudflare-error-issue:lock:reirei-lab/rainrail:sha256:storage-lock-race';
    const store = createStorageCloudflareErrorIssueStore({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value);
      },
      compareAndSet: async (key, expected, value) => {
        if (key === lockKey && expected === undefined) {
          values.set(key, { owner: 'other-runner', expiresAt: Date.now() + 60_000 });
          return false;
        }
        if (!Object.is(values.get(key), expected)) return false;
        values.set(key, value);
        return true;
      },
    });
    const criticalSection = vi.fn(async () => 'locked');

    await expect(store.withFingerprintLock?.({
      repository: 'reirei-lab/rainrail',
      fingerprint: 'sha256:storage-lock-race',
    }, criticalSection)).rejects.toThrow('already locked');

    expect(criticalSection).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer storage fingerprint lock while releasing', async () => {
    const values = new Map<string, unknown>();
    const lockKey = 'rainrail:cloudflare-error-issue:lock:reirei-lab/rainrail:sha256:storage-lock-release-race';
    const store = createStorageCloudflareErrorIssueStore({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        if (key === lockKey && isLockReleaseValue(value)) {
          values.set(key, { owner: 'new-runner', expiresAt: Date.now() + 60_000 });
        }
        values.set(key, value);
      },
      compareAndSet: async (key, expected, value) => {
        if (key === lockKey && isLockReleaseValue(value)) {
          values.set(key, { owner: 'new-runner', expiresAt: Date.now() + 60_000 });
          return false;
        }
        if (!Object.is(values.get(key), expected)) return false;
        values.set(key, value);
        return true;
      },
    });

    await expect(store.withFingerprintLock?.({
      repository: 'reirei-lab/rainrail',
      fingerprint: 'sha256:storage-lock-release-race',
    }, async () => 'locked')).resolves.toBe('locked');

    expect(values.get(lockKey)).toMatchObject({
      owner: 'new-runner',
    });
  });

  it('uses the first exception with a usable stack', () => {
    const candidate = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      leadingStacklessException: true,
    }));

    expect(candidate).toMatchObject({
      exceptionName: 'TypeError',
      stackSignature: ['resolveCurrentHumanAccount @ worker.js', 'handleCurrentHuman @ worker.js', 'Object.fetch @ worker.js'],
    });
  });

  it('skips exceptions whose stack has no usable frames', () => {
    const candidate = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      exceptions: [
        {
          name: 'WrapperError',
          message: 'wrapper stack without frames',
          stack: [
            'WrapperError: wrapper stack without frames',
            'Caused by: TypeError: hidden',
          ].join('\n'),
        },
        {
          name: 'TypeError',
          message: 'usable stack',
          stack: [
            'TypeError: usable stack',
            '    at usableFrame (worker.js:12:34)',
          ].join('\n'),
        },
      ],
    }));

    expect(candidate).toMatchObject({
      exceptionName: 'TypeError',
      stackSignature: ['usableFrame @ worker.js'],
    });
  });

  it('requires compare-and-set storage for storage-backed fingerprint locks at construction time', () => {
    const storage = {
      get: async (_key: string) => undefined,
      put: async (_key: string, _value: unknown) => undefined,
    };

    expect(() =>
      createStorageCloudflareErrorIssueStore(storage as unknown as CloudflareIssueReporterStorage)
    ).toThrow('compareAndSet');
  });

  it('requires compare-and-set storage to expose a function', () => {
    const storage = {
      get: async (_key: string) => undefined,
      put: async (_key: string, _value: unknown) => undefined,
      compareAndSet: true,
    };

    expect(() =>
      createStorageCloudflareErrorIssueStore(storage as unknown as CloudflareIssueReporterStorage)
    ).toThrow('compareAndSet');
  });

  it('accepts storage-backed fingerprint stores with explicit compare-and-set storage', () => {
    const storage: CloudflareIssueReporterStorage = {
      get: async (_key) => undefined,
      put: async (_key, _value) => undefined,
      compareAndSet: async (_key, _expected, _value) => true,
    };

    expect(createStorageCloudflareErrorIssueStore(storage).withFingerprintLock).toBeDefined();
  });
});

describe('cloudflareErrorFingerprint', () => {
  it('ignores path changes and line number changes for the same stack', () => {
    const first = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      url: 'https://asme.dev/me',
      line: 12,
      column: 34,
    }));
    const second = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      url: 'https://asme.dev/identities/01J0ABCDEFG',
      line: 88,
      column: 99,
    }));

    expect(first).not.toBeUndefined();
    expect(second).not.toBeUndefined();
    expect(cloudflareErrorFingerprint(first!)).toBe(cloudflareErrorFingerprint(second!));
  });

  it('ignores dynamic exception messages for the same stack', () => {
    const first = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      message: 'failed for user alice@example.com and slug lunch-menu-alpha',
    }));
    const second = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      message: 'failed for user bob@example.com and slug dinner-menu-beta',
    }));

    expect(first).not.toBeUndefined();
    expect(second).not.toBeUndefined();
    expect(cloudflareErrorFingerprint(first!)).toBe(cloudflareErrorFingerprint(second!));
  });
});

function cloudflareErrorEvent(overrides: {
  id?: string;
  deliveryId?: string;
  url?: string;
  line?: number;
  column?: number;
  scriptName?: string;
  exceptionName?: string;
  message?: string;
  stack?: string;
  rawData?: Record<string, unknown>;
  exceptions?: Array<Record<string, unknown>>;
  leadingStacklessException?: boolean;
} = {}) {
  const line = overrides.line ?? 1510;
  const column = overrides.column ?? 24;
  const deliveryId = overrides.deliveryId ?? 'tail-asme-site-1';

  return createEventEnvelope({
    id: overrides.id ?? `cloudflare-tail:${deliveryId}:cloudflare.error`,
    source: { type: 'cloudflare', name: 'cloudflare-tail' },
    name: 'cloudflare.error',
    delivery: {
      id: deliveryId,
      receivedAt: '2026-06-15T09:00:00.000Z',
    },
    occurredAt: '2026-06-15T09:00:00.000Z',
    subject: { type: 'worker', id: 'asme-site' },
    payload: {
      action: 'exception',
      status: '500',
      conclusion: 'failure',
      scriptName: overrides.scriptName ?? 'asme-site',
      method: 'GET',
      url: overrides.url ?? 'https://asme.dev/me?debug=1',
      exceptions: overrides.exceptions ?? [
        ...(overrides.leadingStacklessException ? [{
          name: 'Error',
          message: 'wrapper without stack',
        }] : []),
        {
          name: overrides.exceptionName ?? 'TypeError',
          message: overrides.message ?? "Cannot read properties of null (reading 'toAuth') reset=secret-reset-code",
          stack: overrides.stack ?? [
            "TypeError: Cannot read properties of null (reading 'toAuth')",
            `    at resolveCurrentHumanAccount (worker.js:${line}:${column})`,
            '    at handleCurrentHuman (worker.js:1377:18)',
            '    at Object.fetch (worker.js:483:14)',
          ].join('\n'),
        },
      ],
      event: {
        request: {
          method: 'GET',
          url: overrides.url ?? 'https://asme.dev/me?token=secret-token&debug=1',
          headers: {
            authorization: 'Bearer secret',
          },
        },
        response: {
          status: 500,
        },
      },
      ...(overrides.rawData ?? {}),
    },
    rawPayload: {
      kind: 'external-reference',
      reference: `cloudflare://deliveries/${deliveryId}`,
    },
  });
}

describe('cloudflare issue redaction', () => {
  it('redacts path secrets and malformed URL fragments without recursion', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 125,
            url: 'https://github.com/reirei-lab/rainrail/issues/125',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      url: 'https://asme.dev/reset/secret-reset-token/magic-link/secret-code?token=secret-token',
      message: 'bad url https://% reset=secret-reset-code',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('secret-reset-token');
    expect(createdIssues[0]?.body).not.toContain('secret-code');
    expect(createdIssues[0]?.body).not.toContain('secret-token');
    expect(createdIssues[0]?.body).not.toContain('https://%');
    expect(createdIssues[0]?.body).toContain('[redacted-url]');
  });

  it('redacts bearer tokens case-insensitively', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 126,
            url: 'https://github.com/reirei-lab/rainrail/issues/126',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'authorization: bearer lowercase-secret-token',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('lowercase-secret-token');
    expect(createdIssues[0]?.body).toContain('authorization: [redacted]');
  });

  it('redacts underscore-prefixed secret parameters in exception strings', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 127,
            url: 'https://github.com/reirei-lab/rainrail/issues/127',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'oauth failed access_token=access-secret refresh_token=refresh-secret client_secret=client-secret',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('access-secret');
    expect(createdIssues[0]?.body).not.toContain('refresh-secret');
    expect(createdIssues[0]?.body).not.toContain('client-secret');
    expect(createdIssues[0]?.body).toContain('access_token=[redacted]');
    expect(createdIssues[0]?.body).toContain('refresh_token=[redacted]');
    expect(createdIssues[0]?.body).toContain('client_secret=[redacted]');
  });

  it('redacts secret URL locations in the stack signature', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 128,
            url: 'https://github.com/reirei-lab/rainrail/issues/128',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      stack: [
        'TypeError: failed',
        '    at resetHandler (https://user:password@worker.example/reset/secret-reset-token/worker.js:1:1)',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('user:password');
    expect(createdIssues[0]?.body).not.toContain('secret-reset-token');
    expect(createdIssues[0]?.body).toContain('resetHandler @ https://worker.example/[redacted]/[redacted]/worker.js');
  });

  it('redacts plain path stack locations in signatures and raw data', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 129,
            url: 'https://github.com/reirei-lab/rainrail/issues/129',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      stack: [
        'TypeError: failed',
        '    at resetHandler (/reset/secret-reset-token/worker.js:1:1)',
        '    at sessionHandler (file:///auth/session/secret-session-id/worker.js:2:1)',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('secret-reset-token');
    expect(createdIssues[0]?.body).not.toContain('secret-session-id');
    expect(createdIssues[0]?.body).toContain('resetHandler @ /[redacted]/[redacted]/worker.js');
    expect(createdIssues[0]?.body).toContain('sessionHandler @ file:///auth/[redacted]/[redacted]/worker.js');
  });

  it('redacts JSON-shaped secret values embedded in exception strings', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 129,
            url: 'https://github.com/reirei-lab/rainrail/issues/129',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'serialized input {"password":"json-secret","access_token":"oauth-secret","api_key":"key-secret","tokens":["array-secret"],"apiKeys":["camel-secret"]} passwords: "plural-secret"',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('json-secret');
    expect(createdIssues[0]?.body).not.toContain('oauth-secret');
    expect(createdIssues[0]?.body).not.toContain('key-secret');
    expect(createdIssues[0]?.body).not.toContain('array-secret');
    expect(createdIssues[0]?.body).not.toContain('camel-secret');
    expect(createdIssues[0]?.body).not.toContain('plural-secret');
    expect(createdIssues[0]?.body).toContain('\\"password\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"access_token\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"api_key\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"tokens\\":[redacted]');
    expect(createdIssues[0]?.body).toContain('\\"apiKeys\\":[redacted]');
    expect(createdIssues[0]?.body).toContain('passwords: \\"[redacted]\\"');
  });

  it('redacts structured code keys and escaped quoted secret strings', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 130,
            url: 'https://github.com/reirei-lab/rainrail/issues/130',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'serialized input {"password":"abc\\"def","verification_code":"verify-secret"} resetCode: "reset-secret" verification: 123456 verification=verify-scalar-secret',
      rawData: {
        code: 'plain-code-secret',
        resetCode: 'reset-code-secret',
        verification_code: 'verification-code-secret',
      },
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('abc');
    expect(createdIssues[0]?.body).not.toContain('def');
    expect(createdIssues[0]?.body).not.toContain('verify-secret');
    expect(createdIssues[0]?.body).not.toContain('reset-secret');
    expect(createdIssues[0]?.body).not.toContain('123456');
    expect(createdIssues[0]?.body).not.toContain('verify-scalar-secret');
    expect(createdIssues[0]?.body).not.toContain('plain-code-secret');
    expect(createdIssues[0]?.body).not.toContain('reset-code-secret');
    expect(createdIssues[0]?.body).not.toContain('verification-code-secret');
    expect(createdIssues[0]?.body).toContain('\\"password\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('"code": "[redacted]"');
    expect(createdIssues[0]?.body).toContain('"resetCode": "[redacted]"');
    expect(createdIssues[0]?.body).toContain('"verification_code": "[redacted]"');
  });

  it('redacts serialized secret key fragments, arrays, and cookie chains', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 132,
            url: 'https://github.com/reirei-lab/rainrail/issues/132',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: [
        'serialized {"apiKeyValue":"api-key-value-secret","auth.token":"dot-token-secret","tokens":["abc]def"],"password.hash":"dot-hash-secret","password_hash":"hash-secret","token":{"meta":{},"value":"nested-object-secret"}}',
        'tokens=["kv-array-secret-1","kv-array-secret-2"] passwords=[kv-password-1,kv-password-2] token="quoted-token-secret" password=\'quoted-password-secret\' token = "spaced-token-secret" password = spaced-password-secret DATABASE_URL=postgres://app:db-pass@db/prod REDIS_URL=redis://:redis-pass@cache/0 CACHE_URL=redis://redis-user-token@cache/0',
        'secretValue=secret-value-secret session=session-secret sessionId=session-id-secret {token=brace-token-secret} details=[token=bracket-token-secret] (sessionId=paren-session-secret)',
        'details=[token={"a":"bracket-structured-secret"}] (sessionId={"x":"paren-structured-secret"})',
        'cookie=session=session-secret; csrf=csrf-secret',
      ].join(' '),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('api-key-value-secret');
    expect(createdIssues[0]?.body).not.toContain('dot-token-secret');
    expect(createdIssues[0]?.body).not.toContain('abc');
    expect(createdIssues[0]?.body).not.toContain('def');
    expect(createdIssues[0]?.body).not.toContain('dot-hash-secret');
    expect(createdIssues[0]?.body).not.toContain('hash-secret');
    expect(createdIssues[0]?.body).not.toContain('nested-object-secret');
    expect(createdIssues[0]?.body).not.toContain('kv-array-secret-1');
    expect(createdIssues[0]?.body).not.toContain('kv-array-secret-2');
    expect(createdIssues[0]?.body).not.toContain('kv-password-1');
    expect(createdIssues[0]?.body).not.toContain('kv-password-2');
    expect(createdIssues[0]?.body).not.toContain('quoted-token-secret');
    expect(createdIssues[0]?.body).not.toContain('quoted-password-secret');
    expect(createdIssues[0]?.body).not.toContain('spaced-token-secret');
    expect(createdIssues[0]?.body).not.toContain('spaced-password-secret');
    expect(createdIssues[0]?.body).not.toContain('db-pass');
    expect(createdIssues[0]?.body).not.toContain('redis-pass');
    expect(createdIssues[0]?.body).not.toContain('redis-user-token');
    expect(createdIssues[0]?.body).not.toContain('secret-value-secret');
    expect(createdIssues[0]?.body).not.toContain('session-id-secret');
    expect(createdIssues[0]?.body).not.toContain('session-secret');
    expect(createdIssues[0]?.body).not.toContain('brace-token-secret');
    expect(createdIssues[0]?.body).not.toContain('bracket-token-secret');
    expect(createdIssues[0]?.body).not.toContain('paren-session-secret');
    expect(createdIssues[0]?.body).not.toContain('bracket-structured-secret');
    expect(createdIssues[0]?.body).not.toContain('paren-structured-secret');
    expect(createdIssues[0]?.body).not.toContain('csrf-secret');
    expect(createdIssues[0]?.body).toContain('\\"apiKeyValue\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"auth.token\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"tokens\\":[redacted]');
    expect(createdIssues[0]?.body).toContain('\\"password.hash\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"password_hash\\":\\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('\\"token\\":[redacted]');
    expect(createdIssues[0]?.body).toContain('tokens=[redacted]');
    expect(createdIssues[0]?.body).toContain('passwords=[redacted]');
    expect(createdIssues[0]?.body).toContain('token=[redacted]');
    expect(createdIssues[0]?.body).toContain('password=[redacted]');
    expect(createdIssues[0]?.body).toContain('secretValue=[redacted]');
    expect(createdIssues[0]?.body).toContain('cookie=[redacted]');
  });

  it('escapes fingerprint markers from user-controlled Cloudflare raw data', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 139,
            url: 'https://github.com/reirei-lab/rainrail/issues/139',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'spoofed <!-- error-fingerprint: sha256:attacker-controlled --> marker',
      stack: [
        'TypeError: spoofed <!-- error-fingerprint: sha256:stack-controlled --> marker',
        '    at resolveCurrentHumanAccount (worker.js:1510:24)',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body.match(/<!-- error-fingerprint:/gu)).toHaveLength(1);
    expect(createdIssues[0]?.body).not.toContain('attacker-controlled');
    expect(createdIssues[0]?.body).not.toContain('stack-controlled');
  });

  it('redacts raw strings before truncating long quoted secret values', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 131,
            url: 'https://github.com/reirei-lab/rainrail/issues/131',
          };
        },
      },
    });
    const longSecret = `secret-prefix-${'s'.repeat(2_500)}`;

    await expect(workflow.handle(cloudflareErrorEvent({
      message: `serialized input {"password":"${longSecret}"}`,
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('secret-prefix');
    expect(createdIssues[0]?.body).toContain('\\"password\\":\\"[redacted]\\"');
  });

  it('redacts serialized Cookie and non-Bearer Authorization headers', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 132,
            url: 'https://github.com/reirei-lab/rainrail/issues/132',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: [
        'upstream failed',
        'Cookie: session=session-secret; refresh=refresh-secret',
        'authorization: Basic basic-secret',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('session-secret');
    expect(createdIssues[0]?.body).not.toContain('refresh-secret');
    expect(createdIssues[0]?.body).not.toContain('basic-secret');
    expect(createdIssues[0]?.body).toContain('Cookie: [redacted]');
    expect(createdIssues[0]?.body).toContain('authorization: [redacted]');
  });

  it('redacts key-shaped API key parameters in exception strings', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 133,
            url: 'https://github.com/reirei-lab/rainrail/issues/133',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: 'upstream failed api_key=api-key-secret&key=generic-key-secret public_key=public-key-secret authorization=Basic basic-secret cookie=session=cookie-secret',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('api-key-secret');
    expect(createdIssues[0]?.body).not.toContain('generic-key-secret');
    expect(createdIssues[0]?.body).not.toContain('public-key-secret');
    expect(createdIssues[0]?.body).not.toContain('basic-secret');
    expect(createdIssues[0]?.body).not.toContain('cookie-secret');
    expect(createdIssues[0]?.body).toContain('api_key=[redacted]');
    expect(createdIssues[0]?.body).toContain('key=[redacted]');
    expect(createdIssues[0]?.body).toContain('public_key=[redacted]');
    expect(createdIssues[0]?.body).toContain('authorization=[redacted]');
    expect(createdIssues[0]?.body).toContain('cookie=[redacted]');
  });

  it('redacts colon-separated secret scalars in exception strings', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 134,
            url: 'https://github.com/reirei-lab/rainrail/issues/134',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: [
        'serialized input {"code":123456,"password":plain-secret}',
        'x-api-key: header-key-secret',
        'password: header-password-secret',
        'password: "quoted-password-secret"',
        'x-api-key: "quoted-key-secret"',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('123456');
    expect(createdIssues[0]?.body).not.toContain('plain-secret');
    expect(createdIssues[0]?.body).not.toContain('header-key-secret');
    expect(createdIssues[0]?.body).not.toContain('header-password-secret');
    expect(createdIssues[0]?.body).not.toContain('quoted-password-secret');
    expect(createdIssues[0]?.body).not.toContain('quoted-key-secret');
    expect(createdIssues[0]?.body).toContain('x-api-key: [redacted]');
    expect(createdIssues[0]?.body).toContain('password: [redacted]');
    expect(createdIssues[0]?.body).toContain('password: \\"[redacted]\\"');
    expect(createdIssues[0]?.body).toContain('x-api-key: \\"[redacted]\\"');
  });

  it('uses only stack frames for the stack signature', async () => {
    const first = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: [
        'HttpException: user alice failed',
        '    at handler (worker.js:10:1)',
      ].join('\n'),
    }));
    const second = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: [
        'HttpException: user bob failed',
        '    at handler (worker.js:10:1)',
      ].join('\n'),
    }));

    expect(first?.stackSignature).toEqual(['handler @ worker.js']);
    expect(second?.stackSignature).toEqual(['handler @ worker.js']);
    expect(cloudflareErrorFingerprint(first!)).toBe(cloudflareErrorFingerprint(second!));
  });

  it('ignores dynamic exception names for the same stack fingerprint', () => {
    const first = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      exceptionName: 'ApiError user alice',
    }));
    const second = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      exceptionName: 'ApiError access_token=name-secret',
    }));

    expect(cloudflareErrorFingerprint(first!)).toBe(cloudflareErrorFingerprint(second!));
  });

  it('normalizes dynamic stack function names before fingerprinting', () => {
    const first = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: '    at Object.handler_alice (worker.js:10:1)',
    }));
    const second = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: '    at Object.handler_bob (worker.js:10:1)',
    }));
    const third = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: '    at Object.access_token=stack-secret (worker.js:10:1)',
    }));
    const fourth = cloudflareErrorCandidateFromEvent(cloudflareErrorEvent({
      stack: '    at Object.access_token=other-secret (worker.js:10:1)',
    }));

    expect(first?.stackSignature).toEqual(['Object.handler_:value @ worker.js']);
    expect(second?.stackSignature).toEqual(['Object.handler_:value @ worker.js']);
    expect(third?.stackSignature).toEqual(['Object.access_token=[redacted] @ worker.js']);
    expect(fourth?.stackSignature).toEqual(['Object.access_token=[redacted] @ worker.js']);
    expect(cloudflareErrorFingerprint(first!)).toBe(cloudflareErrorFingerprint(second!));
    expect(cloudflareErrorFingerprint(third!)).toBe(cloudflareErrorFingerprint(fourth!));
  });

  it('redacts stack function names before writing issue titles', async () => {
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 135,
            url: 'https://github.com/reirei-lab/rainrail/issues/135',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      stack: '    at Object.access_token=title-secret (worker.js:10:1)',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.title).not.toContain('title-secret');
    expect(createdIssues[0]?.body).not.toContain('title-secret');
    expect(createdIssues[0]?.title).toContain('access_token=[redacted]');
  });

  it('redacts exception names before writing issue titles and summaries', async () => {
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 130,
            url: 'https://github.com/reirei-lab/rainrail/issues/130',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      exceptionName: 'ApiError access_token=name-secret https://user:password@worker.example/reset/name-token\n@org/team',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.title).not.toContain('\n');
    expect(createdIssues[0]?.title).not.toContain('@org/team');
    expect(createdIssues[0]?.title).not.toContain('name-secret');
    expect(createdIssues[0]?.title).not.toContain('user:password');
    expect(createdIssues[0]?.title).not.toContain('name-token');
    expect(createdIssues[0]?.body).not.toContain('name-secret');
    expect(createdIssues[0]?.body).not.toContain('user:password');
    expect(createdIssues[0]?.body).not.toContain('name-token');
  });

  it('redacts worker names before writing issue titles and summaries', async () => {
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 138,
            url: 'https://github.com/reirei-lab/rainrail/issues/138',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      scriptName: 'asme-site token=worker-secret\nextra',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.title).not.toContain('worker-secret');
    expect(createdIssues[0]?.title).not.toContain('\n');
    expect(createdIssues[0]?.body).not.toContain('worker-secret');
    expect(createdIssues[0]?.body).not.toContain('asme-site token=worker-secret');
    expect(createdIssues[0]?.title).toContain('token=[redacted]');
  });

  it('truncates the summary exception message independently from raw data', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 131,
            url: 'https://github.com/reirei-lab/rainrail/issues/131',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: `large serialized response ${'m'.repeat(5_000)} summary-tail`,
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    const messageLine = createdIssues[0]?.body.split('\n').find((line) => line.startsWith('- Message: '));
    expect(messageLine?.length).toBeLessThan(1_200);
    expect(messageLine).toContain('... truncated ...');
    expect(messageLine).not.toContain('summary-tail');
  });

  it('keeps the summary exception message on one Markdown line', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 140,
            url: 'https://github.com/reirei-lab/rainrail/issues/140',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      scriptName: 'worker @ops/team',
      exceptionName: 'TypeError @devs',
      message: 'fail\n@org/team\n## injected',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).toContain('- Worker: worker @\u200Bops/team');
    expect(createdIssues[0]?.body).toContain('- Exception: TypeError @\u200Bdevs');
    const messageLine = createdIssues[0]?.body.split('\n').find((line) => line.startsWith('- Message: '));
    expect(messageLine).toBe('- Message: fail @\u200Borg/team ## injected');
    expect(createdIssues[0]?.body).not.toContain('\n@org/team');
    expect(createdIssues[0]?.body).not.toContain('\n## injected');
  });

  it('renders request summaries as inline code', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 142,
            url: 'https://github.com/reirei-lab/rainrail/issues/142',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      url: 'https://asme.dev/@org/team?token=request-secret',
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    const requestLine = createdIssues[0]?.body.split('\n').find((line) => line.startsWith('- Request: '));
    expect(requestLine).toBe('- Request: `GET /@\u200Borg/team`');
    expect(createdIssues[0]?.body).not.toContain('request-secret');
  });

  it('keeps stack signature frames inside the Markdown fence', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 141,
            url: 'https://github.com/reirei-lab/rainrail/issues/141',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      stack: [
        'TypeError: failed',
        '    at ``` (worker.js:1:1)',
        '    at @org/team (worker.js:2:1)',
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).not.toContain('\n```\n@org/team');
    expect(createdIssues[0]?.body).toContain('\\`\\`\\` @ worker.js');
  });

  it('truncates the summary exception name independently from raw data', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 136,
            url: 'https://github.com/reirei-lab/rainrail/issues/136',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      exceptionName: `HugeError ${'n'.repeat(5_000)} exception-name-tail`,
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    const exceptionLine = createdIssues[0]?.body.split('\n').find((line) => line.startsWith('- Exception: '));
    expect(exceptionLine?.length).toBeLessThan(260);
    expect(exceptionLine).toContain('... truncated ...');
    expect(exceptionLine).not.toContain('exception-name-tail');
  });

  it('bounds raw event data before JSON serialization', async () => {
    const createdIssues: Array<{ body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 137,
            url: 'https://github.com/reirei-lab/rainrail/issues/137',
          };
        },
      },
    });

    await expect(workflow.handle(cloudflareErrorEvent({
      message: `large raw message ${'r'.repeat(20_000)} raw-message-tail`,
      stack: [
        'TypeError: failed',
        `    at hugeRaw (worker-${'s'.repeat(20_000)}-raw-stack-tail.js:10:1)`,
      ].join('\n'),
    }), runtimeContext())).resolves.toMatchObject({
      handled: true,
    });

    expect(createdIssues[0]?.body).toContain('... truncated ...');
    expect(createdIssues[0]?.body).not.toContain('raw-message-tail');
    expect(createdIssues[0]?.body).not.toContain('raw-stack-tail');
    expect(createdIssues[0]?.body.length).toBeLessThan(20_000);
  });
});

function isLockReleaseValue(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'expiresAt' in value
    && value.expiresAt === 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeContext() {
  return {
    runId: 'run-cloudflare',
    now: () => new Date('2026-06-15T09:00:00.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider' as const,
        getIssue: async () => {
          throw new Error('not used');
        },
        createComment: async () => {
          throw new Error('not used');
        },
      },
    },
    runtime: {
      name: 'mock-runtime',
      kind: 'runtime-provider' as const,
      startRun: async () => {
        throw new Error('not used');
      },
    },
    signal: new AbortController().signal,
    actions: {
      mergePullRequest: async () => {
        throw new Error('not used');
      },
      startRuntime: async () => {
        throw new Error('not used');
      },
      readSecret: async () => {
        throw new Error('not used');
      },
    },
  };
}
