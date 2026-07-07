export const supportedLocales = ['ja', 'en'] as const;

export type Locale = (typeof supportedLocales)[number];

export const pageIds = [
  'home',
  'howItWorks',
  'concepts',
  'guides',
  'examples',
  'docs',
] as const;

export type PageId = (typeof pageIds)[number];

type LocalizedText = {
  title: string;
  description: string;
};

type NavItem = {
  label: string;
  pageId: Exclude<PageId, 'home'>;
};

type PageContent = {
  meta: LocalizedText;
};

type SiteMessages = {
  nav: {
    ariaLabel: string;
    brandLabel: string;
    github: string;
    primary: NavItem[];
  };
  footer: string;
  pages: Record<PageId, PageContent>;
};

export type LocalizedPage = PageContent & {
  href: string;
  alternates: Record<Locale, string>;
};

export const defaultLocale = 'en' satisfies Locale;

export const pageSlugs = {
  home: '',
  howItWorks: 'how-it-works',
  concepts: 'concepts',
  guides: 'guides',
  examples: 'examples',
  docs: 'docs',
} as const satisfies Record<PageId, string>;

const messages = {
  ja: {
    nav: {
      ariaLabel: '主要ナビゲーション',
      brandLabel: 'Rainrail ホーム',
      github: 'GitHub',
      primary: [
        { label: '仕組み', pageId: 'howItWorks' },
        { label: '概念', pageId: 'concepts' },
        { label: 'ガイド', pageId: 'guides' },
        { label: '例', pageId: 'examples' },
        { label: 'ドキュメント', pageId: 'docs' },
      ],
    },
    footer:
      'Rainrail は開発イベントを決定的なエージェントワークフローへルーティングします。',
    pages: {
      home: {
        meta: {
          title: 'Rainrail',
          description:
            'Rainrail は開発イベントを決定的なエージェントワークフローへルーティングします。',
        },
      },
      howItWorks: {
        meta: {
          title: '仕組み',
          description:
            'Rainrail がソースイベントを正規化し、プラグインとランタイムへ渡す流れ。',
        },
      },
      concepts: {
        meta: {
          title: '概念',
          description:
            'Rainrail のイベントエンベロープ、ソースプラグイン、ワークフロープラグイン、ランタイムの語彙。',
        },
      },
      guides: {
        meta: {
          title: 'ガイド',
          description:
            'GitHub issue 自動化、PR レビューループ、Cloudflare イベント報告の運用ガイド。',
        },
      },
      examples: {
        meta: {
          title: '例',
          description:
            'GitHub issue から Project queue、エージェント PR、レビュー、マージまでの経路例。',
        },
      },
      docs: {
        meta: {
          title: 'ドキュメント',
          description:
            'Rainrail の実装者と運用者向けドキュメント入口。',
        },
      },
    },
  },
  en: {
    nav: {
      ariaLabel: 'Primary navigation',
      brandLabel: 'Rainrail home',
      github: 'GitHub',
      primary: [
        { label: 'How it works', pageId: 'howItWorks' },
        { label: 'Concepts', pageId: 'concepts' },
        { label: 'Guides', pageId: 'guides' },
        { label: 'Examples', pageId: 'examples' },
        { label: 'Docs', pageId: 'docs' },
      ],
    },
    footer: 'Rainrail routes development events into deterministic agent workflows.',
    pages: {
      home: {
        meta: {
          title: 'Rainrail',
          description:
            'Rainrail routes development events into deterministic agent workflows.',
        },
      },
      howItWorks: {
        meta: {
          title: 'How it works',
          description:
            'How Rainrail normalizes source events and hands them to plugins and runtimes.',
        },
      },
      concepts: {
        meta: {
          title: 'Concepts',
          description:
            'Rainrail vocabulary for event envelopes, source plugins, workflow plugins, and runtimes.',
        },
      },
      guides: {
        meta: {
          title: 'Guides',
          description:
            'Initial operating guides for GitHub issue automation, PR review loops, and Cloudflare event reporting.',
        },
      },
      examples: {
        meta: {
          title: 'Examples',
          description:
            'Example paths from GitHub issues to Project queues, agent PRs, reviews, and merges.',
        },
      },
      docs: {
        meta: {
          title: 'Docs',
          description:
            'Rainrail documentation entry points for implementers and operators.',
        },
      },
    },
  },
} as const satisfies Record<Locale, SiteMessages>;

export const isSupportedLocale = (locale: string): locale is Locale =>
  supportedLocales.includes(locale as Locale);

export const assertSupportedLocale = (locale: string): asserts locale is Locale => {
  if (!isSupportedLocale(locale)) {
    throw new RangeError(`Unsupported locale: ${locale}`);
  }
};

export const getLocaleHref = (locale: Locale, pageId: PageId): string => {
  const slug = pageSlugs[pageId];
  return slug === '' ? `/${locale}/` : `/${locale}/${slug}`;
};

export const getLegacyHref = (pageId: PageId): string => {
  const slug = pageSlugs[pageId];
  return slug === '' ? '/' : `/${slug}`;
};

export const getPageIdBySlug = (slug = ''): PageId | undefined =>
  pageIds.find((pageId) => pageSlugs[pageId] === slug);

export const getPageBySlug = (
  locale: Locale,
  slug = '',
): LocalizedPage | undefined => {
  const pageId = getPageIdBySlug(slug);
  return pageId ? getPageContent(locale, pageId) : undefined;
};

export const getSiteMessages = (locale: Locale): SiteMessages => messages[locale];

export const getPageContent = (locale: Locale, pageId: PageId): LocalizedPage => ({
  ...messages[locale].pages[pageId],
  href: getLocaleHref(locale, pageId),
  alternates: {
    ja: getLocaleHref('ja', pageId),
    en: getLocaleHref('en', pageId),
  },
});

export const translate = (locale: Locale, key: string): string => {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, messages[locale]);

  if (typeof value !== 'string') {
    throw new ReferenceError(`Missing translation key "${key}" for locale "${locale}"`);
  }

  return value;
};
