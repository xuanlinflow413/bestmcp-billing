-- Add the code-facing billing columns to a legacy plans table in place.
-- This deliberately preserves the legacy columns so existing subscription foreign keys
-- and Stripe price mappings are never moved or rebuilt.

ALTER TABLE plans ADD COLUMN billing_interval TEXT CHECK (billing_interval IN ('month', 'year', 'one_time'));
ALTER TABLE plans ADD COLUMN credits_allocated INTEGER DEFAULT 0;
ALTER TABLE plans ADD COLUMN rate_limit_rpm INTEGER DEFAULT 60;
ALTER TABLE plans ADD COLUMN rate_limit_rpd INTEGER DEFAULT 2000;

UPDATE plans
SET
    billing_interval = CASE WHEN interval = 'lifetime' THEN 'one_time' ELSE interval END,
    credits_allocated = credits_per_period,
    rate_limit_rpm = COALESCE(rate_limit_rpm, 60),
    rate_limit_rpd = COALESCE(rate_limit_rpd, 2000);

CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product_id);
CREATE INDEX IF NOT EXISTS idx_plans_stripe_price ON plans(stripe_price_id);
