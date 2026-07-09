export interface DashboardClientOptions {
  token: string;
  baseUrl?: string;
  demoMode?: boolean;
  pollIntervalMs?: number;
}

export interface DashboardCollection<T> {
  data: T[];
  page: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface DashboardOverview {
  data: {
    counts: Record<string, number>;
    warnings: { staleProjectClaims?: unknown[] };
    recentActivity: DashboardWorkflowRun[];
    links: {
      events: string;
      workflowRuns: string;
      agentTasks: string;
      sources: string;
      queue: string;
      settings: string;
    };
  };
}

export interface DashboardEvent {
  id: string;
  type: 'event';
  name?: string;
  status: string;
  summary: string;
  deliveryId?: string;
  rawPayloadReference?: string;
  workflowRunCount?: number;
  handlerRetryCount?: number;
  latestOutcome?: string;
  occurredAt?: string;
  receivedAt?: string;
  source?: { type?: string; name?: string; repository?: string };
  subject?: { type?: string; id?: string; url?: string };
  links?: { self?: string };
}

export interface DashboardWorkflowRun {
  id: string;
  type: 'workflow-run';
  status: string;
  summary: string;
  createdAt?: string;
  sourceEventId?: string;
  links?: { self?: string };
}

export interface DashboardAgentTask {
  id: string;
  type: 'agent-task';
  status: string;
  title?: string;
  agentSessionId?: string;
  branchName?: string;
  issue?: { repository?: string; number?: number };
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  warnings?: { staleProjectClaim?: boolean };
  links?: { self?: string };
}

export interface DashboardSource {
  id: string;
  type: 'source';
  status: string;
  sourceType: string;
  name: string;
  endpoint?: string;
  transport?: string;
  auth?: { status?: string };
  lastDelivery?: { id?: string; receivedAt?: string; subject?: { type?: string; id?: string; url?: string } };
  links?: { self?: string };
}

export interface DashboardQueueItem {
  id: string;
  type: 'queue-item';
  status: string;
  title: string;
  branchName?: string;
  projectStatus?: string;
  blockedReason?: string;
  issue?: { repository?: string; number?: number };
  claimLock?: { projectItemId?: string; heldBy?: string };
  links?: { self?: string };
}

export interface DashboardSetting {
  id: string;
  type: 'setting';
  status: string;
  label: string;
  value: string;
  links?: { self?: string };
}

export interface DashboardDetail<TRecord = unknown> {
  data: {
    id: string;
    type: string;
    record: TRecord;
  };
}

export interface DashboardCommandResponse {
  data: {
    action: string;
    targetType: string;
    targetId: string;
    status: string;
    dryRun: boolean;
    confirmationRequired?: boolean;
    confirmationToken?: string;
    auditId?: string;
    auditWarning?: string;
    result?: unknown;
    error?: string;
  };
}

export class RainrailDashboardApiClient {
  readonly pollIntervalMs: number;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly demoMode: boolean;

  constructor(options: DashboardClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? '';
    this.demoMode = options.demoMode ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
  }

  overview(): Promise<DashboardOverview> {
    return this.get('/api/v1/overview');
  }

  events(filters: { sourceType?: string; name?: string } = {}): Promise<DashboardCollection<DashboardEvent>> {
    const params = new URLSearchParams({ limit: '25' });
    if (filters.sourceType !== undefined && filters.sourceType !== '') params.set('filter[source]', filters.sourceType);
    if (filters.name !== undefined && filters.name !== '') params.set('filter[name]', filters.name);
    return this.get(`/api/v1/events?${params.toString()}`);
  }

  workflowRuns(filters: { status?: string } = {}): Promise<DashboardCollection<DashboardWorkflowRun>> {
    const params = new URLSearchParams({ limit: '25' });
    if (filters.status !== undefined && filters.status !== '') params.set('filter[status]', filters.status);
    return this.get(`/api/v1/workflow-runs?${params.toString()}`);
  }

  agentTasks(filters: { status?: string } = {}): Promise<DashboardCollection<DashboardAgentTask>> {
    const params = new URLSearchParams({ limit: '25' });
    if (filters.status !== undefined && filters.status !== '') params.set('filter[status]', filters.status);
    return this.get(`/api/v1/agent-tasks?${params.toString()}`);
  }

  sources(): Promise<DashboardCollection<DashboardSource>> {
    return this.get('/api/v1/sources?limit=25');
  }

  queue(filters: { status?: string } = {}): Promise<DashboardCollection<DashboardQueueItem>> {
    const params = new URLSearchParams({ limit: '25' });
    if (filters.status !== undefined && filters.status !== '') params.set('filter[status]', filters.status);
    return this.get(`/api/v1/queue?${params.toString()}`);
  }

  settings(): Promise<DashboardCollection<DashboardSetting>> {
    return this.get('/api/v1/settings?limit=25');
  }

  eventDetail(id: string): Promise<DashboardDetail> {
    return this.get(`/api/v1/events/${encodeURIComponent(id)}`);
  }

  workflowRunDetail(id: string): Promise<DashboardDetail> {
    return this.get(`/api/v1/workflow-runs/${encodeURIComponent(id)}`);
  }

  agentTaskDetail(id: string): Promise<DashboardDetail> {
    return this.get(`/api/v1/agent-tasks/${encodeURIComponent(id)}`);
  }

  resumeAgentTask(id: string): Promise<DashboardCommandResponse> {
    return this.postCommand(`/api/v1/agent-tasks/${encodeURIComponent(id)}/actions/resume`, {});
  }

  resetAgentTask(id: string, confirmationToken?: string): Promise<DashboardCommandResponse> {
    return this.postCommand(`/api/v1/agent-tasks/${encodeURIComponent(id)}/actions/reset`, confirmationToken === undefined ? {} : { confirmationToken });
  }

  terminateAgentTask(id: string, confirmationToken?: string): Promise<DashboardCommandResponse> {
    return this.postCommand(`/api/v1/agent-tasks/${encodeURIComponent(id)}/actions/terminate`, confirmationToken === undefined ? {} : { confirmationToken });
  }

  terminateAllAgentTasks(confirmationToken?: string): Promise<DashboardCommandResponse> {
    return this.postCommand('/api/v1/agent-tasks/actions/terminate-all', confirmationToken === undefined ? {} : { confirmationToken });
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${this.pathWithDemoMode(path)}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new RainrailDashboardApiError(response.status, await readErrorCode(response));
    }

    return response.json() as Promise<T>;
  }

  private async postCommand(path: string, body: Record<string, unknown>): Promise<DashboardCommandResponse> {
    const response = await fetch(`${this.baseUrl}${this.pathWithDemoMode(path)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-rainrail-client': 'dashboard',
      },
      body: JSON.stringify(body),
    });

    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new RainrailDashboardApiError(response.status, errorCodeFromPayload(payload, response.status), payload);
    }

    return payload as DashboardCommandResponse;
  }

  private pathWithDemoMode(path: string): string {
    if (!this.demoMode) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}demo=1`;
  }
}

export class RainrailDashboardApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly payload?: unknown) {
    super(code);
    this.name = 'RainrailDashboardApiError';
  }
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.clone().json() as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}

async function readJsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return { error: `http_${response.status}` };
  }
}

function errorCodeFromPayload(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  }
  return `http_${status}`;
}
