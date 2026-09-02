import type { MessageBatch } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import { DbClient, type Plan, type Subscription } from '../lib/db';
import { markCheckoutAttemptCompleted } from '../lib/checkout-attempt';
import { requiresProductCreditsV2, usesProductCreditsV2 } from '../lib/product-config';
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

function getStripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id;
  }
  return null;
}

function getInvoiceSubscriptionMetadata(invoice: Stripe.Invoice): Record<string, string> {
  const anyInvoice = invoice as any;
  return anyInvoice.parent?.subscription_details?.metadata
    || anyInvoice.subscription_details?.metadata
    || anyInvoice.metadata
    || {};
}

function normalizeSubscriptionStatus(status: Stripe.Subscription.Status): Subscription['status'] {
  // The live shared table predates Stripe's `incomplete` state. Preserve the
  // blocking semantics using a status accepted by both old and current schemas.
  if (status === 'incomplete') return 'past_due';
  if (status === 'incomplete_expired') return 'canceled';
  if (status === 'paused') return 'unpaid';
  return status;
}

function getInvoiceLinePriceId(line: any): string | null {
  return getStripeObjectId(line?.pricing?.price_details?.price)
    || getStripeObjectId(line?.price);
}

function getInvoiceLineSubscriptionId(line: any): string | null {
  return getStripeObjectId(line?.parent?.subscription_item_details?.subscription)
    || getStripeObjectId(line?.subscription);
}

function isRecurringSubscriptionLine(line: any, subscriptionId: string): boolean {
  const details = line?.parent?.subscription_item_details;
  if (details) {
    return !details.proration && getInvoiceLineSubscriptionId(line) === subscriptionId;
  }

  // Compatibility with invoice events created before Stripe's Basil shape.
  return line?.type === 'subscription'
    && !line?.proration
    && getInvoiceLineSubscriptionId(line) === subscriptionId;
}

function grantsRecurringCredits(invoice: Stripe.Invoice): boolean {
  return invoice.billing_reason === 'subscription_create'
    || invoice.billing_reason === 'subscription_cycle'
    || invoice.billing_reason === 'subscription';
}

async function getPlanByPriceOrMetadata(
  db: DbClient,
  priceId: string | null,
  planId: string | null,
): Promise<Plan | null> {
  // A concrete Stripe price is authoritative. Metadata is only a compatibility
  // fallback for older invoice objects that contain no price snapshot.
  if (priceId) return db.getPlanByStripePriceId(priceId);
  return planId ? db.getPlanById(planId) : null;
}

async function resolveCurrentSubscriptionPlan(
  db: DbClient,
  subscription: Stripe.Subscription,
): Promise<{ plan: Plan | null; hasConcretePrice: boolean }> {
  const item = getPrimaryItem(subscription);
  const priceId = getStripeObjectId(item.price);
  return {
    plan: await getPlanByPriceOrMetadata(
      db,
      priceId,
      subscription.metadata?.plan_id || null,
    ),
    hasConcretePrice: Boolean(priceId),
  };
}

async function resolveInvoicePlan(
  stripe: Stripe,
  db: DbClient,
  invoice: Stripe.Invoice,
  subscriptionId: string,
): Promise<Plan | null> {
  let lines = invoice.lines?.data || [];
  if (invoice.lines?.has_more) {
    const completeLines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
    lines = completeLines.data;
  }

  const priceIds = [...new Set(
    lines
      .filter((line) => isRecurringSubscriptionLine(line, subscriptionId))
      .map(getInvoiceLinePriceId)
      .filter((priceId): priceId is string => Boolean(priceId)),
  )];
  if (priceIds.length > 1) {
    throw new Error(`Invoice ${invoice.id} has multiple recurring subscription prices`);
  }
  if (priceIds.length === 0 && lines.some((line) => Boolean(getInvoiceLinePriceId(line)))) {
    return null;
  }

  const metadataPlanId = getInvoiceSubscriptionMetadata(invoice).plan_id || null;
  return getPlanByPriceOrMetadata(db, priceIds[0] || null, metadataPlanId);
}

async function resolveSubscriptionUserId(
  env: Env,
  existing: Subscription | null,
  subscription: Stripe.Subscription,
  invoice?: Stripe.Invoice,
): Promise<string | null> {
  const invoiceMetadata = invoice ? getInvoiceSubscriptionMetadata(invoice) : {};
  const metadataUserIds = [...new Set(
    [invoiceMetadata.user_id, subscription.metadata?.user_id].filter((userId): userId is string => Boolean(userId)),
  )];
  if (metadataUserIds.length > 1) {
    throw new Error(`Subscription ${subscription.id} has conflicting user metadata`);
  }
  const metadataUserId = metadataUserIds[0] || null;

  if (existing) {
    if (metadataUserId && existing.user_id !== metadataUserId) {
      throw new Error(`Subscription ${subscription.id} user metadata does not match the existing owner`);
    }
    return existing.user_id;
  }
  if (metadataUserId) return metadataUserId;

  const customerId = getStripeObjectId(subscription.customer)
    || (invoice ? getStripeObjectId(invoice.customer) : null);
  if (!customerId) return null;

  const users = await env.DB.prepare('SELECT id FROM users WHERE stripe_customer_id = ? LIMIT 2')
    .bind(customerId)
    .all<{ id: string }>();
  if ((users.results?.length || 0) > 1) {
    throw new Error(`Stripe customer ${customerId} belongs to multiple local users`);
  }
  return users.results?.[0]?.id || null;
}

async function upsertSubscription(
  env: Env,
  db: DbClient,
  subscription: Stripe.Subscription,
  plan: Plan,
  userId: string,
  customerId: string | null,
): Promise<Subscription> {
  const item = getPrimaryItem(subscription);
  const existing = await db.getSubscriptionByStripeId(subscription.id);
  if (existing && existing.user_id !== userId) {
    throw new Error(`Subscription ${subscription.id} belongs to a different user`);
  }

  const user = await env.DB.prepare('SELECT id, stripe_customer_id FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string; stripe_customer_id: string | null }>();
  if (!user) {
    throw new Error(`Subscription ${subscription.id} references an unknown user`);
  }
  if (customerId) {
    if (user.stripe_customer_id && user.stripe_customer_id !== customerId) {
      throw new Error(`Subscription ${subscription.id} customer does not match the local user`);
    }
    const customerOwners = await env.DB.prepare('SELECT id FROM users WHERE stripe_customer_id = ? LIMIT 2')
      .bind(customerId)
      .all<{ id: string }>();
    if ((customerOwners.results?.length || 0) > 1) {
      throw new Error(`Stripe customer ${customerId} belongs to multiple local users`);
    }
    const customerOwner = customerOwners.results?.[0];
    if (customerOwner && customerOwner.id !== userId) {
      throw new Error(`Subscription ${subscription.id} customer belongs to a different user`);
    }
  }

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      id, user_id, stripe_customer_id, stripe_subscription_id, plan_id,
      status, current_period_start, current_period_end,
      cancel_at_period_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
      plan_id = excluded.plan_id,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      updated_at = unixepoch()
    WHERE subscriptions.user_id = excluded.user_id
  `).bind(
    crypto.randomUUID(),
    userId,
    customerId,
    subscription.id,
    plan.id,
    normalizeSubscriptionStatus(subscription.status),
    item.current_period_start ?? null,
    item.current_period_end ?? null,
    subscription.cancel_at_period_end ? 1 : 0,
  ).run();

  const synchronized = await db.getSubscriptionByStripeId(subscription.id);
  if (!synchronized || synchronized.user_id !== userId) {
    throw new Error(`Subscription ${subscription.id} could not be synchronized safely`);
  }
  return synchronized;
}

async function synchronizeSubscriptionState(
  env: Env,
  db: DbClient,
  subscription: Stripe.Subscription,
  invoice?: Stripe.Invoice,
  fallbackPlan?: Plan | null,
): Promise<Subscription | null> {
  const existing = await db.getSubscriptionByStripeId(subscription.id);
  const currentPlan = await resolveCurrentSubscriptionPlan(db, subscription);
  if (!existing && currentPlan.hasConcretePrice && !currentPlan.plan) {
    throw new Error(`Cannot resolve the current price for subscription ${subscription.id}`);
  }
  const plan = currentPlan.plan || (!existing && !currentPlan.hasConcretePrice ? fallbackPlan || null : null);

  if (plan) {
    const userId = await resolveSubscriptionUserId(env, existing, subscription, invoice);
    if (!userId) {
      throw new Error(`Cannot resolve the local user for subscription ${subscription.id}`);
    }
    return upsertSubscription(
      env,
      db,
      subscription,
      plan,
      userId,
      getStripeObjectId(subscription.customer) || (invoice ? getStripeObjectId(invoice.customer) : null),
    );
  }

  if (existing) {
    const item = getPrimaryItem(subscription);
    await db.updateSubscription({
      stripe_subscription_id: subscription.id,
      status: normalizeSubscriptionStatus(subscription.status),
      current_period_start: item.current_period_start ?? null,
      current_period_end: item.current_period_end ?? null,
      cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
    });
    return db.getSubscriptionByStripeId(subscription.id);
  }

  return null;
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
          let checkoutProcessed = false;

          // 处理订阅支付：只创建/更新 subscription，不发放 credits
          // credits 由 invoice.paid 处理，避免重复发放
          if (session.subscription) {
            const subscriptionId = getStripeObjectId(session.subscription);
            if (!subscriptionId) break;
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const item = getPrimaryItem(subscription);
            const priceId = getStripeObjectId(item.price);
            const planId = session.metadata?.plan_id || subscription.metadata?.plan_id;
            const plan = await getPlanByPriceOrMetadata(db, priceId, planId || null);

            if (plan) {
              await upsertSubscription(
                env,
                db,
                subscription,
                plan,
                userId,
                getStripeObjectId(session.customer) || getStripeObjectId(subscription.customer),
              );
              checkoutProcessed = true;
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
                  if (requiresProductCreditsV2(plan.product_id) || usesProductCreditsV2(plan.product_id, env)) {
                    await db.addProductCredits(userId, plan.product_id, plan.credits_per_period, 'purchase', `One-time purchase: ${plan.name}`, session.id);
                  } else {
                    await db.addCredits(userId, plan.credits_per_period, 'purchase', `One-time purchase: ${plan.name}`, session.id, getProductSlug(plan.product_id) || undefined);
                  }
                }
                checkoutProcessed = true;
                console.log(`${purchaseCreated ? 'Recorded' : 'Skipped duplicate'} purchase ${session.id} for ${plan.name}; credits=${plan.credits_per_period}`);
              }
            }
          }
          const checkoutAttemptId = session.metadata?.checkout_attempt_id;
          const checkoutProductId = session.metadata?.product_id;
          if (checkoutProcessed && checkoutAttemptId && checkoutProductId) {
            await markCheckoutAttemptCompleted(
              env.DB,
              userId,
              checkoutProductId,
              checkoutAttemptId,
              session.id,
            );
          }
          break;
        }

        case 'invoice.paid': {
          const invoice = data as Stripe.Invoice;
          const subscriptionId = getInvoiceSubscriptionId(invoice);
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const invoicePlan = await resolveInvoicePlan(stripe, db, invoice, subscriptionId);
            const sub = await synchronizeSubscriptionState(env, db, subscription, invoice, invoicePlan);

            if (!grantsRecurringCredits(invoice)) {
              console.log(`Skipped recurring credits for invoice ${invoice.id} with billing_reason=${invoice.billing_reason || 'unknown'}`);
              break;
            }
            if (!invoicePlan) {
              throw new Error(`Cannot resolve the paid plan snapshot for invoice ${invoice.id}`);
            }
            if (!sub) {
              throw new Error(`Cannot synchronize subscription ${subscription.id} for invoice ${invoice.id}`);
            }
            if (invoicePlan.credits_per_period > 0) {
              // 幂等：使用 invoice.id 作为 reference_id
              const result = requiresProductCreditsV2(invoicePlan.product_id) || usesProductCreditsV2(invoicePlan.product_id, env)
                ? await db.addProductCredits(sub.user_id, invoicePlan.product_id, invoicePlan.credits_per_period, 'subscription_grant', `Subscription payment: ${invoicePlan.name}`, invoice.id)
                : await db.addCredits(sub.user_id, invoicePlan.credits_per_period, 'subscription_grant', `Subscription payment: ${invoicePlan.name}`, invoice.id, getProductSlug(invoicePlan.product_id) || undefined);
              if (result) {
                console.log(`Granted ${invoicePlan.credits_per_period} credits for invoice ${invoice.id}`);
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
            const current = await stripe.subscriptions.retrieve(subscriptionId);
            await synchronizeSubscriptionState(env, db, current, invoice);
          }
          break;
        }

        case 'customer.subscription.updated': {
          const eventSubscription = data as Stripe.Subscription;
          const current = await stripe.subscriptions.retrieve(eventSubscription.id);
          await synchronizeSubscriptionState(env, db, current);
          break;
        }

        case 'customer.subscription.deleted': {
          const eventSubscription = data as Stripe.Subscription;
          const current = await stripe.subscriptions.retrieve(eventSubscription.id);
          await synchronizeSubscriptionState(env, db, current);
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
