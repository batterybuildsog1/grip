-- Additive (new tables, index, triggers, two seed rows). Dedicated MILEAGE_D1 only, after 001; never mail D1. Re-runnable.
-- Apply before deploying the logic-pass Worker (endpoint addresses, agent proposals, rates). Older Workers ignore
-- these tables; without them the new Worker keeps trip APIs unchanged and its new endpoints return 503.
-- Re-running re-inserts a deleted seed rate (INSERT OR IGNORE); delete it again through the API if needed.
CREATE TABLE IF NOT EXISTS mileage_trip_addresses (
 owner TEXT NOT NULL,
 trip_id TEXT NOT NULL,
 endpoint TEXT NOT NULL CHECK(endpoint IN ('start','end')),
 name TEXT CHECK(name IS NULL OR (length(name) BETWEEN 1 AND 120 AND name=trim(name))),
 address TEXT NOT NULL CHECK(length(address) BETWEEN 1 AND 300 AND address=trim(address)),
 source TEXT NOT NULL DEFAULT 'apple' CHECK(source='apple'),
 resolved_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,trip_id,endpoint)
);
-- statement
CREATE TABLE IF NOT EXISTS mileage_proposals (
 owner TEXT NOT NULL,
 id TEXT NOT NULL,
 trip_id TEXT NOT NULL,
 trip_revision INTEGER NOT NULL,
 actor TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 status TEXT NOT NULL CHECK(status IN ('pending','applied','superseded','resolved')),
 created_at INTEGER NOT NULL,
 resolved_at INTEGER,
 PRIMARY KEY(owner,id)
);
-- statement
CREATE INDEX IF NOT EXISTS mileage_proposals_trip ON mileage_proposals(owner,trip_id,status);
-- statement
-- Public IRS facts, global to every mileage owner. A year may have several rows (2026 changed mid-year).
CREATE TABLE IF NOT EXISTS mileage_rates (
 tax_year INTEGER NOT NULL CHECK(typeof(tax_year)='integer' AND tax_year BETWEEN 1990 AND 2100),
 effective_from TEXT NOT NULL PRIMARY KEY CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(effective_from)=effective_from AND CAST(substr(effective_from,1,4) AS INTEGER)=tax_year),
 usd_per_mile REAL NOT NULL CHECK(typeof(usd_per_mile) IN ('real','integer') AND usd_per_mile>0 AND usd_per_mile<10),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 300 AND source=trim(source)),
 updated_at INTEGER NOT NULL,
 updated_by TEXT NOT NULL
);
-- statement
-- Verified on irs.gov/tax-professionals/standard-mileage-rates (2026-10-26): 72.5 cents Jan 1-Jun 30, 76 cents Jul 1-Dec 31.
INSERT OR IGNORE INTO mileage_rates(tax_year,effective_from,usd_per_mile,source,updated_at,updated_by) VALUES(2026,'2026-01-01',0.725,'IRS IR-2025-128 (Notice 2026-10)',CAST(strftime('%s','now') AS INTEGER)*1000,'migration:005');
-- statement
INSERT OR IGNORE INTO mileage_rates(tax_year,effective_from,usd_per_mile,source,updated_at,updated_by) VALUES(2026,'2026-07-01',0.76,'IRS IR-2026-29 (Announcement 2026-11)',CAST(strftime('%s','now') AS INTEGER)*1000,'migration:005');
-- statement
-- Any new trip revision ends its pending proposals in the same transaction: a human decision resolves them;
-- automatic changes (calendar match, agent edit, an applied proposal) supersede them. Deleting a trip drops
-- its endpoint addresses.
CREATE TRIGGER IF NOT EXISTS mileage_logic_trip_update AFTER UPDATE ON mileage_trips BEGIN
 UPDATE mileage_proposals SET status=CASE WHEN new.actor LIKE 'human:%' AND new.operation<>'calendar_match' THEN 'resolved' ELSE 'superseded' END,resolved_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE owner=new.owner AND trip_id=new.id AND status='pending';
 DELETE FROM mileage_trip_addresses WHERE owner=new.owner AND trip_id=new.id AND json_extract(new.data,'$.deleted_at') IS NOT NULL;
END;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_logic_trip_delete AFTER DELETE ON mileage_trips BEGIN
 UPDATE mileage_proposals SET status='superseded',resolved_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE owner=old.owner AND trip_id=old.id AND status='pending';
 DELETE FROM mileage_trip_addresses WHERE owner=old.owner AND trip_id=old.id;
END;
