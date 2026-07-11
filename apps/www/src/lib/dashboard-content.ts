import { getLocaleHref, type Locale } from './i18n.js';

export type DashboardRouteId = 'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings';

export type DashboardRoute = {
  id: DashboardRouteId;
  slug?: string;
  aliases?: string[];
};

const dashboardRoutes: readonly DashboardRoute[] = [
  { id: 'overview' },
  { id: 'events', slug: 'events' },
  { id: 'workflow-runs', slug: 'workflow-runs' },
  { id: 'agent-tasks', slug: 'tasks', aliases: ['agent-tasks'] },
  { id: 'sources', slug: 'sources' },
  { id: 'queue', slug: 'queue' },
  { id: 'settings', slug: 'settings' },
] as const satisfies readonly DashboardRoute[];

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
    demoModeBadge: string;
    apiBaseUrlPlaceholder: string;
    apiBaseUrlLabel: string;
    tokenPlaceholder: string;
    tokenLabel: string;
    connect: string;
    clear: string;
    status: string;
    refresh: string;
    staleData: string;
    statsLabel: string;
    operatorControls: string;
    filtersLabel: string;
    source: string;
    allSources: string;
    sourceOptions: {
      github: string;
      cloudflare: string;
      manual: string;
      system: string;
    };
    eventName: string;
    apply: string;
    delivery: string;
    publishResult: string;
    workflowMatches: string;
    recordsLabel: string;
    actionsLabel: string;
    tasksActionsLabel: string;
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
  placeholders: {
    notAvailable: string;
    unknown: string;
    none: string;
    admin: string;
    required: string;
  };
  empty: {
    sources: string;
    queue: string;
    settings: string;
    fallback: string;
    sourceBundles: string[];
    queueSignals: string[];
    settingsSignals: string[];
  };
  stats: {
    health: string;
    events: string;
    activeRuns: string;
    retryingHandlers: string;
    commandResults: string;
    providerStatus: string;
    agentTasks: string;
    sources: string;
    queue: string;
  };
  detailStates: {
    loading: string;
    unavailable: string;
    requestFailed: string;
    summary: string;
  };
  detailHints: {
    checkHandlerRetryRows: string;
  };
  detailFallbacks: {
    workflow: string;
    handler: string;
    unscheduled: string;
    retryPending: string;
    stale: string;
    current: string;
    resume: string;
  };
  timelineLabels: {
    started: string;
    updated: string;
    completed: string;
    runtime: string;
    resume: string;
  };
  codexActivityLabels: {
    session: string;
    latestTrajectorySource: string;
    events: string;
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
    failed: string;
    command: string;
    audit: string;
    sendingTemplate: string;
    confirmTemplate: string;
    actions: {
      resume: string;
      reset: string;
      terminate: string;
      'terminate-all': string;
    };
    targets: {
      allRunningTasks: string;
    };
  };
  cardSettings: {
    title: string;
    card: string;
    save: string;
    saved: string;
    failed: string;
    invalid: string;
    empty: string;
    noFields: string;
  };
  overviewCards: {
    title: string;
    description: string;
    controlsLabel: string;
    boardLabel: string;
    show: string;
    moveUp: string;
    moveDown: string;
    visible: string;
    hidden: string;
    connected: string;
    lastRefresh: string;
    empty: string;
    noRecentActivity: string;
    noWarnings: string;
    warningCount: string;
    todoHealth: string;
    cards: Record<'health' | 'counts' | 'recentActivity' | 'warnings', { title: string; description: string }>;
  };
  cardLayout: {
    title: string;
    description: string;
    pickerTitle: string;
    searchPlaceholder: string;
    searchLabel: string;
    categoryLabel: string;
    providerLabel: string;
    allCategories: string;
    allProviders: string;
    gridLabel: string;
    add: string;
    hide: string;
    remove: string;
    settings: string;
    open: string;
    resize: string;
    move: string;
    unavailable: string;
    tooWide: string;
    unknownDashboardCard: string;
    empty: string;
    saving: string;
    saved: string;
    failed: string;
    hiddenCardsWarning: string;
    moveBlocked: string;
    resizeBlocked: string;
  };
};

export const getDashboardRoutes = (): readonly DashboardRoute[] => dashboardRoutes;

export const getDashboardRouteBySlug = (slug?: string): DashboardRoute | undefined =>
  dashboardRoutes.find((route) => route.slug === slug || route.aliases?.includes(slug ?? '') === true);

export const getDashboardHref = (locale: Locale, routeId: DashboardRouteId = 'overview'): string => {
  const route = dashboardRoutes.find((entry) => entry.id === routeId);

  if (route === undefined) {
    throw new RangeError(`Unsupported dashboard route: ${routeId}`);
  }

  if (route.slug === undefined) {
    return `/${locale}/dashboard`;
  }

  return `/${locale}/dashboard/${route.slug}`;
};

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
  placeholders: {
    notAvailable: 'n/a',
    unknown: 'unknown',
    none: 'none',
    admin: 'admin',
    required: 'required',
  },
  empty: {
    sources: 'Waiting for configured source adapters',
    queue: 'Waiting for queue records covering',
    settings: 'Waiting for settings metadata covering',
    fallback: 'Select another stream or wait for the next poll.',
    sourceBundles: ['EEP Bridge', 'GitHub webhook', 'Cloudflare tail', 'manual/chat'],
    queueSignals: ['upcoming issue', 'blocked reason', 'in-progress count', 'claim lock', 'Project status'],
    settingsSignals: ['max concurrency', 'auto-start', 'retry policy', 'operational snapshot limit', 'dashboard auth'],
  },
  stats: {
    health: 'Health',
    events: 'Events',
    activeRuns: 'Active runs',
    retryingHandlers: 'Retrying handlers',
    commandResults: 'Command results',
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
  detailStates: {
    loading: 'Loading detail',
    unavailable: 'Detail unavailable',
    requestFailed: 'Detail request failed',
    summary: 'summary',
  },
  detailHints: {
    checkHandlerRetryRows: 'Check handler retry rows for this source event.',
  },
  detailFallbacks: {
    workflow: 'workflow',
    handler: 'handler',
    unscheduled: 'unscheduled',
    retryPending: 'retry pending',
    stale: 'stale',
    current: 'current',
    resume: 'resume',
  },
  timelineLabels: {
    started: 'started',
    updated: 'updated',
    completed: 'completed',
    runtime: 'runtime',
    resume: 'resume',
  },
  codexActivityLabels: {
    session: 'session',
    latestTrajectorySource: 'latest trajectory source',
    events: 'events',
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
    failed: 'Command failed',
    command: 'Command',
    audit: 'audit',
    sendingTemplate: 'Sending {action} for {target}',
    confirmTemplate: 'Confirm {action} for {target}?',
    actions: {
      resume: 'resume',
      reset: 'reset',
      terminate: 'terminate',
      'terminate-all': 'terminate all',
    },
    targets: {
      allRunningTasks: 'all running tasks',
    },
  },
  cardSettings: {
    title: 'Card settings',
    card: 'Card',
    save: 'Save card settings',
    saved: 'Card settings saved',
    failed: 'Card settings save failed',
    invalid: 'Fix invalid card settings before saving.',
    empty: 'No dashboard cards in the current layout.',
    noFields: 'This card has no configurable fields.',
  },
  overviewCards: {
    title: 'Overview cards',
    description: 'Choose the Overview cards and move them up or down. This layout is saved in this browser.',
    controlsLabel: 'Overview card visibility and order',
    boardLabel: 'Custom Overview cards',
    show: 'Show',
    moveUp: 'Move up',
    moveDown: 'Move down',
    visible: 'visible',
    hidden: 'hidden',
    connected: 'Connected',
    lastRefresh: 'Last refresh',
    empty: 'No Overview cards are visible.',
    noRecentActivity: 'No recent activity.',
    noWarnings: 'No warnings.',
    warningCount: 'Warnings',
    todoHealth: 'TODO: expose component health in the overview API.',
    cards: {
      health: { title: 'Health', description: 'API response freshness and dashboard connection state.' },
      counts: { title: 'Counts', description: 'Operational totals from the overview API.' },
      recentActivity: { title: 'Recent activity', description: 'Latest workflow activity from the overview API.' },
      warnings: { title: 'Warnings', description: 'Overview warning signals that need operator attention.' },
    },
  },
  cardLayout: {
    title: 'Dashboard layout',
    description: 'Pick cards, then drag, resize, remove, and save the operator layout.',
    pickerTitle: 'Card picker',
    searchPlaceholder: 'Search category / provider / plugin',
    searchLabel: 'Search dashboard cards by category, provider, or plugin name',
    categoryLabel: 'Filter cards by category',
    providerLabel: 'Filter cards by provider',
    allCategories: 'All categories',
    allProviders: 'All providers',
    gridLabel: 'Editable dashboard card layout',
    add: 'Add card',
    hide: 'Hide',
    remove: 'Remove',
    settings: 'Settings',
    open: 'Open',
    resize: 'Resize',
    move: 'Move',
    unavailable: 'Unavailable',
    tooWide: 'This card does not fit the 12-column dashboard grid.',
    unknownDashboardCard: 'Unknown dashboard card',
    empty: 'No cards in this layout yet.',
    saving: 'Saving dashboard layout',
    saved: 'Dashboard layout saved',
    failed: 'Dashboard layout save failed',
    hiddenCardsWarning: 'Hidden cards may be omitted by this save. Re-enable missing plugin cards before editing this saved layout.',
    moveBlocked: 'Move would place a card outside the grid or overlap another card.',
    resizeBlocked: 'Resize would overlap another card.',
  },
};

export const fallbackDashboardAppCopy: DashboardAppCopy = englishApp;

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
  placeholders: {
    notAvailable: '該当なし',
    unknown: '不明',
    none: 'なし',
    admin: '管理者',
    required: '必須',
  },
  empty: {
    sources: '設定済み入力元アダプターを待っています',
    queue: 'キューレコードを待っています',
    settings: '設定メタデータを待っています',
    fallback: '別のストリームを選ぶか、次のポーリングを待ってください。',
    sourceBundles: ['EEP Bridge', 'GitHub webhook', 'Cloudflare tail', '手動 / チャット'],
    queueSignals: ['次の issue', 'ブロック理由', '進行中件数', '取得ロック', 'Project 状態'],
    settingsSignals: ['最大並列数', '自動開始', 'リトライ方針', '運用 snapshot 上限', 'dashboard 認証'],
  },
  stats: {
    health: '稼働状況',
    events: 'イベント',
    activeRuns: '実行中ワークフロー',
    retryingHandlers: 'リトライ中ハンドラー',
    commandResults: 'コマンド結果',
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
  detailStates: {
    loading: '詳細を読み込み中',
    unavailable: '詳細を利用できません',
    requestFailed: '詳細取得に失敗しました',
    summary: '要約',
  },
  detailHints: {
    checkHandlerRetryRows: 'この入力元イベントの handler retry 行を確認してください。',
  },
  detailFallbacks: {
    workflow: 'ワークフロー',
    handler: 'ハンドラー',
    unscheduled: '未予定',
    retryPending: 'リトライ待ち',
    stale: '古い状態',
    current: '現在',
    resume: '再開',
  },
  timelineLabels: {
    started: '開始',
    updated: '更新',
    completed: '完了',
    runtime: 'ランタイム',
    resume: '再開',
  },
  codexActivityLabels: {
    session: 'セッション',
    latestTrajectorySource: '最新 trajectory 参照',
    events: 'イベント',
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
    failed: 'コマンド失敗',
    command: 'コマンド',
    audit: '監査',
    sendingTemplate: '{target} に {action} を送信中',
    confirmTemplate: '{target} に {action} を実行しますか？',
    actions: {
      resume: '再開',
      reset: 'claim リセット',
      terminate: '終了',
      'terminate-all': '一括終了',
    },
    targets: {
      allRunningTasks: '一括対象の実行中タスク',
    },
  },
  cardSettings: {
    title: 'カード設定',
    card: 'カード',
    save: 'カード設定を保存',
    saved: 'カード設定を保存しました',
    failed: 'カード設定の保存に失敗しました',
    invalid: '無効なカード設定を修正してから保存してください。',
    empty: '現在のレイアウトに dashboard card がありません。',
    noFields: 'このカードに設定項目はありません。',
  },
  overviewCards: {
    title: '概要カード',
    description: '概要に表示するカードを選び、上下に並べ替えます。このレイアウトはこのブラウザに保存されます。',
    controlsLabel: '概要カードの表示と順序',
    boardLabel: 'カスタム概要カード',
    show: '表示',
    moveUp: '上へ',
    moveDown: '下へ',
    visible: '表示中',
    hidden: '非表示',
    connected: '接続中',
    lastRefresh: '最終更新',
    empty: '表示中の概要カードはありません。',
    noRecentActivity: '最近の活動はありません。',
    noWarnings: '警告はありません。',
    warningCount: '警告',
    todoHealth: 'TODO: overview API でコンポーネント別 health を公開する。',
    cards: {
      health: { title: '稼働状況', description: 'API 応答の新しさと dashboard 接続状態。' },
      counts: { title: '件数', description: 'overview API の運用集計。' },
      recentActivity: { title: '最近の活動', description: 'overview API の最新 workflow activity。' },
      warnings: { title: '警告', description: '運用者が確認すべき overview warning。' },
    },
  },
  cardLayout: {
    title: 'Dashboard レイアウト',
    description: 'カードを選び、ドラッグ、サイズ変更、削除を保存できます。',
    pickerTitle: 'カードピッカー',
    searchPlaceholder: 'category / provider / plugin を検索',
    searchLabel: 'category、provider、plugin name で dashboard card を検索',
    categoryLabel: 'カテゴリでカードを絞り込み',
    providerLabel: 'provider でカードを絞り込み',
    allCategories: 'すべてのカテゴリ',
    allProviders: 'すべての provider',
    gridLabel: '編集可能な dashboard card レイアウト',
    add: 'カード追加',
    hide: '非表示',
    remove: '削除',
    settings: '設定',
    open: '表示',
    resize: 'サイズ変更',
    move: '移動',
    unavailable: '利用不可',
    tooWide: 'このカードは12列の dashboard grid に収まりません。',
    unknownDashboardCard: '不明な dashboard card',
    empty: 'このレイアウトにはまだカードがありません。',
    saving: 'Dashboard レイアウトを保存中',
    saved: 'Dashboard レイアウトを保存しました',
    failed: 'Dashboard レイアウトの保存に失敗しました',
    hiddenCardsWarning: '非表示のカードが保存から除外される可能性があります。非表示の plugin card を再度有効にしてから保存してください。',
    moveBlocked: '移動するとカードが grid 外へ出るか別のカードと重なります。',
    resizeBlocked: 'サイズ変更すると別のカードと重なります。',
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
      demoModeBadge: 'Demo mode',
      apiBaseUrlPlaceholder: 'Operational API URL',
      apiBaseUrlLabel: 'Rainrail Operational API base URL',
      tokenPlaceholder: 'Bearer token',
      tokenLabel: 'Operational API bearer token',
      connect: 'Connect',
      clear: 'Clear',
      status: 'Status',
      refresh: 'Refresh',
      staleData: 'Stale data',
      statsLabel: 'Operational totals',
      operatorControls: 'Operator controls',
      filtersLabel: 'Event inbox filters',
      source: 'Source',
      allSources: 'All sources',
      sourceOptions: {
        github: 'GitHub',
        cloudflare: 'Cloudflare',
        manual: 'Manual',
        system: 'System',
      },
      eventName: 'Event name',
      apply: 'Apply',
      delivery: 'Delivery',
      publishResult: 'Publish result',
      workflowMatches: 'Workflow matches',
      recordsLabel: 'Operational records',
      actionsLabel: 'Operator actions',
      tasksActionsLabel: 'Agent task operator actions',
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
      demoModeBadge: 'デモモード',
      apiBaseUrlPlaceholder: '運用 API URL',
      apiBaseUrlLabel: 'Rainrail 運用 API ベース URL',
      tokenPlaceholder: 'Bearer トークン',
      tokenLabel: '運用 API Bearer トークン',
      connect: '接続',
      clear: 'クリア',
      status: '状態',
      refresh: '更新',
      staleData: '古いデータ',
      statsLabel: '運用集計',
      operatorControls: '操作権限',
      filtersLabel: 'イベント受信箱フィルター',
      source: '入力元',
      allSources: 'すべての入力元',
      sourceOptions: {
        github: 'GitHub',
        cloudflare: 'Cloudflare',
        manual: '手動',
        system: 'システム',
      },
      eventName: 'イベント名',
      apply: '適用',
      delivery: '配送',
      publishResult: '公開結果',
      workflowMatches: '一致ワークフロー',
      recordsLabel: '運用レコード',
      actionsLabel: '操作',
      tasksActionsLabel: 'エージェントタスク操作',
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
