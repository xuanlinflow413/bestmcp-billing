import type { D1Database } from '@cloudflare/workers-types';

/**
 * D1 数据库封装
 * 提供类型安全的查询方法
 */

export interface User {
	id: string;
	email: string;
	name: string | null;
	avatar_url: string | null;
	role: 'user' | 'support' | 'admin';
	email_verified: number;
	stripe_customer_id: string | null;
	is_active: number;
	created_at: number;
	updated_at: number;
}

export interface Account {
	id: string;
	user_id: string;
	provider: string;
	provider_account_id: string;
	access_token: string | null;
	refresh_token: string | null;
	expires_at: number | null;
	created_at: number;
}

export interface Credits {
	id: string;
	user_id: string;
	balance: number;
	lifetime_purchased: number;
	lifetime_used: number;
	updated_at: number;
}

export interface CreditTransaction {
	id: string;
	user_id: string;
	type: 'purchase' | 'usage' | 'refund' | 'bonus' | 'rollover' | 'expire' | 'subscription_grant';
	amount: number;
	balance_after: number;
	description: string | null;
	reference_id: string | null;
	product: 'bestmcp' | 'kindreply' | 'cleartext' | null;
	metadata: string | null;
	created_at: number;
}

export interface Subscription {
	id: string;
	user_id: string;
	stripe_customer_id: string | null;
	stripe_subscription_id: string | null;
	stripe_price_id: string | null;
	plan_id: string | null;
	status: 'incomplete' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'trialing';
	current_period_start: number | null;
	current_period_end: number | null;
	cancel_at_period_end: number;
	credits_allocated: number;
	credits_used: number;
	created_at: number;
	updated_at: number;
}

export interface Plan {
	id: string;
	product_id: string;
	slug: string;
	name: string;
	stripe_price_id: string | null;
	interval: 'month' | 'year' | 'lifetime' | null;
	price_cents: number;
	credits_per_period: number;
	rate_limit_rpm: number;
	rate_limit_rpd: number;
	is_active: number;
	created_at: number;
}

export interface Purchase {
	id: string;
	user_id: string;
	plan_id: string;
	stripe_checkout_session_id: string;
	status: 'active' | 'refunded' | 'revoked';
	created_at: number;
	updated_at: number;
}

export class DbClient {
	constructor(private db: D1Database) {}

	// ===== Users =====
	async getUserById(id: string): Promise<User | null> {
		const result = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
		return result || null;
	}

	async getUserByEmail(email: string): Promise<User | null> {
		const result = await this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
		return result || null;
	}

	async createUser(user: Omit<User, 'created_at' | 'updated_at'>): Promise<User> {
		await this.db
			.prepare(
				`INSERT INTO users (id, email, name, avatar_url, role, email_verified, stripe_customer_id, is_active, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
			)
			.bind(user.id, user.email, user.name, user.avatar_url, user.role, user.email_verified, user.stripe_customer_id, user.is_active)
			.run();
		return this.getUserById(user.id) as Promise<User>;
	}

	async updateUserStripeCustomer(userId: string, stripeCustomerId: string): Promise<void> {
		await this.db
			.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = unixepoch() WHERE id = ?')
			.bind(stripeCustomerId, userId)
			.run();
	}

	// ===== Accounts =====
	async getAccountByProvider(provider: string, providerAccountId: string): Promise<Account | null> {
		const result = await this.db
			.prepare('SELECT * FROM accounts WHERE provider = ? AND provider_account_id = ?')
			.bind(provider, providerAccountId)
			.first<Account>();
		return result || null;
	}

	async createAccount(account: Omit<Account, 'created_at'>): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO accounts (id, user_id, provider, provider_account_id, access_token, refresh_token, expires_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`
			)
			.bind(account.id, account.user_id, account.provider, account.provider_account_id, account.access_token, account.refresh_token, account.expires_at)
			.run();
	}

	// ===== Credits =====
	async getCredits(userId: string): Promise<Credits | null> {
		const result = await this.db.prepare('SELECT * FROM credits WHERE user_id = ?').bind(userId).first<Credits>();
		return result || null;
	}

	async createCredits(userId: string): Promise<Credits> {
		const id = crypto.randomUUID();
		await this.db
			.prepare('INSERT INTO credits (id, user_id, balance, lifetime_purchased, lifetime_used, updated_at) VALUES (?, ?, 0, 0, 0, unixepoch())')
			.bind(id, userId)
			.run();
		return this.getCredits(userId) as Promise<Credits>;
	}

	async consumeCredits(userId: string, amount: number, description: string, product: string, referenceId: string): Promise<{ success: boolean; balance: number }> {
		// 使用事务：先检查余额，再扣减
		const stmt = this.db.prepare(`
			UPDATE credits
			SET balance = balance - ?,
			    lifetime_used = lifetime_used + ?,
			    updated_at = unixepoch()
			WHERE user_id = ? AND balance >= ?
		`);
		const result = await stmt.bind(amount, amount, userId, amount).run();

		if (!result.success || (result.meta?.changes ?? 0) === 0) {
			return { success: false, balance: 0 };
		}

		// 获取新余额
		const credits = await this.getCredits(userId);
		const newBalance = credits?.balance ?? 0;

		// 记录流水
		await this.createCreditTransaction({
			id: crypto.randomUUID(),
			user_id: userId,
			type: 'usage',
			amount: -amount,
			balance_after: newBalance,
			description,
			reference_id: referenceId,
			product: product as any,
			metadata: null,
			created_at: Math.floor(Date.now() / 1000),
		});

		return { success: true, balance: newBalance };
	}

	async addCredits(userId: string, amount: number, type: CreditTransaction['type'], description: string, referenceId?: string, product?: string): Promise<Credits | null> {
		// 幂等性检查：如果 reference_id 已存在，跳过
		if (referenceId) {
			const existingTx = await this.getCreditTransactionByReference(referenceId);
			if (existingTx) {
				console.log(`[addCredits] Skipped duplicate: reference_id=${referenceId} already exists (tx_id=${existingTx.id})`);
				return null;
			}
		}

		let existingCredits = await this.getCredits(userId);
		if (!existingCredits) {
			existingCredits = await this.createCredits(userId);
		}

		// 增加余额
		await this.db
			.prepare(`
				UPDATE credits
				SET balance = balance + ?,
				    lifetime_purchased = CASE WHEN ? IN ('purchase', 'subscription_grant') THEN lifetime_purchased + ? ELSE lifetime_purchased END,
				    updated_at = unixepoch()
				WHERE user_id = ?
			`)
			.bind(amount, type, amount, userId)
			.run();

		const credits = await this.getCredits(userId);
		const newBalance = credits?.balance ?? 0;

		// 记录流水
		await this.createCreditTransaction({
			id: crypto.randomUUID(),
			user_id: userId,
			type,
			amount,
			balance_after: newBalance,
			description,
			reference_id: referenceId || null,
			product: (product as any) || null,
			metadata: null,
			created_at: Math.floor(Date.now() / 1000),
		});

		return credits!;
	}

	async refundCredits(userId: string, amount: number, description: string, referenceId: string): Promise<Credits | null> {
		return this.addCredits(userId, amount, 'refund', description, referenceId);
	}

	// ===== Credit Transactions =====
	async createCreditTransaction(tx: CreditTransaction): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO credit_transactions (id, user_id, type, amount, balance_after, description, reference_id, product, metadata, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(tx.id, tx.user_id, tx.type, tx.amount, tx.balance_after, tx.description, tx.reference_id, tx.product, tx.metadata, tx.created_at)
			.run();
	}

	async getCreditTransactions(userId: string, limit = 50, offset = 0): Promise<CreditTransaction[]> {
		const result = await this.db
			.prepare('SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
			.bind(userId, limit, offset)
			.all<CreditTransaction>();
		return result.results || [];
	}

	async getCreditTransactionByReference(referenceId: string): Promise<CreditTransaction | null> {
		const result = await this.db
			.prepare('SELECT * FROM credit_transactions WHERE reference_id = ? LIMIT 1')
			.bind(referenceId)
			.first<CreditTransaction>();
		return result || null;
	}

	// ===== Subscriptions =====
	async getSubscription(userId: string): Promise<Subscription | null> {
		const result = await this.db
			.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
			.bind(userId)
			.first<Subscription>();
		return result || null;
	}

	async getActiveSubscriptionForProduct(userId: string, productId: string): Promise<Subscription | null> {
		const result = await this.db
			.prepare(`
				SELECT s.*
				FROM subscriptions s
				JOIN plans p ON s.plan_id = p.id
				WHERE s.user_id = ?
					AND p.product_id = ?
					AND s.status IN ('active', 'trialing')
				ORDER BY s.created_at DESC
				LIMIT 1
			`)
			.bind(userId, productId)
			.first<Subscription>();
		return result || null;
	}

	async createSubscription(sub: Omit<Subscription, 'created_at' | 'updated_at'>): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
				 current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
			)
			.bind(
				sub.id, sub.user_id, sub.stripe_customer_id, sub.stripe_subscription_id,
				sub.plan_id, sub.status, sub.current_period_start, sub.current_period_end,
				sub.cancel_at_period_end
			)
			.run();
	}

	async updateSubscriptionStatus(stripeSubscriptionId: string, status: Subscription['status']): Promise<void> {
		await this.db
			.prepare('UPDATE subscriptions SET status = ?, updated_at = unixepoch() WHERE stripe_subscription_id = ?')
			.bind(status, stripeSubscriptionId)
			.run();
	}

	async updateSubscription(sub: Partial<Subscription> & { stripe_subscription_id: string }): Promise<void> {
		const fields: string[] = [];
		const values: (string | number | null)[] = [];

		if (sub.status) { fields.push('status = ?'); values.push(sub.status); }
		if (sub.plan_id) { fields.push('plan_id = ?'); values.push(sub.plan_id); }
		if (sub.current_period_start !== undefined) { fields.push('current_period_start = ?'); values.push(sub.current_period_start); }
		if (sub.current_period_end !== undefined) { fields.push('current_period_end = ?'); values.push(sub.current_period_end); }
		if (sub.cancel_at_period_end !== undefined) { fields.push('cancel_at_period_end = ?'); values.push(sub.cancel_at_period_end); }

		fields.push('updated_at = unixepoch()');
		values.push(sub.stripe_subscription_id);

		await this.db
			.prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE stripe_subscription_id = ?`)
			.bind(...values)
			.run();
	}

	// ===== Plans =====
	async getPlanByStripePriceId(stripePriceId: string): Promise<Plan | null> {
		const result = await this.db
			.prepare(`
				SELECT
					id,
					product_id,
					slug,
					name,
					stripe_price_id,
					billing_interval AS interval,
					price_cents,
					credits_allocated AS credits_per_period,
					rate_limit_rpm,
					rate_limit_rpd,
					is_active,
					created_at
				FROM plans
				WHERE stripe_price_id = ?
			`)
			.bind(stripePriceId)
			.first<Plan>();
		return result || null;
	}

	async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
	  const result = await this.db
	    .prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?')
	    .bind(stripeSubscriptionId)
	    .first<Subscription>();
	  return result || null;
	}

	async getPlanById(id: string): Promise<Plan | null> {
	  const result = await this.db.prepare(`
		SELECT
			id,
			product_id,
			slug,
			name,
			stripe_price_id,
			billing_interval AS interval,
			price_cents,
			credits_allocated AS credits_per_period,
			rate_limit_rpm,
			rate_limit_rpd,
			is_active,
			created_at
		FROM plans
		WHERE id = ?
	  `).bind(id).first<Plan>();
	  return result || null;
	}

	// ===== One-time purchases =====
	async createPurchase(userId: string, planId: string, checkoutSessionId: string): Promise<boolean> {
		const result = await this.db
			.prepare(`
				INSERT OR IGNORE INTO purchases (
					id, user_id, plan_id, stripe_checkout_session_id, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'active', unixepoch(), unixepoch())
			`)
			.bind(crypto.randomUUID(), userId, planId, checkoutSessionId)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	async getActivePurchasesForProduct(userId: string, productId: string): Promise<Purchase[]> {
		const result = await this.db
			.prepare(`
				SELECT pu.*
				FROM purchases pu
				JOIN plans p ON p.id = pu.plan_id
				WHERE pu.user_id = ? AND p.product_id = ? AND pu.status = 'active'
				ORDER BY pu.created_at DESC
			`)
			.bind(userId, productId)
			.all<Purchase>();
		return result.results || [];
	}

	async hasActivePurchase(userId: string, planId: string): Promise<boolean> {
		const purchase = await this.db
			.prepare(`
				SELECT id FROM purchases
				WHERE user_id = ? AND plan_id = ? AND status = 'active'
				LIMIT 1
			`)
			.bind(userId, planId)
			.first<{ id: string }>();
		return Boolean(purchase);
	}

	// ===== Webhook Events =====
	async getWebhookEvent(stripeEventId: string): Promise<{ id: string; status: string; payload: string; processing_error: string | null } | null> {
		const result = await this.db
			.prepare('SELECT id, status, payload, processing_error FROM webhook_events WHERE stripe_event_id = ?')
			.bind(stripeEventId)
			.first<{ id: string; status: string; payload: string; processing_error: string | null }>();
		return result || null;
	}

	async createWebhookEvent(event: { id: string; stripe_event_id: string; event_type: string; payload: string }): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO webhook_events (id, stripe_event_id, event_type, payload, status, created_at)
				 VALUES (?, ?, ?, ?, 'pending', unixepoch())`
			)
			.bind(event.id, event.stripe_event_id, event.event_type, event.payload)
			.run();
	}

	async markWebhookProcessed(id: string, status: 'processed' | 'failed' | 'ignored', error?: string): Promise<void> {
		await this.db
			.prepare(
				`UPDATE webhook_events SET status = ?, processing_error = ?, processed_at = unixepoch() WHERE id = ?`
			)
			.bind(status, error || null, id)
			.run();
	}

	// ===== Usage Logs =====
	async createUsageLog(log: {
		id: string;
		user_id: string;
		api_key_id: string | null;
		product: string;
		feature: string;
		credits_consumed: number;
		input_tokens: number | null;
		output_tokens: number | null;
		model: string | null;
		latency_ms: number | null;
		status: string;
		error_message: string | null;
		metadata: string | null;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO usage_logs (id, user_id, api_key_id, product, feature, credits_consumed,
				 input_tokens, output_tokens, model, latency_ms, status, error_message, metadata, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
			)
			.bind(
				log.id, log.user_id, log.api_key_id, log.product, log.feature, log.credits_consumed,
				log.input_tokens, log.output_tokens, log.model, log.latency_ms, log.status,
				log.error_message, log.metadata
			)
			.run();
	}
}
