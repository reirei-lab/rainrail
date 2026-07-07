import { getDashboardHref } from './dashboard-content';
import { defaultLocale, getLocaleHref, type PageId } from './i18n';

type RedirectPageId = PageId | 'dashboard';

export const getDefaultLocaleRedirect = (pageId: RedirectPageId) => {
  const href =
    pageId === 'dashboard'
      ? getDashboardHref(defaultLocale)
      : getLocaleHref(defaultLocale, pageId);

  return {
    href,
    title: `Redirecting to: ${href}`,
    body: `Redirecting to ${href}`,
  };
};
