import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { verifySession, getSessionToken } from '../lib/auth';
import { errorResponse, jsonResponse, generateApiKey, hashApiKey } from '../lib/utils';

const apiKeyRoutes = new Hono<AppContext>();

async function authMiddleware(c: any, next: any) {
  const token = getSessionToken(c.req.raw);
  if (!token) return errorResponse('Unauthorized', 401);
  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) return errorResponse('Session expired', 401);
  c.set('userId', payload.userId);
  c.set('userRole', payload.role);
  await next();
}

apiKeyRoutes.use('*', authMiddleware);

/**
 * GET /api/keys
 * 列出用户的 API Keys
 */
apiKeyRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = new DbClient(c.env.DB);

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, permissions, rate_limit_rpm, is_active, last_used_at, created_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all();

  return jsonResponse({ keys: results });
});

/**
 * POST /api/keys
 * 创建新的 API Key
 */
const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(z.string()).optional(),
});

apiKeyRoutes.post('/', zValidator('json', createKeySchema), async (c) => {
  const userId = c.get('userId');
  const body = c.req.valid('json');

  const { key, prefix } = generateApiKey();
  const hash = await hashApiKey(key);

  const db = new DbClient(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, permissions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
  ).bind(
    crypto.randomUUID(),
    userId,
    body.name,
    hash,
    prefix,
    JSON.stringify(body.permissions || [])
  ).run();

  // 只返回一次完整 key，之后无法查看
  return jsonResponse({
    key,
    prefix,
    name: body.name,
    message: 'Save this key now. You will not be able to see it again.',
  });
});

/**
 * DELETE /api/keys/:id
 * 删除 API Key
 */
apiKeyRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const keyId = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM api_keys WHERE id = ? AND user_id = ?'
  ).bind(keyId, userId).run();

  return jsonResponse({ success: true });
});

export { apiKeyRoutes };
