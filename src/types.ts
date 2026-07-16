import type { Ai, D1Database, KVNamespace, Queue, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  // D1 数据库
  DB: D1Database;

  // KV 命名空间
  KV_SESSIONS: KVNamespace;
  KV_RATELIMIT: KVNamespace;
  KV_CACHE: KVNamespace;

  // R2 存储
  R2_STORAGE: R2Bucket;

  // Queues
  QUEUE_WEBHOOK: Queue;
  QUEUE_AUDIT: Queue;
  QUEUE_CREDITS: Queue;

  // Workers AI
  AI: Ai;

  // 环境变量
  APP_ENV: string;
  APP_URL: string;
  FRONTEND_URL: string;
  API_URL: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
  PRODUCT_CREDITS_V2_PRODUCTS: string;

  // Secrets (通过 wrangler secret 设置)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  INTERNAL_API_KEY: string; // 服务间调用认证
  ADMIN_SECRET: string; // Admin replay endpoint

  // PayPal
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_LIVE: string;
}

// Hono Context 类型
export type AppContext = {
  Bindings: Env;
  Variables: {
    userId?: string;
    userEmail?: string;
    userRole?: string;
  };
};
