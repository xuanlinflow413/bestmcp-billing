-- BestMCPServers + KindReply 统一收费系统 D1 Schema
-- SQLite 适配版
-- 执行: npx wrangler d1 execute bestmcp-billing-db --file=./src/db/schema.sql

-- 开启外键约束
PRAGMA foreign_keys = ON;

-- ============================================
-- 1. 用户与认证
-- ============================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                          -- UUID v7
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    avatar_url TEXT,
    role TEXT DEFAULT 'user' CHECK (role IN ('user', 'support', 'admin')),
    email_verified INTEGER DEFAULT 0,             -- SQLite boolean: 0/1
    stripe_customer_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google',
    provider_account_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider, provider_account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

-- ============================================
-- 2. 订阅与套餐
-- ============================================

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    stripe_price_id TEXT UNIQUE,
    billing_interval TEXT CHECK (billing_interval IN ('month', 'year', 'one_time')),
    price_cents INTEGER NOT NULL,                 -- 以分为单位，避免浮点
    credits_allocated INTEGER DEFAULT 0,          -- 每月/每次分配的 Credits
    rate_limit_rpm INTEGER DEFAULT 60,
    rate_limit_rpd INTEGER DEFAULT 2000,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product_id);
CREATE INDEX IF NOT EXISTS idx_plans_stripe_price ON plans(stripe_price_id);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT UNIQUE,
    stripe_price_id TEXT,
    plan_id TEXT,
    status TEXT DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'active', 'past_due', 'unpaid', 'canceled', 'trialing')),
    current_period_start INTEGER,
    current_period_end INTEGER,
    cancel_at_period_end INTEGER DEFAULT 0,
    credits_allocated INTEGER DEFAULT 0,
    credits_used INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ============================================
-- 3. Credits 系统
-- ============================================

CREATE TABLE IF NOT EXISTS credits (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,                    -- 当前可用 Credits（分=Credit）
    lifetime_purchased INTEGER DEFAULT 0,
    lifetime_used INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id);

CREATE TABLE IF NOT EXISTS credit_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus', 'rollover', 'expire', 'subscription_grant')),
    amount INTEGER NOT NULL,                      -- 正=增加，负=消耗
    balance_after INTEGER NOT NULL,
    description TEXT,
    reference_id TEXT,                            -- 关联 invoice/usage_log
    product TEXT CHECK (product IN ('bestmcp', 'kindreply')),
    metadata TEXT,                                -- JSON 字符串
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type);
CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_tx_reference ON credit_transactions(reference_id);

-- ============================================
-- 4. AI 调用日志
-- ============================================

CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    api_key_id TEXT,
    product TEXT NOT NULL CHECK (product IN ('bestmcp', 'kindreply')),
    feature TEXT NOT NULL,                        -- 'mcp_eval', 'search', 'reply_short', 'reply_long'
    credits_consumed INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    model TEXT,
    latency_ms INTEGER,
    status TEXT DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
    error_message TEXT,
    metadata TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_product ON usage_logs(product);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_logs(feature);

-- ============================================
-- 5. API 密钥
-- ============================================

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    key_hash TEXT UNIQUE NOT NULL,                -- SHA-256
    key_prefix TEXT,                              -- 前8位展示
    permissions TEXT DEFAULT '[]',                -- JSON 数组
    rate_limit_rpm INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    last_used_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ============================================
-- 6. Stripe Webhook 事件
-- ============================================

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,                        -- 完整 JSON payload
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed', 'ignored')),
    processing_error TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_event_id ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_events(created_at);

-- ============================================
-- 7. 发票记录
-- ============================================

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stripe_invoice_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    paid_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe ON invoices(stripe_invoice_id);

-- ============================================
-- 8. 初始化数据
-- ============================================

-- 插入产品
INSERT OR IGNORE INTO products (id, slug, name, description) VALUES
('prod_bestmcp', 'bestmcp', 'BestMCPServers', 'MCP server directory and evaluation platform'),
('prod_kindreply', 'kindreply', 'KindReply', 'AI-powered reply assistant');

-- 插入套餐
INSERT OR IGNORE INTO plans (id, product_id, slug, name, stripe_price_id, billing_interval, price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd) VALUES
('plan_starter_monthly', 'prod_kindreply', 'starter_monthly', 'Starter Monthly', 'price_starter_monthly', 'month', 900, 1000, 30, 500),
('plan_starter_yearly', 'prod_kindreply', 'starter_yearly', 'Starter Yearly', 'price_starter_yearly', 'year', 8600, 12000, 30, 500),
('plan_pro_monthly', 'prod_bestmcp', 'pro_monthly', 'Pro Monthly', 'price_pro_monthly', 'month', 2900, 4000, 60, 2000),
('plan_pro_yearly', 'prod_bestmcp', 'pro_yearly', 'Pro Yearly', 'price_pro_yearly', 'year', 27800, 48000, 60, 2000),
('plan_team_monthly', 'prod_bestmcp', 'team_monthly', 'Team Monthly', 'price_team_monthly', 'month', 7900, 12000, 120, 10000),
('plan_enterprise', 'prod_bestmcp', 'enterprise', 'Enterprise', NULL, 'month', 29900, 50000, 0, 0);
