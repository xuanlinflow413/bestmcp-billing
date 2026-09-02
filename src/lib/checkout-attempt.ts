import type { Env } from '../types';
import { sha256 } from './utils';

export type CheckoutAttemptStatus = 'creating' | 'open' | 'completed' | 'failed' | 'expired';

export interface CheckoutAttempt {
  user_id: string;
  product_id: string;
  attempt_id: string;
  client_request_id: string;
  plan_id: string;
  owner_token: string;
  status: CheckoutAttemptStatus;
  stripe_checkout_session_id: string | null;
  session_expires_at: number | null;
  lock_expires_at: number;
}

const CHECKOUT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCheckoutRequestId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHECKOUT_REQUEST_ID.test(value);
}

export async function getStripeIdempotencyKey(scope: 'customer' | 'checkout', attemptId: string): Promise<string> {
  const digest = await sha256(`bestmcp-billing:${scope}:v1:${attemptId}`);
  return `bestmcp-${scope}-v1-${digest}`;
}

export async function getCheckoutAttempt(
  db: Env['DB'],
  userId: string,
  productId: string,
): Promise<CheckoutAttempt | null> {
  return db.prepare(`
    SELECT user_id, product_id, attempt_id, client_request_id, plan_id,
      owner_token, status, stripe_checkout_session_id,
      session_expires_at, lock_expires_at
    FROM checkout_attempts
    WHERE user_id = ? AND product_id = ?
    LIMIT 1
  `).bind(userId, productId).first<CheckoutAttempt>();
}

export async function claimCheckoutAttempt(
  db: Env['DB'],
  userId: string,
  productId: string,
  planId: string,
  clientRequestId: string,
): Promise<{ attempt: CheckoutAttempt; ownerToken: string } | null> {
  const attemptId = crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  const attempt = await db.prepare(`
    INSERT INTO checkout_attempts (
      user_id, product_id, attempt_id, client_request_id, plan_id,
      owner_token, status, stripe_checkout_session_id,
      session_expires_at, lock_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'creating', NULL, NULL, unixepoch() + 120, unixepoch(), unixepoch())
    ON CONFLICT(user_id, product_id) DO UPDATE SET
      attempt_id = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.attempt_id
        ELSE excluded.attempt_id
      END,
      client_request_id = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.client_request_id
        ELSE excluded.client_request_id
      END,
      plan_id = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.plan_id
        ELSE excluded.plan_id
      END,
      owner_token = excluded.owner_token,
      status = 'creating',
      stripe_checkout_session_id = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.stripe_checkout_session_id
        ELSE NULL
      END,
      session_expires_at = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.session_expires_at
        ELSE NULL
      END,
      lock_expires_at = unixepoch() + 120,
      created_at = CASE
        WHEN checkout_attempts.status = 'creating' THEN checkout_attempts.created_at
        ELSE unixepoch()
      END,
      updated_at = unixepoch()
    WHERE
      (checkout_attempts.status = 'creating' AND checkout_attempts.lock_expires_at <= unixepoch())
      OR checkout_attempts.status IN ('failed', 'expired')
      OR (
        checkout_attempts.status = 'open'
        AND checkout_attempts.session_expires_at IS NOT NULL
        AND checkout_attempts.session_expires_at <= unixepoch()
      )
    RETURNING user_id, product_id, attempt_id, client_request_id, plan_id,
      owner_token, status, stripe_checkout_session_id,
      session_expires_at, lock_expires_at
  `).bind(
    userId,
    productId,
    attemptId,
    clientRequestId,
    planId,
    ownerToken,
  ).first<CheckoutAttempt>();

  return attempt ? { attempt, ownerToken } : null;
}

export async function markCheckoutAttemptExpired(
  db: Env['DB'],
  attempt: CheckoutAttempt,
): Promise<void> {
  await db.prepare(`
    UPDATE checkout_attempts
    SET status = 'expired', updated_at = unixepoch()
    WHERE user_id = ? AND product_id = ? AND attempt_id = ?
      AND status IN ('open', 'completed')
  `).bind(attempt.user_id, attempt.product_id, attempt.attempt_id).run();
}

export async function markCheckoutAttemptCompleted(
  db: Env['DB'],
  userId: string,
  productId: string,
  attemptId: string,
  stripeSessionId: string,
): Promise<void> {
  await db.prepare(`
    UPDATE checkout_attempts
    SET status = 'completed', lock_expires_at = 0, updated_at = unixepoch()
    WHERE user_id = ? AND product_id = ? AND attempt_id = ?
      AND stripe_checkout_session_id = ? AND status = 'open'
  `).bind(userId, productId, attemptId, stripeSessionId).run();
}

export async function markCheckoutAttemptOpen(
  db: Env['DB'],
  attempt: CheckoutAttempt,
  ownerToken: string,
  stripeSessionId: string,
  sessionExpiresAt: number,
): Promise<void> {
  const result = await db.prepare(`
    UPDATE checkout_attempts
    SET status = 'open', stripe_checkout_session_id = ?, session_expires_at = ?,
      lock_expires_at = 0, updated_at = unixepoch()
    WHERE user_id = ? AND product_id = ? AND attempt_id = ?
      AND owner_token = ? AND status = 'creating'
  `).bind(
    stripeSessionId,
    sessionExpiresAt,
    attempt.user_id,
    attempt.product_id,
    attempt.attempt_id,
    ownerToken,
  ).run();

  if (!result.success || (result.meta?.changes ?? 0) !== 1) {
    throw new Error('Checkout attempt could not be finalized safely');
  }
}

export async function shortenCheckoutAttemptLock(
  db: Env['DB'],
  attempt: CheckoutAttempt,
  ownerToken: string,
): Promise<void> {
  await db.prepare(`
    UPDATE checkout_attempts
    SET lock_expires_at = unixepoch() + 5, updated_at = unixepoch()
    WHERE user_id = ? AND product_id = ? AND attempt_id = ?
      AND owner_token = ? AND status = 'creating'
  `).bind(
    attempt.user_id,
    attempt.product_id,
    attempt.attempt_id,
    ownerToken,
  ).run();
}
