import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  getInitialProductCredits,
  getProductConfigForHost,
  requiresProductCreditsV2,
} from '../src/lib/product-config';
import { getCheckoutReturnUrls } from '../src/routes/billing';

async function createBillingTables() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      stripe_price_id TEXT,
      billing_interval TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      credits_allocated INTEGER DEFAULT 0,
      rate_limit_rpm INTEGER DEFAULT 60,
      rate_limit_rpd INTEGER DEFAULT 2000,
      features TEXT,
      is_active INTEGER DEFAULT 1
    )`),
  ]);
}

describe('SKU Angles shared auth and billing', () => {
  it('maps the trusted SKU Angles hosts to an isolated product', () => {
    const config = getProductConfigForHost('auth.skuangles.com');

    expect(config).toMatchObject({
      productId: 'prod_skuangles',
      appUrl: 'https://skuangles.com',
      oauthRedirectUri: 'https://auth.skuangles.com/api/auth/google/callback',
    });
    expect(getCheckoutReturnUrls(config!)).toEqual({
      successUrl: 'https://skuangles.com/account/?checkout=success',
      cancelUrl: 'https://skuangles.com/pricing/?checkout=canceled',
    });
    expect(requiresProductCreditsV2('prod_skuangles')).toBe(true);
    expect(getInitialProductCredits('prod_skuangles')).toBe(3);
  });

  it('uses the SKU Angles Google callback and accepts only its trusted return host', async () => {
    const response = await SELF.fetch(
      'http://auth.skuangles.com/api/auth/google?returnUrl=https%3A%2F%2Fskuangles.com%2Faccount%2F',
      { redirect: 'manual' },
    );
    const location = new URL(response.headers.get('location') || '');

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://auth.skuangles.com/api/auth/google/callback',
    );
  });

  it('returns only SKU Angles plans on its billing host', async () => {
    await createBillingTables();
    const suffix = crypto.randomUUID();
    const skuPlanId = `skuangles-test-${suffix}`;
    const otherPlanId = `editimages-test-${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles', 'Product angle images', 1)`),
      env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
        VALUES ('prod_editimages', 'EditImages', 'editimages', 'Image tools', 1)`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', 'SKU Test', 'price_test_sku', 'month', 1200, 80, 1)`)
        .bind(skuPlanId),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_editimages', 'Edit Test', 'price_test_edit', 'month', 900, 100, 1)`)
        .bind(otherPlanId),
    ]);

    const response = await SELF.fetch('http://auth.skuangles.com/api/billing/plans');
    const body = await response.json() as { plans: Array<{ id: string; product_id: string }> };

    expect(response.status).toBe(200);
    expect(body.plans).toContainEqual(expect.objectContaining({
      id: skuPlanId,
      product_id: 'prod_skuangles',
    }));
    expect(body.plans.some((plan) => plan.id === otherPlanId)).toBe(false);
  });

  it('allows SKU Angles CORS without trusting a lookalike origin', async () => {
    const allowed = await SELF.fetch('http://auth.skuangles.com/health', {
      headers: { Origin: 'https://skuangles.com' },
    });
    const denied = await SELF.fetch('http://auth.skuangles.com/health', {
      headers: { Origin: 'https://skuangles.com.attacker.example' },
    });

    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://skuangles.com');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps checkout protected before any Stripe session can be created', async () => {
    const response = await SELF.fetch('http://auth.skuangles.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'skuangles-starter-monthly' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
  });
});
