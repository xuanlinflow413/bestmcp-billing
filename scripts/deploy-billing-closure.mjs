#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL || 'https://bestmcp-billing.xuanlinflow.workers.dev';
const DB_NAME = process.env.D1_DATABASE_NAME || 'bestmcp-billing-db';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : 'pipe',
    input: options.input,
    text: true,
    env: process.env,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
  return stdout + stderr;
}

function wrangler(args, options = {}) {
  return run('npx', ['wrangler', ...args], options);
}

async function stripeGet(path) {
  const secret = requireEnv('STRIPE_SECRET_KEY');
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Stripe API failed ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function productName(productMap, productRef) {
  const product = typeof productRef === 'object' ? productRef : productMap.get(productRef);
  return `${product?.name || ''} ${product?.metadata?.app || ''} ${product?.metadata?.slug || ''}`.toLowerCase();
}

function choosePrice(prices, productMap, { appNeedle, amount, liveMode }) {
  const matchesContract = (price) => {
    if (!price.active || !price.recurring) return false;
    if (price.livemode !== liveMode) return false;
    if (price.currency !== 'usd') return false;
    if (typeof price.unit_amount !== 'number' || price.unit_amount !== amount) return false;
    if (price.recurring.interval !== 'month') return false;
    return productName(productMap, price.product).includes(appNeedle);
  };

  const explicit = process.env[`${appNeedle.toUpperCase()}_PRO_PRICE_ID`];
  if (explicit) {
    const selected = prices.find((price) => price.id === explicit.trim());
    if (!selected || !matchesContract(selected)) {
      throw new Error(`Explicit ${appNeedle.toUpperCase()}_PRO_PRICE_ID does not match the expected mode, product, USD amount, and monthly interval`);
    }
    return selected.id;
  }

  const candidates = prices.filter(matchesContract);

  if (candidates.length !== 1) {
    const safeCandidates = prices
      .filter((p) => p.active && p.recurring)
      .map((p) => ({
        id: '[REDACTED_PRICE_ID]',
        product: productMap.get(p.product)?.name || p.product,
        currency: p.currency,
        unit_amount: p.unit_amount,
        interval: p.recurring?.interval,
        lookup_key: p.lookup_key,
      }));
    throw new Error(
      `Could not uniquely select ${appNeedle} Pro price. Set ${appNeedle.toUpperCase()}_PRO_PRICE_ID explicitly. Candidates: ${JSON.stringify(safeCandidates, null, 2)}`
    );
  }
  return candidates[0].id;
}

async function main() {
  // Required local-only deploy/auth variables.
  requireEnv('CLOUDFLARE_API_TOKEN');
  const secrets = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'JWT_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ];
  for (const name of secrets) requireEnv(name);

  console.log('1/7 Local build gate...');
  console.log(run('npm', ['run', 'build']));
  console.log(run('npm', ['test', '--', '--run']));

  console.log('2/7 Discover Stripe prices...');
  const [productsResponse, pricesResponse] = await Promise.all([
    stripeGet('/products?active=true&limit=100'),
    stripeGet('/prices?active=true&type=recurring&limit=100&expand[]=data.product'),
  ]);
  const productMap = new Map(productsResponse.data.map((product) => [product.id, product]));
  for (const price of pricesResponse.data) {
    if (typeof price.product === 'object') productMap.set(price.product.id, price.product);
  }

  const liveMode = requireEnv('STRIPE_SECRET_KEY').startsWith('sk_live_');
  const bestmcpPriceId = choosePrice(pricesResponse.data, productMap, { appNeedle: 'bestmcp', amount: 1900, liveMode });
  const kindreplyPriceId = choosePrice(pricesResponse.data, productMap, { appNeedle: 'kindreply', amount: 999, liveMode });
  const cleartextPriceId = choosePrice(pricesResponse.data, productMap, { appNeedle: 'cleartext', amount: 999, liveMode });
  console.log('Stripe prices selected: bestmcp=[REDACTED], kindreply=[REDACTED], cleartext=[REDACTED]');

  console.log('3/7 Write Cloudflare Worker secrets...');
  for (const name of secrets) {
    wrangler(['secret', 'put', name], { input: `${process.env[name]}\n` });
    console.log(`secret ${name}: written`);
  }

  console.log('4/7 Apply remote D1 migrations...');
  wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);

  console.log('5/7 Update remote D1 plan -> Stripe price mapping...');
  const dir = mkdtempSync(join(tmpdir(), 'billing-price-map-'));
  const sqlPath = join(dir, 'price-map.sql');
  try {
    const escapeSql = (value) => value.replaceAll("'", "''");
    writeFileSync(sqlPath, `
UPDATE plans SET stripe_price_id = '${escapeSql(bestmcpPriceId)}' WHERE id = 'plan_bestmcp_pro';
UPDATE plans SET stripe_price_id = '${escapeSql(kindreplyPriceId)}' WHERE id = 'plan_kindreply_pro';
UPDATE plans SET stripe_price_id = '${escapeSql(cleartextPriceId)}' WHERE id = 'plan_cleartext_pro';
SELECT id, slug, CASE WHEN stripe_price_id IS NULL THEN 'missing' ELSE 'configured' END AS price_status FROM plans WHERE id IN ('plan_bestmcp_pro', 'plan_kindreply_pro', 'plan_cleartext_pro') ORDER BY id;
`);
    const output = wrangler(['d1', 'execute', DB_NAME, '--remote', '--file', sqlPath]);
    const configuredCount = (output.match(/"price_status": "configured"/g) || []).length;
    if (configuredCount !== 3) {
      throw new Error(`Expected three configured Pro plan mappings, got ${configuredCount}`);
    }
    console.log(output.replace(/price_[A-Za-z0-9_]+/g, '[REDACTED_PRICE_ID]'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('6/7 Deploy Worker...');
  console.log(wrangler(['deploy']).replace(/https:\/\/[^\s]+/g, APP_URL));

  console.log('7/7 Production smoke test...');
  for (const path of ['/health', '/dashboard', '/billing/cancel', '/auth/error?error=smoke']) {
    const response = await fetch(`${APP_URL}${path}`, { redirect: 'manual' });
    if (![200, 302].includes(response.status)) {
      throw new Error(`Smoke failed for ${path}: HTTP ${response.status}`);
    }
    console.log(`${path}: HTTP ${response.status}`);
  }

  const google = await fetch(`${APP_URL}/api/auth/google`, { redirect: 'manual' });
  const location = google.headers.get('location') || '';
  if (google.status !== 302 || !location.includes('accounts.google.com') || location.includes('undefined')) {
    throw new Error(`/api/auth/google smoke failed: status=${google.status}, location=${location.replace(/client_id=[^&]+/, 'client_id=[REDACTED]')}`);
  }
  console.log('/api/auth/google: HTTP 302 to Google OAuth');

  console.log('DONE: deploy pipeline completed. Manual browser test remains: Google login, each Pro checkout, Stripe test payment, webhook confirmation.');
}

main().catch((error) => {
  const message = String(error?.stack || error?.message || error)
    .replace(/sk_(test|live)_[A-Za-z0-9_]+/g, 'sk_$1_[REDACTED]')
    .replace(/whsec_[A-Za-z0-9_]+/g, 'whsec_[REDACTED]')
    .replace(/price_[A-Za-z0-9_]+/g, '[REDACTED_PRICE_ID]')
    .replace(/Bearer\s+[A-Za-z0-9_\-]+/g, 'Bearer [REDACTED]');
  console.error(message);
  process.exit(1);
});
