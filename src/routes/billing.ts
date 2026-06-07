import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { verifySession, getSessionToken } from '../lib/auth';
import { errorResponse, jsonResponse } from '../lib/utils';

const billingRoutes = new Hono<AppContext>();

async function authMiddleware(c: any, next: any) {
  const token = getSessionToken(c.req.raw);
  if (!token) return errorResponse('Unauthorized', 401);
  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) return errorResponse('Session expired', 401);
  c.set('userId', payload.userId);
  c.set('userRole', payload.role);
  await next();
}

billingRoutes.use('*', authMiddleware);

/**
 * GET /api/billing/plans
 * 获取所有可用套餐
 */
billingRoutes.get('/plans', async (c) => {
  const db = new DbClient(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, pr.name as product_name, pr.slug as product_slug
     FROM plans p
     JOIN products pr ON p.product_id = pr.id
     WHERE p.is_active = 1
     ORDER BY p.price_cents ASC`
  ).all();
  return jsonResponse({ plans: results });
});

/**
 * POST /api/billing/checkout
 * 创建 Stripe Checkout Session
 */
billingRoutes.post('/checkout', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { price_id, success_url, cancel_url } = body;

  if (!price_id) return errorResponse('price_id is required', 400);

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);
  if (!user) return errorResponse('User not found', 404);

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

  // 获取或创建 Stripe Customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await db.updateUserStripeCustomer(userId, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: price_id, quantity: 1 }],
    success_url: success_url || `${c.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancel_url || `${c.env.APP_URL}/billing/cancel`,
    metadata: { user_id: userId },
  });

  return jsonResponse({ sessionId: session.id, url: session.url });
});

/**
 * POST /api/billing/portal
 * 创建 Stripe Customer Portal Session
 */
billingRoutes.post('/portal', async (c) => {
  const userId = c.get('userId');
  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);

  if (!user?.stripe_customer_id) {
    return errorResponse('No subscription found', 404);
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${c.env.APP_URL}/dashboard`,
  });

  return jsonResponse({ url: session.url });
});

/**
 * GET /api/billing/invoices
 * 获取用户发票列表
 */
billingRoutes.get('/invoices', async (c) => {
  const userId = c.get('userId');
  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);

  if (!user?.stripe_customer_id) {
    return jsonResponse({ invoices: [] });
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
  const invoices = await stripe.invoices.list({
    customer: user.stripe_customer_id,
    limit: 20,
  });

  return jsonResponse({
    invoices: invoices.data.map((inv) => ({
      id: inv.id,
      amount: inv.amount_due,
      status: inv.status,
      created: inv.created,
      pdf: inv.invoice_pdf,
    })),
  });
});

export { billingRoutes };
