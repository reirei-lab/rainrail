import { getDashboardHref, type DashboardRouteId } from './dashboard-content';
import { defaultLocale, getLocaleHref, type PageId } from './i18n';

type RedirectPageId = PageId | 'dashboard';

const publicDocsRoot = 'https://docs.rainrail.dev/';

export const getDefaultLocaleRedirect = (pageId: RedirectPageId) => {
  const href =
    pageId === 'docs'
      ? publicDocsRoot
      : pageId === 'dashboard'
      ? getDashboardHref(defaultLocale)
      : getLocaleHref(defaultLocale, pageId);

  return {
    href,
    title: `Redirecting to: ${href}`,
    body: `Redirecting to ${href}`,
  };
};

export const getDefaultLocaleDashboardRedirect = (routeId: DashboardRouteId) => {
  const href = getDashboardHref(defaultLocale, routeId);

  return {
    href,
    title: `Redirecting to: ${href}`,
    body: `Redirecting to ${href}`,
  };
};
