import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStripeIdempotencyKey } from '../src/lib/checkout-attempt';
import { billingRoutes } from '../src/routes/billing';
import type { Env as WorkerEnv } from '../src/types';

const stripeMocks = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  createSession: vi.fn(),
  expireSession: vi.fn(),
  retrieveSession: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    customers = { create: stripeMocks.createCustomer };
    checkout = {
      sessions: {
        create: stripeMocks.createSession,
        expire: stripeMocks.expireSession,
        retrieve: stripeMocks.retrieveSession,
      },
    };
  },
}));

async function createCheckoutTables() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, avatar_url TEXT,
      role TEXT DEFAULT 'user', email_verified INTEGER DEFAULT 1,
      stripe_customer_id TEXT, is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      description TEXT, is_active INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, stripe_price_id TEXT UNIQUE, billing_interval TEXT,
      price_cents INTEGER NOT NULL, credits_allocated INTEGER DEFAULT 0,
      rate_limit_rpm INTEGER DEFAULT 60, rate_limit_rpd INTEGER DEFAULT 2000,
      is_active INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE, plan_id TEXT NOT NULL, status TEXT NOT NULL,
      current_period_start INTEGER, current_period_end INTEGER,
      cancel_at_period_end INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      stripe_checkout_session_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS checkout_attempts (
      user_id TEXT NOT NULL, product_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
      client_request_id TEXT NOT NULL, plan_id TEXT NOT NULL, owner_token TEXT NOT NULL,
      status TEXT NOT NULL, stripe_checkout_session_id TEXT UNIQUE,
      session_expires_at INTEGER, lock_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, product_id)
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, is_active)
      VALUES ('prod_skuangles', 'SKU Angles', 'skuangles', 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, is_active)
      VALUES ('prod_bestmcp', 'BestMCPServers', 'bestmcp', 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO plans (
      id, product_id, slug, name, stripe_price_id, billing_interval,
      price_cents, credits_allocated, is_active
    ) VALUES
      ('skuangles-starter-monthly', 'prod_skuangles', 'skuangles-starter-monthly', 'Starter', 'price_test_starter', 'month', 1200, 20, 1),
      ('skuangles-pro-monthly', 'prod_skuangles', 'skuangles-pro-monthly', 'Pro', 'price_test_pro', 'month', 2900, 50, 1),
      ('plan_bestmcp_pro', 'prod_bestmcp', 'bestmcp-pro', 'Pro', 'price_test_bestmcp_pro', 'month', 999, 1000, 1),
      ('plan_bestmcp_security_audit', 'prod_bestmcp', 'bestmcp-security-audit', 'Security Audit', 'price_test_audit', 'one_time', 2900, 0, 1)`),
  ]);
}

function checkoutRequest(
  host: string,
  userId: string,
  planId: string,
  requestId = crypto.randomUUID(),
) {
  return SELF.fetch(`http://${host}/api/billing/checkout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.INTERNAL_API_KEY}`,
      'X-User-ID': userId,
      'Content-Type': 'application/json',
      'Idempotency-Key': requestId,
    },
    body: JSON.stringify({ plan_id: planId }),
  });
}

function checkoutRouteRequest(
  host: string,
  userId: string,
  planId: string,
  bindings: Partial<WorkerEnv>,
  body: Record<string, unknown> = { plan_id: planId },
) {
  return billingRoutes.request(`http://${host}/checkout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.INTERNAL_API_KEY}`,
      'X-User-ID': userId,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  }, { ...env, ...bindings } as unknown as WorkerEnv);
}

async function createUser(stripeCustomerId: string | null = null) {
  const userId = `checkout-route-user-${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO users (
    id, email, name, role, email_verified, stripe_customer_id, is_active
  ) VALUES (?, ?, 'Checkout Tester', 'user', 1, ?, 1)`)
    .bind(userId, `${userId}@example.test`, stripeCustomerId)
    .run();
  return userId;
}

function mockOpenSession(
  id = `cs_test_${crypto.randomUUID()}`,
  metadata: Record<string, string> = {},
) {
  const session = {
    id,
    status: 'open',
    url: `https://checkout.stripe.com/c/pay/${id}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    metadata,
  };
  stripeMocks.createSession.mockResolvedValue(session);
  stripeMocks.retrieveSession.mockResolvedValue(session);
  return session;
}

async function createOpenSkuanglesAttempt(
  userId: string,
  session: ReturnType<typeof mockOpenSession>,
) {
  const attemptId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO checkout_attempts (
    user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
    status, stripe_checkout_session_id, session_expires_at, lock_expires_at
  ) VALUES (?, 'prod_skuangles', ?, ?, 'skuangles-starter-monthly', ?,
    'open', ?, ?, 0)`)
    .bind(
      userId,
      attemptId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      session.id,
      session.expires_at,
    )
    .run();
}

beforeAll(createCheckoutTables);

beforeEach(() => {
  stripeMocks.createCustomer.mockReset();
  stripeMocks.createSession.mockReset();
  stripeMocks.expireSession.mockReset();
  stripeMocks.retrieveSession.mockReset();
  stripeMocks.createCustomer.mockResolvedValue({ id: `cus_test_${crypto.randomUUID()}` });
  stripeMocks.expireSession.mockResolvedValue({ status: 'expired' });
  mockOpenSession();
});

describe('checkout route idempotency', () => {
  it('applies exactly one server-configured coupon to the allowlisted SKU Angles Starter user', async () => {
    const userId = await createUser();

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
      {
        SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1',
        SKUANGLES_LIVE_TEST_USER_ID: userId,
        SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter',
      },
    );

    expect(response.status).toBe(200);
    expect(stripeMocks.createSession).toHaveBeenCalledOnce();
    expect(stripeMocks.createSession.mock.calls[0][0].discounts).toEqual([
      { coupon: 'coupon_test_starter' },
    ]);
  });

  it.each([
    [
      'user does not match, even with a client coupon',
      'skuangles-starter-monthly',
      { SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1', SKUANGLES_LIVE_TEST_USER_ID: 'another-user', SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_server_only' },
      { plan_id: 'skuangles-starter-monthly', coupon: 'coupon_client_supplied' },
    ],
    [
      'plan is Pro',
      'skuangles-pro-monthly',
      { SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1', SKUANGLES_LIVE_TEST_USER_ID: 'TEST_USER', SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter' },
      { plan_id: 'skuangles-pro-monthly' },
    ],
    [
      'enabled flag is missing',
      'skuangles-starter-monthly',
      { SKUANGLES_LIVE_TEST_USER_ID: 'TEST_USER', SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter' },
      { plan_id: 'skuangles-starter-monthly' },
    ],
    [
      'test user binding is missing',
      'skuangles-starter-monthly',
      { SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1', SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter' },
      { plan_id: 'skuangles-starter-monthly' },
    ],
    [
      'coupon binding is missing',
      'skuangles-starter-monthly',
      { SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1', SKUANGLES_LIVE_TEST_USER_ID: 'TEST_USER' },
      { plan_id: 'skuangles-starter-monthly' },
    ],
  ])('does not apply a test coupon when the %s', async (_scenario, planId, configuredBindings, body) => {
    const userId = await createUser();
    const bindings = Object.fromEntries(
      Object.entries(configuredBindings).map(([key, value]) => [
        key,
        value === 'TEST_USER' ? userId : value,
      ]),
    ) as Partial<WorkerEnv>;

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      planId,
      bindings,
      body,
    );

    expect(response.status).toBe(200);
    expect(stripeMocks.createSession.mock.calls[0][0]).not.toHaveProperty('discounts');
  });

  it('expires an unmarked open session before creating the enabled test coupon session', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const existingSession = mockOpenSession('cs_test_unmarked_existing');
    const replacementSession = {
      ...existingSession,
      id: 'cs_test_marked_replacement',
      url: 'https://checkout.stripe.com/c/pay/cs_test_marked_replacement',
    };
    stripeMocks.createSession.mockResolvedValue(replacementSession);
    await createOpenSkuanglesAttempt(userId, existingSession);

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
      {
        SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1',
        SKUANGLES_LIVE_TEST_USER_ID: userId,
        SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacementSession.url });
    expect(stripeMocks.expireSession).toHaveBeenCalledOnce();
    expect(stripeMocks.expireSession).toHaveBeenCalledWith(existingSession.id);
    expect(stripeMocks.createSession).toHaveBeenCalledOnce();
    const createdSession = stripeMocks.createSession.mock.calls[0][0];
    expect(createdSession.discounts).toEqual([{ coupon: 'coupon_test_starter' }]);
    expect(createdSession.metadata.skuangles_live_test_coupon_applied).toBe('1');
    expect(Object.values(createdSession.metadata)).not.toContain('coupon_test_starter');
  });

  it('reuses a marked open session while the test coupon remains enabled', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const existingSession = mockOpenSession('cs_test_marked_existing', {
      skuangles_live_test_coupon_applied: '1',
    });
    await createOpenSkuanglesAttempt(userId, existingSession);

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
      {
        SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1',
        SKUANGLES_LIVE_TEST_USER_ID: userId,
        SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: existingSession.url });
    expect(stripeMocks.expireSession).not.toHaveBeenCalled();
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it('expires a marked open session before creating a regular session when the gate is disabled', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const existingSession = mockOpenSession('cs_test_marked_disabled', {
      skuangles_live_test_coupon_applied: '1',
    });
    const replacementSession = {
      ...existingSession,
      id: 'cs_test_regular_replacement',
      url: 'https://checkout.stripe.com/c/pay/cs_test_regular_replacement',
      metadata: {},
    };
    stripeMocks.createSession.mockResolvedValue(replacementSession);
    await createOpenSkuanglesAttempt(userId, existingSession);

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacementSession.url });
    expect(stripeMocks.expireSession).toHaveBeenCalledWith(existingSession.id);
    expect(stripeMocks.createSession).toHaveBeenCalledOnce();
    const createdSession = stripeMocks.createSession.mock.calls[0][0];
    expect(createdSession).not.toHaveProperty('discounts');
    expect(createdSession.metadata).not.toHaveProperty('skuangles_live_test_coupon_applied');
  });

  it('fails closed when an incompatible open session cannot be expired', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const existingSession = mockOpenSession('cs_test_expire_failure');
    stripeMocks.expireSession.mockRejectedValue(new Error('Stripe unavailable'));
    await createOpenSkuanglesAttempt(userId, existingSession);

    const response = await checkoutRouteRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
      {
        SKUANGLES_LIVE_TEST_COUPON_ENABLED: '1',
        SKUANGLES_LIVE_TEST_USER_ID: userId,
        SKUANGLES_LIVE_TEST_COUPON_ID: 'coupon_test_starter',
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CHECKOUT_UNAVAILABLE' });
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it('creates one payable session under concurrent requests and uses a user-stable customer key', async () => {
    const userId = await createUser();
    const session = mockOpenSession('cs_test_concurrent');
    stripeMocks.createSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return session;
    });

    const responses = await Promise.all(Array.from({ length: 8 }, () => checkoutRequest(
      'auth.skuangles.com',
      userId,
      'skuangles-starter-monthly',
    )));
    const successfulBodies = await Promise.all(
      responses.filter((response) => response.ok).map((response) => response.json() as Promise<{ url: string }>),
    );

    expect(stripeMocks.createCustomer).toHaveBeenCalledOnce();
    expect(stripeMocks.createSession).toHaveBeenCalledOnce();
    expect(successfulBodies.length).toBeGreaterThanOrEqual(1);
    expect(successfulBodies.every((body) => body.url === session.url)).toBe(true);
    expect(stripeMocks.createCustomer.mock.calls[0][1]).toEqual({
      idempotencyKey: await getStripeIdempotencyKey('customer', userId),
    });
  });

  it('recycles an expired session before evaluating a different plan', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO checkout_attempts (
      user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
      status, stripe_checkout_session_id, session_expires_at, lock_expires_at
    ) VALUES (?, 'prod_skuangles', ?, ?, 'skuangles-starter-monthly', ?,
      'open', ?, unixepoch() - 1, 0)`)
      .bind(userId, attemptId, crypto.randomUUID(), crypto.randomUUID(), `cs_expired_${attemptId}`)
      .run();
    const replacement = mockOpenSession('cs_test_pro_replacement');
    stripeMocks.retrieveSession.mockResolvedValue({ id: `cs_expired_${attemptId}`, status: 'expired', url: null });

    const response = await checkoutRequest('auth.skuangles.com', userId, 'skuangles-pro-monthly');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacement.url });
    expect(stripeMocks.createSession).toHaveBeenCalledOnce();
  });

  it('keeps an open session from being replaced by another plan', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    const openSession = mockOpenSession(`cs_open_${attemptId}`);
    await env.DB.prepare(`INSERT INTO checkout_attempts (
      user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
      status, stripe_checkout_session_id, session_expires_at, lock_expires_at
    ) VALUES (?, 'prod_skuangles', ?, ?, 'skuangles-starter-monthly', ?,
      'open', ?, ?, 0)`)
      .bind(
        userId,
        attemptId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        openSession.id,
        openSession.expires_at,
      )
      .run();

    const response = await checkoutRequest('auth.skuangles.com', userId, 'skuangles-pro-monthly');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CHECKOUT_ALREADY_OPEN' });
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it('allows a new one-time purchase only after the previous webhook recorded it', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    const oldSessionId = `cs_paid_${attemptId}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkout_attempts (
        user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
        status, stripe_checkout_session_id, session_expires_at, lock_expires_at
      ) VALUES (?, 'prod_bestmcp', ?, ?, 'plan_bestmcp_security_audit', ?,
        'completed', ?, unixepoch() + 3600, 0)`)
        .bind(userId, attemptId, crypto.randomUUID(), crypto.randomUUID(), oldSessionId),
      env.DB.prepare(`INSERT INTO purchases (
        id, user_id, plan_id, stripe_checkout_session_id, status
      ) VALUES (?, ?, 'plan_bestmcp_security_audit', ?, 'active')`)
        .bind(crypto.randomUUID(), userId, oldSessionId),
    ]);
    const replacement = mockOpenSession('cs_test_repeat_purchase');

    const response = await checkoutRequest(
      'auth.bestmcpservers.com',
      userId,
      'plan_bestmcp_security_audit',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacement.url });
  });

  it('allows a canceled subscription to start a fresh checkout', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkout_attempts (
        user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
        status, stripe_checkout_session_id, session_expires_at, lock_expires_at
      ) VALUES (?, 'prod_skuangles', ?, ?, 'skuangles-starter-monthly', ?,
        'completed', ?, unixepoch() + 3600, 0)`)
        .bind(userId, attemptId, crypto.randomUUID(), crypto.randomUUID(), `cs_canceled_${attemptId}`),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id, plan_id,
        status, cancel_at_period_end
      ) VALUES (?, ?, ?, ?, 'skuangles-pro-monthly', 'canceled', 0)`)
        .bind(crypto.randomUUID(), userId, `cus_${userId}`, `sub_${attemptId}`),
    ]);
    const replacement = mockOpenSession('cs_test_resubscribe');

    const response = await checkoutRequest('auth.skuangles.com', userId, 'skuangles-pro-monthly');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacement.url });
  });

  it('allows a one-time purchase after a completed subscription checkout was recorded', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkout_attempts (
        user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
        status, stripe_checkout_session_id, session_expires_at, lock_expires_at
      ) VALUES (?, 'prod_bestmcp', ?, ?, 'plan_bestmcp_pro', ?,
        'completed', ?, unixepoch() + 3600, 0)`)
        .bind(userId, attemptId, crypto.randomUUID(), crypto.randomUUID(), `cs_subscription_${attemptId}`),
      env.DB.prepare(`INSERT INTO subscriptions (
        id, user_id, stripe_customer_id, stripe_subscription_id, plan_id,
        status, cancel_at_period_end
      ) VALUES (?, ?, ?, ?, 'plan_bestmcp_pro', 'active', 0)`)
        .bind(crypto.randomUUID(), userId, `cus_${userId}`, `sub_${attemptId}`),
    ]);
    const replacement = mockOpenSession('cs_test_subscription_to_purchase');

    const response = await checkoutRequest(
      'auth.bestmcpservers.com',
      userId,
      'plan_bestmcp_security_audit',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacement.url });
  });

  it('allows a subscription after a completed one-time checkout was recorded', async () => {
    const userId = await createUser(`cus_${crypto.randomUUID()}`);
    const attemptId = crypto.randomUUID();
    const oldSessionId = `cs_purchase_${attemptId}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkout_attempts (
        user_id, product_id, attempt_id, client_request_id, plan_id, owner_token,
        status, stripe_checkout_session_id, session_expires_at, lock_expires_at
      ) VALUES (?, 'prod_bestmcp', ?, ?, 'plan_bestmcp_security_audit', ?,
        'completed', ?, unixepoch() + 3600, 0)`)
        .bind(userId, attemptId, crypto.randomUUID(), crypto.randomUUID(), oldSessionId),
      env.DB.prepare(`INSERT INTO purchases (
        id, user_id, plan_id, stripe_checkout_session_id, status
      ) VALUES (?, ?, 'plan_bestmcp_security_audit', ?, 'active')`)
        .bind(crypto.randomUUID(), userId, oldSessionId),
    ]);
    const replacement = mockOpenSession('cs_test_purchase_to_subscription');

    const response = await checkoutRequest('auth.bestmcpservers.com', userId, 'plan_bestmcp_pro');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: replacement.url });
  });
});
