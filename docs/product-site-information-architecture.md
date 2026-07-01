# Product site information architecture

Rainrail の product-facing content は `apps/www` に集約し、engineering-facing
contract/spec docs は `docs/` に残す。ここでは最初の product site sitemap と、
README / docs / examples / website の責務境界を固定する。

## Product site sitemap

`apps/www` は Rainrail を評価する人、導入する人、運用責任者が最初に読む
product site として扱う。実装がまだ無い間も、次の sitemap を初期 IA とする。

| Route | Purpose | Primary audience | Source of truth |
| --- | --- | --- | --- |
| `/` | Rainrail が何を解決するか、どのイベントをどの agent workflow に流すかを短く示す。 | 初見の evaluator | `README.md` の product summary と公開可能な examples |
| `/how-it-works` | Source plugin、neutral event、workflow plugin、runtime provider の流れを図解する。 | 導入検討者、technical lead | `docs/plugin-runtime-contract.md` |
| `/use-cases` | issue triage、PR follow-up、Cloudflare tail alert、project queue dispatch などの代表 workflow を説明する。 | team lead、operator | `examples/` と issue-driven workflow docs |
| `/docs` | engineering docs への入口。product site では概要とリンクだけを置き、contract 本文は複製しない。 | implementer、operator | `docs/` |
| `/security` | webhook secrets、SSE token、runner trust boundary、public/private payload の扱いを説明する。 | security reviewer、operator | `docs/cloudflare-worker.md` と AGENTS.md security rules |
| `/changelog` | release notes と breaking changes への入口。 | existing users | GitHub Releases または repository changelog |

Product site の本文は「なぜ使うか」「どんな workflow が作れるか」「どこから始めるか」
を優先する。payload shape、API signature、retry/replay semantics、secret 名一覧などの
実装 contract は product page に展開せず、`docs/` へリンクする。

## Documentation boundary

`docs/` は実装者と運用者向けの contract/spec/ops docs を置く場所とする。

- `docs/` に置くもの:
  - event envelope、source plugin、workflow plugin、runtime provider の contract
  - GitHub webhook normalization や Project issue selection などの provider 境界
  - Cloudflare Worker deploy、secret、smoke test などの運用手順
  - routing、retry、replay、assignment など後続 agent が実装判断に使う仕様決定
- `apps/www` に置くもの:
  - product narrative、導入価値、主要 use case、公開できる architecture overview
  - `docs/` や GitHub Releases への navigation
  - evaluator が 5 分以内に理解できる diagram、copy、CTA
  - secret 値や非公開 payload を含まない公開前提の content

同じ内容を両方に書く場合は、`docs/` を source of truth にする。`apps/www` は要約と
リンクに留め、contract が変わるたびに二重更新が必要な構造を避ける。

## Surface roles

| Surface | Role | Keep out |
| --- | --- | --- |
| `README.md` | Repository overview、local development entrypoint、主要 docs への index。 | 長い仕様本文、marketing copy の詳細 |
| `docs/` | Durable engineering decisions and operating procedures. | 初見向け hero copy、重い product narrative |
| `examples/` | Reproducible workflow samples, payload fixtures, plugin skeletons. | 仕様決定そのもの、実在 credential、production payload |
| `apps/www` | Public product site and docs gateway. | Contract の全文複製、未公開 operational detail、private automation context |

`examples/` はまだ存在しないが、作る場合は runnable であることを優先する。
単なる説明文は `docs/`、公開 product copy は `apps/www` に置く。

## Initial page priority

1. `/`:
   - Rainrail の一文説明
   - event source から agent workflow までの最短 diagram
   - README と GitHub issue workflow への CTA
1. `/how-it-works`:
   - Source plugin -> neutral event -> workflow plugin -> runtime provider の流れ
   - `docs/plugin-runtime-contract.md` への deep link
1. `/docs`:
   - `docs/` のカテゴリ別 index
   - contract、provider、ops の読み分け
1. `/security`:
   - secret boundary と public/private payload policy
   - Cloudflare Worker deploy docs への link
1. `/use-cases`:
   - 最初は issue/project queue automation を代表例にする
   - plugin examples が増えたら workflow ごとに追加する
1. `/changelog`:
   - 初回は GitHub Releases への link でよい
   - breaking contract change が増えたら dedicated page にする

この順序は「初見で価値を理解する」「実装者が contract に辿り着く」「運用者が安全に
deploy する」を先に満たすためのもの。site implementation issue は、まず `/`、
`/how-it-works`、`/docs` の 3 ページを MVP として切る。
