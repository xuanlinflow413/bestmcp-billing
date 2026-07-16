-- Product-scoped credits v2. Legacy credit tables remain untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_credit_balances (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_purchased INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_purchased >= 0),
    lifetime_used INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_used >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS product_credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus', 'rollover', 'expire', 'subscription_grant')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    description TEXT,
    reference_id TEXT,
    idempotency_key TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    UNIQUE (user_id, product_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_product_credit_ledger_user_product_created
    ON product_credit_ledger(user_id, product_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_credit_ledger_reference
    ON product_credit_ledger(user_id, product_id, reference_id)
    WHERE reference_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_credit_reservations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'refunded')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    UNIQUE (user_id, product_id, idempotency_key),
    UNIQUE (user_id, product_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_product_credit_reservation_user_product_status
    ON product_credit_reservations(user_id, product_id, status);