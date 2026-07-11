import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("BestMCP Billing worker smoke tests", () => {
	async function seedClearTextPlan() {
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
			env.DB.prepare(`INSERT OR REPLACE INTO products (id, name, slug, description, is_active)
			VALUES ('prod_cleartext', 'ClearText Detector', 'cleartext', 'AI text detection', 1)`),
			env.DB.prepare(`INSERT OR REPLACE INTO plans (
				id, product_id, name, billing_interval, price_cents,
				credits_allocated, features, is_active
			) VALUES (
				'plan_cleartext_pro', 'prod_cleartext', 'ClearText Pro', 'month', 999,
				500, '["500 analyses per month"]', 1
			)`),
		]);
	}

	it("/health returns ok (unit style)", async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			"http://example.com/health"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "ok" });
	});

	it("/health returns ok (integration style)", async () => {
		const response = await SELF.fetch("http://example.com/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "ok" });
	});

	it("/api/billing/plans is public and returns the ClearText Pro plan", async () => {
		await seedClearTextPlan();
		const response = await SELF.fetch("http://auth.cleartextdetector.com/api/billing/plans");
		const body = await response.json() as { plans: Array<Record<string, unknown>> };

		expect(response.status).toBe(200);
		expect(body.plans).toContainEqual(expect.objectContaining({
		id: "plan_cleartext_pro",
		product_id: "prod_cleartext",
		billing_interval: "month",
		price_cents: 999,
		credits_allocated: 500,
		}));
	});

	it("/api/billing/checkout remains protected", async () => {
		const response = await SELF.fetch("http://auth.cleartextdetector.com/api/billing/checkout", {
			method: "POST",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: "Unauthorized" });
	});

	it("/dashboard serves the static dashboard page", async () => {
		const response = await SELF.fetch("http://example.com/dashboard");
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain("BestMCP Billing Dashboard");
		expect(text).toContain("Plans");
	});
});
