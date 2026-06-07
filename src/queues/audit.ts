import type { MessageBatch } from '@cloudflare/workers-types';
import { DbClient } from '../lib/db';
import type { Env } from '../types';

interface AuditMessage {
  type: 'credits_consumed' | 'api_call' | 'login' | 'subscription_change';
  userId: string;
  timestamp: number;
  [key: string]: any;
}

/**
 * Queue Consumer: 处理审计日志
 */
export async function handleAuditQueue(batch: MessageBatch<AuditMessage>, env: Env): Promise<void> {
  const db = new DbClient(env.DB);

  for (const message of batch.messages) {
    try {
      const { type, userId, timestamp, ...data } = message.body;

      switch (type) {
        case 'credits_consumed': {
          await db.createUsageLog({
            id: crypto.randomUUID(),
            user_id: userId,
            api_key_id: data.apiKeyId || null,
            product: data.product,
            feature: data.feature,
            credits_consumed: data.amount,
            input_tokens: data.inputTokens || null,
            output_tokens: data.outputTokens || null,
            model: data.model || null,
            latency_ms: data.latency || null,
            status: 'success',
            error_message: null,
            metadata: JSON.stringify({ reference_id: data.referenceId }),
          });
          break;
        }

        case 'api_call': {
          await db.createUsageLog({
            id: crypto.randomUUID(),
            user_id: userId,
            api_key_id: data.apiKeyId || null,
            product: data.product,
            feature: data.feature,
            credits_consumed: data.creditsConsumed || 0,
            input_tokens: data.inputTokens || null,
            output_tokens: data.outputTokens || null,
            model: data.model || null,
            latency_ms: data.latency || null,
            status: data.status || 'success',
            error_message: data.error || null,
            metadata: JSON.stringify(data.metadata || {}),
          });
          break;
        }

        default:
          console.log(`Audit type ${type} logged for user ${userId}`);
      }

      message.ack();
    } catch (err: any) {
      console.error('Audit queue processing failed:', err);
      message.retry();
    }
  }
}
