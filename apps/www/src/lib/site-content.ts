import { getLocaleHref, type Locale, type PageId } from './i18n.js';

type LinkAction = {
  label: string;
  href?: string;
  pageId?: PageId;
  variant?: 'primary' | 'secondary';
};

type TextBlock = {
  title: string;
  body: string;
  href?: string;
  pageId?: PageId;
  linkText?: string;
};

type HomeContent = {
  kind: 'home';
  eyebrow: string;
  headline: string;
  lede: string;
  primaryActionsLabel: string;
  actions: LinkAction[];
  facts: {
    ariaLabel: string;
    items: { label: string; value: string }[];
  };
  console: {
    ariaLabel: string;
    decisionsLabel: string;
    topline: string;
    status: string;
    events: { className: string; label: string; title: string; body: string }[];
    logs: string[];
  };
  sections: {
    eyebrow: string;
    heading: string;
    items?: TextBlock[];
    steps?: TextBlock[];
    columns?: TextBlock[];
  }[];
  cta: {
    eyebrow: string;
    heading: string;
    actions: LinkAction[];
  };
};

type SecondaryContent = {
  kind: 'secondary';
  eyebrow: string;
  headline: string;
  lede: string;
  panel?: { ariaLabel: string; title?: string; body?: string; flow?: TextBlock[] };
  sections: {
    heading: string;
    body?: string;
    items?: TextBlock[];
    timeline?: TextBlock[];
    actions?: LinkAction[];
    code?: string;
  }[];
};

export type ProductPageContent = HomeContent | SecondaryContent;

type LocaleContent = Record<PageId, ProductPageContent>;

const repo = 'https://github.com/reirei-lab/rainrail';
const docsBase = `${repo}/blob/main/docs`;
const publicDocsBase = 'https://docs.rainrail.dev';

const english = {
  home: {
    kind: 'home',
    eyebrow: 'Developer event routing for agent operations',
    headline: 'Rainrail routes development events into agent workflows.',
    lede:
      'Turn issues, pull requests, project queues, webhook deliveries, and operational signals into deterministic agent tasks with stable contracts between every source, plugin, and runtime.',
    primaryActionsLabel: 'Primary actions',
    actions: [
      { label: 'Start with the workflow', pageId: 'howItWorks' },
      { label: 'Open developer docs', href: `${publicDocsBase}/`, variant: 'secondary' },
      { label: 'Open GitHub repo', href: repo, variant: 'secondary' },
    ],
    facts: {
      ariaLabel: 'Rainrail operating model',
      items: [
        { label: 'Sources', value: 'GitHub, Cloudflare tail, project queues' },
        { label: 'Boundary', value: 'Neutral Rainrail event envelope' },
        { label: 'Output', value: 'Agent workflow with audit context' },
      ],
    },
    console: {
      ariaLabel: 'Rainrail routing console',
      decisionsLabel: 'Routing decisions',
      topline: 'rainrail/router',
      status: 'live route preview',
      events: [
        {
          className: 'source',
          label: 'Development event',
          title: 'issue.opened',
          body: 'repo: reirei-lab/rainrail',
        },
        {
          className: 'envelope',
          label: 'Neutral event',
          title: 'rainrail.event.v1',
          body: 'source, actor, payload, trace',
        },
        {
          className: 'policy',
          label: 'Policy and plugin routing',
          title: 'workflow: product-site',
          body: 'dedupe, assign, observe',
        },
        {
          className: 'workflow',
          label: 'Agent workflow',
          title: 'codex.issue.implementation',
          body: 'branch, tests, PR, result callback',
        },
      ],
      logs: [
        'matched source adapter github.issue',
        'normalized payload with contract rainrail.event.v1',
        'dispatched to runtime provider openclaw',
      ],
    },
    sections: [
      {
        eyebrow: 'Why teams put Rainrail in the middle',
        heading: 'Automation stays understandable when the routing is explicit.',
        items: [
          {
            title: 'Webhook storms become ordered work',
            body:
              'Incoming events are normalized before they reach an agent, so retries, duplicate deliveries, and project queue changes are handled as routing decisions instead of improvised scripts.',
          },
          {
            title: 'Contracts stay stable',
            body:
              'Source payloads can evolve while workflow plugins keep receiving a predictable event envelope with the context they need to act.',
          },
          {
            title: 'Operators can audit every handoff',
            body:
              'Dispatch reasons, assignment choices, and runtime inputs are designed to be visible enough for reviews, incident follow-up, and local replay.',
          },
        ],
      },
      {
        eyebrow: 'Core workflow',
        heading: 'From repository signal to repeatable agent run.',
        steps: [
          {
            title: 'Source adapters capture events',
            body:
              'GitHub issues, pull requests, project queues, and runtime telemetry enter through source-specific adapters.',
          },
          {
            title: 'Rainrail normalizes the envelope',
            body:
              'Provider details are preserved behind a stable event contract with traceable actor, source, and payload context.',
          },
          {
            title: 'Plugins own the routing logic',
            body:
              'Workflow plugins match events, apply policy, and choose the runtime without hard-coding every source to every agent.',
          },
          {
            title: 'Runtimes receive deterministic work',
            body:
              'Agents start with explicit instructions, branch context, observable execution state, and a completion path.',
          },
        ],
      },
      {
        eyebrow: 'Plugin model',
        heading: 'Keep integrations small enough to reason about.',
        columns: [
          {
            title: 'Source plugins',
            body: 'Translate provider-specific signals into Rainrail events.',
            linkText: 'GitHub issue|Cloudflare tail|Project queue',
          },
          {
            title: 'Workflow plugins',
            body: 'Decide what should happen and why.',
            linkText: 'triage|implementation|review follow-up',
          },
          {
            title: 'Runtime providers',
            body: 'Start agents with reproducible input and reporting.',
            linkText: 'OpenClaw|Codex|local runner',
          },
        ],
      },
      {
        eyebrow: 'Initial content',
        heading: 'Read the vocabulary, then trace the operating paths.',
        items: [
          {
            title: 'Concepts',
            pageId: 'concepts',
            body:
              'Learn the event envelope, source plugin, workflow plugin, provider, and bridge room vocabulary before reading implementation contracts.',
          },
          {
            title: 'Guides',
            pageId: 'guides',
            body:
              'Follow the first GitHub issue automation, PR review loop, and Cloudflare event reporting paths at an operator level.',
          },
          {
            title: 'Examples',
            pageId: 'examples',
            body:
              'Trace the GitHub issue to Project queue to agent PR to review and merge workflow end to end.',
          },
        ],
      },
    ],
    cta: {
      eyebrow: 'Build the route before the agent runs',
      heading:
        'Use Rainrail when event-driven automation needs contracts, not another one-off webhook handler.',
      actions: [
        { label: 'Follow the event path', pageId: 'howItWorks' },
        { label: 'Engineering docs', href: `${publicDocsBase}/`, variant: 'secondary' },
        {
          label: 'Runtime contract',
          href: `${publicDocsBase}/reference/plugin-runtime/`,
          variant: 'secondary',
        },
        { label: 'Issues', href: `${repo}/issues`, variant: 'secondary' },
      ],
    },
  },
  howItWorks: {
    kind: 'secondary',
    eyebrow: 'Architecture overview',
    headline: 'One route from provider events to agent execution.',
    lede:
      'Rainrail separates event ingestion from workflow selection so each adapter can stay small, testable, and accountable.',
    panel: {
      ariaLabel: 'Plugin runtime stages',
      flow: [
        {
          title: 'Source plugin',
          body: 'Accepts provider input and normalizes it.',
        },
        {
          title: 'RainrailEventEnvelope',
          body: 'Captures event kind, source, identity, and safe metadata.',
        },
        {
          title: 'Workflow plugin',
          body: 'Maps neutral events to task-specific agent instructions.',
        },
        {
          title: 'Runtime provider',
          body: 'Starts or resumes the agent workflow with deterministic inputs.',
        },
      ],
    },
    sections: [
      {
        heading: 'Implementation contracts stay in engineering docs',
        body:
          'The product site summarizes the architecture. Payload shapes, plugin API signatures, retry behavior, and runtime semantics remain in the repository documentation so implementation decisions have a single source of truth.',
        actions: [
          { label: 'Plugin runtime contract', href: `${publicDocsBase}/reference/plugin-runtime/` },
          { label: 'End-to-end example', pageId: 'examples', variant: 'secondary' },
        ],
      },
    ],
  },
  concepts: {
    kind: 'secondary',
    eyebrow: 'Concepts',
    headline: 'The vocabulary for routing provider events into agent workflows.',
    lede:
      'Rainrail keeps source systems, workflow decisions, and agent runtimes in separate contracts so automation can grow without turning every adapter into a one-off script.',
    panel: {
      ariaLabel: 'Concept stack',
      flow: [
        { title: 'Source bundle', body: 'Connects GitHub, Cloudflare, manual, and chat ingress.' },
        { title: 'Source plugin', body: 'Normalizes each input into an envelope.' },
        {
          title: 'RainrailEventEnvelope',
          body: 'Stabilizes delivery, source, subject, and payload metadata.',
        },
        { title: 'Workflow plugin', body: 'Chooses the deterministic automation path.' },
        { title: 'Runtime provider', body: 'Starts the agent run behind capability gates.' },
      ],
    },
    sections: [
      {
        heading: 'Initial concept map',
        items: [
          {
            title: 'RainrailEventEnvelope',
            body:
              'The neutral event shape that carries a schema version, source identity, delivery metadata, subject, normalized payload, and a raw payload reference.',
          },
          {
            title: 'Source plugin',
            body:
              'The boundary that accepts provider-specific input, such as GitHub webhooks or Cloudflare tail events, and normalizes it into a RainrailEventEnvelope.',
          },
          {
            title: 'Source bundle',
            body:
              'The composition layer that wires one or more source adapters, such as EEP Bridge, manual input, or web chat, into Core intake without moving provider behavior into Core.',
          },
          {
            title: 'Workflow plugin',
            body:
              'The routing unit that accepts neutral events and maps them to task provider calls, runtime starts, or local deterministic decisions.',
          },
          {
            title: 'Runtime provider',
            body:
              'The adapter for starting or resuming agent runs in OpenClaw, devteam, Codex, or another execution backend without exposing runtime secrets to workflows.',
          },
          {
            title: 'Task and queue providers',
            body:
              'Provider adapters keep GitHub issue operations and Project queue selection behind stable methods so workflow logic does not depend on GraphQL details.',
          },
          {
            title: 'Bridge room',
            body:
              'The event bus layer that keeps publish, replay, SSE delivery, and duplicate delivery handling observable for agents and operators.',
          },
        ],
      },
      {
        heading: 'Implementation references',
        body:
          'This page is a product-facing map. The exact payload fields, plugin API signatures, capability gates, and Bridge room replay behavior stay in the engineering docs.',
        actions: [
          { label: 'Plugin runtime contract', href: `${publicDocsBase}/reference/plugin-runtime/` },
          { label: 'Event delivery', href: `${publicDocsBase}/concepts/event-delivery/`, variant: 'secondary' },
        ],
      },
    ],
  },
  guides: {
    kind: 'secondary',
    eyebrow: 'Guides',
    headline: 'Start with the workflows Rainrail is being built to operate.',
    lede:
      'These guides describe the first operational paths at a high level and link into the repository contracts that implementation work should follow.',
    panel: {
      ariaLabel: 'Guide categories',
      title: 'First workflows',
      body: 'Issue intake, manual/chat input, review follow-up, and Cloudflare reporting.',
    },
    sections: [
      {
        heading: 'Initial guides',
        items: [
          {
            title: 'GitHub issue automation',
            body:
              'Start from a GitHub issue event, normalize it, select work from the Project queue, claim it with a short-lived lock, and dispatch an agent run with branch and session metadata.',
            href: `${publicDocsBase}/operations/task-queue/`,
            linkText: 'Project issue selection',
          },
          {
            title: 'Manual and chat intake',
            body:
              'Publish operator-entered manual prompts or web chat messages as first-party source events that use Core intake and replay without going through the legacy EEP Bridge bundle.',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            linkText: 'Manual source contract',
          },
          {
            title: 'PR review loop',
            body:
              'Use pull request and review events as neutral workflow inputs, then route review follow-up into the same task and runtime provider boundaries used for issue automation.',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            linkText: 'Workflow plugin contract',
          },
          {
            title: 'Cloudflare event reporting',
            body:
              'Deploy the Worker bridge, register required secrets, publish Cloudflare tail or error events, and smoke test health without committing operational credentials.',
            href: `${publicDocsBase}/operations/cloudflare-worker/`,
            linkText: 'Cloudflare Worker operations',
          },
        ],
      },
      {
        heading: 'How to read the guides',
        body:
          'Treat product-site guide pages as orientation. When a guide affects payload shape, Project queue locking, provider auth, retry behavior, or capability-gated actions, the linked docs are the implementation source of truth.',
      },
    ],
  },
  examples: {
    kind: 'secondary',
    eyebrow: 'Examples',
    headline: 'GitHub issue to Project queue to agent PR to review to merge.',
    lede:
      'This first end-to-end example shows the intended path from a work item to an observable agent workflow while keeping provider details behind Rainrail contracts.',
    panel: {
      ariaLabel: 'End-to-end example summary',
      title: 'GitHub -> Project -> agent -> PR -> review -> merge',
      body: 'One traceable workflow across source bundles, queue, runtime, and review events.',
    },
    sections: [
      {
        heading: 'End-to-end path',
        timeline: [
          {
            title: '1. GitHub issue',
            body:
              'A newly selected issue becomes a provider event that Rainrail can normalize instead of handing raw GitHub payloads to workflow code.',
          },
          {
            title: '1b. Manual or chat message',
            body:
              'An operator prompt or web chat message can enter through its own source adapter, publish the same neutral envelope shape, and skip EEP Bridge-specific ingress entirely.',
          },
          {
            title: '2. Project queue',
            body:
              'The queue provider selects the next eligible issue, takes a starting lock, and keeps closed issues or already running work out of the dispatch path.',
          },
          {
            title: '3. Agent run',
            body:
              'A workflow plugin requests an agent run through the runtime provider, passing deterministic issue, branch, and session inputs.',
          },
          {
            title: '4. Pull request',
            body:
              'The agent pushes an implementation branch and opens a pull request that links back to the issue and records the checks that were run.',
          },
          {
            title: '5. Review',
            body:
              'Review events can re-enter Rainrail as neutral events so follow-up work uses the same workflow and provider boundaries.',
          },
          {
            title: '6. Merge',
            body:
              'After review and CI pass, merge remains behind explicit workflow capability gates instead of being an implicit side effect of event ingestion.',
          },
        ],
      },
      {
        heading: 'Contracts behind this example',
        body:
          'The example intentionally stays implementation-neutral. The exact event envelope, Project queue claim semantics, and runtime capability gates are documented in the engineering specs.',
        actions: [
          { label: 'Plugin runtime contract', href: `${publicDocsBase}/reference/plugin-runtime/` },
          {
            label: 'Project issue selection',
            href: `${publicDocsBase}/operations/task-queue/`,
            variant: 'secondary',
          },
        ],
      },
    ],
  },
  docs: {
    kind: 'secondary',
    eyebrow: 'Documentation gateway',
    headline: 'Start with the overview, then jump into the contracts.',
    lede:
      'Rainrail keeps product narrative in this site and durable engineering decisions in the self-hosted developer docs.',
    sections: [
      {
        heading: 'Start here',
        items: [
          {
            title: 'Concepts',
            pageId: 'concepts',
            body:
              'Product-facing vocabulary for events, source plugins, workflow plugins, providers, and bridge room delivery.',
          },
          {
            title: 'Guides',
            pageId: 'guides',
            body:
              'Initial operating guides for GitHub issue automation, PR review follow-up, and Cloudflare event reporting.',
          },
          {
            title: 'Examples',
            pageId: 'examples',
            body:
              'An end-to-end GitHub issue to Project queue to agent PR to review and merge path.',
          },
          {
            title: 'Plugin runtime contract',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            body: 'Source plugin, workflow plugin, and runtime provider boundaries.',
          },
          {
            title: 'Engineering docs index',
            href: `${publicDocsBase}/`,
            body:
              'Public developer docs for contracts, operations, deployment notes, and examples.',
          },
          {
            title: 'GitHub webhook normalization',
            href: `${publicDocsBase}/reference/github-webhook-normalization/`,
            body: 'How GitHub webhook payloads become neutral Rainrail events.',
          },
          {
            title: 'Cloudflare Worker operations',
            href: `${publicDocsBase}/operations/cloudflare-worker/`,
            body: 'Deploy, required secrets, local development, and production smoke testing.',
          },
          {
            title: 'Cloudflare Pages operations',
            href: `${publicDocsBase}/operations/cloudflare-pages/`,
            body:
              'Preview deploys, production deploys, required secrets, and product site smoke testing.',
          },
          {
            title: 'GitHub-only engineering notes',
            href: `${docsBase}/product-site-information-architecture.md`,
            body:
              'Internal source specs such as product-site IA stay in GitHub and are not part of public docs navigation.',
          },
          {
            title: 'GitHub repository',
            href: repo,
            body: 'Source code, pull requests, workflows, and repository history.',
          },
          {
            title: 'Issue tracker',
            href: `${repo}/issues`,
            body: 'Open implementation work, bugs, follow-up tasks, and product site improvements.',
          },
        ],
      },
      {
        heading: 'CLI quick start',
        body:
          'Install the Rainrail CLI with Node.js 20 or newer available on your machine.',
        code:
          'curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes\nexec $SHELL\nrainrail help',
      },
      {
        heading: 'First-use smoke test',
        body:
          "Run a minimal first-use smoke test in a disposable directory. Use rainrail <plugin> help for each plugin's command details.",
        code:
          'mkdir -p ~/rainrail-sandbox\ncd ~/rainrail-sandbox\nmkdir my-agent-ops\ncd my-agent-ops\nrainrail init\ncat rainrail.config.json\nrainrail openclaw help\nrainrail openclaw session test help',
      },
    ],
  },
} satisfies LocaleContent;

const japanese = {
  home: {
    kind: 'home',
    eyebrow: 'エージェント運用のための開発イベントルーティング',
    headline: 'Rainrail は開発イベントをエージェントワークフローへ届けます。',
    lede:
      'issue、pull request、Project queue、webhook delivery、運用シグナルを、source・plugin・runtime の安定した契約で決定的な agent task に変換します。',
    primaryActionsLabel: '主要アクション',
    actions: [
      { label: 'ワークフローを見る', pageId: 'howItWorks' },
      { label: '技術ドキュメントを開く', href: `${publicDocsBase}/`, variant: 'secondary' },
      { label: 'GitHub repo を開く', href: repo, variant: 'secondary' },
    ],
    facts: {
      ariaLabel: 'Rainrail の運用モデル',
      items: [
        { label: '入力元', value: 'GitHub、Cloudflare tail、Project queue' },
        { label: '境界', value: '中立な Rainrail event envelope' },
        { label: '出力', value: '監査文脈つきの agent workflow' },
      ],
    },
    console: {
      ariaLabel: 'Rainrail ルーティングコンソール',
      decisionsLabel: 'ルーティング判断',
      topline: 'rainrail/router',
      status: 'live route preview',
      events: [
        {
          className: 'source',
          label: '開発イベント',
          title: 'issue.opened',
          body: 'repo: reirei-lab/rainrail',
        },
        {
          className: 'envelope',
          label: '中立イベント',
          title: 'rainrail.event.v1',
          body: 'source, actor, payload, trace',
        },
        {
          className: 'policy',
          label: 'ポリシーとプラグインルーティング',
          title: 'workflow: product-site',
          body: 'dedupe, assign, observe',
        },
        {
          className: 'workflow',
          label: 'エージェントワークフロー',
          title: 'codex.issue.implementation',
          body: 'branch, tests, PR, result callback',
        },
      ],
      logs: [
        'source adapter github.issue に一致',
        'payload を rainrail.event.v1 契約で正規化',
        'runtime provider openclaw へ dispatch',
      ],
    },
    sections: [
      {
        eyebrow: 'Rainrail を間に置く理由',
        heading: 'ルーティングが明示されると、自動化は読み解けるまま育ちます。',
        items: [
          {
            title: 'Webhook の嵐を順序ある作業にする',
            body:
              '入力イベントは agent に届く前に正規化されます。retry、重複 delivery、Project queue の変化は、その場しのぎの script ではなく routing decision として扱えます。',
          },
          {
            title: '契約を安定させる',
            body:
              'source payload が変わっても、workflow plugin は必要な文脈を持つ予測可能な event envelope を受け取り続けます。',
          },
          {
            title: 'すべての handoff を監査できる',
            body:
              'dispatch 理由、assignment、runtime input は、review、incident follow-up、local replay で追える粒度で見える設計です。',
          },
        ],
      },
      {
        eyebrow: '中核ワークフロー',
        heading: 'Repository signal から再現可能な agent run へ。',
        steps: [
          {
            title: 'Source adapter が event を受け取る',
            body:
              'GitHub issue、pull request、Project queue、runtime telemetry は source ごとの adapter から入ります。',
          },
          {
            title: 'Rainrail が envelope を正規化する',
            body:
              'provider 固有の詳細は、actor、source、payload の traceable な文脈を持つ安定した event contract の後ろに保たれます。',
          },
          {
            title: 'Plugin が routing logic を持つ',
            body:
              'workflow plugin が event を match し、policy を適用し、すべての source と agent を直結せず runtime を選びます。',
          },
          {
            title: 'Runtime が決定的な作業を受け取る',
            body:
              'agent は明示的な instruction、branch context、観測可能な execution state、completion path と一緒に起動します。',
          },
        ],
      },
      {
        eyebrow: 'プラグインモデル',
        heading: '理解できる小ささで integration を保つ。',
        columns: [
          {
            title: 'Source plugins',
            body: 'Provider 固有の signal を Rainrail event に変換します。',
            linkText: 'GitHub issue|Cloudflare tail|Project queue',
          },
          {
            title: 'Workflow plugins',
            body: '何を、なぜ行うかを決めます。',
            linkText: 'triage|implementation|review follow-up',
          },
          {
            title: 'Runtime providers',
            body: '再現可能な input と reporting つきで agent を起動します。',
            linkText: 'OpenClaw|Codex|local runner',
          },
        ],
      },
      {
        eyebrow: '初期コンテンツ',
        heading: '語彙を読み、運用経路をたどる。',
        items: [
          {
            title: '概念',
            pageId: 'concepts',
            body:
              '実装契約を読む前に、event envelope、source plugin、workflow plugin、provider、bridge room の語彙を確認します。',
          },
          {
            title: 'ガイド',
            pageId: 'guides',
            body:
              '最初の GitHub issue automation、PR review loop、Cloudflare event reporting を operator 目線で追います。',
          },
          {
            title: '例',
            pageId: 'examples',
            body:
              'GitHub issue から Project queue、agent PR、review、merge までの workflow を end-to-end でたどります。',
          },
        ],
      },
    ],
    cta: {
      eyebrow: 'Agent を走らせる前に route を作る',
      heading:
        'イベント駆動の自動化に必要なのが、もうひとつの一回限りの webhook handler ではなく契約なら、Rainrail を使います。',
      actions: [
        { label: 'イベント経路を追う', pageId: 'howItWorks' },
        { label: '技術ドキュメント', href: `${publicDocsBase}/`, variant: 'secondary' },
        {
          label: 'ランタイム契約',
          href: `${publicDocsBase}/reference/plugin-runtime/`,
          variant: 'secondary',
        },
        { label: 'Issue を見る', href: `${repo}/issues`, variant: 'secondary' },
      ],
    },
  },
  howItWorks: {
    kind: 'secondary',
    eyebrow: 'アーキテクチャ概要',
    headline: 'Provider event から agent execution までを一本の route にする。',
    lede:
      'Rainrail は event ingestion と workflow selection を分け、各 adapter を小さく、testable に、責任範囲の見える形に保ちます。',
    panel: {
      ariaLabel: 'プラグイン実行ステージ',
      flow: [
        {
          title: 'Source plugin',
          body: 'provider input を受け取り、Rainrail の event envelope へ正規化します。',
        },
        {
          title: 'RainrailEventEnvelope',
          body: 'event kind、source、identity、安全に扱える metadata を保持します。',
        },
        {
          title: 'Workflow plugin',
          body: 'neutral event を task-specific な agent instruction に対応づけます。',
        },
        {
          title: 'Runtime provider',
          body: '決定的な input と一緒に agent workflow を開始または再開します。',
        },
      ],
    },
    sections: [
      {
        heading: '実装契約は engineering docs に残す',
        body:
          'Product site は architecture を要約します。payload shape、plugin API signature、retry behavior、runtime semantics は repository docs に置き、実装判断の source of truth をひとつに保ちます。',
        actions: [
          { label: 'プラグイン実行契約', href: `${publicDocsBase}/reference/plugin-runtime/` },
          { label: 'End-to-end の例', pageId: 'examples', variant: 'secondary' },
        ],
      },
    ],
  },
  concepts: {
    kind: 'secondary',
    eyebrow: '概念',
    headline: 'Provider event を agent workflow に流すための語彙。',
    lede:
      'Rainrail は source system、workflow decision、agent runtime を別々の contract に分け、自動化が大きくなっても adapter が一回限りの script へ崩れないようにします。',
    panel: {
      ariaLabel: '概念スタック',
      flow: [
        { title: 'Source bundle', body: 'GitHub、Cloudflare、manual、chat の入口を束ねます。' },
        { title: 'Source plugin', body: '各 input を event envelope に正規化します。' },
        {
          title: 'RainrailEventEnvelope',
          body: 'delivery、source、subject、payload metadata を安定させます。',
        },
        { title: 'Workflow plugin', body: '決定的な automation path を選びます。' },
        { title: 'Runtime provider', body: 'capability gate の後ろで agent run を起動します。' },
      ],
    },
    sections: [
      {
        heading: '初期 concept map',
        items: [
          {
            title: 'RainrailEventEnvelope',
            body:
              'schema version、source identity、delivery metadata、subject、normalized payload、raw payload reference を運ぶ中立な event shape です。',
          },
          {
            title: 'Source plugin',
            body:
              'GitHub webhook や Cloudflare tail event のような provider 固有 input を受け取り、RainrailEventEnvelope へ正規化する境界です。',
          },
          {
            title: 'Source bundle',
            body:
              'EEP Bridge、manual input、web chat など、ひとつ以上の source adapter を Core intake へ接続する composition layer です。',
          },
          {
            title: 'Workflow plugin',
            body:
              'neutral event を受け取り、task provider call、runtime start、local deterministic decision へ写像する routing unit です。',
          },
          {
            title: 'Runtime provider',
            body:
              'OpenClaw、devteam、Codex などの execution backend で agent run を開始または再開する adapter です。runtime secret は workflow に露出させません。',
          },
          {
            title: 'Task and queue providers',
            body:
              'GitHub issue operation と Project queue selection を安定した method の後ろに置き、workflow logic が GraphQL detail に依存しないようにします。',
          },
          {
            title: 'Bridge room',
            body:
              'publish、replay、SSE delivery、duplicate delivery handling を agent と operator が観測できる event bus layer です。',
          },
        ],
      },
      {
        heading: '実装参照',
        body:
          'このページは product-facing な地図です。正確な payload field、plugin API signature、capability gate、Bridge room replay behavior は engineering docs に残します。',
        actions: [
          { label: 'プラグイン実行契約', href: `${publicDocsBase}/reference/plugin-runtime/` },
          { label: 'イベント配送', href: `${publicDocsBase}/concepts/event-delivery/`, variant: 'secondary' },
        ],
      },
    ],
  },
  guides: {
    kind: 'secondary',
    eyebrow: 'ガイド',
    headline: 'Rainrail が運用する最初の workflow から始める。',
    lede:
      'これらの guide は最初の operational path を高いレベルで説明し、実装作業が従うべき repository contract へリンクします。',
    panel: {
      ariaLabel: 'ガイドカテゴリ',
      title: '最初の workflow',
      body: 'Issue intake、manual/chat input、review follow-up、Cloudflare reporting。',
    },
    sections: [
      {
        heading: '初期 guides',
        items: [
          {
            title: 'GitHub issue 自動化',
            body:
              'GitHub issue event から始め、正規化し、Project queue から work を選び、短い lock を取り、branch と session metadata つきで agent run を dispatch します。',
            href: `${publicDocsBase}/operations/task-queue/`,
            linkText: 'Project issue 選択',
          },
          {
            title: 'Manual / chat intake',
            body:
              'operator が入力した manual prompt や web chat message を first-party source event として publish し、legacy EEP Bridge bundle を通さず Core intake と replay を使います。',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            linkText: 'Manual source 契約',
          },
          {
            title: 'PR review loop',
            body:
              'pull request と review event を neutral workflow input として受け取り、review follow-up を issue automation と同じ task / runtime provider boundary に流します。',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            linkText: 'Workflow plugin 契約',
          },
          {
            title: 'Cloudflare event reporting',
            body:
              'Worker bridge を deploy し、必要な secret を登録し、Cloudflare tail や error event を publish し、operational credential を commit せず health を smoke test します。',
            href: `${publicDocsBase}/operations/cloudflare-worker/`,
            linkText: 'Cloudflare Worker 運用',
          },
        ],
      },
      {
        heading: 'Guide の読み方',
        body:
          'Product-site guide page は orientation として扱います。payload shape、Project queue locking、provider auth、retry behavior、capability-gated action に関わる場合、リンク先 docs が実装の source of truth です。',
      },
    ],
  },
  examples: {
    kind: 'secondary',
    eyebrow: '例',
    headline: 'GitHub issue から Project queue、agent PR、review、merge まで。',
    lede:
      'この最初の end-to-end example は、work item から観測可能な agent workflow までの意図した経路を、provider detail を Rainrail contract の後ろに保ったまま示します。',
    panel: {
      ariaLabel: 'End-to-end 例の要約',
      title: 'GitHub -> Project -> agent -> PR -> review -> merge',
      body: 'source bundle、queue、runtime、review event をまたぐ traceable な workflow です。',
    },
    sections: [
      {
        heading: 'End-to-end path',
        timeline: [
          {
            title: '1. GitHub issue',
            body:
              '選ばれた issue は provider event になり、workflow code に raw GitHub payload を直接渡す代わりに Rainrail が正規化します。',
          },
          {
            title: '1b. Manual / chat message',
            body:
              'operator prompt や web chat message も独自の source adapter から入り、同じ neutral envelope shape を publish できます。',
          },
          {
            title: '2. Project queue',
            body:
              'queue provider が次の eligible issue を選び、starting lock を取り、closed issue やすでに running の work を dispatch path から外します。',
          },
          {
            title: '3. Agent run',
            body:
              'workflow plugin が runtime provider に agent run を依頼し、deterministic な issue、branch、session input を渡します。',
          },
          {
            title: '4. Pull request',
            body:
              'agent は implementation branch を push し、issue への link と実行した check を記録した pull request を開きます。',
          },
          {
            title: '5. Review',
            body:
              'review event は neutral event として Rainrail に戻せるため、follow-up work も同じ workflow / provider boundary を使えます。',
          },
          {
            title: '6. Merge',
            body:
              'review と CI が通った後の merge は、event ingestion の暗黙の副作用ではなく、明示的な workflow capability gate の後ろに残します。',
          },
        ],
      },
      {
        heading: 'この example の背後にある contract',
        body:
          'Example は意図的に implementation-neutral にしています。正確な event envelope、Project queue claim semantics、runtime capability gate は engineering specs に記録します。',
        actions: [
          { label: 'プラグイン実行契約', href: `${publicDocsBase}/reference/plugin-runtime/` },
          {
            label: 'Project issue 選択',
            href: `${publicDocsBase}/operations/task-queue/`,
            variant: 'secondary',
          },
        ],
      },
    ],
  },
  docs: {
    kind: 'secondary',
    eyebrow: 'ドキュメント入口',
    headline: '概要から始めて、contract へ進む。',
    lede:
      'Rainrail は product narrative をこの site に、長く残す engineering decision を self-hosted developer docs に分けて置きます。',
    sections: [
      {
        heading: 'ここから始める',
        items: [
          {
            title: '概念',
            pageId: 'concepts',
            body:
              'event、source plugin、workflow plugin、provider、bridge room delivery の product-facing な語彙集です。',
          },
          {
            title: 'ガイド',
            pageId: 'guides',
            body:
              'GitHub issue automation、PR review follow-up、Cloudflare event reporting の初期運用ガイドです。',
          },
          {
            title: '例',
            pageId: 'examples',
            body:
              'GitHub issue から Project queue、agent PR、review、merge までの end-to-end path です。',
          },
          {
            title: 'プラグイン実行契約',
            href: `${publicDocsBase}/reference/plugin-runtime/`,
            body: 'Source plugin、workflow plugin、runtime provider の境界。',
          },
          {
            title: '技術ドキュメント一覧',
            href: `${publicDocsBase}/`,
            body:
              'contract、operation、deployment note、example への public developer docs 入口です。',
          },
          {
            title: 'GitHub webhook 正規化',
            href: `${publicDocsBase}/reference/github-webhook-normalization/`,
            body: 'GitHub webhook payload が neutral Rainrail event になる流れ。',
          },
          {
            title: 'Cloudflare Worker 運用',
            href: `${publicDocsBase}/operations/cloudflare-worker/`,
            body: 'deploy、required secrets、local development、production smoke testing。',
          },
          {
            title: 'Cloudflare Pages 運用',
            href: `${publicDocsBase}/operations/cloudflare-pages/`,
            body: 'preview deploy、production deploy、required secrets、product site smoke testing。',
          },
          {
            title: 'GitHub-only engineering notes',
            href: `${docsBase}/product-site-information-architecture.md`,
            body:
              'product-site IA などの内部 source spec は GitHub に残し、public docs navigation には含めません。',
          },
          {
            title: 'GitHub repository',
            href: repo,
            body: 'source code、pull request、workflow、repository history。',
          },
          {
            title: 'Issue tracker',
            href: `${repo}/issues`,
            body: 'open implementation work、bug、follow-up task、product site improvement。',
          },
        ],
      },
      {
        heading: 'CLI quick start',
        body:
          'Node.js 20 以降が使える環境で Rainrail CLI を install します。',
        code:
          'curl -fsSL https://rainrail.dev/install.sh | bash -s -- --add-to-shell --yes\nexec $SHELL\nrainrail help',
      },
      {
        heading: '初回 smoke test',
        body:
          '使い捨て directory で最小の first-use smoke test を実行します。各 plugin の command details は rainrail <plugin> help を使います。',
        code:
          'mkdir -p ~/rainrail-sandbox\ncd ~/rainrail-sandbox\nmkdir my-agent-ops\ncd my-agent-ops\nrainrail init\ncat rainrail.config.json\nrainrail openclaw help\nrainrail openclaw session test help',
      },
    ],
  },
} satisfies LocaleContent;

export const productContent: Record<Locale, LocaleContent> = {
  en: english,
  ja: japanese,
};

export const getProductPageContent = (
  locale: Locale,
  pageId: PageId,
): ProductPageContent => productContent[locale][pageId];

export const resolveActionHref = (locale: Locale, action: LinkAction): string =>
  action.pageId ? getLocaleHref(locale, action.pageId) : (action.href ?? '#');
