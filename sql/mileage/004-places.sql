-- Additive (new table and index). Dedicated MILEAGE_D1 only, after 001; never mail D1. Re-runnable.
-- Apply before deploying known-place endpoints. Older Workers ignore this table; trip summaries are unchanged.
CREATE TABLE IF NOT EXISTS mileage_places (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80 AND name=trim(name)),
 lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
 lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
 radius_m INTEGER NOT NULL DEFAULT 150 CHECK(typeof(radius_m)='integer' AND radius_m BETWEEN 50 AND 1000),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 deleted_at INTEGER
);
-- statement
CREATE INDEX IF NOT EXISTS mileage_places_owner ON mileage_places(owner,deleted_at);
