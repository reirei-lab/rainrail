# www i18n foundation

Rainrail の Astro プロダクトサイトは、`apps/www/src/lib/i18n.ts` を i18n
基盤の入口にする。product pages は `/ja/` / `/en/` の明示 URL で公開する。

## 対象 locale

サポート locale は `ja` / `en` の 2 つに固定して一元定義する。
新しい locale を追加するときは、locale 配列、全ページの meta、ナビゲーション、
footer、alternate URL の検証を同じ変更で更新する。

## ページモデル

ページ ID は locale に依存しない安定キーとして扱う。各 locale は同じページ ID
に対して次の情報を持つ。

- meta title
- meta description
- navigation label
- localized href
- locale alternates

`/ja/` / `/en/` ルーティングでは、canonical URL と `hreflang` alternate は同じ page model から生成する。
`hreflang` は検索エンジン
向けに absolute URL とし、sitemap も同じ page model から各 locale URL を列挙する。

## エラー方針

未対応 locale は自動 fallback しない。`assertSupportedLocale` で明示的に拒否し、
呼び出し側が 404、HTTP redirect、または自動 locale detection entry point `/`
の処理を選ぶ。

存在しない翻訳キーは例外にする。空文字や英語 fallback を黙って表示すると、
翻訳漏れが production まで残りやすいため。

## ルーティング方針

`/` は自動 locale detection entry point として扱う。保存済みの手動選択
`rainrail.locale` があれば最優先する。保存済み選択がない場合はブラウザの
`navigator.languages` を優先順に走査し、最初に対応した locale へ遷移する。
どちらでも判定できない場合の fallback locale は `en` とする。
JavaScript を実行しない smoke / fetch クライアント向けに、fallback HTML には
Rainrail の短い説明と明示的な言語リンクを残す。

legacy unprefixed product URL は `/en/` へ 301 redirect する。Cloudflare Pages では
`apps/www/public/_redirects` で `/docs`、`/how-it-works`、`/concepts`、`/guides`、
`/examples` を対応する `/en/...` に送る。Astro の静的ビルドでは `Astro.redirect`
を使わない。

明示的な locale URL は user-controlled な安定ページとして扱う。`/ja/...` や
`/en/...` は自動判定結果によって別 locale へ redirect しない。
language switcher から明示的に locale を選んだ場合だけ、次回 `/` 訪問時の
自動判定に使う locale として保存する。
