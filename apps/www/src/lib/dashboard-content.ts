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
    authMissing: 'Bearer トークンが必要です',
    loading: '運用状態を読み込み中',
    ready: '運用状態を表示中',
    empty: '運用レコードはまだありません',
    authRejected: '運用 API がトークンを拒否しました',
    unavailable: '運用 API を利用できません',
  },
  placeholder: {
    selectStream: '接続後にストリームを選択してください。',
    ready: '準備完了',
    waiting: '待機中',
    branch: 'ブランチ',
    issue: 'Issue',
  },
  empty: {
    sources: '設定済み入力元アダプターを待っています',
    queue: 'キューレコードを待っています',
    settings: '設定メタデータを待っています',
    fallback: '別のストリームを選ぶか、次のポーリングを待ってください。',
  },
  stats: {
    health: '稼働状況',
    events: 'イベント',
    activeRuns: '実行中ワークフロー',
    retryingHandlers: 'リトライ中ハンドラー',
    providerStatus: 'プロバイダー状態',
    agentTasks: 'エージェントタスク',
    sources: '入力元',
    queue: 'キュー',
  },
  detailLabels: {
    id: 'ID',
    branch: 'ブランチ',
    issue: 'Issue',
    actionAudit: '操作履歴',
    humanSummary: '人間向け要約',
    delivery: '配送',
    rawPayloadReference: '元 payload 参照',
    matchedWorkflows: '一致ワークフロー',
    retrySchedule: 'リトライ予定',
    sanitizedEnvelope: '正規化済み envelope',
    sourceEvent: '入力元イベント',
    workflowRunRecord: 'ワークフロー実行レコード',
    agentSession: 'エージェントセッション',
    runtimePid: 'ランタイム PID',
    resumeCount: '再開回数',
    projectClaim: 'Project 取得状態',
    latestResumeAttempt: '最新の再開試行',
    agentTaskTabs: 'エージェントタスク詳細タブ',
    summary: '概要',
    timeline: 'タイムライン',
    codexActivity: 'Codex 活動',
    stdoutLog: 'stdout log',
    stderrLog: 'stderr log',
    rawDetail: 'JSONL / 生データ詳細',
  },
  metadata: {
    sourceType: '入力元タイプ',
    endpoint: 'エンドポイント',
    transport: '配送方式',
    auth: '認証',
    lastDelivery: '最終配送',
    bundleModel: 'バンドルモデル',
    projectStatus: 'Project 状態',
    claimLock: '取得ロック',
    heldBy: '保持者',
    blockedReason: 'ブロック理由',
    queueSignals: 'キューシグナル',
    value: '値',
    updateScope: '更新範囲',
    audit: '監査',
    settingsModel: '設定モデル',
  },
  rowMeta: {
    delivery: '配送',
    publishResult: '公開結果',
    workflowMatches: '一致ワークフロー',
    retries: 'リトライ',
    sourceEvent: '入力元イベント',
    staleProjectClaim: '古い Project 取得状態',
    lastDelivery: '最終配送',
    project: 'Project',
    blocked: 'ブロック',
    claim: '取得',
  },
  command: {
    connectFirst: '操作用トークンで接続してからコマンドを実行してください。',
    selectTaskFirst: '先にエージェントタスクを選択してください。',
    sending: '送信中',
    confirm: '確認',
    failed: 'コマンド失敗',
    command: 'コマンド',
    audit: '監査',
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
      eyebrow: '運用 API クライアント',
      heading: 'Rainrail 運用',
      apiBaseUrlPlaceholder: '運用 API URL',
      apiBaseUrlLabel: 'Rainrail 運用 API ベース URL',
      tokenPlaceholder: 'Bearer トークン',
      tokenLabel: '運用 API Bearer トークン',
      connect: '接続',
      clear: 'クリア',
      status: '状態',
      refresh: '更新',
      staleData: '古いデータ',
      operatorControls: '操作権限',
      filtersLabel: 'イベント受信箱フィルター',
      source: '入力元',
      allSources: 'すべての入力元',
      eventName: 'イベント名',
      apply: '適用',
      delivery: '配送',
      publishResult: '公開結果',
      workflowMatches: '一致ワークフロー',
      recordsLabel: '運用レコード',
      actionsLabel: '操作',
      commandButtons: {
        resume: '選択中を再開',
        reset: 'claim をリセット',
        terminate: '選択中を終了',
        terminateAll: 'すべて終了',
      },
      states: japaneseApp.status,
      tabs: {
        overview: '概要',
        events: 'イベント受信箱',
        workflowRuns: 'ワークフロー実行',
        agentTasks: 'エージェントタスク',
        sources: '入力元',
        queue: 'キュー',
        settings: '設定',
      },
    },
    app: japaneseApp,
  },
} as const satisfies Record<Locale, DashboardContent>;

export const getDashboardContent = (locale: Locale): DashboardContent =>
  dashboardContent[locale];
