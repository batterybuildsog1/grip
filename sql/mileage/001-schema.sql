-- Additive (new tables, indexes, triggers). Mileage-only schema for the dedicated MILEAGE_D1 database, never mail D1. Re-runnable. Release: docs/mileage/RELEASE.md.
CREATE TABLE IF NOT EXISTS mileage_categories(owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,treatment TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(owner,id));
-- statement
CREATE TABLE IF NOT EXISTS mileage_tokens(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,entity_ids TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
-- statement
CREATE TABLE IF NOT EXISTS mileage_trips(owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),measurement_hash TEXT NOT NULL,device_id TEXT NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(owner,id));
-- statement
CREATE TABLE IF NOT EXISTS mileage_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,trip_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,UNIQUE(owner,trip_id,revision));
-- statement
CREATE INDEX IF NOT EXISTS mileage_changes ON mileage_revisions(owner,seq);
-- statement
CREATE TABLE IF NOT EXISTS mileage_commands(owner TEXT NOT NULL,actor TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,actor,key));
-- statement
CREATE TABLE IF NOT EXISTS mileage_guard(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
-- statement
CREATE TABLE IF NOT EXISTS mileage_questions(owner TEXT NOT NULL,id TEXT NOT NULL,trip_id TEXT NOT NULL,trip_revision INTEGER NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(owner,id),UNIQUE(owner,trip_id,trip_revision));
-- statement
CREATE TABLE IF NOT EXISTS mileage_calendar(owner TEXT NOT NULL,calendar_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,calendar_id,id));
-- statement
CREATE TABLE IF NOT EXISTS mileage_exports(owner TEXT NOT NULL,id TEXT NOT NULL,manifest TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,id));
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_trip_insert AFTER INSERT ON mileage_trips BEGIN
 INSERT INTO mileage_revisions(owner,trip_id,revision,data,actor,operation) VALUES(new.owner,new.id,new.revision,new.data,new.actor,new.operation);
 INSERT OR IGNORE INTO mileage_questions(owner,id,trip_id,trip_revision,prompt) SELECT new.owner,new.id||':'||new.revision,new.id,new.revision,'Choose category and specific purpose for this trip' WHERE json_extract(new.data,'$.treatment')='needs_review' AND json_extract(new.data,'$.deleted_at') IS NULL;
END;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_trip_update AFTER UPDATE ON mileage_trips BEGIN
 INSERT INTO mileage_revisions(owner,trip_id,revision,data,actor,operation) VALUES(new.owner,new.id,new.revision,new.data,new.actor,new.operation);
 UPDATE mileage_questions SET status='superseded' WHERE owner=new.owner AND trip_id=new.id AND status='pending';
 INSERT OR IGNORE INTO mileage_questions(owner,id,trip_id,trip_revision,prompt) SELECT new.owner,new.id||':'||new.revision,new.id,new.revision,'Choose category and specific purpose for this trip' WHERE json_extract(new.data,'$.treatment')='needs_review' AND json_extract(new.data,'$.deleted_at') IS NULL;
END;
-- statement
CREATE TABLE IF NOT EXISTS mileage_admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);

-- statement
CREATE INDEX IF NOT EXISTS mileage_trip_period ON mileage_trips(owner,json_extract(data,'$.deleted_at'),json_extract(data,'$.started_at'),id);
-- statement
CREATE INDEX IF NOT EXISTS mileage_trip_category ON mileage_trips(owner,json_extract(data,'$.category_id'),json_extract(data,'$.deleted_at'),json_extract(data,'$.started_at'),id);
-- statement
CREATE TABLE IF NOT EXISTS mileage_vehicle(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
