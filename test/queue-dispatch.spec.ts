import { describe, expect, it } from 'vitest';
import { resolveQueueHandler } from '../src';
import { handleWebhookQueue } from '../src/queues/webhook';
import { handleAuditQueue } from '../src/queues/audit';
import { handleCreditsQueue } from '../src/queues/credits';
import type { Env } from '../src/types';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as any,
    KV_SESSIONS: {} as any,
    KV_RATELIMIT: {} as any,
    KV_CACHE: {} as any,
    R2_STORAGE: {} as any,
    QUEUE_WEBHOOK: {} as any,
    QUEUE_AUDIT: {} as any,
    QUEUE_CREDITS: {} as any,
    AI: {} as any,
    APP_ENV: 'test',
    APP_URL: 'http://example.test',
    FRONTEND_URL: 'http://example.test',
    API_URL: 'http://example.test',
    GOOGLE_OAUTH_REDIRECT_URI: 'http://example.test/api/auth/google/callback',
    PRODUCT_CREDITS_V2_PRODUCTS: 'prod_editimages,prod_skuangles',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    JWT_SECRET: 'test',
    STRIPE_SECRET_KEY: 'test',
    STRIPE_WEBHOOK_SECRET: 'test',
    INTERNAL_API_KEY: 'test',
    ADMIN_SECRET: 'test',
    PAYPAL_CLIENT_ID: 'test',
    PAYPAL_CLIENT_SECRET: 'test',
    PAYPAL_LIVE: 'false',
    ...overrides,
  };
}

describe('Queue dispatcher', () => {
  it('selects the default production queue names when overrides are absent', () => {
    const env = makeEnv();

    expect(resolveQueueHandler('bestmcp-billing-webhooks', env)).toBe(handleWebhookQueue);
    expect(resolveQueueHandler('bestmcp-billing-audit', env)).toBe(handleAuditQueue);
    expect(resolveQueueHandler('bestmcp-billing-credits', env)).toBe(handleCreditsQueue);
  });

  it('selects overridden queue names from environment variables', () => {
    const env = makeEnv({
      WEBHOOK_QUEUE_NAME: 'bestmcp-billing-skuangles-sandbox-webhooks',
      AUDIT_QUEUE_NAME: 'bestmcp-billing-skuangles-sandbox-audit',
      CREDITS_QUEUE_NAME: 'bestmcp-billing-skuangles-sandbox-credits',
    });

    expect(resolveQueueHandler('bestmcp-billing-skuangles-sandbox-webhooks', env)).toBe(handleWebhookQueue);
    expect(resolveQueueHandler('bestmcp-billing-skuangles-sandbox-audit', env)).toBe(handleAuditQueue);
    expect(resolveQueueHandler('bestmcp-billing-skuangles-sandbox-credits', env)).toBe(handleCreditsQueue);
  });

  it('falls back to defaults when only some overrides are provided', () => {
    const env = makeEnv({ CREDITS_QUEUE_NAME: 'custom-credits-queue' });

    expect(resolveQueueHandler('bestmcp-billing-webhooks', env)).toBe(handleWebhookQueue);
    expect(resolveQueueHandler('bestmcp-billing-audit', env)).toBe(handleAuditQueue);
    expect(resolveQueueHandler('custom-credits-queue', env)).toBe(handleCreditsQueue);
    expect(resolveQueueHandler('bestmcp-billing-credits', env)).toBeNull();
  });

  it('returns null for unrecognized queue names', () => {
    const env = makeEnv();

    expect(resolveQueueHandler('bestmcp-billing-unknown', env)).toBeNull();
    expect(resolveQueueHandler('', env)).toBeNull();
  });
});
