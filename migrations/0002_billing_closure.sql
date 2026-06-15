-- Payment closure migration for BestMCP Billing
-- Run: npx wrangler d1 migrations apply bestmcp-billing-db --remote

PRAGMA foreign_keys = OFF;

-- Normalize plans table to the code-facing schema while preserving existing rows.
CREATE TABLE IF NOT EXISTS plans_new (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    stripe_price_id TEXT UNIQUE,
    billing_interval TEXT CHECK (billing_interval IN ('month', 'year', 'one_time')),
    price_cents INTEGER NOT NULL,
    credits_allocated INTEGER DEFAULT 0,
    rate_limit_rpm INTEGER DEFAULT 60,
    rate_limit_rpd INTEGER DEFAULT 2000,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

INSERT OR REPLACE INTO plans_new (id, product_id, slug, name, stripe_price_id, billing_interval, price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd, is_active, created_at)
SELECT
    id,
    product_id,
    slug,
    name,
    stripe_price_id,
    CASE WHEN interval = 'lifetime' THEN 'one_time' ELSE interval END,
    price_cents,
    credits_per_period,
    60,
    2000,
    COALESCE(is_active, 1),
    COALESCE(created_at, unixepoch())
FROM plans;

DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;
CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product_id);
CREATE INDEX IF NOT EXISTS idx_plans_stripe_price ON plans(stripe_price_id);

-- Keep MVP plan IDs stable and normalize billing/limit fields.
INSERT OR IGNORE INTO plans (id, product_id, slug, name, stripe_price_id, billing_interval, price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd) VALUES
('plan_bestmcp_free', 'prod_bestmcp', 'bestmcp-free', 'Free', NULL, NULL, 0, 100, 30, 500),
('plan_bestmcp_pro', 'prod_bestmcp', 'bestmcp-pro', 'Pro', NULL, 'month', 999, 1000, 60, 2000),
('plan_kindreply_free', 'prod_kindreply', 'kindreply-free', 'Free', NULL, NULL, 0, 50, 30, 500),
('plan_kindreply_pro', 'prod_kindreply', 'kindreply-pro', 'Pro', NULL, 'month', 799, 500, 60, 2000);

UPDATE plans SET billing_interval = NULL, price_cents = 0, credits_allocated = 100, rate_limit_rpm = 30, rate_limit_rpd = 500 WHERE id = 'plan_bestmcp_free';
UPDATE plans SET billing_interval = 'month', price_cents = 999, credits_allocated = 1000, rate_limit_rpm = 60, rate_limit_rpd = 2000 WHERE id = 'plan_bestmcp_pro';
UPDATE plans SET billing_interval = NULL, price_cents = 0, credits_allocated = 50, rate_limit_rpm = 30, rate_limit_rpd = 500 WHERE id = 'plan_kindreply_free';
UPDATE plans SET billing_interval = 'month', price_cents = 799, credits_allocated = 500, rate_limit_rpm = 60, rate_limit_rpd = 2000 WHERE id = 'plan_kindreply_pro';

-- Rebuild subscriptions to include fields expected by src/lib/db.ts and allow incomplete status.
CREATE TABLE IF NOT EXISTS subscriptions_new (
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

INSERT OR REPLACE INTO subscriptions_new (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, credits_allocated, credits_used, created_at, updated_at)
SELECT
    id,
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    NULL,
    plan_id,
    status,
    current_period_start,
    current_period_end,
    COALESCE(cancel_at_period_end, 0),
    0,
    0,
    COALESCE(created_at, unixepoch()),
    COALESCE(updated_at, unixepoch())
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed', 'ignored')),
    processing_error TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_event_id ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_events(created_at);

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

CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    api_key_id TEXT,
    product TEXT NOT NULL CHECK (product IN ('bestmcp', 'kindreply')),
    feature TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT,
    permissions TEXT DEFAULT '[]',
    rate_limit_rpm INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    last_used_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

PRAGMA foreign_keys = ON;
