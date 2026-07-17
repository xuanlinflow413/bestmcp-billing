import { env, SELF } from "cloudflare:test";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { getCheckoutReturnUrls } from "../src/routes/billing";
import { getProductConfigForHost } from "../src/lib/product-config";
import { detectImageType } from "../src/routes/images";

async function createBillingTables() {
	await env.DB.batch([
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			description TEXT,
			is_active INTEGER DEFAULT 1
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
			id TEXT PRIMARY KEY,
			product_id TEXT NOT NULL,
			name TEXT NOT NULL,
			stripe_price_id TEXT,
			billing_interval TEXT NOT NULL,
			price_cents INTEGER NOT NULL,
			credits_allocated INTEGER DEFAULT 0,
			rate_limit_rpm INTEGER DEFAULT 60,
			rate_limit_rpd INTEGER DEFAULT 2000,
			features TEXT,
			is_active INTEGER DEFAULT 1
		)`),
	]);
}

async function createSubscriptionTables() {
	await createBillingTables();
	await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		stripe_customer_id TEXT,
		stripe_subscription_id TEXT UNIQUE,
		plan_id TEXT NOT NULL,
		status TEXT NOT NULL,
		current_period_start INTEGER,
		current_period_end INTEGER,
		cancel_at_period_end INTEGER DEFAULT 0,
		credits_allocated INTEGER DEFAULT 0,
		created_at INTEGER DEFAULT (unixepoch()),
		updated_at INTEGER DEFAULT (unixepoch())
	)`).run();
}

async function createWebhookTable() {
	await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_events (
		id TEXT PRIMARY KEY,
		stripe_event_id TEXT UNIQUE NOT NULL,
		event_type TEXT NOT NULL,
		payload TEXT NOT NULL,
		status TEXT DEFAULT 'pending',
		processing_error TEXT,
		created_at INTEGER DEFAULT (unixepoch()),
		processed_at INTEGER
	)`).run();
}

async function createCreditTables() {
	await env.DB.batch([
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, stripe_customer_id TEXT, is_active INTEGER DEFAULT 1)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, is_active INTEGER DEFAULT 1)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, balance INTEGER DEFAULT 0, lifetime_purchased INTEGER DEFAULT 0, lifetime_used INTEGER DEFAULT 0, updated_at INTEGER)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS credit_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, description TEXT, reference_id TEXT, product TEXT, metadata TEXT, created_at INTEGER)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS image_credit_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, reference_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id, idempotency_key))`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_balances (user_id TEXT NOT NULL, product_id TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0), lifetime_purchased INTEGER NOT NULL DEFAULT 0, lifetime_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, product_id))`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, description TEXT, reference_id TEXT, idempotency_key TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (user_id, product_id, idempotency_key))`),
		env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_test_product_credit_ledger_reference ON product_credit_ledger(user_id, product_id, reference_id) WHERE reference_id IS NOT NULL`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_credit_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, reference_id TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(user_id, product_id, idempotency_key), UNIQUE(user_id, product_id, reference_id))`),
		env.DB.prepare(`INSERT OR IGNORE INTO products (id, name, slug) VALUES ('prod_editimages', 'EditImages', 'editimages')`),
	]);
}

describe("EditImages branded auth and billing", () => {
	it("uses the branded OAuth callback from the trusted request host", async () => {
		const response = await SELF.fetch(
			"http://auth.editimages.app/api/auth/google?returnUrl=https%3A%2F%2Feditimages.app%2Flogin%2F",
			{
				headers: { "X-Forwarded-Host": "auth.bestmcpservers.com" },
				redirect: "manual",
			},
		);
		const location = new URL(response.headers.get("location") || "");

		expect(response.status).toBe(302);
		expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(location.searchParams.get("redirect_uri")).toBe("https://auth.editimages.app/api/auth/google/callback");
	});

	it("returns no plans when EditImages has no approved mapping", async () => {
		await createBillingTables();
		await env.DB.batch([
			env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
				VALUES ('prod_cleartext', 'ClearText Detector', 'cleartext', 'AI text detection', 1)`),
			env.DB.prepare(`INSERT OR REPLACE INTO plans (
				id, product_id, name, billing_interval, price_cents, credits_allocated, is_active
			) VALUES ('plan_cleartext_pro', 'prod_cleartext', 'ClearText Pro', 'month', 999, 500, 1)`),
		]);

		const response = await SELF.fetch("http://auth.editimages.app/api/billing/plans", {
			headers: { "X-Forwarded-Host": "auth.bestmcpservers.com" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ plans: [] });
	});

	it("returns the production plan field contract for EditImages", async () => {
		await createBillingTables();
		await env.DB.batch([
			env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
				VALUES ('prod_editimages', 'EditImages', 'editimages', 'Image tools', 1)`),
			env.DB.prepare(`INSERT OR REPLACE INTO plans (
				id, product_id, name, stripe_price_id, billing_interval, price_cents, credits_allocated, is_active
			) VALUES ('editimages-seller-monthly', 'prod_editimages', 'Seller', 'price_test_seller', 'month', 900, 100, 1)`),
		]);

		const response = await SELF.fetch("http://auth.editimages.app/api/billing/plans");
		const body = await response.json() as { plans: Array<Record<string, unknown>> };
		expect(response.status).toBe(200);
		expect(body.plans).toContainEqual(expect.objectContaining({
			id: "editimages-seller-monthly",
			billing_interval: "month",
			credits_allocated: 100,
		}));
	});

	it("selects fixed EditImages checkout redirects instead of client URLs", () => {
		const config = getProductConfigForHost("auth.editimages.app");
		expect(config).not.toBeNull();
		expect(getCheckoutReturnUrls(config!)).toEqual({
			successUrl: "https://editimages.app/account/?checkout=success",
			cancelUrl: "https://editimages.app/account/?checkout=canceled",
		});
		const redirects = Object.values(getCheckoutReturnUrls(config!));
		expect(redirects).not.toContain("https://attacker.example/success");
		expect(redirects).not.toContain("https://attacker.example/cancel");
	});

	it("distinguishes active, trialing, past-due, canceled, and ended subscriptions", async () => {
		await createSubscriptionTables();
		const userId = `user_${crypto.randomUUID()}`;
		await env.DB.batch([
			env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
				VALUES ('prod_editimages', 'EditImages', 'editimages', 'Image tools', 1)`),
			env.DB.prepare(`INSERT OR REPLACE INTO plans (
				id, product_id, name, stripe_price_id, billing_interval, price_cents, credits_allocated, is_active
			) VALUES ('editimages-seller-monthly', 'prod_editimages', 'Seller', 'price_test_seller', 'month', 900, 100, 1)`),
		]);
		const db = new (await import('../src/lib/db')).DbClient(env.DB);
		const insertSubscription = async (status: string, createdAt: number, currentPeriodEnd: number | null = null) => {
			await env.DB.prepare(`INSERT INTO subscriptions (
				id, user_id, plan_id, status, current_period_end, created_at
			) VALUES (?, ?, 'editimages-seller-monthly', ?, ?, ?)`)
				.bind(crypto.randomUUID(), userId, status, currentPeriodEnd, createdAt)
				.run();
		};

		for (const [status, createdAt] of [["active", 100], ["trialing", 200], ["past_due", 300]] as const) {
			await insertSubscription(status, createdAt);
			expect(await db.getLatestSubscriptionForProduct(userId, 'prod_editimages')).toMatchObject({ status });
			expect(await db.getBlockingSubscriptionForProduct(userId, 'prod_editimages')).toMatchObject({ status });
		}

		await insertSubscription("canceled", 400, 500);
		expect(await db.getLatestSubscriptionForProduct(userId, 'prod_editimages')).toMatchObject({
			status: 'canceled',
			current_period_end: 500,
		});
		expect(await db.getBlockingSubscriptionForProduct(userId, 'prod_editimages')).toMatchObject({ status: 'past_due' });

		const endedUserId = `user_${crypto.randomUUID()}`;
		await env.DB.prepare(`INSERT INTO subscriptions (
			id, user_id, plan_id, status, current_period_end, created_at
		) VALUES (?, ?, 'editimages-seller-monthly', 'canceled', 100, 500)`)
			.bind(crypto.randomUUID(), endedUserId)
			.run();
		expect(await db.getLatestSubscriptionForProduct(endedUserId, 'prod_editimages')).toMatchObject({
			status: 'canceled',
			current_period_end: 100,
		});
		expect(await db.getBlockingSubscriptionForProduct(endedUserId, 'prod_editimages')).toBeNull();
	});

	it("rejects invalid Stripe webhook signatures", async () => {
		const response = await SELF.fetch("http://example.com/api/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "t=1,v1=invalid" },
			body: JSON.stringify({ id: "evt_invalid", type: "checkout.session.completed" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("Webhook Error") });
	});

	it("verifies and de-duplicates a signed Stripe webhook", async () => {
		await createWebhookTable();
		const payload = JSON.stringify({
			id: `evt_editimages_${crypto.randomUUID()}`,
			object: "event",
			type: "checkout.session.completed",
			data: { object: { id: "cs_test", mode: "payment", metadata: { product_id: "prod_editimages" } } },
		});
		const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
			payload,
			secret: env.STRIPE_WEBHOOK_SECRET,
		});
		const request = () => SELF.fetch("http://example.com/api/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": signature },
			body: payload,
		});

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
		const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM webhook_events WHERE stripe_event_id = ?")
			.bind(JSON.parse(payload).id).first<{ count: number }>();
		expect(row?.count).toBe(1);
	});

	it("reserves, de-duplicates, and refunds an EditImages credit", async () => {
		await createCreditTables();
		const userId = `user_${crypto.randomUUID()}`;
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'user')").bind(userId, `${userId}@example.test`),
			env.DB.prepare("INSERT INTO credits (id, user_id, balance, lifetime_purchased, lifetime_used, updated_at) VALUES (?, ?, 2, 2, 0, unixepoch())").bind(crypto.randomUUID(), userId),
		]);
		const db = new (await import('../src/lib/db')).DbClient(env.DB);
		const initialized = await Promise.all(Array.from({ length: 5 }, () => db.ensureProductCredits(userId, 'prod_editimages', 2)));
		expect(initialized.every((credits) => credits.balance === 2)).toBe(true);
		expect((await env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM product_credit_ledger WHERE user_id = ? AND product_id = ? AND type = 'bonus'").bind(userId, 'prod_editimages').first<{ count: number; amount: number }>())).toEqual({ count: 1, amount: 2 });

		const references = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		const reservations = await Promise.all(references.map((referenceId, index) => db.reserveProductCredit(userId, 'prod_editimages', `edit-key-123456789${index}`, referenceId)));
		expect(reservations.filter((result) => result.success)).toHaveLength(2);
		expect((await db.getProductCredits(userId, 'prod_editimages'))?.balance).toBe(0);
		expect((await db.getCredits(userId))?.balance).toBe(2);

		const successfulReference = references[reservations.findIndex((result) => result.success)];
		expect(await db.refundProductCreditReservation(userId, 'prod_editimages', successfulReference)).toMatchObject({ alreadyProcessed: false, balance: 1 });
		expect(await db.refundProductCreditReservation(userId, 'prod_editimages', successfulReference)).toMatchObject({ alreadyProcessed: true, balance: 1 });
		expect((await db.getCredits(userId))?.balance).toBe(2);
	});

	it("classifies AI output bytes as jpeg, png, or webp and rejects other payloads", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
		const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
		expect(detectImageType(jpeg)).toBe("image/jpeg");
		expect(detectImageType(png)).toBe("image/png");
		expect(detectImageType(webp)).toBe("image/webp");
		expect(detectImageType(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]))).toBeNull();
		expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
	});

	it("fails closed for unknown hosts and ignores spoofed forwarded product hosts", async () => {
		const unknown = await SELF.fetch("http://unknown.example/api/billing/plans", {
			headers: { "X-Forwarded-Host": "auth.editimages.app" },
		});
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ code: "PRODUCT_HOST_UNKNOWN" });

		await createBillingTables();
		const legacy = await SELF.fetch("http://auth.bestmcpservers.com/api/billing/plans", {
			headers: { "X-Forwarded-Host": "auth.editimages.app" },
		});
		expect(legacy.status).toBe(200);
	});
});
