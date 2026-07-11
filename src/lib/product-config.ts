import type { AppContext } from '../types';

type ProductConfig = {
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

export function getProductConfigForHost(host: string): ProductConfig {
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

  return BESTMCP_CONFIG;
}

export function getProductConfigForRequest(requestUrl: string, forwardedHost?: string | null): ProductConfig {
  if (forwardedHost) {
    return getProductConfigForHost(forwardedHost);
  }
  return getProductConfigForHost(getRequestHost(requestUrl));
}

export function getProductConfigForReturnUrl(returnUrl: string | null | undefined, env: AppContext['Bindings']): ProductConfig {
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
