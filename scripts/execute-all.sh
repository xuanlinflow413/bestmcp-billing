#!/bin/bash
# KindReply Stripe Live 部署脚本
# 需要有效的 CLOUDFLARE_API_TOKEN 环境变量

set -e

echo "=== KindReply Stripe Live 部署 ==="
echo ""

# 检查 token
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "错误: CLOUDFLARE_API_TOKEN 未设置"
    echo "请设置: export CLOUDFLARE_API_TOKEN=your_token"
    exit 1
fi

echo "1. 更新 D1 plans 表..."
npx wrangler d1 execute bestmcp-billing-db --remote --file=./scripts/update-plans.sql

echo ""
echo "2. 检查 secrets..."
npx wrangler secret list | grep -E "STRIPE|WEBHOOK|PAYPAL" || true

echo ""
echo "3. 执行 typecheck..."
npx tsc --noEmit

echo ""
echo "4. 部署到 production..."
npx wrangler deploy

echo ""
echo "=== 部署完成 ==="
echo ""
echo "测试链接:"
echo "  Plans: https://bestmcp-billing.xuanlinflow.workers.dev/api/billing/plans"
echo "  Checkout: POST /api/billing/checkout"
echo "  Webhook: POST /api/webhooks/stripe"
