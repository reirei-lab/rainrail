import { RainrailDashboardApiError } from './dashboard-client';

export const TOKEN_STORAGE_KEY = 'rainrail-dashboard-token';
export const API_BASE_URL_STORAGE_KEY = 'rainrail-dashboard-api-base-url';
export const OPERATOR_STORAGE_KEY = 'rainrail-dashboard-operator';

export interface SafeStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface PollingClient {
  pollIntervalMs: number;
}

export interface DashboardPollingController {
  start(client: PollingClient, onPoll: () => void | Promise<void>): void;
  stop(): void;
}

export function createDashboardPollingController(windowRef: Pick<Window, 'setInterval' | 'clearInterval'>): DashboardPollingController {
  let pollTimer: number | undefined;

  return {
    start(client, onPoll) {
      this.stop();
      pollTimer = windowRef.setInterval(() => {
        void onPoll();
      }, client.pollIntervalMs);
    },
    stop() {
      if (pollTimer !== undefined) {
        windowRef.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}

export function createSafeStorage(getStorage: () => Storage): SafeStorage {
  const memoryStorage = new Map<string, string>();

  function storage(): Storage | undefined {
    try {
      const candidate = getStorage();
      const probeKey = 'rainrail-dashboard-storage-probe';
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      return undefined;
    }
  }

  return {
    get(key) {
      const target = storage();
      if (target === undefined) return memoryStorage.get(key);

      try {
        return target.getItem(key) ?? undefined;
      } catch {
        return memoryStorage.get(key);
      }
    },
    set(key, value) {
      const target = storage();
      if (target === undefined) {
        memoryStorage.set(key, value);
        return;
      }

      try {
        target.setItem(key, value);
      } catch {
        memoryStorage.set(key, value);
      }
    },
    remove(key) {
      memoryStorage.delete(key);
      const target = storage();
      if (target === undefined) return;

      try {
        target.removeItem(key);
      } catch {
        // The fallback is already cleared.
      }
    },
  };
}

export function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isLoopbackDashboardHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function isDashboardAuthError(error: unknown): boolean {
  return error instanceof RainrailDashboardApiError
    && (error.status === 401 || error.status === 403 || error.code === 'invalid_bearer_token');
}
