import type { AppContext } from '../types';

export type ProductConfig = {
  productId: string;
  appUrl: string;
  frontendUrl: string;
  oauthRedirectUri: string;
  defaultReturnPath: string;
  checkoutSuccessPath: string;
  checkoutCancelPath: string;
  portalReturnPath: string;
};

const BESTMCP_CONFIG: ProductConfig = {
  productId: 'prod_bestmcp',
  appUrl: 'https://bestmcpservers.com',
  frontendUrl: 'https://bestmcpservers.com',
  oauthRedirectUri: 'https://auth.bestmcpservers.com/api/auth/google/callback',
  defaultReturnPath: '/my-purchases/',
  checkoutSuccessPath: '/my-purchases/?checkout=success',
  checkoutCancelPath: '/pricing/?checkout=cancelled',
  portalReturnPath: '/my-purchases/',
};

const KINDREPLY_CONFIG: ProductConfig = {
  productId: 'prod_kindreply',
  appUrl: 'https://kindreply.co',
  frontendUrl: 'https://kindreply.co',
  oauthRedirectUri: 'https://api.kindreply.co/api/auth/google/callback',
  defaultReturnPath: '/cover-letter-writer/',
  checkoutSuccessPath: '/cover-letter-writer/?checkout=success',
  checkoutCancelPath: '/pricing/?checkout=cancelled',
  portalReturnPath: '/pricing/',
};

const CLEARTEXT_CONFIG: ProductConfig = {
  productId: 'prod_cleartext',
  appUrl: 'https://cleartextdetector.com',
  frontendUrl: 'https://cleartextdetector.com',
  oauthRedirectUri: 'https://auth.cleartextdetector.com/api/auth/google/callback',
  defaultReturnPath: '/pricing/',
  checkoutSuccessPath: '/pricing/?checkout=success',
  checkoutCancelPath: '/pricing/?checkout=cancelled',
  portalReturnPath: '/pricing/',
};

const EDITIMAGES_CONFIG: ProductConfig = {
  productId: 'prod_editimages',
  appUrl: 'https://editimages.app',
  frontendUrl: 'https://editimages.app',
  oauthRedirectUri: 'https://auth.editimages.app/api/auth/google/callback',
  defaultReturnPath: '/account/',
  checkoutSuccessPath: '/account/?checkout=success',
  checkoutCancelPath: '/account/?checkout=cancelled',
  portalReturnPath: '/account/',
};

function getRequestHost(requestUrl: string): string {
  try {
    return new URL(requestUrl).host;
  } catch {
    return '';
  }
}

function normalizeHost(host: string | null | undefined): string {
  return (host || '').toLowerCase();
}

export function getProductConfigForHost(host: string): ProductConfig | null {
  const normalizedHost = normalizeHost(host);
  if (
    normalizedHost === 'bestmcpservers.com'
    || normalizedHost === 'www.bestmcpservers.com'
    || normalizedHost === 'auth.bestmcpservers.com'
    || normalizedHost.endsWith('.mcp-server-directory.pages.dev')
  ) {
    return BESTMCP_CONFIG;
  }

  if (
    normalizedHost === 'kindreply.co'
    || normalizedHost === 'www.kindreply.co'
    || normalizedHost === 'api.kindreply.co'
    || normalizedHost.endsWith('.kindreply.pages.dev')
  ) {
    return KINDREPLY_CONFIG;
  }

  if (
    normalizedHost === 'cleartextdetector.com'
    || normalizedHost === 'www.cleartextdetector.com'
    || normalizedHost === 'auth.cleartextdetector.com'
    || normalizedHost.endsWith('.cleartextdetector.pages.dev')
  ) {
    return CLEARTEXT_CONFIG;
  }

  if (
    normalizedHost === 'editimages.app'
    || normalizedHost === 'www.editimages.app'
    || normalizedHost === 'auth.editimages.app'
    || normalizedHost.endsWith('.editimages.pages.dev')
  ) {
    return EDITIMAGES_CONFIG;
  }

  return null;
}

export function getProductConfigForRequest(requestUrl: string, _forwardedHost?: string | null): ProductConfig | null {
  // Product identity is derived from the request URL. X-Forwarded-Host is
  // client-controlled on public endpoints and must not select a credit scope.
  return getProductConfigForHost(getRequestHost(requestUrl));
}

export function getProductConfigForReturnUrl(returnUrl: string | null | undefined, env: AppContext['Bindings']): ProductConfig | null {
  if (returnUrl) {
    try {
      return getProductConfigForHost(new URL(returnUrl).host);
    } catch {
      // Fall through to request-level defaults.
    }
  }

  const apiHost = (() => {
    try {
      return new URL(env.API_URL).host;
    } catch {
      return '';
    }
  })();
  return getProductConfigForHost(apiHost);
}

export function usesProductCreditsV2(productId: string, env: AppContext['Bindings']): boolean {
  const enabledProducts = (env.PRODUCT_CREDITS_V2_PRODUCTS || '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean);
  return enabledProducts.includes(productId);
}
