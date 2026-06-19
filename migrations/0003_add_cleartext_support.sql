-- Add ClearText billing product support
-- Run: npx wrangler d1 migrations apply bestmcp-billing-db --remote

PRAGMA foreign_keys = OFF;

-- Rebuild credit_transactions so its product CHECK allows ClearText while preserving rows.
CREATE TABLE IF NOT EXISTS credit_transactions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus', 'rollover', 'expire', 'subscription_grant')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    reference_id TEXT,
    product TEXT CHECK (product IN ('bestmcp', 'kindreply', 'cleartext')),
    metadata TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO credit_transactions_new (
    id, user_id, type, amount, balance_after, description, reference_id, product, metadata, created_at
)
SELECT
    id, user_id, type, amount, balance_after, description, reference_id, product, metadata, created_at
FROM credit_transactions;

DROP TABLE credit_transactions;
ALTER TABLE credit_transactions_new RENAME TO credit_transactions;

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type);
CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_tx_reference ON credit_transactions(reference_id);

-- Rebuild usage_logs so its product CHECK allows ClearText while preserving rows.
CREATE TABLE IF NOT EXISTS usage_logs_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    api_key_id TEXT,
    product TEXT NOT NULL CHECK (product IN ('bestmcp', 'kindreply', 'cleartext')),
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

INSERT OR IGNORE INTO usage_logs_new (
    id, user_id, api_key_id, product, feature, credits_consumed,
    input_tokens, output_tokens, model, latency_ms, status, error_message, metadata, created_at
)
SELECT
    id, user_id, api_key_id, product, feature, credits_consumed,
    input_tokens, output_tokens, model, latency_ms, status, error_message, metadata, created_at
FROM usage_logs;

DROP TABLE usage_logs;
ALTER TABLE usage_logs_new RENAME TO usage_logs;

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_product ON usage_logs(product);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_logs(feature);

INSERT OR IGNORE INTO products (id, slug, name, description) VALUES
('prod_cleartext', 'cleartext', 'ClearText Detector', 'AI text detection and humanization workspace');

INSERT OR IGNORE INTO plans (id, product_id, slug, name, description, stripe_price_id, interval, price_cents, credits_per_period) VALUES
('plan_cleartext_free', 'prod_cleartext', 'cleartext-free', 'Free', 'Free ClearText detection credits for evaluation.', NULL, NULL, 0, 20),
('plan_cleartext_pro', 'prod_cleartext', 'cleartext-pro', 'Pro', 'Monthly ClearText detection and humanization credits.', NULL, 'month', 999, 500);

PRAGMA foreign_keys = ON;
