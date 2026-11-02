-- Additive (new tables, triggers, backfill). Dedicated MILEAGE_D1 only, after 001; never mail D1. Re-runnable.
-- Apply before the Worker that reads mileage_routes deploys (docs/mileage/RELEASE.md).
-- Points are plain JSON per chunk: D1's at-rest encryption, owner-only auth, no app key (2026-10-25).
-- Never applied anywhere persistent before that change; an old iv/ciphertext table fails closed (503).
CREATE TABLE IF NOT EXISTS mileage_routes(owner TEXT NOT NULL,trip_id TEXT NOT NULL,device_id TEXT NOT NULL,chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 1000),created_at INTEGER NOT NULL,PRIMARY KEY(owner,trip_id));
-- statement
CREATE TABLE IF NOT EXISTS mileage_route_expected(owner TEXT NOT NULL,trip_id TEXT NOT NULL,PRIMARY KEY(owner,trip_id));
-- statement
CREATE TABLE IF NOT EXISTS mileage_route_chunks(owner TEXT NOT NULL,trip_id TEXT NOT NULL,chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 999),point_count INTEGER NOT NULL,request_hash TEXT NOT NULL,points TEXT NOT NULL,PRIMARY KEY(owner,trip_id,chunk_index));
-- statement
CREATE TABLE IF NOT EXISTS mileage_route_tombstones(owner TEXT NOT NULL,trip_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(owner,trip_id));
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_route_soft_delete AFTER UPDATE ON mileage_trips WHEN json_extract(new.data,'$.deleted_at') IS NOT NULL BEGIN
 INSERT OR IGNORE INTO mileage_route_tombstones(owner,trip_id,deleted_at) VALUES(new.owner,new.id,json_extract(new.data,'$.deleted_at'));
 DELETE FROM mileage_route_chunks WHERE owner=new.owner AND trip_id=new.id;
 DELETE FROM mileage_routes WHERE owner=new.owner AND trip_id=new.id;
 DELETE FROM mileage_route_expected WHERE owner=new.owner AND trip_id=new.id;
END;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_route_hard_delete AFTER DELETE ON mileage_trips BEGIN
 INSERT OR IGNORE INTO mileage_route_tombstones(owner,trip_id,deleted_at) VALUES(old.owner,old.id,CAST(strftime('%s','now') AS INTEGER)*1000);
 DELETE FROM mileage_route_chunks WHERE owner=old.owner AND trip_id=old.id;
 DELETE FROM mileage_routes WHERE owner=old.owner AND trip_id=old.id;
 DELETE FROM mileage_route_expected WHERE owner=old.owner AND trip_id=old.id;
END;
-- statement
INSERT OR IGNORE INTO mileage_route_tombstones(owner,trip_id,deleted_at) SELECT owner,id,json_extract(data,'$.deleted_at') FROM mileage_trips WHERE json_extract(data,'$.deleted_at') IS NOT NULL;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_route_no_resurrection BEFORE INSERT ON mileage_trips WHEN EXISTS(SELECT 1 FROM mileage_route_tombstones WHERE owner=new.owner AND trip_id=new.id) BEGIN
 SELECT RAISE(ABORT,'Mileage trip is tombstoned');
END;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_route_expect_capture AFTER INSERT ON mileage_trips WHEN json_extract(new.data,'$.source')='gps' AND new.device_id!='owner' AND json_extract(new.data,'$.deleted_at') IS NULL BEGIN
 INSERT OR IGNORE INTO mileage_route_expected(owner,trip_id) VALUES(new.owner,new.id);
END;
-- statement
INSERT OR IGNORE INTO mileage_route_expected(owner,trip_id) SELECT owner,id FROM mileage_trips WHERE json_extract(data,'$.source')='gps' AND device_id!='owner' AND json_extract(data,'$.deleted_at') IS NULL;
