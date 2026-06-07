import type { MessageBatch } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import { DbClient } from '../lib/db';
import type { Env } from '../types';

interface WebhookMessage {
  eventId: string;
  type: string;
  data: any;
  timestamp: number;
}

/**
 * Queue Consumer: 处理 Stripe Webhook 事件
 */
export async function handleWebhookQueue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
  const db = new DbClient(env.DB);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

  for (const message of batch.messages) {
    const { eventId, type, data } = message.body;

    try {
      switch (type) {
        case 'checkout.session.completed': {
          const session = data as Stripe.Checkout.Session;
          const userId = session.metadata?.user_id;
          if (!userId) break;

          // 获取订阅详情
          if (session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
            const plan = await db.getPlanByStripePriceId(subscription.items.data[0].price.id);

            if (plan) {
              await db.createSubscription({
                id: crypto.randomUUID(),
                user_id: userId,
                stripe_customer_id: session.customer as string,
                stripe_subscription_id: subscription.id,
                stripe_price_id: subscription.items.data[0].price.id,
                plan_id: plan.id,
                status: subscription.status as any,
                current_period_start: subscription.current_period_start,
                current_period_end: subscription.current_period_end,
                cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
                credits_allocated: plan.credits_allocated,
                credits_used: 0,
              });

              // 发放 Credits
              await db.addCredits(
                userId,
                plan.credits_allocated,
                'subscription_grant',
                `Subscription: ${plan.name}`,
                subscription.id,
                plan.product_id === 'prod_bestmcp' ? 'bestmcp' : 'kindreply'
              );
            }
          }
          break;
        }

        case 'invoice.paid': {
          const invoice = data as Stripe.Invoice;
          if (invoice.subscription) {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
            await db.updateSubscription({
              stripe_subscription_id: subscription.id,
              status: subscription.status as any,
              current_period_start: subscription.current_period_start,
              current_period_end: subscription.current_period_end,
            });

            // 续期重置 Credits
            const sub = await db.getSubscriptionByStripeId(subscription.id);
            if (sub) {
              const plan = await db.getPlanById(sub.plan_id!);
              if (plan) {
                await db.addCredits(
                  sub.user_id,
                  plan.credits_allocated,
                  'subscription_grant',
                  `Subscription renewal: ${plan.name}`,
                  subscription.id
                );
              }
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = data as Stripe.Invoice;
          if (invoice.subscription) {
            await db.updateSubscriptionStatus(invoice.subscription as string, 'past_due');
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = data as Stripe.Subscription;
          await db.updateSubscription({
            stripe_subscription_id: subscription.id,
            status: subscription.status as any,
            plan_id: (await db.getPlanByStripePriceId(subscription.items.data[0].price.id))?.id || undefined,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
            cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
          });
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = data as Stripe.Subscription;
          await db.updateSubscriptionStatus(subscription.id, 'canceled');
          break;
        }

        default:
          console.log(`Unhandled webhook event type: ${type}`);
      }

      // 标记为已处理
      const webhookEvent = await db.getWebhookEvent(eventId);
      if (webhookEvent) {
        await db.markWebhookProcessed(webhookEvent.id, 'processed');
      }

      message.ack();
    } catch (err: any) {
      console.error(`Failed to process webhook ${eventId}:`, err);

      const webhookEvent = await db.getWebhookEvent(eventId);
      if (webhookEvent) {
        await db.markWebhookProcessed(webhookEvent.id, 'failed', err.message);
      }

      message.retry();
    }
  }
}
