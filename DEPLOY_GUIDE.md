# BestMCP Billing 部署指南

## 前置条件

1. Cloudflare API Token（需要 Workers Scripts:Edit、D1:Edit、KV:Edit 权限）
2. Stripe 账户（测试模式或生产模式）
3. Google OAuth 客户端（已创建）

## 步骤 1：配置 Cloudflare API Token

```bash
# 编辑配置文件，把 *** 替换为你的真实 token
nano ~/.config/.wrangler/config.toml
```

内容应该是：
```toml
CLOUDFLARE_API_TOKEN="<set in your shell only>"
```

验证：
```bash
npx wrangler whoami
```

## 步骤 2：设置环境变量

```bash
export GOOGLE_CLIENT_ID="<set via Cloudflare secret>"
export GOOGLE_CLIENT_SECRET="<set via Cloudflare secret>"
export JWT_SECRET="$(openssl rand -hex 32)"
export STRIPE_SECRET_KEY="<set via Cloudflare secret>"
export STRIPE_WEBHOOK_SECRET="<set via Cloudflare secret>"
```

## 步骤 3：在 Stripe 创建产品

去 https://dashboard.stripe.com/test/products 创建：

1. **BestMCP Pro** — 订阅制，$9/月
2. **KindReply Pro** — 订阅制，$5/月

记录它们的 Price ID（格式 `price_xxx`）。

## 步骤 4：执行 D1 Migrations

```bash
cd /root/bestmcp-billing/bestmcp-billing
npx wrangler d1 migrations apply bestmcp-billing-db --remote
```

## 步骤 5：写入 Secrets

```bash
export GOOGLE_CLIENT_ID="<set via Cloudflare secret>"
# 输入你的 client id

export GOOGLE_CLIENT_SECRET="<set via Cloudflare secret>"
# 输入你的 client secret

export JWT_SECRET="$(openssl rand -hex 32)"
# 输入随机字符串

export STRIPE_SECRET_KEY="<set via Cloudflare secret>"
# 输入 Stripe Secret Key（不要写入本文档）

export STRIPE_WEBHOOK_SECRET="<set via Cloudflare secret>"
# 输入 whsec_xxx
```

## 步骤 6：部署

```bash
npm run build
npx wrangler deploy
```

## 步骤 7：配置外部服务

### Google OAuth Console
添加回调 URI：
```
https://auth.bestmcpservers.com/api/auth/google/callback
```

### Stripe Webhook
添加 Endpoint：
```
https://auth.bestmcpservers.com/api/webhooks/stripe
```

选择事件：
- checkout.session.completed
- invoice.paid
- invoice.payment_failed
- customer.subscription.updated
- customer.subscription.deleted

## 步骤 8：验证

1. 打开 https://auth.bestmcpservers.com/dashboard
2. 点击 Login with Google
3. 选择套餐 → Stripe Checkout → 支付
4. 回到 dashboard 查看 credits/subscription
