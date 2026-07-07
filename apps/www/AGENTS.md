# AGENTS.md - Rainrail Product Site Rules

This scope covers the Astro product site under `apps/www`. Keep site changes
localized, reviewable, and consistent across all public entry points.

## Localization Policy

- The initial supported locales are `ja` and `en`.
- Locale-specific pages must live under explicit URL prefixes: `/ja/` for
  Japanese and `/en/` for English.
- `/` is the automatic language detection entry point. It may route visitors to
  a locale based on browser or request context.
- Explicit locale pages must be stable. They must not redirect users away from an
  explicit locale page just because automatic detection prefers another language.
- When adding a new public page, add both locale versions in the same change
  unless the issue explicitly scopes the page to one locale as a temporary
  migration step.

## Translation Coverage

Every localized page update must cover the full user-facing surface, not only
the main body copy:

- body copy
- navigation labels
- CTA labels and supporting copy
- meta title
- meta description
- OGP title, description, image, and locale data when present
- sitemap entries for every locale URL that should be indexed

If a source string is intentionally shared between locales, document why in the
review or nearby code so it is not mistaken for a missing translation.

## New Page Requirements

- Both locales must receive page copy and metadata together.
- Page-level routes, canonical URLs, and `hreflang` alternates must be generated
  from the same locale/page model where practical.
- Language switcher links must point to the equivalent page in the other locale,
  not to the localized home page unless no equivalent page exists yet.
- New indexable pages must be represented in the sitemap for each supported
  locale.

## Translation Review Checklist

Code review for `apps/www` localization changes should check:

- Both locales were updated for any new or changed page.
- Japanese and English routes use `/ja/` and `/en/` consistently.
- `hreflang` links are reciprocal between equivalent locale pages.
- The language switcher keeps users on the equivalent content page.
- meta title, meta description, OGP, and sitemap output were updated with the
  visible content.
- `/` remains the automatic language detection entry point, while explicit
  locale URLs remain user-controlled.
