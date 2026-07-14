import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						GOOGLE_CLIENT_ID: 'test-google-client',
						GOOGLE_CLIENT_SECRET: 'test-google-secret',
						JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
						STRIPE_SECRET_KEY: 'test-stripe-secret-placeholder',
						STRIPE_WEBHOOK_SECRET: 'whsec_test_editimages',
					},
				},
			},
		},
	},
});
