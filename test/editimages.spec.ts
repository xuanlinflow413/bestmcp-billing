import { env, SELF } from "cloudflare:test";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

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

describe("EditImages branded auth and billing", () => {
	it("uses the branded OAuth callback through a forwarded host", async () => {
		const response = await SELF.fetch(
			"http://bestmcp-billing/api/auth/google?returnUrl=https%3A%2F%2Feditimages.app%2Flogin%2F",
			{
				headers: { "X-Forwarded-Host": "auth.editimages.app" },
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

		const response = await SELF.fetch("http://bestmcp-billing/api/billing/plans", {
			headers: { "X-Forwarded-Host": "auth.editimages.app" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ plans: [] });
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
});
