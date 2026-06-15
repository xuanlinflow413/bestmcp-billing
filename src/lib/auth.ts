import type { KVNamespace } from '@cloudflare/workers-types';
import { SignJWT, jwtVerify } from 'jose';
import type { User } from './db';

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  userId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * 创建会话 JWT
 */
export async function createSession(
  user: User,
  kv: any,
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    userId: user.id,
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL)
    .sign(new TextEncoder().encode(secret));

  // 同时写入 KV 作为服务端会话
  await kv.put(
    `session:${token}`,
    JSON.stringify({ userId: user.id, email: user.email, role: user.role }),
    { expirationTtl: SESSION_TTL }
  );

  return token;
}

/**
 * 验证会话
 */
export async function verifySession(
  token: string,
  kv: any,
  secret: string
): Promise<SessionPayload | null> {
  try {
    // 先验证 JWT
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { clockTolerance: 60 }
    );

    // 再查 KV 确认会话存在
    const sessionData = await kv.get(`session:${token}`);
    if (!sessionData) return null;

    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * 销毁会话
 */
export async function destroySession(
  token: string,
  kv: any
): Promise<void> {
  await kv.delete(`session:${token}`);
}

/**
 * 从请求中提取 session token
 */
export function getSessionToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const cookie = request.headers.get('cookie');
  if (!cookie) return null;

  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}
