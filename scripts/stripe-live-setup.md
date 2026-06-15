# Stripe Live 切换执行清单

## 前置条件（需要用户提供）
1. **Stripe Live Secret Key** (sk_live_...)
2. **Stripe Live Webhook Secret** (whsec_...) - 或创建新的
3. **确认 credits 数量**：
   - Job Pack ($4.99 one-time): ? credits
   - Pro ($9.99/month): ? credits

## 执行步骤

### 1. 更新 Worker Secrets
```bash
# 设置 Stripe Live Key
npx wrangler secret put STRIPE_SECRET_KEY
# 输入: sk_live_...

# 设置 Webhook Secret
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# 输入: whsec_...

# 删除 PayPal Secrets（可选）
npx wrangler secret delete PAYPAL_CLIENT_ID
npx wrangler secret delete PAYPAL_CLIENT_SECRET
npx wrangler secret delete PAYPAL_LIVE
```

### 2. 创建 Stripe Products & Prices
使用 Stripe CLI 或 API：

```bash
# Job Pack (One-time)
stripe products create \
  --name="KindReply Job Pack" \
  --description="One-time job application credits pack"

stripe prices create \
  --product=prod_xxx \
  --unit-amount=499 \
  --currency=usd \
  --one-time

# Pro (Monthly)
stripe products create \
  --name="KindReply Pro" \
  --description="Monthly subscription with unlimited features"

stripe prices create \
  --product=prod_yyy \
  --unit-amount=999 \
  --currency=usd \
  --recurring="interval=month"
```

### 3. 更新数据库 Plans 表
```sql
-- 添加 Job Pack
INSERT INTO plans (id, product_id, slug, name, stripe_price_id, billing_interval, price_cents, credits_allocated, rate_limit_rpm, rate_limit_rpd, is_active)
VALUES ('plan_kindreply_jobpack', 'prod_kindreply', 'kindreply-jobpack', 'Job Pack', 'price_xxx', 'one_time', 499, ?, 60, 2000, 1);

-- 更新 Pro Plan
UPDATE plans SET stripe_price_id = 'price_yyy', price_cents = 999, credits_allocated = ? WHERE id = 'plan_kindreply_pro';
```

### 4. 配置 Stripe Webhook
Endpoint: `https://bestmcp-billing.xuanlinflow.workers.dev/api/webhooks/stripe`
Events:
- `checkout.session.completed`
- `invoice.payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

### 5. 测试支付
- Job Pack: 真实 $4.99 支付测试
- Pro: 真实 $9.99 订阅测试

### 6. 验证
- Dashboard 显示订单
- Credits 自动增加
- Webhook 正常触发
