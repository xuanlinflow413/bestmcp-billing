import { Hono } from 'hono';
import type { AppContext } from '../types';
import { DbClient } from '../lib/db';
import { createSession, destroySession, getSessionToken, verifySession } from '../lib/auth';
import { getProductConfigForRequest, getProductConfigForReturnUrl } from '../lib/product-config';
import { errorResponse, generateUUID, jsonResponse, now, setCookie, clearCookie } from '../lib/utils';

const authRoutes = new Hono<AppContext>();

/**
 * 允许的登录回跳域名白名单
 * - 固定域名：kindreply.co, www.kindreply.co, bestmcpservers.com, www.bestmcpservers.com, cleartextdetector.com, www.cleartextdetector.com
 * - 通配子域：*.kindreply.pages.dev, *.mcp-server-directory.pages.dev, *.cleartextdetector.pages.dev
 */
const ALLOWED_RETURN_HOSTS = [
  'kindreply.co',
  'www.kindreply.co',
  'bestmcpservers.com',
  'www.bestmcpservers.com',
  'cleartextdetector.com',
  'www.cleartextdetector.com',
  'editimages.app',
  'www.editimages.app',
];

const ALLOWED_RETURN_HOST_SUFFIXES = [
  '.kindreply.pages.dev',
  '.mcp-server-directory.pages.dev',
  '.cleartextdetector.pages.dev',
  '.editimages.pages.dev',
];

/**
 * 验证并获取安全的回跳 URL
 * 安全要求：
 * - protocol 必须是 https:
 * - hostname 必须等于固定白名单域名，或以 .kindreply.pages.dev 结尾
 * - 不允许 http
 * - 不允许形如 evilkindreply.pages.dev.attacker.com 的攻击
 * - 不允许 query 里伪造域名通过
 */
function getSafeReturnUrl(returnUrl: string | null, fallback: string): string {
  if (!returnUrl) return fallback;
  try {
    const url = new URL(returnUrl);

    // 必须是 https 协议
    if (url.protocol !== 'https:') {
      console.log('getSafeReturnUrl: rejected - not https:', url.protocol);
      return fallback;
    }

    const host = url.host; // 包含端口（如果有）

    // 检查固定白名单
    if (ALLOWED_RETURN_HOSTS.includes(host)) {
      return returnUrl;
    }

    // 检查后缀白名单（防止 attacker.com 攻击）
    for (const suffix of ALLOWED_RETURN_HOST_SUFFIXES) {
      if (host.endsWith(suffix)) {
        // 额外检查：确保不是 attacker.com 伪造
        // host 必须以 suffix 结尾，且 suffix 前必须是一个合法的子域（含点或开头）
        const prefix = host.slice(0, -suffix.length);
        if (prefix.length > 0 && !prefix.includes('.')) {
          return returnUrl;
        }
      }
    }

    console.log('getSafeReturnUrl: rejected - host not allowed:', host);
  } catch (e) {
    console.log('getSafeReturnUrl: rejected - invalid URL:', returnUrl);
  }
  return fallback;
}

function getOAuthRedirectUri(requestUrl: string, env: AppContext['Bindings'], forwardedHost?: string | null): string {
  const requestConfig = getProductConfigForRequest(requestUrl, forwardedHost);
  if (requestConfig.oauthRedirectUri) {
    return requestConfig.oauthRedirectUri;
  }
  return env.GOOGLE_OAUTH_REDIRECT_URI;
}

/**
 * GET /api/auth/google
 * 发起 Google OAuth 登录
 */
authRoutes.get('/google', async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const returnUrl = url.searchParams.get('returnUrl') || '';
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // 存储 state + returnUrl 到 KV（10分钟过期）
  const stateData = JSON.stringify({ nonce, returnUrl });
  await env.KV_SESSIONS.put(`oauth:state:${state}`, stateData, { expirationTtl: 600 });

  const oauthRedirectUri = getOAuthRedirectUri(c.req.url, env, c.req.header('X-Forwarded-Host'));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: oauthRedirectUri,
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
  const requestConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return c.redirect(`${requestConfig.appUrl}/auth/error?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return c.redirect(`${requestConfig.appUrl}/auth/error?error=missing_params`);
  }

  // 验证 state
  const storedStateData = await env.KV_SESSIONS.get(`oauth:state:${state}`);
  if (!storedStateData) {
    return c.redirect(`${requestConfig.appUrl}/auth/error?error=invalid_state`);
  }
  await env.KV_SESSIONS.delete(`oauth:state:${state}`);

  let returnUrl = '';
  let state_return_url_host = '';
  let state_return_url_path = '';
  let fallback_used = false;
  
  try {
    const parsed = JSON.parse(storedStateData);
    returnUrl = parsed.returnUrl || '';
    if (returnUrl) {
      try {
        const ru = new URL(returnUrl);
        state_return_url_host = ru.host;
        state_return_url_path = ru.pathname;
      } catch {
        state_return_url_host = 'invalid';
      }
    }
  } catch {
    returnUrl = '';
  }

  // 计算 safe return URL
  const productConfig = getProductConfigForReturnUrl(returnUrl, env);
  const fallbackReturnUrl = `${productConfig.frontendUrl}${productConfig.defaultReturnPath}`;
  const safeReturnUrl = getSafeReturnUrl(returnUrl, fallbackReturnUrl);
  let safe_return_url_host = '';
  try {
    safe_return_url_host = new URL(safeReturnUrl).host;
  } catch {
    safe_return_url_host = 'invalid';
  }
  fallback_used = safeReturnUrl === fallbackReturnUrl;

  console.log(JSON.stringify({
    event: 'oauth_callback_return_url_debug',
    state_return_url_host,
    state_return_url_path,
    safe_return_url_host,
    fallback_used,
    returnUrl_length: returnUrl.length,
  }));

  // 用 code 换 token
  const oauthRedirectUri = getOAuthRedirectUri(c.req.url, env, c.req.header('X-Forwarded-Host'));
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: oauthRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('Google token exchange failed:', err);
    console.error('Request details:', {
      client_id_present: Boolean(env.GOOGLE_CLIENT_ID),
      redirect_uri: oauthRedirectUri,
      grant_type: 'authorization_code',
      code_length: code.length,
    });
    return c.redirect(`${requestConfig.appUrl}/auth/error?error=token_exchange&details=${encodeURIComponent(err.slice(0, 200))}`);
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
    return c.redirect(`${requestConfig.appUrl}/auth/error?error=userinfo`);
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
  }

  // 创建会话
  const sessionToken = await createSession(user, env.KV_SESSIONS, env.JWT_SECRET);

  // 设置 cookie 并重定向到原页面或 dashboard
  const redirectUrl = safeReturnUrl;
  console.log(JSON.stringify({
    event: 'oauth_callback_final_redirect',
    redirectUrl,
    fallback_used,
  }));

  // 生成一次性 handoff token（用于跨域登录态同步）
  const handoffToken = 'handoff_' + crypto.randomUUID();
  const handoffData = JSON.stringify({
    userId: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    role: user.role,
    returnHost: new URL(redirectUrl).host,
  });
  await env.KV_SESSIONS.put(`handoff:${handoffToken}`, handoffData, { expirationTtl: 60 });

  // 在 redirect URL 上附加 auth_token
  const redirectWithToken = new URL(redirectUrl);
  redirectWithToken.searchParams.set('auth_token', handoffToken);
  console.log(JSON.stringify({
    event: 'oauth_callback_handoff_created',
    returnHost: redirectWithToken.host,
  }));

  c.header('Set-Cookie', setCookie('session', sessionToken, 7 * 24 * 60 * 60));
  return c.redirect(redirectWithToken.toString());
});

/**
 * POST /api/auth/exchange
 * 一次性 handoff token 交换为 session
 * 用于跨域登录态同步（KindReply 前端）
 */
authRoutes.post('/exchange', async (c) => {
  const env = c.env;
  let body: { token?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { token } = body;

  // 验证 token 格式
  if (!token || typeof token !== 'string' || !token.startsWith('handoff_')) {
    return errorResponse('Invalid token format', 400);
  }

  // 查 KV（一次性使用，读取后立即删除）
  const kvKey = `handoff:${token}`;
  const handoffDataRaw = await env.KV_SESSIONS.get(kvKey);
  if (!handoffDataRaw) {
    return errorResponse('Token expired or invalid', 401);
  }

  // 立即删除，确保一次性使用
  await env.KV_SESSIONS.delete(kvKey);

  let handoffData: {
    userId: string;
    email: string;
    name: string;
    avatar_url?: string;
    role: string;
    returnHost: string;
  };
  try {
    handoffData = JSON.parse(handoffDataRaw);
  } catch {
    return errorResponse('Invalid token data', 400);
  }

  // 验证 returnHost 在白名单中
  const allowed = ALLOWED_RETURN_HOSTS.includes(handoffData.returnHost) ||
    ALLOWED_RETURN_HOST_SUFFIXES.some(suffix => {
      if (!handoffData.returnHost.endsWith(suffix)) return false;
      const prefix = handoffData.returnHost.slice(0, -suffix.length);
      return prefix.length > 0 && !prefix.includes('.');
    });
  if (!allowed) {
    return errorResponse('Invalid return host', 403);
  }

  // 验证用户仍然存在
  const db = new DbClient(env.DB);
  const user = await db.getUserById(handoffData.userId);
  if (!user) {
    return errorResponse('User not found', 404);
  }

  // 创建正式 session token
  const sessionToken = await createSession(user, env.KV_SESSIONS, env.JWT_SECRET);

  // Service Binding proxies use this response to establish a host-only,
  // HttpOnly session cookie on the product frontend domain.
  c.header('Set-Cookie', setCookie('session', sessionToken, 7 * 24 * 60 * 60));

  // 返回用户信息和 session token（前端存储到 localStorage）
  return jsonResponse({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      role: user.role,
    },
    token: sessionToken,
  });
});
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
    return jsonResponse({ authenticated: false, user: null, credits: null, subscription: null, purchases: [] });
  }

  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  if (!payload) {
    c.header('Set-Cookie', clearCookie('session'));
    return jsonResponse({ authenticated: false, user: null, credits: null, subscription: null, purchases: [] });
  }

  const db = new DbClient(c.env.DB);
  const user = await db.getUserById(payload.userId);
  const credits = await db.getCredits(payload.userId);
  const productConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  const subscription = await db.getActiveSubscriptionForProduct(payload.userId, productConfig.productId);
  const purchases = await db.getActivePurchasesForProduct(payload.userId, productConfig.productId);

  return jsonResponse({
    authenticated: true,
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
    purchases: purchases.map((purchase) => ({
      plan_id: purchase.plan_id,
      status: purchase.status,
      purchased_at: purchase.created_at,
    })),
  });
});

export { authRoutes };
