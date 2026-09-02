import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { authRoutes } from './routes/auth';
import { creditsRoutes } from './routes/credits';
import { billingRoutes } from './routes/billing';
import { webhookRoutes } from './routes/webhook';
import { apiKeyRoutes } from './routes/api-keys';
import { imageRoutes } from './routes/images';
import { handleWebhookQueue } from './queues/webhook';
import { handleAuditQueue } from './queues/audit';
import { handleCreditsQueue } from './queues/credits';
import type { MessageBatch } from '@cloudflare/workers-types';
import {
  asSkuanglesServiceRequest,
  isAllowedSkuanglesServiceRequest,
} from './lib/skuangles-service';

const app = new Hono<{ Bindings: Env }>();

// 中间件
app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    const allowed = [
      'https://kindreply.co',
      'https://www.kindreply.co',
      'https://bestmcpservers.com',
      'https://www.bestmcpservers.com',
      'https://cleartextdetector.com',
      'https://www.cleartextdetector.com',
      'https://editimages.app',
      'https://www.editimages.app',
      'https://skuangles.com',
      'https://www.skuangles.com',
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    if (!origin) return null;
    if (allowed.includes(origin)) return origin;
    if (origin.endsWith('.kindreply.pages.dev')) return origin;
    if (origin.endsWith('.mcp-server-directory.pages.dev')) return origin;
    if (origin.endsWith('.cleartextdetector.pages.dev')) return origin;
    if (origin.endsWith('.editimages.pages.dev')) return origin;
    return null;
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// 健康检查
app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// 路由注册
app.route('/api/auth', authRoutes);
app.route('/api/credits', creditsRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/webhooks', webhookRoutes);
app.route('/api/keys', apiKeyRoutes);
app.route('/api/images', imageRoutes);

// 404
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

// 全局错误处理
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

export class SkuanglesAccountService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (!isAllowedSkuanglesServiceRequest(request)) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }

    return app.fetch(await asSkuanglesServiceRequest(request), this.env, this.ctx);
  }
}

export type QueueHandler = (batch: MessageBatch<any>, env: Env) => Promise<void>;

export function resolveQueueHandler(queueName: string, env: Env): QueueHandler | null {
  const webhookQueueName = env.WEBHOOK_QUEUE_NAME ?? 'bestmcp-billing-webhooks';
  const auditQueueName = env.AUDIT_QUEUE_NAME ?? 'bestmcp-billing-audit';
  const creditsQueueName = env.CREDITS_QUEUE_NAME ?? 'bestmcp-billing-credits';

  if (queueName === webhookQueueName) return handleWebhookQueue;
  if (queueName === auditQueueName) return handleAuditQueue;
  if (queueName === creditsQueueName) return handleCreditsQueue;
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    const handler = resolveQueueHandler(batch.queue, env);
    if (handler) {
      await handler(batch, env);
    } else {
      console.log(`Unknown queue: ${batch.queue}`);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case '0 0 1 * *':
        // 每月1日重置 Credits
        await env.QUEUE_CREDITS.send({ type: 'monthly_reset', timestamp: Date.now() });
        break;
      case '0 0 * * *':
        // 每日同步订阅状态
        console.log('Daily subscription sync');
        break;
    }
  },
};
