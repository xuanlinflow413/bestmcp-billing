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

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return errorResponse(`Webhook Error: ${err.message}`, 400);
  }

  return await processWebhookEvent(c, event);
});

/**
 * POST /api/webhooks/replay
 * Admin replay endpoint: re-process a stored webhook event by stripe_event_id
 * Requires ADMIN_SECRET header for authorization
 */
webhookRoutes.post('/replay', async (c) => {
  const env = c.env;
  const adminSecret = c.req.header('x-admin-secret');

  if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
    return errorResponse('Unauthorized', 401);
  }

  const body = await c.req.json();
  const { stripe_event_id } = body;

  if (!stripe_event_id) {
    return errorResponse('Missing stripe_event_id', 400);
  }

  const db = new DbClient(env.DB);
  const eventRecord = await db.getWebhookEvent(stripe_event_id);

  if (!eventRecord) {
    return errorResponse('Webhook event not found', 404);
  }

  let event: Stripe.Event;
  try {
    event = JSON.parse(eventRecord.payload);
  } catch (err: any) {
    return errorResponse(`Invalid payload: ${err.message}`, 400);
  }

  console.log(`[Admin Replay] Replaying event ${stripe_event_id}`);
  return await processWebhookEvent(c, event);
});

async function processWebhookEvent(c: any, event: Stripe.Event) {
  const env = c.env;
  const db = new DbClient(env.DB);

  // 幂等性检查：已处理过的事件直接返回 200
  const existing = await db.getWebhookEvent(event.id);
  if (existing && existing.status === 'processed') {
    console.log(`Webhook event ${event.id} already processed, skipping`);
    return jsonResponse({ received: true, status: 'already_processed' });
  }

  // 如果存在但处理失败，更新状态为 pending 重新处理
  if (existing && existing.status !== 'processed') {
    console.log(`Webhook event ${event.id} exists but not processed, re-queueing`);
  } else {
    // 写入 D1
    await db.createWebhookEvent({
      id: crypto.randomUUID(),
      stripe_event_id: event.id,
      event_type: event.type,
      payload: JSON.stringify(event),
    });
  }

  // 发送 Queue 异步处理
  await env.QUEUE_WEBHOOK.send({
    eventId: event.id,
    type: event.type,
    data: event.data.object,
    timestamp: Date.now(),
  });

  return jsonResponse({ received: true, replayed: true });
}

export { webhookRoutes };
