import { defaultLocale, getLocaleHref, type PageId } from './i18n';

export const redirectToDefaultLocale = (
  astro: { redirect: (path: string, status?: number) => Response },
  pageId: PageId,
): Response => astro.redirect(getLocaleHref(defaultLocale, pageId), 301);
