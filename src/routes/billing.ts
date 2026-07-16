import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { verifySession, getSessionToken } from '../lib/auth';
import { getProductConfigForRequest } from '../lib/product-config';
import type { ProductConfig } from '../lib/product-config';
import { errorResponse, jsonResponse } from '../lib/utils';

const billingRoutes = new Hono<AppContext>();
const STRIPE_API_VERSION = '2026-05-27.dahlia';
const SECURITY_AUDIT_PLAN_ID = 'plan_bestmcp_security_audit';
const SECURITY_AUDIT_ASSETS: Record<string, { key: string; filename: string; contentType: string }> = {
  'audit-workbook': {
    key: 'bestmcp/security-audit-pack/mcp-security-audit-pack.md',
    filename: 'mcp-security-audit-pack.md',
    contentType: 'text/markdown; charset=utf-8',
  },
  'permission-scorecard': {
    key: 'bestmcp/security-audit-pack/permission-scorecard.csv',
    filename: 'permission-scorecard.csv',
    contentType: 'text/csv; charset=utf-8',
  },
  'rollout-checklist': {
    key: 'bestmcp/security-audit-pack/production-rollout-checklist.md',
    filename: 'production-rollout-checklist.md',
    contentType: 'text/markdown; charset=utf-8',
  },
};

export function getCheckoutReturnUrls(productConfig: ProductConfig) {
  return {
    successUrl: `${productConfig.frontendUrl}${productConfig.checkoutSuccessPath}`,
    cancelUrl: `${productConfig.frontendUrl}${productConfig.checkoutCancelPath}`,
  };
}

async function authMiddleware(c: any, next: any) {
  // 优先检查 Internal API Key（服务间调用）
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === c.env.INTERNAL_API_KEY) {
      // 服务间调用，从 X-User-ID 获取用户
      const userId = c.req.header('X-User-ID');
      if (userId) {
        c.set('userId', userId);
        c.set('userRole', 'service');
        await next();
        return;
      }
    }
  }

  // 回退到 Session Cookie 认证（浏览器用户）
  const token = getSessionToken(c.req.raw);
  if (!token) return errorResponse('Unauthorized', 401);
  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) return errorResponse('Session expired', 401);
  c.set('userId', payload.userId);
  c.set('userRole', payload.role);
  await next();
}

/**
 * GET /api/billing/plans
 * 获取所有可售套餐。前端只传 plan_id，后端从 D1 读取真实 Stripe price_id。
 */
billingRoutes.get('/plans', async (c) => {
  const productConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  if (!productConfig) return errorResponse('Unknown product host', 404, 'PRODUCT_HOST_UNKNOWN');
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, pr.name as product_name, pr.slug as product_slug
     FROM plans p
     JOIN products pr ON p.product_id = pr.id
     WHERE p.is_active = 1 AND p.price_cents > 0 AND p.product_id = ?
     ORDER BY pr.slug ASC, p.price_cents ASC`
  ).bind(productConfig.productId).all();
  return jsonResponse({ plans: results });
});

// Plans are public pricing data. All state-changing and account-specific routes below require auth.
billingRoutes.use('*', authMiddleware);

/**
 * POST /api/billing/checkout
 * 创建 Stripe Checkout Session
 */
billingRoutes.post('/checkout', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const productConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  if (!productConfig) return errorResponse('Unknown product host', 404, 'PRODUCT_HOST_UNKNOWN');

  const body = await c.req
    .json<{ plan_id?: string }>()
    .catch((): { plan_id?: string } => ({}));
  const planId = body.plan_id;
  if (!planId) return errorResponse('plan_id is required', 400);

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);
  if (!user) return errorResponse('User not found', 404);

  const plan = await db.getPlanById(planId);
  if (!plan || !plan.is_active || plan.price_cents <= 0) {
    return errorResponse('Plan not found or unavailable', 404);
  }
  if (plan.product_id !== productConfig.productId) {
    return errorResponse('Plan not found or unavailable', 404);
  }

  const isSubscription = plan.interval === 'month' || plan.interval === 'year';
  if (isSubscription) {
    const existingSubscription = await db.getBlockingSubscriptionForProduct(userId, plan.product_id);
    if (existingSubscription) {
      return errorResponse('An active subscription already exists for this product', 409, 'SUBSCRIPTION_ALREADY_ACTIVE');
    }
  }

  const configuredPriceId = plan.stripe_price_id?.startsWith('price_') ? plan.stripe_price_id : null;
  if (!configuredPriceId) {
    return errorResponse('Checkout is not configured for this plan', 503, 'CHECKOUT_UNAVAILABLE');
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

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

  // 根据套餐类型决定 Checkout mode
  const mode = isSubscription ? 'subscription' : 'payment';

  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = {
    price: configuredPriceId,
    quantity: 1,
  };

  const returnUrls = getCheckoutReturnUrls(productConfig);
  const sessionConfig: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode,
    payment_method_types: ['card'],
    line_items: [lineItem],
    success_url: returnUrls.successUrl,
    cancel_url: returnUrls.cancelUrl,
    metadata: { user_id: userId, plan_id: plan.id, product_id: plan.product_id },
  };

  // 订阅模式需要 subscription_data
  if (isSubscription) {
    sessionConfig.subscription_data = {
      metadata: { user_id: userId, plan_id: plan.id, product_id: plan.product_id },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionConfig);

  return jsonResponse({ sessionId: session.id, url: session.url });
});

/**
 * GET /api/billing/downloads/:asset
 * Streams private R2 assets only after verifying the one-time entitlement.
 */
billingRoutes.get('/downloads/:asset', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);

  const asset = SECURITY_AUDIT_ASSETS[c.req.param('asset')];
  if (!asset) return errorResponse('Download not found', 404);

  const db = new DbClient(c.env.DB);
  if (!(await db.hasActivePurchase(userId, SECURITY_AUDIT_PLAN_ID))) {
    return errorResponse('Purchase required', 403, 'ENTITLEMENT_REQUIRED');
  }

  const object = await c.env.R2_STORAGE.get(asset.key);
  if (!object) return errorResponse('Download is temporarily unavailable', 404, 'ASSET_NOT_FOUND');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', asset.contentType);
  headers.set('Content-Disposition', `attachment; filename="${asset.filename}"`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
});

/**
 * POST /api/billing/portal
 * 创建 Stripe Customer Portal Session
 */
billingRoutes.post('/portal', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const productConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  if (!productConfig) return errorResponse('Unknown product host', 404, 'PRODUCT_HOST_UNKNOWN');

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);

  if (!user?.stripe_customer_id) {
    return errorResponse('No Stripe customer found', 404);
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${productConfig.frontendUrl}${productConfig.portalReturnPath}`,
  });

  return jsonResponse({ url: session.url });
});

/**
 * GET /api/billing/invoices
 * 获取用户发票列表
 */
billingRoutes.get('/invoices', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(userId);

  if (!user?.stripe_customer_id) {
    return jsonResponse({ invoices: [] });
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
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
