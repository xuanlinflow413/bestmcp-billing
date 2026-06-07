import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { createSession, destroySession, getSessionToken, verifySession } from '../lib/auth';
import { errorResponse, generateUUID, jsonResponse, now, setCookie, clearCookie } from '../lib/utils';

const authRoutes = new Hono<AppContext>();

/**
 * GET /api/auth/google
 * 发起 Google OAuth 登录
 */
authRoutes.get('/google', async (c) => {
  const env = c.env;
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // 存储 state 到 KV（10分钟过期）
  await env.KV_SESSIONS.put(`oauth:state:${state}`, nonce, { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'offline',
    prompt: 'consent',
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

/**
 * GET /api/auth/google/callback
 * Google OAuth 回调处理
 */
authRoutes.get('/google/callback', async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return c.redirect(`${env.APP_URL}/auth/error?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return c.redirect(`${env.APP_URL}/auth/error?error=missing_params`);
  }

  // 验证 state
  const storedNonce = await env.KV_SESSIONS.get(`oauth:state:${state}`);
  if (!storedNonce) {
    return c.redirect(`${env.APP_URL}/auth/error?error=invalid_state`);
  }
  await env.KV_SESSIONS.delete(`oauth:state:${state}`);

  // 用 code 换 token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('Google token exchange failed:', err);
    return c.redirect(`${env.APP_URL}/auth/error?error=token_exchange`);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token: string;
  };

  // 获取用户信息
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    return c.redirect(`${env.APP_URL}/auth/error?error=userinfo`);
  }

  const googleUser = await userRes.json() as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  const db = new DbClient(env.DB);

  // 查找或创建用户
  let user = await db.getUserByEmail(googleUser.email);

  if (!user) {
    const userId = generateUUID();
    user = await db.createUser({
      id: userId,
      email: googleUser.email,
      name: googleUser.name,
      avatar_url: googleUser.picture,
      role: 'user',
      email_verified: 1,
      stripe_customer_id: null,
      is_active: 1,
    });

    // 创建 OAuth 账户关联
    await db.createAccount({
      id: generateUUID(),
      user_id: userId,
      provider: 'google',
      provider_account_id: googleUser.id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: tokenData.expires_in ? now() + tokenData.expires_in : null,
    });

    // 初始化 Credits
    await db.createCredits(userId);
  } else {
    // 更新 OAuth token
    const account = await db.getAccountByProvider('google', googleUser.id);
    if (account) {
      // 这里可以更新 token，暂时省略
    }
  }

  // 创建会话
  const sessionToken = await createSession(user, env.KV_SESSIONS, env.JWT_SECRET);

  // 设置 cookie 并重定向
  c.header('Set-Cookie', setCookie('session', sessionToken, 7 * 24 * 60 * 60));
  return c.redirect(`${env.APP_URL}/dashboard`);
});

/**
 * POST /api/auth/logout
 * 登出
 */
authRoutes.post('/logout', async (c) => {
  const token = getSessionToken(c.req.raw);
  if (token) {
    await destroySession(token, c.env.KV_SESSIONS);
  }
  c.header('Set-Cookie', clearCookie('session'));
  return jsonResponse({ success: true });
});

/**
 * GET /api/auth/session
 * 获取当前会话信息
 */
authRoutes.get('/session', async (c) => {
  const token = getSessionToken(c.req.raw);
  if (!token) {
    return errorResponse('Unauthorized', 401);
  }

  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) {
    c.header('Set-Cookie', clearCookie('session'));
    return errorResponse('Session expired', 401);
  }

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(payload.userId);
  const credits = await db.getCredits(payload.userId);
  const subscription = await db.getSubscription(payload.userId);

  return jsonResponse({
    user: user ? {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      role: user.role,
    } : null,
    credits: credits ? {
      balance: credits.balance,
      lifetime_used: credits.lifetime_used,
      lifetime_purchased: credits.lifetime_purchased,
    } : null,
    subscription: subscription ? {
      status: subscription.status,
      plan_id: subscription.plan_id,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
    } : null,
  });
});

export { authRoutes };
