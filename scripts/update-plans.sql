-- 更新 KindReply Pro Plan
UPDATE plans 
SET stripe_price_id = 'price_1TgdK7E9dKQekvzkD1XxwIln',
    price_cents = 999,
    credits_allocated = 300,
    billing_interval = 'month'
WHERE id = 'plan_kindreply_pro';

-- 添加 KindReply Job Pack Plan (如果不存在则插入)
INSERT OR IGNORE INTO plans (
    id, product_id, slug, name, stripe_price_id, billing_interval, 
    price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd, is_active
) VALUES (
    'plan_kindreply_jobpack', 
    'prod_kindreply', 
    'kindreply-jobpack', 
    'Job Pack', 
    'price_1TgdKrE9dKQekvzkVFWf4NEp',
    'one_time',
    499,
    10,
    60,
    2000,
    1
);

-- 验证更新结果
SELECT id, name, slug, price_cents, billing_interval, credits_allocated, stripe_price_id, is_active 
FROM plans 
WHERE id IN ('plan_kindreply_pro', 'plan_kindreply_jobpack');