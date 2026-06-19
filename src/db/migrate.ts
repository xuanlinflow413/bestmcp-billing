import type { D1Database } from '@cloudflare/workers-types';

/**
 * D1 数据库迁移工具
 * 执行所有 schema 创建和初始化
 */
export async function runMigrations(db: D1Database): Promise<void> {
	// 开启外键约束
	await db.exec('PRAGMA foreign_keys = ON;');

	// 1. users
	await db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT UNIQUE NOT NULL,
			name TEXT,
			avatar_url TEXT,
			role TEXT DEFAULT 'user' CHECK (role IN ('user', 'support', 'admin')),
			email_verified INTEGER DEFAULT 0,
			stripe_customer_id TEXT,
			is_active INTEGER DEFAULT 1,
			created_at INTEGER DEFAULT (unixepoch()),
			updated_at INTEGER DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
		CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
		CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
	`);

	// 2. accounts
	await db.exec(`
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
	`);

	// 3. products
	await db.exec(`
		CREATE TABLE IF NOT EXISTS products (
			id TEXT PRIMARY KEY,
			slug TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			is_active INTEGER DEFAULT 1,
			created_at INTEGER DEFAULT (unixepoch())
		);
	`);

	// 4. plans
	await db.exec(`
		CREATE TABLE IF NOT EXISTS plans (
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
		CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product_id);
		CREATE INDEX IF NOT EXISTS idx_plans_stripe_price ON plans(stripe_price_id);
	`);

	// 5. subscriptions
	await db.exec(`
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
	`);

	// 6. credits
	await db.exec(`
		CREATE TABLE IF NOT EXISTS credits (
			id TEXT PRIMARY KEY,
			user_id TEXT UNIQUE NOT NULL,
			balance INTEGER DEFAULT 0,
			lifetime_purchased INTEGER DEFAULT 0,
			lifetime_used INTEGER DEFAULT 0,
			updated_at INTEGER DEFAULT (unixepoch()),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id);
	`);

	// 7. credit_transactions
	await db.exec(`
		CREATE TABLE IF NOT EXISTS credit_transactions (
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
		CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
		CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type);
		CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at);
		CREATE INDEX IF NOT EXISTS idx_credit_tx_reference ON credit_transactions(reference_id);
	`);

	// 8. usage_logs
	await db.exec(`
		CREATE TABLE IF NOT EXISTS usage_logs (
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
		CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
		CREATE INDEX IF NOT EXISTS idx_usage_product ON usage_logs(product);
		CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
		CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_logs(feature);
	`);

	// 9. api_keys
	await db.exec(`
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
	`);

	// 10. webhook_events
	await db.exec(`
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
	`);

	// 11. invoices
	await db.exec(`
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
	`);

	// 初始化数据
	await db.exec(`
		INSERT OR IGNORE INTO products (id, slug, name, description) VALUES
		('prod_bestmcp', 'bestmcp', 'BestMCPServers', 'MCP server directory and evaluation platform'),
		('prod_kindreply', 'kindreply', 'KindReply', 'AI-powered reply assistant'),
		('prod_cleartext', 'cleartext', 'ClearText Detector', 'AI text detection and humanization workspace');

		INSERT OR IGNORE INTO plans (id, product_id, slug, name, stripe_price_id, billing_interval, price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd) VALUES
		('plan_bestmcp_free', 'prod_bestmcp', 'bestmcp-free', 'Free', NULL, NULL, 0, 100, 30, 500),
		('plan_bestmcp_pro', 'prod_bestmcp', 'bestmcp-pro', 'Pro', NULL, 'month', 999, 1000, 60, 2000),
		('plan_kindreply_free', 'prod_kindreply', 'kindreply-free', 'Free', NULL, NULL, 0, 50, 30, 500),
		('plan_kindreply_pro', 'prod_kindreply', 'kindreply-pro', 'Pro', NULL, 'month', 799, 500, 60, 2000),
		('plan_cleartext_free', 'prod_cleartext', 'cleartext-free', 'Free', NULL, NULL, 0, 20, 30, 300),
		('plan_cleartext_pro', 'prod_cleartext', 'cleartext-pro', 'Pro', NULL, 'month', 999, 500, 60, 2000);
	`);
}
