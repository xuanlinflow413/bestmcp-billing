import { Hono } from 'hono';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { verifySession, getSessionToken } from '../lib/auth';
import { errorResponse, jsonResponse } from '../lib/utils';

const paypalRoutes = new Hono<AppContext>();

function getPayPalConfig(env: any) {
  const isLive = env.PAYPAL_LIVE === '1';
  return {
    baseUrl: isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  };
}

async function getPayPalAccessToken(config: { baseUrl: string; clientId: string; clientSecret: string }): Promise<string> {
  const auth = btoa(`${config.clientId}:${config.clientSecret}`);
  const res = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal auth failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === c.env.INTERNAL_API_KEY) {
      const userId = c.req.header('X-User-ID');
      if (userId) {
        c.set('userId', userId);
        c.set('userRole', 'service');
        await next();
        return;
      }
    }
  }

  const token = getSessionToken(c.req.raw);
  if (!token) return errorResponse('Unauthorized', 401);
  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) return errorResponse('Session expired', 401);
  c.set('userId', payload.userId);
  c.set('userRole', payload.role);
  await next();
}

paypalRoutes.use('*', authMiddleware);

/**
 * POST /paypal/create-order
 */
paypalRoutes.post('/create-order', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);

  const body = await c.req.json<{ plan_id?: string; return_url?: string }>().catch(() => ({ plan_id: undefined, return_url: undefined }));
  const planId = body.plan_id || 'plan_kindreply_jobpack';

  const db = new DbClient(c.env.DB);
  const plan = await db.getPlanById(planId);
  if (!plan || !plan.is_active || plan.price_cents <= 0) {
    return errorResponse('Plan not found or unavailable', 404);
  }

  const creditsAmount = plan.credits_per_period || 0;
  if (creditsAmount <= 0) {
    return errorResponse('Invalid credits amount', 500);
  }

  const config = getPayPalConfig(c.env);
  const accessToken = await getPayPalAccessToken(config);

  const orderRes = await fetch(`${config.baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `${userId}-${Date.now()}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: planId,
        description: `KindReply ${plan.name} - ${creditsAmount} credits`,
        amount: {
          currency_code: 'USD',
          value: (plan.price_cents / 100).toFixed(2),
        },
        custom_id: userId,
      }],
      application_context: {
        brand_name: 'KindReply',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        return_url: body.return_url || 'https://kindreply.co/cover-letter-writer/?paypal=success',
        cancel_url: 'https://kindreply.co/cover-letter-writer/?paypal=cancel',
      },
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    console.error('PayPal create order failed:', err);
    return errorResponse('Failed to create PayPal order', 500);
  }

  const orderData = await orderRes.json() as {
    id: string;
    status: string;
    links: Array<{ rel: string; href: string }>;
  };

  const approvalUrl = orderData.links.find(l => l.rel === 'approve')?.href;
  if (!approvalUrl) {
    return errorResponse('No approval URL returned', 500);
  }

  return jsonResponse({
    orderId: orderData.id,
    url: approvalUrl,
  });
});

/**
 * POST /paypal/capture
 */
paypalRoutes.post('/capture', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);

  const body = await c.req.json<{ order_id?: string }>().catch(() => ({ order_id: undefined }));
  const orderId = body.order_id;
  if (!orderId) return errorResponse('order_id is required', 400);

  const db = new DbClient(c.env.DB);

  // 幂等性检查
  const existingTx = await db.getCreditTransactionByReference(orderId);
  if (existingTx) {
    const credits = await db.getCredits(userId);
    return jsonResponse({
      success: true,
      alreadyProcessed: true,
      creditsAdded: existingTx.amount,
      balance: credits?.balance || 0,
    });
  }

  const config = getPayPalConfig(c.env);
  const accessToken = await getPayPalAccessToken(config);

  const orderRes = await fetch(`${config.baseUrl}/v2/checkout/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!orderRes.ok) {
    return errorResponse('Failed to fetch order', 500);
  }

  const orderData = await orderRes.json() as {
    id: string;
    status: string;
    purchase_units: Array<{
      reference_id: string;
      custom_id?: string;
      amount: { value: string };
    }>;
  };

  const purchaseUnit = orderData.purchase_units?.[0];
  if (!purchaseUnit || purchaseUnit.custom_id !== userId) {
    return errorResponse('Order does not belong to current user', 403);
  }

  // 已支付完成
  if (orderData.status === 'COMPLETED') {
    const planId = purchaseUnit.reference_id || 'plan_kindreply_jobpack';
    const plan = await db.getPlanById(planId);
    if (!plan) return errorResponse('Plan not found', 404);

    const creditsAmount = plan.credits_per_period || 0;
    if (creditsAmount <= 0) {
      return errorResponse('Invalid credits amount', 500);
    }

    // 双重检查幂等性
    const doubleCheck = await db.getCreditTransactionByReference(orderId);
    if (doubleCheck) {
      const credits = await db.getCredits(userId);
      return jsonResponse({
        success: true,
        alreadyProcessed: true,
        creditsAdded: doubleCheck.amount,
        balance: credits?.balance || 0,
      });
    }

    const credits = await db.addCredits(
      userId,
      creditsAmount,
      'purchase',
      `PayPal purchase: ${plan.name}`,
      orderId,
      'kindreply'
    );

    if (!credits) {
      const latestCredits = await db.getCredits(userId);
      return jsonResponse({
        success: true,
        alreadyProcessed: true,
        orderId,
        creditsAdded: creditsAmount,
        balance: latestCredits?.balance || 0,
      });
    }

    return jsonResponse({
      success: true,
      orderId,
      creditsAdded: creditsAmount,
      balance: credits.balance,
    });
  }

  // 已授权，尝试 capture
  if (orderData.status === 'APPROVED') {
    const captureRes = await fetch(`${config.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture-${orderId}`,
      },
    });

    if (!captureRes.ok) {
      const err = await captureRes.text();
      console.error('PayPal capture failed:', err);
      return errorResponse('Payment capture failed', 500);
    }

    const captureData = await captureRes.json() as { status: string };
    
    if (captureData.status === 'COMPLETED') {
      const planId = purchaseUnit.reference_id || 'plan_kindreply_jobpack';
      const plan = await db.getPlanById(planId);
      if (!plan) return errorResponse('Plan not found', 404);

      const creditsAmount = plan.credits_per_period || 0;
      if (creditsAmount <= 0) {
        return errorResponse('Invalid credits amount', 500);
      }

      // 双重检查幂等性
      const doubleCheck = await db.getCreditTransactionByReference(orderId);
      if (doubleCheck) {
        const credits = await db.getCredits(userId);
        return jsonResponse({
          success: true,
          alreadyProcessed: true,
          creditsAdded: doubleCheck.amount,
          balance: credits?.balance || 0,
        });
      }

      const credits = await db.addCredits(
        userId,
        creditsAmount,
        'purchase',
        `PayPal purchase: ${plan.name}`,
        orderId,
        'kindreply'
      );

      if (!credits) {
        const latestCredits = await db.getCredits(userId);
        return jsonResponse({
          success: true,
          alreadyProcessed: true,
          orderId,
          creditsAdded: creditsAmount,
          balance: latestCredits?.balance || 0,
        });
      }

      return jsonResponse({
        success: true,
        orderId,
        creditsAdded: creditsAmount,
        balance: credits.balance,
      });
    }
  }

  return errorResponse(`Order status: ${orderData.status}`, 400);
});

export { paypalRoutes };
