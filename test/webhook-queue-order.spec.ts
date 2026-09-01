import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeMocks = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  listInvoiceLineItems: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    subscriptions = { retrieve: stripeMocks.retrieveSubscription };
    invoices = { listLineItems: stripeMocks.listInvoiceLineItems };
    checkout = { sessions: { listLineItems: vi.fn() } };
  },
}));

import { handleWebhookQueue } from '../src/queues/webhook';

async function createWebhookBillingTables() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar_url TEXT,
      role TEXT DEFAULT 'user',
      email_verified INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      stripe_price_id TEXT UNIQUE,
      billing_interval TEXT,
      price_cents INTEGER NOT NULL,
      credits_allocated INTEGER DEFAULT 0,
      rate_limit_rpm INTEGER DEFAULT 60,
      rate_limit_rpd INTEGER DEFAULT 2000,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'past_due', 'unpaid', 'trialing')),
      current_period_start INTEGER,
      current_period_end INTEGER,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      balance INTEGER DEFAULT 0,
      lifetime_purchased INTEGER DEFAULT 0,
      lifetime_used INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT,
      reference_id TEXT,
      product TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_balances (
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
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
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_order_product_credit_reference
      ON product_credit_ledger(user_id, product_id, reference_id)
      WHERE reference_id IS NOT NULL`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      stripe_event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      processing_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      processed_at INTEGER
    )`),
  ]);
}

function queueMessage(eventId: string, type: string, data: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      body: { eventId, type, data, timestamp: Date.now() },
      ack,
      retry,
    },
    ack,
    retry,
  };
}

function testEnv() {
  return {
    DB: env.DB,
    STRIPE_SECRET_KEY: 'sk_test_webhook_order',
    // SKU Angles must stay product-scoped even if the optional rollout env var is missing.
    PRODUCT_CREDITS_V2_PRODUCTS: '',
  } as any;
}

function stripeSubscription(input: {
  subscriptionId: string;
  customerId: string;
  userId: string;
  planId: string;
  productId: string;
  priceId: string;
}) {
  return {
    id: input.subscriptionId,
    customer: input.customerId,
    status: 'active',
    cancel_at_period_end: false,
    metadata: {
      user_id: input.userId,
      plan_id: input.planId,
      product_id: input.productId,
    },
    items: {
      data: [{
        price: { id: input.priceId },
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_678_400,
      }],
    },
  };
}

function invoiceSubscriptionLine(priceId: string, subscriptionId: string, proration = false) {
  return {
    id: `il_${priceId}`,
    pricing: {
      price_details: { price: priceId },
    },
    parent: {
      subscription_item_details: {
        subscription: subscriptionId,
        proration,
      },
    },
  };
}

function renewalInvoice(input: {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  userId: string;
  planId: string;
  productId: string;
  priceId: string;
}) {
  return {
    id: input.invoiceId,
    customer: input.customerId,
    billing_reason: 'subscription_cycle',
    lines: { data: [invoiceSubscriptionLine(input.priceId, input.subscriptionId)] },
    parent: {
      subscription_details: {
        subscription: input.subscriptionId,
        metadata: {
          user_id: input.userId,
          plan_id: input.planId,
          product_id: input.productId,
        },
      },
    },
  };
}

beforeAll(createWebhookBillingTables);

beforeEach(() => {
  stripeMocks.retrieveSubscription.mockReset();
  stripeMocks.listInvoiceLineItems.mockReset();
  stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: [] });
});

describe('Stripe webhook queue event ordering', () => {
  it('creates a SKU Angles subscription and grants product credits when invoice.paid arrives first', async () => {
    const suffix = crypto.randomUUID();
    const userId = `sku-user-${suffix}`;
    const planId = `sku-plan-${suffix}`;
    const priceId = `price_sku_${suffix}`;
    const customerId = `cus_sku_${suffix}`;
    const subscriptionId = `sub_sku_${suffix}`;
    const invoiceId = `in_sku_${suffix}`;
    const subscription = stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    });

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(planId, planId, priceId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(subscription);

    const invoicePayload = renewalInvoice({
      invoiceId,
      customerId,
      subscriptionId,
      userId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    });
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: invoicePayload.lines.data });
    const invoiceFirst = queueMessage(`evt_invoice_first_${suffix}`, 'invoice.paid', invoicePayload);
    await handleWebhookQueue({ messages: [invoiceFirst.message] } as any, testEnv());

    expect(invoiceFirst.ack).toHaveBeenCalledOnce();
    expect(invoiceFirst.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare(`SELECT user_id, plan_id, stripe_customer_id,
      status, current_period_start, current_period_end
      FROM subscriptions WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId).first()).toEqual({
        user_id: userId,
        plan_id: planId,
        stripe_customer_id: customerId,
        status: 'active',
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_678_400,
      });
    expect(await env.DB.prepare(`SELECT balance, lifetime_purchased, lifetime_used
      FROM product_credit_balances WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first()).toEqual({
        balance: 20,
        lifetime_purchased: 20,
        lifetime_used: 0,
      });

    const checkoutLater = queueMessage(`evt_checkout_later_${suffix}`, 'checkout.session.completed', {
      id: `cs_sku_${suffix}`,
      mode: 'subscription',
      customer: customerId,
      subscription: subscriptionId,
      metadata: { user_id: userId, plan_id: planId, product_id: 'prod_skuangles' },
    });
    await handleWebhookQueue({ messages: [checkoutLater.message] } as any, testEnv());

    const duplicateInvoice = queueMessage(`evt_invoice_duplicate_${suffix}`, 'invoice.paid', invoicePayload);
    await handleWebhookQueue({ messages: [duplicateInvoice.message] } as any, testEnv());

    expect(checkoutLater.ack).toHaveBeenCalledOnce();
    expect(duplicateInvoice.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM subscriptions
      WHERE stripe_subscription_id = ?`).bind(subscriptionId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_ledger
      WHERE user_id = ? AND product_id = 'prod_skuangles' AND reference_id = ?`)
      .bind(userId, invoiceId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare(`SELECT balance FROM product_credit_balances
      WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first<{ balance: number }>()).toEqual({ balance: 20 });
  });

  it('grants a delayed Starter invoice from its snapshot without downgrading the current Pro subscription', async () => {
    const suffix = crypto.randomUUID();
    const userId = `delayed-invoice-user-${suffix}`;
    const starterPlanId = `delayed-starter-plan-${suffix}`;
    const proPlanId = `delayed-pro-plan-${suffix}`;
    const starterPriceId = `price_delayed_starter_${suffix}`;
    const proPriceId = `price_delayed_pro_${suffix}`;
    const customerId = `cus_delayed_${suffix}`;
    const subscriptionId = `sub_delayed_${suffix}`;
    const invoiceId = `in_delayed_starter_${suffix}`;
    const starterLine = invoiceSubscriptionLine(starterPriceId, subscriptionId);

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(starterPlanId, starterPlanId, starterPriceId),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Pro', ?, 'month', 2900, 50, 1)`)
        .bind(proPlanId, proPlanId, proPriceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status, current_period_start, current_period_end
      ) VALUES (?, ?, ?, ?, ?, 'active', 1800000000, 1802678400)`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, proPlanId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId: proPlanId,
      productId: 'prod_skuangles',
      priceId: proPriceId,
    }));
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: [starterLine] });

    const delayedStarterInvoice = queueMessage(`evt_delayed_starter_${suffix}`, 'invoice.paid', {
      id: invoiceId,
      customer: customerId,
      billing_reason: 'subscription_cycle',
      lines: { data: [starterLine] },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {
            user_id: userId,
            plan_id: starterPlanId,
            product_id: 'prod_skuangles',
          },
        },
      },
    });
    await handleWebhookQueue({ messages: [delayedStarterInvoice.message] } as any, testEnv());

    expect(delayedStarterInvoice.ack).toHaveBeenCalledOnce();
    expect(delayedStarterInvoice.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare(`SELECT plan_id, status
      FROM subscriptions WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId).first()).toEqual({
        plan_id: proPlanId,
        status: 'active',
      });
    expect(await env.DB.prepare(`SELECT amount, reference_id FROM product_credit_ledger
      WHERE user_id = ? AND product_id = 'prod_skuangles' AND reference_id = ?`)
      .bind(userId, invoiceId).first()).toEqual({
        amount: 20,
        reference_id: invoiceId,
      });
    expect(await env.DB.prepare(`SELECT balance, lifetime_purchased FROM product_credit_balances
      WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first()).toEqual({ balance: 20, lifetime_purchased: 20 });
  });

  it('does not grant a full-period credit allocation for a prorated subscription update invoice', async () => {
    const suffix = crypto.randomUUID();
    const userId = `proration-user-${suffix}`;
    const planId = `proration-plan-${suffix}`;
    const priceId = `price_proration_${suffix}`;
    const customerId = `cus_proration_${suffix}`;
    const subscriptionId = `sub_proration_${suffix}`;
    const invoiceId = `in_proration_${suffix}`;
    const proratedLine = invoiceSubscriptionLine(priceId, subscriptionId, true);

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Pro', ?, 'month', 2900, 50, 1)`)
        .bind(planId, planId, priceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status, current_period_start, current_period_end
      ) VALUES (?, ?, ?, ?, ?, 'active', 1800000000, 1802678400)`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, planId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    }));
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: [proratedLine] });

    const prorationInvoice = queueMessage(`evt_proration_${suffix}`, 'invoice.paid', {
      id: invoiceId,
      customer: customerId,
      billing_reason: 'subscription_update',
      lines: { data: [proratedLine] },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {
            user_id: userId,
            plan_id: planId,
            product_id: 'prod_skuangles',
          },
        },
      },
    });
    await handleWebhookQueue({ messages: [prorationInvoice.message] } as any, testEnv());

    expect(prorationInvoice.ack).toHaveBeenCalledOnce();
    expect(prorationInvoice.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_ledger
      WHERE user_id = ? AND product_id = 'prod_skuangles' AND reference_id = ?`)
      .bind(userId, invoiceId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_balances
      WHERE user_id = ? AND product_id = 'prod_skuangles'`)
      .bind(userId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('fails closed when an invoice price is unmapped instead of trusting stale plan metadata', async () => {
    const suffix = crypto.randomUUID();
    const userId = `unmapped-price-user-${suffix}`;
    const planId = `unmapped-price-plan-${suffix}`;
    const mappedPriceId = `price_mapped_${suffix}`;
    const unmappedPriceId = `price_unmapped_${suffix}`;
    const customerId = `cus_unmapped_${suffix}`;
    const subscriptionId = `sub_unmapped_${suffix}`;
    const invoiceId = `in_unmapped_${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Pro', ?, 'month', 2900, 50, 1)`)
        .bind(planId, planId, mappedPriceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status
      ) VALUES (?, ?, ?, ?, ?, 'active')`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, planId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId,
      productId: 'prod_skuangles',
      priceId: unmappedPriceId,
    }));

    const invoice = queueMessage(`evt_unmapped_${suffix}`, 'invoice.paid', {
      id: invoiceId,
      customer: customerId,
      billing_reason: 'subscription_cycle',
      lines: { data: [invoiceSubscriptionLine(unmappedPriceId, subscriptionId)] },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: { user_id: userId, plan_id: planId, product_id: 'prod_skuangles' },
        },
      },
    });
    await handleWebhookQueue({ messages: [invoice.message] } as any, testEnv());

    expect(invoice.ack).not.toHaveBeenCalled();
    expect(invoice.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_ledger
      WHERE user_id = ? AND reference_id = ?`)
      .bind(userId, invoiceId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM credits
      WHERE user_id = ?`).bind(userId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('fails closed when a delayed mapped invoice arrives after the live subscription moved to an unmapped price', async () => {
    const suffix = crypto.randomUUID();
    const userId = `unmapped-current-user-${suffix}`;
    const oldPlanId = `unmapped-current-old-plan-${suffix}`;
    const oldPriceId = `price_unmapped_current_old_${suffix}`;
    const newPriceId = `price_unmapped_current_new_${suffix}`;
    const customerId = `cus_unmapped_current_${suffix}`;
    const subscriptionId = `sub_unmapped_current_${suffix}`;
    const invoiceId = `in_unmapped_current_old_${suffix}`;
    const oldLine = invoiceSubscriptionLine(oldPriceId, subscriptionId);

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(oldPlanId, oldPlanId, oldPriceId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId: oldPlanId,
      productId: 'prod_skuangles',
      priceId: newPriceId,
    }));
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: [oldLine] });

    const delayedInvoice = queueMessage(`evt_unmapped_current_${suffix}`, 'invoice.paid', {
      id: invoiceId,
      customer: customerId,
      billing_reason: 'subscription_cycle',
      lines: { data: [oldLine] },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {
            user_id: userId,
            plan_id: oldPlanId,
            product_id: 'prod_skuangles',
          },
        },
      },
    });
    await handleWebhookQueue({ messages: [delayedInvoice.message] } as any, testEnv());

    expect(delayedInvoice.ack).not.toHaveBeenCalled();
    expect(delayedInvoice.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM subscriptions
      WHERE stripe_subscription_id = ?`).bind(subscriptionId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_ledger
      WHERE user_id = ? AND reference_id = ?`)
      .bind(userId, invoiceId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('syncs a canceled status for an existing subscription even when its live price is unmapped', async () => {
    const suffix = crypto.randomUUID();
    const userId = `unmapped-canceled-user-${suffix}`;
    const oldPlanId = `unmapped-canceled-old-plan-${suffix}`;
    const oldPriceId = `price_unmapped_canceled_old_${suffix}`;
    const newPriceId = `price_unmapped_canceled_new_${suffix}`;
    const customerId = `cus_unmapped_canceled_${suffix}`;
    const subscriptionId = `sub_unmapped_canceled_${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(oldPlanId, oldPlanId, oldPriceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status, current_period_start, current_period_end
      ) VALUES (?, ?, ?, ?, ?, 'active', 1800000000, 1802678400)`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, oldPlanId),
    ]);
    const current = {
      ...stripeSubscription({
        subscriptionId,
        customerId,
        userId,
        planId: oldPlanId,
        productId: 'prod_skuangles',
        priceId: newPriceId,
      }),
      status: 'canceled',
    };
    stripeMocks.retrieveSubscription.mockResolvedValue(current);

    const deleted = queueMessage(`evt_unmapped_canceled_${suffix}`, 'customer.subscription.deleted', current);
    await handleWebhookQueue({ messages: [deleted.message] } as any, testEnv());

    expect(deleted.ack).toHaveBeenCalledOnce();
    expect(deleted.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare(`SELECT plan_id, status FROM subscriptions
      WHERE stripe_subscription_id = ?`).bind(subscriptionId).first()).toEqual({
      plan_id: oldPlanId,
      status: 'canceled',
    });
  });

  it('keeps a canceled subscription canceled when a stale subscription.updated event arrives', async () => {
    const suffix = crypto.randomUUID();
    const userId = `stale-update-user-${suffix}`;
    const planId = `stale-update-plan-${suffix}`;
    const priceId = `price_stale_update_${suffix}`;
    const customerId = `cus_stale_update_${suffix}`;
    const subscriptionId = `sub_stale_update_${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(planId, planId, priceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status, current_period_start, current_period_end
      ) VALUES (?, ?, ?, ?, ?, 'canceled', 1800000000, 1802678400)`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, planId),
    ]);
    const staleActiveSubscription = stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    });
    stripeMocks.retrieveSubscription.mockResolvedValue({
      ...staleActiveSubscription,
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const staleUpdate = queueMessage(`evt_stale_update_${suffix}`, 'customer.subscription.updated', staleActiveSubscription);
    await handleWebhookQueue({ messages: [staleUpdate.message] } as any, testEnv());

    expect(staleUpdate.ack).toHaveBeenCalledOnce();
    expect(staleUpdate.retry).not.toHaveBeenCalled();
    expect(stripeMocks.retrieveSubscription).toHaveBeenCalledWith(subscriptionId);
    expect(await env.DB.prepare(`SELECT status FROM subscriptions WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId).first()).toEqual({ status: 'canceled' });
  });

  it('maps Stripe incomplete status to a blocking value supported by the live schema', async () => {
    const suffix = crypto.randomUUID();
    const userId = `incomplete-user-${suffix}`;
    const planId = `incomplete-plan-${suffix}`;
    const priceId = `price_incomplete_${suffix}`;
    const customerId = `cus_incomplete_${suffix}`;
    const subscriptionId = `sub_incomplete_${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(planId, planId, priceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id, plan_id, status
      ) VALUES (?, ?, ?, ?, ?, 'active')`)
        .bind(crypto.randomUUID(), userId, customerId, subscriptionId, planId),
    ]);
    const current = {
      ...stripeSubscription({ subscriptionId, customerId, userId, planId, productId: 'prod_skuangles', priceId }),
      status: 'incomplete',
    };
    stripeMocks.retrieveSubscription.mockResolvedValue(current);

    const update = queueMessage(`evt_incomplete_${suffix}`, 'customer.subscription.updated', current);
    await handleWebhookQueue({ messages: [update.message] } as any, testEnv());

    expect(update.ack).toHaveBeenCalledOnce();
    expect(update.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare(`SELECT status FROM subscriptions WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId).first()).toEqual({ status: 'past_due' });
  });

  it('preserves legacy shared-credit subscription grants and their invoice idempotency', async () => {
    const suffix = crypto.randomUUID();
    const userId = `legacy-user-${suffix}`;
    const planId = `legacy-plan-${suffix}`;
    const priceId = `price_legacy_${suffix}`;
    const customerId = `cus_legacy_${suffix}`;
    const subscriptionId = `sub_legacy_${suffix}`;
    const invoiceId = `in_legacy_${suffix}`;
    const subscription = stripeSubscription({
      subscriptionId,
      customerId,
      userId,
      planId,
      productId: 'prod_bestmcp',
      priceId,
    });

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(userId, `${userId}@example.test`, customerId),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_bestmcp', 'BestMCPServers', 'bestmcp')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_bestmcp', ?, 'Pro', ?, 'month', 999, 100, 1)`)
        .bind(planId, planId, priceId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(subscription);
    const invoicePayload = renewalInvoice({
      invoiceId,
      customerId,
      subscriptionId,
      userId,
      planId,
      productId: 'prod_bestmcp',
      priceId,
    });
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: invoicePayload.lines.data });

    for (const eventId of [`evt_legacy_first_${suffix}`, `evt_legacy_duplicate_${suffix}`]) {
      const invoice = queueMessage(eventId, 'invoice.paid', invoicePayload);
      await handleWebhookQueue({ messages: [invoice.message] } as any, testEnv());
      expect(invoice.ack).toHaveBeenCalledOnce();
      expect(invoice.retry).not.toHaveBeenCalled();
    }

    expect(await env.DB.prepare('SELECT balance, lifetime_purchased FROM credits WHERE user_id = ?')
      .bind(userId).first()).toEqual({ balance: 100, lifetime_purchased: 100 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM credit_transactions
      WHERE user_id = ? AND reference_id = ?`).bind(userId, invoiceId).first<{ count: number }>())
      .toEqual({ count: 1 });
  });

  it('retries instead of changing ownership when Stripe metadata conflicts with an existing subscription', async () => {
    const suffix = crypto.randomUUID();
    const ownerId = `owner-${suffix}`;
    const otherUserId = `other-${suffix}`;
    const planId = `owner-plan-${suffix}`;
    const priceId = `price_owner_${suffix}`;
    const customerId = `cus_owner_${suffix}`;
    const subscriptionId = `sub_owner_${suffix}`;
    const invoiceId = `in_owner_${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(ownerId, `${ownerId}@example.test`, customerId),
      env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id)
        VALUES (?, ?, ?)`).bind(otherUserId, `${otherUserId}@example.test`, `cus_other_${suffix}`),
      env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug)
        VALUES ('prod_skuangles', 'SKU Angles', 'skuangles')`),
      env.DB.prepare(`INSERT INTO plans (
        id, product_id, slug, name, stripe_price_id, billing_interval,
        price_cents, credits_allocated, is_active
      ) VALUES (?, 'prod_skuangles', ?, 'Starter', ?, 'month', 1200, 20, 1)`)
        .bind(planId, planId, priceId),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status
      ) VALUES (?, ?, ?, ?, ?, 'active')`)
        .bind(crypto.randomUUID(), ownerId, customerId, subscriptionId, planId),
    ]);
    stripeMocks.retrieveSubscription.mockResolvedValue(stripeSubscription({
      subscriptionId,
      customerId,
      userId: otherUserId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    }));
    const invoicePayload = renewalInvoice({
      invoiceId,
      customerId,
      subscriptionId,
      userId: otherUserId,
      planId,
      productId: 'prod_skuangles',
      priceId,
    });
    stripeMocks.listInvoiceLineItems.mockResolvedValue({ data: invoicePayload.lines.data });

    const conflictingInvoice = queueMessage(`evt_owner_conflict_${suffix}`, 'invoice.paid', invoicePayload);
    await handleWebhookQueue({ messages: [conflictingInvoice.message] } as any, testEnv());

    expect(conflictingInvoice.ack).not.toHaveBeenCalled();
    expect(conflictingInvoice.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId).first()).toEqual({ user_id: ownerId });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM product_credit_ledger
      WHERE reference_id = ?`).bind(invoiceId).first<{ count: number }>()).toEqual({ count: 0 });
  });
});
