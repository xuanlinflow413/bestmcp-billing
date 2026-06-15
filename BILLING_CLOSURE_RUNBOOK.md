# BestMCP + KindReply 登录付费闭环 Runbook

## 目标
让两个产品在同一个 Cloudflare Worker 收费系统中完成：Google 登录 → Dashboard → 选择套餐 → Stripe Checkout → success/cancel 回跳 → Webhook 入库 → subscription/credits 生效。

## 本地质量闸门
```bash
cd /root/bestmcp-billing/bestmcp-billing
npm run build
npm test -- --run
```

## 必需环境变量（不要提交到 Git）
```bash
export CLOUDFLARE_API_TOKEN='[REDACTED]'
export GOOGLE_CLIENT_ID='[REDACTED]'
export GOOGLE_CLIENT_SECRET='[REDACTED]'
export JWT_SECRET='[REDACTED]'
export STRIPE_SECRET_KEY='[REDACTED]'
export STRIPE_WEBHOOK_SECRET='[REDACTED]'
```

如果 Stripe 产品名无法唯一匹配，可显式设置：
```bash
export BESTMCP_PRO_PRICE_ID='[REDACTED_PRICE_ID]'
export KINDREPLY_PRO_PRICE_ID='[REDACTED_PRICE_ID]'
```

## 一键执行
```bash
npm run deploy:closure
```

脚本顺序：
1. npm run build
2. npm test -- --run
3. 查询 Stripe products/prices
4. 写入 Cloudflare Worker secrets
5. 执行远程 D1 migrations
6. 写入远程 D1 plan -> stripe_price_id 映射
7. wrangler deploy
8. 生产 smoke test：/health、/dashboard、/billing/cancel、/auth/error、/api/auth/google

## Google OAuth Console 必须配置
Authorized redirect URI:
```text
https://bestmcp-billing.xuanlinflow.workers.dev/api/auth/google/callback
```

## Stripe Webhook 必须配置
Endpoint URL:
```text
https://bestmcp-billing.xuanlinflow.workers.dev/api/webhooks/stripe
```

Recommended events:
- checkout.session.completed
- invoice.paid
- invoice.payment_failed
- customer.subscription.updated
- customer.subscription.deleted

## 最终人工验收
1. 打开 /dashboard
2. 点击 Login with Google
3. 登录成功回到 dashboard
4. BestMCP Pro 点击 Buy，进入 Stripe Checkout
5. 使用 Stripe 测试卡完成支付
6. 回到 /billing/success
7. 回 dashboard 查看 subscription/credits
8. KindReply Pro 重复步骤 4-7
