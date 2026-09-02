-- Enforce atomic idempotency for legacy shared-credit grants.
-- A usage and its refund may intentionally share the same reference ID,
-- so transaction type remains part of the uniqueness key.

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_user_type_reference_unique
    ON credit_transactions(user_id, type, reference_id)
    WHERE reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_unique_nonempty
    ON users(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';

-- The live database predates the UNIQUE constraint that later schema files
-- declare, so make the webhook UPSERT conflict target real without rebuilding
-- the shared subscriptions table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_id_unique
    ON subscriptions(stripe_subscription_id);
