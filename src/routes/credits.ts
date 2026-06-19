import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { verifySession, getSessionToken } from '../lib/auth';
import { errorResponse, jsonResponse } from '../lib/utils';

const creditsRoutes = new Hono<AppContext>();

/**
 * 认证中间件 - 支持 Session Cookie 或 Internal API Key
 */
async function authMiddleware(c: any, next: any) {
  // 优先检查 Internal API Key（服务间调用）
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === c.env.INTERNAL_API_KEY) {
      // 服务间调用，从 X-User-ID 获取用户
      const userId = c.req.header('X-User-ID');
      if (userId) {
        c.set('userId', userId);
        c.set('userRole', 'service');
        await next();
        return;
      }
    }
  }

  // 回退到 Session Cookie 认证（浏览器用户）
  const token = getSessionToken(c.req.raw);
  if (!token) {
    return errorResponse('Unauthorized', 401);
  }

  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) {
    return errorResponse('Session expired', 401);
  }

  c.set('userId', payload.userId);
  c.set('userEmail', payload.email);
  c.set('userRole', payload.role);
  await next();
}

creditsRoutes.use('*', authMiddleware);

/**
 * GET /api/credits
 * 查询当前用户 Credits 余额
 */
creditsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const db = new DbClient(c.env.DB);
  const credits = await db.getCredits(userId);

  if (!credits) {
    return jsonResponse({ balance: 0, lifetime_used: 0, lifetime_purchased: 0 });
  }

  return jsonResponse({
    balance: credits.balance,
    lifetime_used: credits.lifetime_used,
    lifetime_purchased: credits.lifetime_purchased,
  });
});

/**
 * GET /api/credits/transactions
 * 查询 Credits 交易流水
 */
creditsRoutes.get('/transactions', async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const db = new DbClient(c.env.DB);
  const transactions = await db.getCreditTransactions(userId, limit, offset);

  return jsonResponse({ transactions });
});

/**
 * POST /api/credits/consume
 * 消耗 Credits（内部 API，用于 AI 调用）
 */
const consumeSchema = z.object({
  amount: z.number().int().positive(),
  product: z.enum(['bestmcp', 'kindreply', 'cleartext']),
  feature: z.string(),
  description: z.string().optional(),
});

creditsRoutes.post('/consume', zValidator('json', consumeSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const body = c.req.valid('json');

  const db = new DbClient(c.env.DB);

  // 检查余额
  const credits = await db.getCredits(userId);
  if (!credits || credits.balance < body.amount) {
    return errorResponse('Insufficient credits', 402, 'CREDITS_INSUFFICIENT');
  }

  // 消耗 Credits
  const referenceId = crypto.randomUUID();
  const result = await db.consumeCredits(
    userId,
    body.amount,
    body.description || `${body.product}:${body.feature}`,
    body.product,
    referenceId
  );

  if (!result.success) {
    return errorResponse('Failed to consume credits', 500);
  }

  // 异步审计日志
  await c.env.QUEUE_AUDIT.send({
    type: 'credits_consumed',
    userId,
    amount: body.amount,
    product: body.product,
    feature: body.feature,
    referenceId,
    timestamp: Date.now(),
  });

  return jsonResponse({
    success: true,
    balance: result.balance,
    reference_id: referenceId,
  });
});

/**
 * POST /api/credits/refund
 * 返还 Credits（内部 API，用于 AI 调用失败）
 * 仅 admin 可操作
 */
const refundSchema = z.object({
  user_id: z.string(),
  reference_id: z.string(),
  amount: z.number().int().positive(),
  reason: z.string(),
});

creditsRoutes.post('/refund', zValidator('json', refundSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return errorResponse('Unauthorized', 401);
  const role = c.get('userRole');

  // 允许 service 角色（kindreply-api）或 admin 角色
  if (role !== 'service' && role !== 'admin') {
    return errorResponse('Forbidden', 403);
  }

  const body = c.req.valid('json');
  const db = new DbClient(c.env.DB);

  const credits = await db.refundCredits(body.user_id, body.amount, body.reason, body.reference_id);

  if (!credits) {
    const latestCredits = await db.getCredits(body.user_id);
    return jsonResponse({
      success: true,
      alreadyProcessed: true,
      balance: latestCredits?.balance || 0,
      reference_id: body.reference_id,
    });
  }

  return jsonResponse({
    success: true,
    balance: credits.balance,
    reference_id: body.reference_id,
  });
});

export { creditsRoutes };
