-- Additive (new tables only). Dedicated MILEAGE_D1 only, after 001-schema.sql; never mail D1. Re-runnable.
-- No OAuth credentials, access tokens, true Calendar IDs or event payloads here.
CREATE TABLE IF NOT EXISTS mileage_google_sync (
 owner TEXT NOT NULL,
 calendar_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 sync_token TEXT,
 last_success_at INTEGER,
 last_attempt_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('fresh','error')),
 error_code TEXT,
 generation INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner,calendar_id)
);
-- statement
-- Owner-wide serialization also fences commits across distinct sources at the 500-row cap.
CREATE TABLE IF NOT EXISTS mileage_google_lease (
 owner TEXT PRIMARY KEY,
 fence INTEGER NOT NULL,
 lease_token TEXT,
 expires_at INTEGER NOT NULL
);
