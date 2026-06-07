import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/utils';

const webhookRoutes = new Hono<AppContext>();

/**
 * POST /api/webhooks/stripe
 * Stripe Webhook 接收端点
 * 1. 校验签名
 * 2. 写入 D1（幂等性检查）
 * 3. 发送 Queue 异步处理
 */
webhookRoutes.post('/stripe', async (c) => {
  const env = c.env;
  const payload = await c.req.text();
  const signature = c.req.header('stripe-signature');

  if (!signature) {
    return errorResponse('Missing stripe-signature header', 400);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return errorResponse(`Webhook Error: ${err.message}`, 400);
  }

  const db = new DbClient(env.DB);

  // 幂等性检查：已处理过的事件直接返回 200
  const existing = await db.getWebhookEvent(event.id);
  if (existing) {
    console.log(`Webhook event ${event.id} already processed, skipping`);
    return jsonResponse({ received: true, status: 'already_processed' });
  }

  // 写入 D1
  await db.createWebhookEvent({
    id: crypto.randomUUID(),
    stripe_event_id: event.id,
    event_type: event.type,
    payload: JSON.stringify(event),
  });

  // 发送 Queue 异步处理
  await env.QUEUE_WEBHOOK.send({
    eventId: event.id,
    type: event.type,
    data: event.data.object,
    timestamp: Date.now(),
  });

  return jsonResponse({ received: true });
});

export { webhookRoutes };
