export interface WebSocketCodexAppServerTransportConfig {
  type: 'websocket';
  endpoint: string;
  headers?: Record<string, string>;
  tokenEnv?: string;
  reconnect?: {
    enabled: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
  };
}
