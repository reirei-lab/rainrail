import { defaultLocale, getLocaleHref, type PageId } from './i18n';

export const getDefaultLocaleRedirect = (pageId: PageId) => {
  const href = getLocaleHref(defaultLocale, pageId);

  return {
    href,
    title: `Redirecting to: ${href}`,
    body: `Redirecting to ${href}`,
  };
};
