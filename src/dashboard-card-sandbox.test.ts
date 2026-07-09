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
});
