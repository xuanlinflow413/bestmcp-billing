-- Add EditImages to shared credit accounting and reserve one credit per AI edit.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS credit_transactions_new;
CREATE TABLE credit_transactions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus', 'rollover', 'expire', 'subscription_grant')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    reference_id TEXT,
    product TEXT CHECK (product IN ('bestmcp', 'kindreply', 'cleartext', 'editimages')),
    metadata TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO credit_transactions_new SELECT * FROM credit_transactions;
DROP TABLE credit_transactions;
ALTER TABLE credit_transactions_new RENAME TO credit_transactions;
CREATE INDEX idx_credit_tx_user ON credit_transactions(user_id);
CREATE INDEX idx_credit_tx_type ON credit_transactions(type);
CREATE INDEX idx_credit_tx_created ON credit_transactions(created_at);
CREATE INDEX idx_credit_tx_reference ON credit_transactions(reference_id);

CREATE TABLE IF NOT EXISTS image_credit_reservations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    reference_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'refunded')),
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, idempotency_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_image_credit_reservation_user ON image_credit_reservations(user_id);

PRAGMA foreign_keys = ON;
