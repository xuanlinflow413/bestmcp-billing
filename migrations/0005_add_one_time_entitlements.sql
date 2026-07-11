-- Durable entitlements for one-time products that do not grant credits.

CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    stripe_checkout_session_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'refunded', 'revoked')),
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_plan ON purchases(plan_id);

INSERT OR IGNORE INTO plans (
    id, product_id, slug, name, stripe_price_id, billing_interval,
    price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd, is_active
) VALUES (
    'plan_bestmcp_security_audit',
    'prod_bestmcp',
    'bestmcp-security-audit',
    'MCP Security Audit Pack',
    NULL,
    'one_time',
    2900,
    0,
    0,
    0,
    0
);
