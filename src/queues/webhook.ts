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

const STRIPE_API_VERSION = '2026-05-27.dahlia';

function getPrimaryItem(subscription: Stripe.Subscription): any {
  const item = subscription.items.data[0] as any;
  if (!item) throw new Error(`Subscription ${subscription.id} has no items`);
  return item;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const anyInvoice = invoice as any;
  const sub = anyInvoice.subscription || anyInvoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

function getProductSlug(productId: string | null | undefined): 'bestmcp' | 'kindreply' | 'cleartext' | 'editimages' | null {
  if (productId === 'prod_bestmcp') return 'bestmcp';
  if (productId === 'prod_kindreply') return 'kindreply';
  if (productId === 'prod_cleartext') return 'cleartext';
  if (productId === 'prod_editimages') return 'editimages';
  return null;
}

/**
 * Queue Consumer: 处理 Stripe Webhook 事件
 */
export async function handleWebhookQueue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
  const db = new DbClient(env.DB);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

  for (const message of batch.messages) {
    const { eventId, type, data } = message.body;

    try {
      switch (type) {
        case 'checkout.session.completed': {
          const session = data as Stripe.Checkout.Session;
          const userId = session.metadata?.user_id;
          if (!userId) break;

          // 处理订阅支付：只创建/更新 subscription，不发放 credits
          // credits 由 invoice.paid 处理，避免重复发放
          if (session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
            const item = getPrimaryItem(subscription);
            const priceId = item.price?.id;
            const planId = session.metadata?.plan_id || subscription.metadata?.plan_id;
            const plan = (priceId ? await db.getPlanByStripePriceId(priceId) : null) || (planId ? await db.getPlanById(planId) : null);

            if (plan) {
              const existing = await db.getSubscriptionByStripeId(subscription.id);
              if (existing) {
                await db.updateSubscription({
                  stripe_subscription_id: subscription.id,
                  plan_id: plan.id,
                  status: subscription.status as any,
                  current_period_start: item.current_period_start ?? null,
                  current_period_end: item.current_period_end ?? null,
                  cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
                });
              } else {
                await db.createSubscription({
                  id: crypto.randomUUID(),
                  user_id: userId,
                  stripe_customer_id: session.customer as string,
                  stripe_subscription_id: subscription.id,
                  stripe_price_id: priceId,
                  plan_id: plan.id,
                  status: subscription.status as any,
                  current_period_start: item.current_period_start ?? null,
                  current_period_end: item.current_period_end ?? null,
                  cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
                  credits_allocated: plan.credits_per_period,
                  credits_used: 0,
                });
              }
              // 注意：订阅的 credits 发放由 invoice.paid 处理，不在此处发放
              console.log(`Subscription ${subscription.id} created/updated for user ${userId}, credits will be granted on invoice.paid`);
            }
          } 
          // 处理一次性支付（如 Job Pack, Builder Pack）
          else if (session.mode === 'payment') {
            const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
            const item = lineItems.data[0];
            if (item && item.price) {
              const priceId = item.price.id;
              const metadataPlanId = session.metadata?.plan_id;
              const plan = (metadataPlanId ? await db.getPlanById(metadataPlanId) : null)
                || await db.getPlanByStripePriceId(priceId);
              
              if (plan) {
                const purchaseCreated = await db.createPurchase(userId, plan.id, session.id);
                if (plan.credits_per_period > 0) {
                  await db.addCredits(
                    userId,
                    plan.credits_per_period,
                    'purchase',
                    `One-time purchase: ${plan.name}`,
                    session.id,
                    getProductSlug(plan.product_id) || undefined
                  );
                }
                console.log(`${purchaseCreated ? 'Recorded' : 'Skipped duplicate'} purchase ${session.id} for ${plan.name}; credits=${plan.credits_per_period}`);
              }
            }
          }
          break;
        }

        case 'invoice.paid': {
          const invoice = data as Stripe.Invoice;
          const subscriptionId = getInvoiceSubscriptionId(invoice);
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const item = getPrimaryItem(subscription);
            const priceId = item.price?.id;
            const planId = subscription.metadata?.plan_id;
            const plan = (priceId ? await db.getPlanByStripePriceId(priceId) : null) || (planId ? await db.getPlanById(planId) : null);

            await db.updateSubscription({
              stripe_subscription_id: subscription.id,
              plan_id: plan?.id || undefined,
              status: subscription.status as any,
              current_period_start: item.current_period_start ?? null,
              current_period_end: item.current_period_end ?? null,
              cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
            });

            const sub = await db.getSubscriptionByStripeId(subscription.id);
            if (sub && plan) {
              // 幂等：使用 invoice.id 作为 reference_id
              const result = await db.addCredits(
                sub.user_id,
                plan.credits_per_period,
                'subscription_grant',
                `Subscription payment: ${plan.name}`,
                invoice.id,
                getProductSlug(plan.product_id) || undefined
              );
              if (result) {
                console.log(`Granted ${plan.credits_per_period} credits for invoice ${invoice.id}`);
              } else {
                console.log(`Skipped duplicate credit grant for invoice ${invoice.id}`);
              }
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = data as Stripe.Invoice;
          const subscriptionId = getInvoiceSubscriptionId(invoice);
          if (subscriptionId) {
            await db.updateSubscriptionStatus(subscriptionId, 'past_due');
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = data as Stripe.Subscription;
          const item = getPrimaryItem(subscription);
          const priceId = item.price?.id;
          const plan = priceId ? await db.getPlanByStripePriceId(priceId) : null;
          await db.updateSubscription({
            stripe_subscription_id: subscription.id,
            status: subscription.status as any,
            plan_id: plan?.id || undefined,
            current_period_start: item.current_period_start ?? null,
            current_period_end: item.current_period_end ?? null,
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
