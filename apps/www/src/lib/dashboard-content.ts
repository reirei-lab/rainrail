import { getLocaleHref, type Locale } from './i18n.js';

export type DashboardContent = {
  meta: {
    title: string;
    description: string;
  };
  shell: {
    navLabel: string;
    brandHref: string;
    brandLabel: string;
    eyebrow: string;
    heading: string;
    apiBaseUrlPlaceholder: string;
    apiBaseUrlLabel: string;
    tokenPlaceholder: string;
    tokenLabel: string;
    connect: string;
    clear: string;
    status: string;
    refresh: string;
    staleData: string;
    operatorControls: string;
    filtersLabel: string;
    source: string;
    allSources: string;
    eventName: string;
    apply: string;
    delivery: string;
    publishResult: string;
    workflowMatches: string;
    recordsLabel: string;
    actionsLabel: string;
    commandButtons: {
      resume: string;
      reset: string;
      terminate: string;
      terminateAll: string;
    };
    states: DashboardAppCopy['status'];
    tabs: {
      overview: string;
      events: string;
      workflowRuns: string;
      agentTasks: string;
      sources: string;
      queue: string;
      settings: string;
    };
  };
  app: DashboardAppCopy;
};

export type DashboardAppCopy = {
  status: {
    authMissing: string;
    loading: string;
    ready: string;
    empty: string;
    authRejected: string;
    unavailable: string;
  };
  placeholder: {
    selectStream: string;
    ready: string;
    waiting: string;
    branch: string;
    issue: string;
  };
  empty: {
    sources: string;
    queue: string;
    settings: string;
    fallback: string;
  };
  stats: {
    health: string;
    events: string;
    activeRuns: string;
    retryingHandlers: string;
    providerStatus: string;
    agentTasks: string;
    sources: string;
    queue: string;
  };
  detailLabels: {
    id: string;
    branch: string;
    issue: string;
    actionAudit: string;
    humanSummary: string;
    delivery: string;
    rawPayloadReference: string;
    matchedWorkflows: string;
    retrySchedule: string;
    sanitizedEnvelope: string;
    sourceEvent: string;
    workflowRunRecord: string;
    agentSession: string;
    runtimePid: string;
    resumeCount: string;
    projectClaim: string;
    latestResumeAttempt: string;
    agentTaskTabs: string;
    summary: string;
    timeline: string;
    codexActivity: string;
    stdoutLog: string;
    stderrLog: string;
    rawDetail: string;
  };
  metadata: {
    sourceType: string;
    endpoint: string;
    transport: string;
    auth: string;
    lastDelivery: string;
    bundleModel: string;
    projectStatus: string;
    claimLock: string;
    heldBy: string;
    blockedReason: string;
    queueSignals: string;
    value: string;
    updateScope: string;
    audit: string;
    settingsModel: string;
  };
  rowMeta: {
    delivery: string;
    publishResult: string;
    workflowMatches: string;
    retries: string;
    sourceEvent: string;
    staleProjectClaim: string;
    lastDelivery: string;
    project: string;
    blocked: string;
    claim: string;
  };
  command: {
    connectFirst: string;
    selectTaskFirst: string;
    sending: string;
    confirm: string;
    failed: string;
    command: string;
    audit: string;
  };
};

export const getDashboardHref = (locale: Locale): string => `/${locale}/dashboard`;

const englishApp: DashboardAppCopy = {
  status: {
    authMissing: 'Bearer token required',
    loading: 'Loading operational state',
    ready: 'Live operational state',
    empty: 'No operational records yet',
    authRejected: 'Token rejected by operational API',
    unavailable: 'Operational API unavailable',
  },
  placeholder: {
    selectStream: 'Select a stream after connecting.',
    ready: 'ready',
    waiting: 'waiting',
    branch: 'Branch',
    issue: 'Issue',
  },
  empty: {
    sources: 'Waiting for configured source adapters',
    queue: 'Waiting for queue records covering',
    settings: 'Waiting for settings metadata covering',
    fallback: 'Select another stream or wait for the next poll.',
  },
  stats: {
    health: 'Health',
    events: 'Events',
    activeRuns: 'Active runs',
    retryingHandlers: 'Retrying handlers',
    providerStatus: 'Provider status',
    agentTasks: 'Agent tasks',
    sources: 'Sources',
    queue: 'Queue',
  },
  detailLabels: {
    id: 'ID',
    branch: 'Branch',
    issue: 'Issue',
    actionAudit: 'Action audit',
    humanSummary: 'Human summary',
    delivery: 'Delivery',
    rawPayloadReference: 'Raw payload reference',
    matchedWorkflows: 'Matched workflows',
    retrySchedule: 'Retry schedule',
    sanitizedEnvelope: 'Sanitized envelope',
    sourceEvent: 'Source event',
    workflowRunRecord: 'Workflow run record',
    agentSession: 'Agent session',
    runtimePid: 'Runtime pid',
    resumeCount: 'Resume count',
    projectClaim: 'Project claim',
    latestResumeAttempt: 'Latest resume attempt',
    agentTaskTabs: 'Agent task detail tabs',
    summary: 'Summary',
    timeline: 'Timeline',
    codexActivity: 'Codex activity',
    stdoutLog: 'stdout log',
    stderrLog: 'stderr log',
    rawDetail: 'JSONL/raw detail',
  },
  metadata: {
    sourceType: 'Source type',
    endpoint: 'Endpoint',
    transport: 'Transport',
    auth: 'Auth',
    lastDelivery: 'Last delivery',
    bundleModel: 'Bundle model',
    projectStatus: 'Project status',
    claimLock: 'Claim lock',
    heldBy: 'Held by',
    blockedReason: 'Blocked reason',
    queueSignals: 'Queue signals',
    value: 'Value',
    updateScope: 'Update scope',
    audit: 'Audit',
    settingsModel: 'Settings model',
  },
  rowMeta: {
    delivery: 'Delivery',
    publishResult: 'Publish result',
    workflowMatches: 'Workflow matches',
    retries: 'Retries',
    sourceEvent: 'Source event',
    staleProjectClaim: 'stale project claim',
    lastDelivery: 'Last delivery',
    project: 'Project',
    blocked: 'Blocked',
    claim: 'Claim',
  },
  command: {
    connectFirst: 'Connect with an operator token before running commands.',
    selectTaskFirst: 'Select an agent task first.',
    sending: 'Sending',
    confirm: 'Confirm',
    failed: 'Command failed',
    command: 'Command',
    audit: 'audit',
  },
};

const japaneseApp: DashboardAppCopy = {
  status: {
    authMissing: 'Bearer token が必要です',
    loading: '運用状態を読み込み中',
    ready: '運用状態を表示中',
    empty: '運用レコードはまだありません',
    authRejected: 'Operational API が token を拒否しました',
    unavailable: 'Operational API を利用できません',
  },
  placeholder: {
    selectStream: '接続後に stream を選択してください。',
    ready: '準備完了',
    waiting: '待機中',
    branch: 'Branch',
    issue: 'Issue',
  },
  empty: {
    sources: '設定済み source adapter を待っています',
    queue: 'queue record を待っています',
    settings: 'settings metadata を待っています',
    fallback: '別の stream を選ぶか、次の poll を待ってください。',
  },
  stats: {
    health: 'Health',
    events: 'Events',
    activeRuns: 'Active runs',
    retryingHandlers: 'Retrying handlers',
    providerStatus: 'Provider status',
    agentTasks: 'Agent tasks',
    sources: 'Sources',
    queue: 'Queue',
  },
  detailLabels: {
    id: 'ID',
    branch: 'Branch',
    issue: 'Issue',
    actionAudit: 'Action audit',
    humanSummary: 'Human summary',
    delivery: 'Delivery',
    rawPayloadReference: 'Raw payload reference',
    matchedWorkflows: 'Matched workflows',
    retrySchedule: 'Retry schedule',
    sanitizedEnvelope: 'Sanitized envelope',
    sourceEvent: 'Source event',
    workflowRunRecord: 'Workflow run record',
    agentSession: 'Agent session',
    runtimePid: 'Runtime pid',
    resumeCount: 'Resume count',
    projectClaim: 'Project claim',
    latestResumeAttempt: 'Latest resume attempt',
    agentTaskTabs: 'Agent task detail tabs',
    summary: 'Summary',
    timeline: 'Timeline',
    codexActivity: 'Codex activity',
    stdoutLog: 'stdout log',
    stderrLog: 'stderr log',
    rawDetail: 'JSONL/raw detail',
  },
  metadata: {
    sourceType: 'Source type',
    endpoint: 'Endpoint',
    transport: 'Transport',
    auth: 'Auth',
    lastDelivery: 'Last delivery',
    bundleModel: 'Bundle model',
    projectStatus: 'Project status',
    claimLock: 'Claim lock',
    heldBy: 'Held by',
    blockedReason: 'Blocked reason',
    queueSignals: 'Queue signals',
    value: 'Value',
    updateScope: 'Update scope',
    audit: 'Audit',
    settingsModel: 'Settings model',
  },
  rowMeta: {
    delivery: 'Delivery',
    publishResult: 'Publish result',
    workflowMatches: 'Workflow matches',
    retries: 'Retries',
    sourceEvent: 'Source event',
    staleProjectClaim: 'stale project claim',
    lastDelivery: 'Last delivery',
    project: 'Project',
    blocked: 'Blocked',
    claim: 'Claim',
  },
  command: {
    connectFirst: 'operator token で接続してから command を実行してください。',
    selectTaskFirst: '先に agent task を選択してください。',
    sending: '送信中',
    confirm: '確認',
    failed: 'Command failed',
    command: 'Command',
    audit: 'audit',
  },
};

const dashboardContent = {
  en: {
    meta: {
      title: 'Rainrail Operations',
      description: 'Operational dashboard shell for Rainrail event, workflow, and agent task state.',
    },
    shell: {
      navLabel: 'Dashboard navigation',
      brandHref: getLocaleHref('en', 'home'),
      brandLabel: 'Rainrail home',
      eyebrow: 'Operational API client',
      heading: 'Rainrail Operations',
      apiBaseUrlPlaceholder: 'Operational API URL',
      apiBaseUrlLabel: 'Rainrail Operational API base URL',
      tokenPlaceholder: 'Bearer token',
      tokenLabel: 'Operational API bearer token',
      connect: 'Connect',
      clear: 'Clear',
      status: 'Status',
      refresh: 'Refresh',
      staleData: 'Stale data',
      operatorControls: 'Operator controls',
      filtersLabel: 'Event inbox filters',
      source: 'Source',
      allSources: 'All sources',
      eventName: 'Event name',
      apply: 'Apply',
      delivery: 'Delivery',
      publishResult: 'Publish result',
      workflowMatches: 'Workflow matches',
      recordsLabel: 'Operational records',
      actionsLabel: 'Operator actions',
      commandButtons: {
        resume: 'Resume selected',
        reset: 'Reset claim',
        terminate: 'Terminate selected',
        terminateAll: 'Terminate all',
      },
      states: englishApp.status,
      tabs: {
        overview: 'Overview',
        events: 'Event Inbox',
        workflowRuns: 'Workflow Runs',
        agentTasks: 'Agent Tasks',
        sources: 'Sources',
        queue: 'Queue',
        settings: 'Settings',
      },
    },
    app: englishApp,
  },
  ja: {
    meta: {
      title: 'Rainrail 運用',
      description: 'Rainrail の event、workflow、agent task 状態を確認する運用 dashboard。',
    },
    shell: {
      navLabel: 'Dashboard ナビゲーション',
      brandHref: getLocaleHref('ja', 'home'),
      brandLabel: 'Rainrail ホーム',
      eyebrow: 'Operational API client',
      heading: 'Rainrail 運用',
      apiBaseUrlPlaceholder: 'Operational API URL',
      apiBaseUrlLabel: 'Rainrail Operational API base URL',
      tokenPlaceholder: 'Bearer token',
      tokenLabel: 'Operational API bearer token',
      connect: '接続',
      clear: 'クリア',
      status: '状態',
      refresh: '更新',
      staleData: '古いデータ',
      operatorControls: 'Operator controls',
      filtersLabel: 'Event inbox filters',
      source: 'Source',
      allSources: 'すべての source',
      eventName: 'Event name',
      apply: '適用',
      delivery: 'Delivery',
      publishResult: 'Publish result',
      workflowMatches: 'Workflow matches',
      recordsLabel: '運用レコード',
      actionsLabel: 'Operator actions',
      commandButtons: {
        resume: '選択中を resume',
        reset: 'claim を reset',
        terminate: '選択中を terminate',
        terminateAll: 'すべて terminate',
      },
      states: japaneseApp.status,
      tabs: {
        overview: '概要',
        events: 'イベント受信箱',
        workflowRuns: 'ワークフロー実行',
        agentTasks: 'エージェントタスク',
        sources: 'Sources',
        queue: 'Queue',
        settings: 'Settings',
      },
    },
    app: japaneseApp,
  },
} as const satisfies Record<Locale, DashboardContent>;

export const getDashboardContent = (locale: Locale): DashboardContent =>
  dashboardContent[locale];
