import { env } from 'cloudflare:test';
import Stripe from 'stripe';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DbClient } from '../src/lib/db';
import { processWebhookEvent } from '../src/routes/webhook';

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    processing_error TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    processed_at INTEGER
  )`).run();
});

function makeEvent(id: string): Stripe.Event {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test' } },
  } as Stripe.Event;
}

function makeContext(send: ReturnType<typeof vi.fn>) {
  return {
    env: {
      DB: env.DB,
      QUEUE_WEBHOOK: { send },
    },
  };
}

async function responseStatus(response: Response): Promise<string> {
  return ((await response.json()) as { status: string }).status;
}

describe('Stripe webhook enqueue idempotency', () => {
  it('atomically creates a webhook event once under concurrent inserts', async () => {
    const db = new DbClient(env.DB);
    const event = makeEvent(`evt_atomic_${crypto.randomUUID()}`);
    const claims = await Promise.all(Array.from({ length: 8 }, () => db.createWebhookEvent({
      id: crypto.randomUUID(),
      stripe_event_id: event.id,
      event_type: event.type,
      payload: JSON.stringify(event),
    })));

    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM webhook_events WHERE stripe_event_id = ?')
      .bind(event.id)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it('enqueues a new event only once when requests arrive concurrently', async () => {
    const event = makeEvent(`evt_concurrent_${crypto.randomUUID()}`);
    const send = vi.fn(async () => undefined);
    const responses = await Promise.all(Array.from({ length: 8 }, () => processWebhookEvent(makeContext(send), event)));
    const statuses = await Promise.all(responses.map(responseStatus));

    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'already_pending')).toHaveLength(7);
  });

  it('skips pending and processed events, but atomically requeues a failed event once', async () => {
    const db = new DbClient(env.DB);
    const pending = makeEvent(`evt_pending_${crypto.randomUUID()}`);
    const processed = makeEvent(`evt_processed_${crypto.randomUUID()}`);
    const failed = makeEvent(`evt_failed_${crypto.randomUUID()}`);

    for (const event of [pending, processed, failed]) {
      await db.createWebhookEvent({
        id: crypto.randomUUID(),
        stripe_event_id: event.id,
        event_type: event.type,
        payload: JSON.stringify(event),
      });
    }
    const processedRecord = await db.getWebhookEvent(processed.id);
    const failedRecord = await db.getWebhookEvent(failed.id);
    await db.markWebhookProcessed(processedRecord!.id, 'processed');
    await db.markWebhookProcessed(failedRecord!.id, 'failed', 'first attempt failed');

    const send = vi.fn(async () => undefined);
    expect(await responseStatus(await processWebhookEvent(makeContext(send), pending))).toBe('already_pending');
    expect(await responseStatus(await processWebhookEvent(makeContext(send), processed))).toBe('already_processed');

    const failedResponses = await Promise.all(Array.from({ length: 6 }, () => processWebhookEvent(makeContext(send), failed)));
    const failedStatuses = await Promise.all(failedResponses.map(responseStatus));
    expect(failedStatuses.filter((status) => status === 'requeued')).toHaveLength(1);
    expect(failedStatuses.filter((status) => status === 'already_pending')).toHaveLength(5);
    expect(send).toHaveBeenCalledTimes(1);

    expect(await db.getWebhookEvent(failed.id)).toMatchObject({
      status: 'pending',
      processing_error: null,
    });
  });

  it('marks the claim failed when Queue rejects so a later request can retry', async () => {
    const db = new DbClient(env.DB);
    const event = makeEvent(`evt_enqueue_failure_${crypto.randomUUID()}`);
    const failure = new Error('queue unavailable');

    await expect(processWebhookEvent(makeContext(vi.fn(async () => { throw failure; })), event)).rejects.toThrow('queue unavailable');
    expect(await db.getWebhookEvent(event.id)).toMatchObject({
      status: 'failed',
      processing_error: 'queue unavailable',
    });

    const retrySend = vi.fn(async () => undefined);
    expect(await responseStatus(await processWebhookEvent(makeContext(retrySend), event))).toBe('requeued');
    expect(retrySend).toHaveBeenCalledTimes(1);
  });
});
