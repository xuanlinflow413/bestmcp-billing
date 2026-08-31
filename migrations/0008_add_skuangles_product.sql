-- Add SKU Angles as an isolated product in the shared account and billing system.
-- Paid plans stay inactive until their real Stripe price IDs are written to D1.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO products (id, slug, name, description, is_active)
VALUES (
  'prod_skuangles',
  'skuangles',
  'SKU Angles',
  'AI product photo angle generation',
  1
);

INSERT OR IGNORE INTO plans (
  id,
  product_id,
  slug,
  name,
  stripe_price_id,
  billing_interval,
  price_cents,
  credits_allocated,
  rate_limit_rpm,
  rate_limit_rpd,
  is_active
) VALUES
  (
    'skuangles-starter-monthly',
    'prod_skuangles',
    'skuangles-starter-monthly',
    'Starter',
    NULL,
    'month',
    1200,
    80,
    10,
    200,
    0
  ),
  (
    'skuangles-pro-monthly',
    'prod_skuangles',
    'skuangles-pro-monthly',
    'Pro',
    NULL,
    'month',
    2900,
    250,
    20,
    600,
    0
  );
