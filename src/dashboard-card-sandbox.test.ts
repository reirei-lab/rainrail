import { describe, expect, it, vi } from 'vitest';

import {
  createDashboardCardSandboxHost,
  type DashboardCardDefinition,
} from './index.js';

const pluginQueueCard: DashboardCardDefinition = {
  id: 'plugin:github.queue',
  title: 'GitHub queue',
  entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
  category: 'operations',
  requiredCapabilities: ['dashboard:read', 'github:read', 'runtime:start'],
  size: {
    default: { columns: 3, rows: 2 },
  },
};

describe('dashboard card sandbox host', () => {
  it('builds an iframe sandbox descriptor without same-origin or privileged features', () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: 'https://plugins.rainrail.local/cards/',
      allowedCapabilities: ['dashboard:read', 'github:read'],
    });

    const frame = host.createFrame(pluginQueueCard, {
      layoutItemId: 'slot-1',
      settings: { repository: 'reirei-lab/rainrail' },
    });

    expect(frame).toMatchObject({
      cardId: 'plugin:github.queue',
      pluginName: 'github',
      cardName: 'queue',
      title: 'GitHub queue',
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      loading: 'lazy',
      bridgeCapabilities: ['dashboard:read', 'github:read'],
      settings: { repository: 'reirei-lab/rainrail' },
    });
    expect(frame.src).toBe('https://plugins.rainrail.local/cards/github/queue/?cardId=plugin%3Agithub.queue&layoutItemId=slot-1');
    expect(frame.sandbox).not.toContain('allow-same-origin');
    expect(frame.bridgeCapabilities).not.toContain('runtime:start');
  });

  it('isolates per-card load failures and keeps other sandbox cards renderable', async () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
    });
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('plugin bundle failed'))
      .mockResolvedValueOnce({ ready: true });

    await expect(host.load(pluginQueueCard, loader)).resolves.toEqual({
      status: 'error',
      cardId: 'plugin:github.queue',
      error: 'Plugin card failed to load',
    });
    await expect(host.load(pluginQueueCard, loader)).resolves.toEqual({
      status: 'loaded',
      cardId: 'plugin:github.queue',
      value: { ready: true },
    });
  });

  it('exposes only the capabilities granted to the card bridge', async () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
      bridgeHandlers: {
        'dashboard:read': async (request) => ({ ok: true, request }),
        'github:read': async () => ({ ok: false }),
      },
    });
    const frame = host.createFrame(pluginQueueCard);

    await expect(frame.bridge.request('dashboard:read', { path: '/api/v1/overview' }))
      .resolves.toEqual({ ok: true, request: { path: '/api/v1/overview' } });
    await expect(frame.bridge.request('github:read', {}))
      .rejects.toThrow(/Capability "github:read" is not available to dashboard card "plugin:github.queue"/u);
  });

  it('snapshots allowed capabilities when the sandbox host is created', () => {
    const allowedCapabilities = ['dashboard:read'];
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities,
    });

    allowedCapabilities.push('runtime:start');

    expect(host.createFrame(pluginQueueCard).bridgeCapabilities).toEqual(['dashboard:read']);
  });

  it('snapshots the card base URL when the sandbox host is created', () => {
    const options = {
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
    };
    const host = createDashboardCardSandboxHost(options);

    options.cardBaseUrl = 'https://attacker.example/cards/';

    expect(host.createFrame(pluginQueueCard).src)
      .toBe('/dashboard/plugin-cards/github/queue/?cardId=plugin%3Agithub.queue');
  });

  it('rejects protocol-relative card base URLs', () => {
    expect(() => createDashboardCardSandboxHost({
      cardBaseUrl: '//attacker.example/cards/',
      allowedCapabilities: ['dashboard:read'],
    })).toThrow(/card base URL must not be protocol-relative/u);

    expect(() => createDashboardCardSandboxHost({
      cardBaseUrl: '/\\attacker.example/cards/',
      allowedCapabilities: ['dashboard:read'],
    })).toThrow(/card base URL must not be protocol-relative/u);

    expect(() => createDashboardCardSandboxHost({
      cardBaseUrl: '\\\\attacker.example/cards/',
      allowedCapabilities: ['dashboard:read'],
    })).toThrow(/card base URL must not be protocol-relative/u);

    expect(() => createDashboardCardSandboxHost({
      cardBaseUrl: '\t//attacker.example/cards/',
      allowedCapabilities: ['dashboard:read'],
    })).toThrow(/card base URL must not be protocol-relative/u);

    expect(() => createDashboardCardSandboxHost({
      cardBaseUrl: '\n/\\attacker.example/cards/',
      allowedCapabilities: ['dashboard:read'],
    })).toThrow(/card base URL must not be protocol-relative/u);
  });

  it('rejects plugin identifiers that could escape the sandbox card base path', () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
    });

    expect(() => host.createFrame({
      ...pluginQueueCard,
      id: 'plugin:...queue',
      entry: { type: 'plugin', pluginName: '..', cardName: 'queue' },
    })).toThrow(/pluginName must not contain "\." or ":"/u);

    expect(() => host.createFrame({
      ...pluginQueueCard,
      id: 'plugin:github.',
      entry: { type: 'plugin', pluginName: 'github', cardName: '.' },
    })).toThrow(/cardName must not contain "\." or ":"/u);
  });

  it('excludes workflow-only capabilities from the iframe bridge', async () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read', 'runtime:start', 'secret:access', 'merge'],
      bridgeHandlers: {
        'dashboard:read': async () => ({ ok: true }),
        'runtime:start': async () => ({ ok: false }),
        'secret:access': async () => ({ ok: false }),
        merge: async () => ({ ok: false }),
      },
    });
    const frame = host.createFrame({
      ...pluginQueueCard,
      requiredCapabilities: ['dashboard:read', 'runtime:start', 'secret:access', 'merge'],
    });

    expect(frame.bridgeCapabilities).toEqual(['dashboard:read']);
    await expect(frame.bridge.request('runtime:start', {}))
      .rejects.toThrow(/Capability "runtime:start" is not available to dashboard card "plugin:github.queue"/u);
  });

  it('ignores inherited bridge handler properties', async () => {
    const bridgeHandlers = Object.create({
      'dashboard:read': async () => ({ ok: false }),
    }) as Record<string, () => Promise<{ ok: boolean }>>;
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
      bridgeHandlers,
    });
    const frame = host.createFrame({
      ...pluginQueueCard,
      requiredCapabilities: ['dashboard:read'],
    });

    await expect(frame.bridge.request('dashboard:read', {}))
      .rejects.toThrow(/Capability "dashboard:read" does not have a dashboard card bridge handler/u);
  });

  it('validates card identity and capability before dispatching bridge calls', async () => {
    const dashboardRead = vi.fn(async () => ({ ok: true }));
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
      bridgeHandlers: {
        'dashboard:read': dashboardRead,
      },
    });
    const frame = host.createFrame(pluginQueueCard, {
      layoutItemId: 'github-queue',
    });

    await expect(frame.bridge.request({
      cardId: 'plugin:github.queue',
      pluginName: 'github',
      cardName: 'queue',
      layoutItemId: 'github-queue',
      capability: 'dashboard:read',
      action: 'refresh',
    })).resolves.toEqual({ ok: true });
    expect(dashboardRead).toHaveBeenCalledWith({
      cardId: 'plugin:github.queue',
      pluginName: 'github',
      cardName: 'queue',
      layoutItemId: 'github-queue',
      capability: 'dashboard:read',
      action: 'refresh',
      params: {},
    });

    await expect(frame.bridge.request({
      cardId: 'plugin:github.other',
      pluginName: 'github',
      cardName: 'queue',
      capability: 'dashboard:read',
      action: 'refresh',
    })).rejects.toThrow(/Bridge request cardId does not match dashboard card "plugin:github.queue"/u);

    await expect(frame.bridge.request({
      cardId: 'plugin:github.queue',
      pluginName: 'github',
      cardName: 'queue',
      capability: 'runtime:start',
      action: 'runAction',
    })).rejects.toThrow(/Capability "runtime:start" is not available to dashboard card "plugin:github.queue"/u);
  });

  it('limits bridge actions to dashboard card capabilities', async () => {
    const host = createDashboardCardSandboxHost({
      cardBaseUrl: '/dashboard/plugin-cards/',
      allowedCapabilities: ['dashboard:read'],
      bridgeHandlers: {
        'dashboard:read': async () => ({ ok: true }),
      },
    });
    const frame = host.createFrame(pluginQueueCard);

    await expect(frame.bridge.request({
      cardId: 'plugin:github.queue',
      pluginName: 'github',
      cardName: 'queue',
      capability: 'dashboard:read',
      action: 'readToken' as 'refresh',
    })).rejects.toThrow(/Bridge action "readToken" is not available to dashboard card "plugin:github.queue"/u);
  });
});
