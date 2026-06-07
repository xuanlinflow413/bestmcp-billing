import type { MessageBatch } from '@cloudflare/workers-types';
import { DbClient } from '../lib/db';
import type { Env } from '../types';

interface CreditsMessage {
  type: 'monthly_reset' | 'expire' | 'rollover';
  userId?: string;
  planId?: string;
  timestamp: number;
}

/**
 * Queue Consumer: 处理 Credits 相关异步任务
 */
export async function handleCreditsQueue(batch: MessageBatch<CreditsMessage>, env: Env): Promise<void> {
  const db = new DbClient(env.DB);

  for (const message of batch.messages) {
    try {
      const { type, userId, planId } = message.body;

      switch (type) {
        case 'monthly_reset': {
          // 为所有 active 订阅用户重置月度 Credits
          const { results } = await env.DB.prepare(
            `SELECT s.user_id, s.credits_allocated, p.credits_allocated as plan_credits
             FROM subscriptions s
             JOIN plans p ON s.plan_id = p.id
             WHERE s.status = 'active' AND s.cancel_at_period_end = 0`
          ).all<{ user_id: string; credits_allocated: number; plan_credits: number }>();

          for (const row of results || []) {
            await db.addCredits(
              row.user_id,
              row.plan_credits,
              'subscription_grant',
              'Monthly credits reset'
            );
          }
          break;
        }

        case 'expire': {
          // 处理过期 Credits（如需要）
          console.log(`Processing credits expiration for user ${userId}`);
          break;
        }

        default:
          console.log(`Unhandled credits message type: ${type}`);
      }

      message.ack();
    } catch (err: any) {
      console.error('Credits queue processing failed:', err);
      message.retry();
    }
  }
}
