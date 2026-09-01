import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  getInitialProductCredits,
  getProductConfigForHost,
  requiresProductCreditsV2,
} from '../src/lib/product-config';
import { createSession } from '../src/lib/auth';
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

async function createProductCreditTables() {
  await createBillingTables();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL,
      email_verified INTEGER DEFAULT 1,
      stripe_customer_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_balances (
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      lifetime_purchased INTEGER NOT NULL DEFAULT 0,
      lifetime_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, product_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT,
      reference_id TEXT,
      idempotency_key TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (user_id, product_id, idempotency_key)
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_test_credit_reference
      ON product_credit_ledger(user_id, product_id, reference_id)
      WHERE reference_id IS NOT NULL`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_reservations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, product_id, idempotency_key),
      UNIQUE(user_id, product_id, reference_id)
    )`),
    env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug, description, is_active)
      VALUES ('prod_skuangles', 'SKU Angles', 'skuangles', 'Product angle images', 1)`),
  ]);
}

async function createSkuSession() {
  await createProductCreditTables();
  const userId = `sku-user-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, is_active)
    VALUES (?, ?, 'SKU Tester', 'user', 1)`).bind(userId, email).run();
  const token = await createSession({ id: userId, email, role: 'user' } as any, env.KV_SESSIONS, env.JWT_SECRET);
  return { userId, token };
}

describe('SKU Angles shared auth and billing', () => {
  it('maps the trusted SKU Angles hosts to an isolated product', () => {
    const config = getProductConfigForHost('auth.skuangles.com');

    expect(config).toMatchObject({
      productId: 'prod_skuangles',
      appUrl: 'https://skuangles.com',
      oauthRedirectUri: 'https://auth.bestmcpservers.com/api/auth/google/callback',
    });
    expect(getCheckoutReturnUrls(config!)).toEqual({
      successUrl: 'https://skuangles.com/account/?checkout=success',
      cancelUrl: 'https://skuangles.com/pricing/?checkout=canceled',
    });
    expect(requiresProductCreditsV2('prod_skuangles')).toBe(true);
    expect(getInitialProductCredits('prod_skuangles')).toBe(1);
  });

  it('maps the exact sandbox workers.dev host to the production SKU Angles product', () => {
    const config = getProductConfigForHost('bestmcp-billing-skuangles-sandbox.xuanlinflow.workers.dev');

    expect(config).toMatchObject({
      productId: 'prod_skuangles',
      appUrl: 'https://skuangles.com',
      oauthRedirectUri: 'https://auth.bestmcpservers.com/api/auth/google/callback',
    });
    expect(getCheckoutReturnUrls(config!)).toEqual({
      successUrl: 'https://skuangles.com/account/?checkout=success',
      cancelUrl: 'https://skuangles.com/pricing/?checkout=canceled',
    });
  });

  it('rejects unknown workers.dev hosts instead of accepting a wildcard', () => {
    expect(getProductConfigForHost('bestmcp-billing-other.xuanlinflow.workers.dev')).toBeNull();
    expect(getProductConfigForHost('attacker-workers-dev.xuanlinflow.workers.dev')).toBeNull();
    expect(getProductConfigForHost('skuangles.com.attacker.example')).toBeNull();
  });

  it('uses the shared Google callback and accepts only the SKU Angles return host', async () => {
    const response = await SELF.fetch(
      'http://auth.skuangles.com/api/auth/google?returnUrl=https%3A%2F%2Fskuangles.com%2Faccount%2F',
      { redirect: 'manual' },
    );
    const location = new URL(response.headers.get('location') || '');

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://auth.bestmcpservers.com/api/auth/google/callback',
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
      ) VALUES (?, 'prod_skuangles', 'SKU Test', 'price_test_sku', 'month', 1200, 20, 1)`)
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

  it('reserves, refunds, and idempotently completes SKU Angles credits', async () => {
    const { userId, token } = await createSkuSession();
    const request = (path: string, body: Record<string, string>) => SELF.fetch(
      `http://auth.skuangles.com/api/credits/skuangles/${path}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    const firstKey = `sku-reserve-${crypto.randomUUID()}`;
    const first = await request('reserve', { idempotency_key: firstKey });
    const firstBody = await first.json() as { balance: number; reference_id: string };
    expect(first.status).toBe(201);
    expect(firstBody.balance).toBe(0);

    const duplicate = await request('reserve', { idempotency_key: firstKey });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as Record<string, unknown>;
    expect(duplicateBody).toMatchObject({ duplicate: true, status: 'pending' });
    expect(duplicateBody).not.toHaveProperty('reference_id');

    const refunded = await request('refund', { reference_id: firstBody.reference_id });
    expect(refunded.status).toBe(200);
    expect(await refunded.json()).toMatchObject({ balance: 1, alreadyProcessed: false });
    const refundedAgain = await request('refund', { reference_id: firstBody.reference_id });
    expect(refundedAgain.status).toBe(200);
    expect(await refundedAgain.json()).toMatchObject({ balance: 1, alreadyProcessed: true });

    const second = await request('reserve', { idempotency_key: `sku-complete-${crypto.randomUUID()}` });
    const secondBody = await second.json() as { reference_id: string };
    expect(second.status).toBe(201);
    expect((await request('complete', { reference_id: secondBody.reference_id })).status).toBe(200);
    expect((await request('complete', { reference_id: secondBody.reference_id })).status).toBe(200);
    expect((await request('refund', { reference_id: secondBody.reference_id })).status).toBe(404);

    const balance = await env.DB.prepare(`SELECT balance, lifetime_used
      FROM product_credit_balances WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first<{ balance: number; lifetime_used: number }>();
    expect(balance).toEqual({ balance: 0, lifetime_used: 1 });
  });

  it('atomically reserves only one credit for concurrent duplicate requests', async () => {
    const { userId, token } = await createSkuSession();
    const idempotencyKey = `sku-race-${crypto.randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => SELF.fetch(
      'http://auth.skuangles.com/api/credits/skuangles/reserve',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      },
    )));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(7);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(await response.json()).not.toHaveProperty('reference_id');
    }

    const balance = await env.DB.prepare(`SELECT balance, lifetime_used
      FROM product_credit_balances WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first<{ balance: number; lifetime_used: number }>();
    expect(balance).toEqual({ balance: 0, lifetime_used: 1 });
    const ledger = await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM product_credit_ledger WHERE user_id = ? AND product_id = 'prod_skuangles' AND type = 'usage'`)
      .bind(userId).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it('refunds a pending reservation only once under concurrency', async () => {
    const { userId, token } = await createSkuSession();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const reserve = await SELF.fetch('http://auth.skuangles.com/api/credits/skuangles/reserve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ idempotency_key: `sku-refund-race-${crypto.randomUUID()}` }),
    });
    const { reference_id: referenceId } = await reserve.json() as { reference_id: string };

    const responses = await Promise.all(Array.from({ length: 8 }, () => SELF.fetch(
      'http://auth.skuangles.com/api/credits/skuangles/refund',
      { method: 'POST', headers, body: JSON.stringify({ reference_id: referenceId }) },
    )));
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const balance = await env.DB.prepare(`SELECT balance, lifetime_used
      FROM product_credit_balances WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first<{ balance: number; lifetime_used: number }>();
    expect(balance).toEqual({ balance: 1, lifetime_used: 0 });
    const ledger = await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM product_credit_ledger WHERE user_id = ? AND product_id = 'prod_skuangles' AND type = 'refund'`)
      .bind(userId).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it('does not let one shared-account user settle another user reservation', async () => {
    const owner = await createSkuSession();
    const other = await createSkuSession();
    const reserve = await SELF.fetch('http://auth.skuangles.com/api/credits/skuangles/reserve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: `sku-owner-${crypto.randomUUID()}` }),
    });
    const { reference_id: referenceId } = await reserve.json() as { reference_id: string };

    for (const action of ['complete', 'refund']) {
      const response = await SELF.fetch(`http://auth.skuangles.com/api/credits/skuangles/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_id: referenceId }),
      });
      expect(response.status).toBe(action === 'complete' ? 409 : 404);
    }

    const reservation = await env.DB.prepare(`SELECT status FROM product_credit_reservations
      WHERE user_id = ? AND product_id = 'prod_skuangles' AND reference_id = ?`)
      .bind(owner.userId, referenceId).first<{ status: string }>();
    expect(reservation?.status).toBe('pending');
  });

  it('blocks unscoped Stripe portal and invoice history on the SKU host', async () => {
    const { token } = await createSkuSession();
    const headers = { Authorization: `Bearer ${token}` };
    const portal = await SELF.fetch('http://auth.skuangles.com/api/billing/portal', { method: 'POST', headers });
    const invoices = await SELF.fetch('http://auth.skuangles.com/api/billing/invoices', { headers });

    expect(portal.status).toBe(404);
    expect(await portal.json()).toMatchObject({ code: 'BILLING_HISTORY_UNAVAILABLE' });
    expect(invoices.status).toBe(404);
    expect(await invoices.json()).toMatchObject({ code: 'BILLING_HISTORY_UNAVAILABLE' });
  });
});
