import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  claimCheckoutAttempt,
  getCheckoutAttempt,
  getStripeIdempotencyKey,
  isCheckoutRequestId,
  markCheckoutAttemptOpen,
} from '../src/lib/checkout-attempt';

async function ensureCheckoutAttemptsTable() {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS checkout_attempts (
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      client_request_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      status TEXT NOT NULL,
      stripe_checkout_session_id TEXT UNIQUE,
      session_expires_at INTEGER,
      lock_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, product_id)
    )
  `).run();
}

describe('checkout attempt idempotency', () => {
  it('accepts only UUID v4 client request IDs', () => {
    expect(isCheckoutRequestId(crypto.randomUUID())).toBe(true);
    expect(isCheckoutRequestId('same-key-for-every-user')).toBe(false);
    expect(isCheckoutRequestId(null)).toBe(false);
  });

  it('builds stable Stripe keys without exposing the attempt ID', async () => {
    const attemptId = crypto.randomUUID();
    const first = await getStripeIdempotencyKey('checkout', attemptId);
    const second = await getStripeIdempotencyKey('checkout', attemptId);
    const customer = await getStripeIdempotencyKey('customer', attemptId);

    expect(first).toBe(second);
    expect(first).not.toBe(customer);
    expect(first).not.toContain(attemptId);
    expect(first.length).toBeLessThanOrEqual(255);
  });

  it('allows only one concurrent creator per user and product', async () => {
    await ensureCheckoutAttemptsTable();
    const userId = `checkout-user-${crypto.randomUUID()}`;
    const productId = `checkout-product-${crypto.randomUUID()}`;
    const planId = `checkout-plan-${crypto.randomUUID()}`;

    const claims = await Promise.all(Array.from({ length: 8 }, () => claimCheckoutAttempt(
      env.DB,
      userId,
      productId,
      planId,
      crypto.randomUUID(),
    )));

    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    await markCheckoutAttemptOpen(
      env.DB,
      winner.attempt,
      winner.ownerToken,
      `cs_test_${crypto.randomUUID()}`,
      Math.floor(Date.now() / 1000) + 3600,
    );
    expect((await getCheckoutAttempt(env.DB, userId, productId))?.status).toBe('open');

    expect(await claimCheckoutAttempt(
      env.DB,
      userId,
      productId,
      planId,
      crypto.randomUUID(),
    )).toBeNull();
  });

  it('reclaims a stale creator with the same Stripe attempt and plan', async () => {
    await ensureCheckoutAttemptsTable();
    const userId = `checkout-stale-user-${crypto.randomUUID()}`;
    const productId = `checkout-stale-product-${crypto.randomUUID()}`;
    const originalPlanId = `checkout-plan-${crypto.randomUUID()}`;
    const originalRequestId = crypto.randomUUID();
    const first = await claimCheckoutAttempt(env.DB, userId, productId, originalPlanId, originalRequestId);
    expect(first).not.toBeNull();

    await env.DB.prepare(`
      UPDATE checkout_attempts SET lock_expires_at = unixepoch() - 1
      WHERE user_id = ? AND product_id = ?
    `).bind(userId, productId).run();

    const reclaimed = await claimCheckoutAttempt(
      env.DB,
      userId,
      productId,
      `different-plan-${crypto.randomUUID()}`,
      crypto.randomUUID(),
    );

    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attempt.attempt_id).toBe(first!.attempt.attempt_id);
    expect(reclaimed!.attempt.plan_id).toBe(originalPlanId);
    expect(reclaimed!.attempt.client_request_id).toBe(originalRequestId);
    expect(reclaimed!.ownerToken).not.toBe(first!.ownerToken);
  });

  it('replaces an expired open attempt with a fresh one', async () => {
    await ensureCheckoutAttemptsTable();
    const userId = `checkout-expired-user-${crypto.randomUUID()}`;
    const productId = `checkout-expired-product-${crypto.randomUUID()}`;
    const first = await claimCheckoutAttempt(
      env.DB,
      userId,
      productId,
      `old-plan-${crypto.randomUUID()}`,
      crypto.randomUUID(),
    );
    expect(first).not.toBeNull();
    await markCheckoutAttemptOpen(
      env.DB,
      first!.attempt,
      first!.ownerToken,
      `cs_expired_${crypto.randomUUID()}`,
      Math.floor(Date.now() / 1000) - 1,
    );

    const newPlanId = `new-plan-${crypto.randomUUID()}`;
    const replacement = await claimCheckoutAttempt(
      env.DB,
      userId,
      productId,
      newPlanId,
      crypto.randomUUID(),
    );

    expect(replacement).not.toBeNull();
    expect(replacement!.attempt.attempt_id).not.toBe(first!.attempt.attempt_id);
    expect(replacement!.attempt.plan_id).toBe(newPlanId);
  });
});
