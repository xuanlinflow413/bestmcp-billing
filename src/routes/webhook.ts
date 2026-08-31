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

export async function processWebhookEvent(c: any, event: Stripe.Event) {
  const env = c.env;
  const db = new DbClient(env.DB);
  const payload = JSON.stringify(event);

  // 只有新事件或 failed -> pending 的原子状态转换能取得入队权。
  const existing = await db.getWebhookEvent(event.id);
  if (existing && existing.status === 'processed') {
    console.log(`Webhook event ${event.id} already processed, skipping`);
    return jsonResponse({ received: true, status: 'already_processed' });
  }
  if (existing && existing.status === 'ignored') {
    console.log(`Webhook event ${event.id} already ignored, skipping`);
    return jsonResponse({ received: true, status: 'already_ignored' });
  }
  if (existing && existing.status === 'pending') {
    console.log(`Webhook event ${event.id} already pending, skipping duplicate enqueue`);
    return jsonResponse({ received: true, status: 'already_pending' });
  }

  let webhookEventId: string;
  let queueStatus: 'queued' | 'requeued';
  let claimed: boolean;

  if (existing && existing.status === 'failed') {
    webhookEventId = existing.id;
    queueStatus = 'requeued';
    claimed = await db.retryFailedWebhookEvent(existing.id, event.type, payload);
  } else {
    webhookEventId = crypto.randomUUID();
    queueStatus = 'queued';
    claimed = await db.createWebhookEvent({
      id: webhookEventId,
      stripe_event_id: event.id,
      event_type: event.type,
      payload,
    });
  }

  if (!claimed) {
    const concurrent = await db.getWebhookEvent(event.id);
    const status = concurrent?.status === 'processed'
      ? 'already_processed'
      : concurrent?.status === 'ignored'
        ? 'already_ignored'
        : 'already_pending';
    console.log(`Webhook event ${event.id} was claimed concurrently, skipping duplicate enqueue`);
    return jsonResponse({ received: true, status });
  }

  try {
    await env.QUEUE_WEBHOOK.send({
      eventId: event.id,
      type: event.type,
      data: event.data.object,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    await db.markWebhookProcessed(webhookEventId, 'failed', err?.message || 'Queue enqueue failed');
    throw err;
  }

  return jsonResponse({ received: true, replayed: true, status: queueStatus });
}

export { webhookRoutes };
