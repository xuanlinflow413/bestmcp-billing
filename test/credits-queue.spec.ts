import type { MessageBatch } from '@cloudflare/workers-types';
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleCreditsQueue } from '../src/queues/credits';
import type { Env } from '../src/types';

interface MonthlyResetMessage {
  type: 'monthly_reset';
  timestamp: number;
}

async function createCreditTables() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      credits_allocated INTEGER DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL,
      cancel_at_period_end INTEGER DEFAULT 0,
      credits_allocated INTEGER DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      balance INTEGER DEFAULT 0,
      lifetime_purchased INTEGER DEFAULT 0,
      lifetime_used INTEGER DEFAULT 0,
      updated_at INTEGER
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
      created_at INTEGER
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
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_queue_product_reference
      ON product_credit_ledger(user_id, product_id, reference_id)
      WHERE reference_id IS NOT NULL`),
  ]);
}

async function seedSubscription(userId: string, productId: string, credits: number) {
  const planId = `plan-${productId}-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO plans (id, product_id, credits_allocated)
      VALUES (?, ?, ?)`).bind(planId, productId, credits),
    env.DB.prepare(`INSERT INTO subscriptions (
      id, user_id, plan_id, status, cancel_at_period_end, credits_allocated
    ) VALUES (?, ?, ?, 'active', 0, ?)`)
      .bind(crypto.randomUUID(), userId, planId, credits),
  ]);
}

async function seedStripeSubscription(userId: string, productId: string, credits: number) {
  const planId = `plan-${productId}-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO plans (id, product_id, credits_allocated)
      VALUES (?, ?, ?)`).bind(planId, productId, credits),
    env.DB.prepare(`INSERT INTO subscriptions (
      id, user_id, plan_id, stripe_subscription_id, status, cancel_at_period_end, credits_allocated
    ) VALUES (?, ?, ?, ?, 'active', 0, ?)`)
      .bind(crypto.randomUUID(), userId, planId, `sub-${crypto.randomUUID()}`, credits),
  ]);
}

function monthlyResetBatch(timestamp: number) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    queue: 'bestmcp-billing-credits',
    messages: [{
      id: crypto.randomUUID(),
      timestamp: new Date(timestamp),
      body: { type: 'monthly_reset', timestamp } satisfies MonthlyResetMessage,
      attempts: 1,
      ack,
      retry,
    }],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<MonthlyResetMessage>;
  return { batch, ack, retry };
}

describe('monthly credits queue', () => {
  it('routes required and configured v2 products to isolated balances idempotently', async () => {
    await createCreditTables();
    const skuUserId = `sku-${crypto.randomUUID()}`;
    const editImagesUserId = `editimages-${crypto.randomUUID()}`;
    const configuredUserId = `configured-${crypto.randomUUID()}`;
    const legacyUserId = `legacy-${crypto.randomUUID()}`;
    const stripeUserId = `stripe-${crypto.randomUUID()}`;
    await seedSubscription(skuUserId, 'prod_skuangles', 20);
    await seedSubscription(editImagesUserId, 'prod_editimages', 25);
    await seedSubscription(configuredUserId, 'prod_configured_v2', 30);
    await seedSubscription(legacyUserId, 'prod_legacy', 40);
    await seedStripeSubscription(stripeUserId, 'prod_skuangles', 99);

    const queueEnv = {
      ...env,
      PRODUCT_CREDITS_V2_PRODUCTS: 'prod_configured_v2',
    } as Env;
    const timestamp = Date.UTC(2026, 8, 1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { batch, ack, retry } = monthlyResetBatch(timestamp);
      await handleCreditsQueue(batch, queueEnv);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    }

    for (const [userId, productId, amount] of [
      [skuUserId, 'prod_skuangles', 20],
      [editImagesUserId, 'prod_editimages', 25],
      [configuredUserId, 'prod_configured_v2', 30],
    ] as const) {
      expect(await env.DB.prepare(`SELECT balance, lifetime_purchased
        FROM product_credit_balances WHERE user_id = ? AND product_id = ?`)
        .bind(userId, productId).first()).toEqual({
        balance: amount,
        lifetime_purchased: amount,
      });
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
        FROM product_credit_ledger
        WHERE user_id = ? AND product_id = ? AND type = 'subscription_grant'`)
        .bind(userId, productId).first()).toEqual({ count: 1, amount });
      expect(await env.DB.prepare('SELECT 1 AS found FROM credits WHERE user_id = ?')
        .bind(userId).first()).toBeNull();
    }

    expect(await env.DB.prepare(`SELECT balance, lifetime_purchased
      FROM credits WHERE user_id = ?`).bind(legacyUserId).first()).toEqual({
      balance: 40,
      lifetime_purchased: 40,
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM credit_transactions
      WHERE user_id = ? AND type = 'subscription_grant'`)
      .bind(legacyUserId).first()).toEqual({ count: 1, amount: 40 });
    expect(await env.DB.prepare(`SELECT 1 AS found FROM product_credit_balances
      WHERE user_id = ?`).bind(legacyUserId).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 AS found FROM product_credit_balances
      WHERE user_id = ?`).bind(stripeUserId).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 AS found FROM credits
      WHERE user_id = ?`).bind(stripeUserId).first()).toBeNull();
  });
});
