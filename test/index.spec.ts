import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("BestMCP Billing worker smoke tests", () => {
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

	it("/billing/success renders a non-404 checkout return page", async () => {
		const response = await SELF.fetch("http://example.com/billing/success?session_id=cs_test_placeholder");
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain("Payment successful");
		expect(text).toContain("Back to dashboard");
	});

	it("/billing/cancel renders a non-404 cancel page", async () => {
		const response = await SELF.fetch("http://example.com/billing/cancel");
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain("Payment cancelled");
	});

	it("/auth/error renders a non-404 auth error page", async () => {
		const response = await SELF.fetch("http://example.com/auth/error?error=test_error");
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain("Authentication error");
		expect(text).toContain("test_error");
	});

	it("/dashboard serves the static dashboard page", async () => {
		const response = await SELF.fetch("http://example.com/dashboard");
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain("BestMCP Billing Dashboard");
		expect(text).toContain("Plans");
	});
});
