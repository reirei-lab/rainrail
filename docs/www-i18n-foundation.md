# www i18n foundation

Rainrail の Astro プロダクトサイトは、後続の明示的な locale ルーティング
実装に向けて `apps/www/src/lib/i18n.ts` を i18n 基盤の入口にする。

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

後続の `/ja/` / `/en/` ルーティング実装では、このページモデルから canonical
URL、`hreflang`、言語スイッチャーを生成する。

## エラー方針

未対応 locale は自動 fallback しない。`assertSupportedLocale` で明示的に拒否し、
呼び出し側が 404、リダイレクト、または自動判定入口 `/` の処理を選ぶ。

存在しない翻訳キーは例外にする。空文字や英語 fallback を黙って表示すると、
翻訳漏れが production まで残りやすいため。

## 既存ルートとの互換性

この基盤追加では既存の unprefixed ページを `/en/` へ移動しない。
`SiteLayout` は `locale` が明示されたときだけ localized href を出し、既存ページは
現行の `/docs` などのリンクを維持する。明示的な locale ルートは別 issue で追加する。
