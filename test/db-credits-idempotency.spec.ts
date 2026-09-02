import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DbClient } from '../src/lib/db';

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT UNIQUE NOT NULL,
			stripe_customer_id TEXT
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS credits (
			id TEXT PRIMARY KEY,
			user_id TEXT UNIQUE NOT NULL,
			balance INTEGER DEFAULT 0,
			lifetime_purchased INTEGER DEFAULT 0,
			lifetime_used INTEGER DEFAULT 0,
			updated_at INTEGER
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS credit_transactions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			type TEXT NOT NULL,
			amount INTEGER NOT NULL,
			balance_after INTEGER NOT NULL,
			description TEXT,
			reference_id TEXT,
			product TEXT,
			metadata TEXT,
			created_at INTEGER
		)`),
		env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_test_credit_tx_user_type_reference_unique
			ON credit_transactions(user_id, type, reference_id)
			WHERE reference_id IS NOT NULL`),
		env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_test_users_stripe_customer_unique_nonempty
			ON users(stripe_customer_id)
			WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''`),
	]);
});

describe('legacy shared-credit idempotency', () => {
	it('grants one balance update for concurrent calls with the same invoice reference', async () => {
		const db = new DbClient(env.DB);
		const userId = `credit-user-${crypto.randomUUID()}`;
		const invoiceId = `in-${crypto.randomUUID()}`;
		const results = await Promise.all(Array.from({ length: 8 }, () => db.addCredits(
			userId,
			40,
			'subscription_grant',
			'Monthly subscription credits',
			invoiceId,
			'kindreply',
		)));

		expect(results.filter((result) => result !== null)).toHaveLength(1);
		expect(await db.getCredits(userId)).toMatchObject({
			balance: 40,
			lifetime_purchased: 40,
		});
		expect(await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
			FROM credit_transactions
			WHERE user_id = ? AND type = 'subscription_grant' AND reference_id = ?`)
			.bind(userId, invoiceId)
			.first()).toEqual({ count: 1, amount: 40 });
	});

	it('allows a usage and refund to share a reference ID', async () => {
		const db = new DbClient(env.DB);
		const userId = `refund-user-${crypto.randomUUID()}`;
		const referenceId = `request-${crypto.randomUUID()}`;

		await db.addCredits(userId, 5, 'bonus', 'Test balance');
		expect(await db.addCredits(userId, -1, 'usage', 'Use one credit', referenceId)).not.toBeNull();
		expect(await db.addCredits(userId, 1, 'refund', 'Refund one credit', referenceId)).not.toBeNull();

		expect((await db.getCredits(userId))?.balance).toBe(5);
		expect(await env.DB.prepare(`SELECT COUNT(*) AS count
			FROM credit_transactions
			WHERE user_id = ? AND reference_id = ?`)
			.bind(userId, referenceId)
			.first()).toEqual({ count: 2 });
	});

	it('keeps reference-less grants non-idempotent for backwards compatibility', async () => {
		const db = new DbClient(env.DB);
		const userId = `legacy-user-${crypto.randomUUID()}`;

		expect(await db.addCredits(userId, 3, 'bonus', 'First legacy grant')).not.toBeNull();
		expect(await db.addCredits(userId, 3, 'bonus', 'Second legacy grant')).not.toBeNull();

		expect((await db.getCredits(userId))?.balance).toBe(6);
		expect(await env.DB.prepare(`SELECT COUNT(*) AS count
			FROM credit_transactions
			WHERE user_id = ? AND reference_id IS NULL`)
			.bind(userId)
			.first()).toEqual({ count: 2 });
	});

	it('rejects a duplicate non-empty Stripe customer ID but allows null and empty values', async () => {
		const customerId = `cus-${crypto.randomUUID()}`;
		const insert = (id: string, value: string | null) => env.DB.prepare(
			'INSERT INTO users (id, email, stripe_customer_id) VALUES (?, ?, ?)',
		).bind(id, `${id}@example.test`, value).run();

		await insert(`stripe-a-${crypto.randomUUID()}`, customerId);
		await expect(insert(`stripe-b-${crypto.randomUUID()}`, customerId)).rejects.toThrow();
		await insert(`stripe-null-a-${crypto.randomUUID()}`, null);
		await insert(`stripe-null-b-${crypto.randomUUID()}`, null);
		await insert(`stripe-empty-a-${crypto.randomUUID()}`, '');
		await insert(`stripe-empty-b-${crypto.randomUUID()}`, '');
	});
});
