-- Freeze SKU Angles early-access allowances against the verified image cost.
-- One product credit represents one successfully delivered angle image.
PRAGMA foreign_keys = ON;

UPDATE plans
SET credits_allocated = 20
WHERE id = 'skuangles-starter-monthly'
  AND product_id = 'prod_skuangles'
  AND price_cents = 1200
  AND is_active = 0;

UPDATE plans
SET credits_allocated = 50
WHERE id = 'skuangles-pro-monthly'
  AND product_id = 'prod_skuangles'
  AND price_cents = 2900
  AND is_active = 0;
