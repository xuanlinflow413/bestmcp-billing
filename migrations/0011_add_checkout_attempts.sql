-- Prevent concurrent checkout requests from creating multiple payable sessions.
-- One row per user and product keeps storage bounded while preserving retries.

CREATE TABLE IF NOT EXISTS checkout_attempts (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    client_request_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'completed', 'failed', 'expired')),
    stripe_checkout_session_id TEXT UNIQUE,
    session_expires_at INTEGER,
    lock_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_attempts_status
    ON checkout_attempts(status, lock_expires_at, session_expires_at);
