-- Additive (two triggers). Dedicated MILEAGE_D1 only, after 001; never mail D1. Re-runnable.
-- LATE-START §3: a trip's `start_estimate` (the phone's Apple Maps start leg: {meters, method, from_trip_id,
-- reason}) is a nullable field of the trip JSON in mileage_trips.data, so every revision snapshot
-- (mileage_revisions.data, copied by the 001 trigger) keeps it; no column holds a second copy. These triggers
-- make the database refuse a malformed estimate from any write path (upload, edit, split, merge, undo).
-- Absent or null = no estimate. Old Workers never write one, so apply before or after the Worker deploy.
-- Rollback: sql/mileage/rollback-006-start-estimate.sql.
CREATE TRIGGER IF NOT EXISTS mileage_start_estimate_insert BEFORE INSERT ON mileage_trips
WHEN json_type(new.data,'$.start_estimate') IS NOT NULL AND json_type(new.data,'$.start_estimate')<>'null' AND NOT (
 json_type(new.data,'$.start_estimate')='object'
 AND (SELECT count(*) FROM json_each(new.data,'$.start_estimate'))=4
 AND json_type(new.data,'$.start_estimate.meters')='integer'
 AND json_extract(new.data,'$.start_estimate.meters') BETWEEN 0 AND 5000
 AND json_extract(new.data,'$.start_estimate.method')='apple_maps_driving'
 AND json_extract(new.data,'$.start_estimate.reason')='parked_continuity'
 AND json_type(new.data,'$.start_estimate.from_trip_id')='text'
 AND json_extract(new.data,'$.start_estimate.from_trip_id')<>new.id)
BEGIN
 SELECT RAISE(ABORT,'INVALID_START_ESTIMATE');
END;
-- statement
CREATE TRIGGER IF NOT EXISTS mileage_start_estimate_update BEFORE UPDATE OF data ON mileage_trips
WHEN json_type(new.data,'$.start_estimate') IS NOT NULL AND json_type(new.data,'$.start_estimate')<>'null' AND NOT (
 json_type(new.data,'$.start_estimate')='object'
 AND (SELECT count(*) FROM json_each(new.data,'$.start_estimate'))=4
 AND json_type(new.data,'$.start_estimate.meters')='integer'
 AND json_extract(new.data,'$.start_estimate.meters') BETWEEN 0 AND 5000
 AND json_extract(new.data,'$.start_estimate.method')='apple_maps_driving'
 AND json_extract(new.data,'$.start_estimate.reason')='parked_continuity'
 AND json_type(new.data,'$.start_estimate.from_trip_id')='text'
 AND json_extract(new.data,'$.start_estimate.from_trip_id')<>new.id)
BEGIN
 SELECT RAISE(ABORT,'INVALID_START_ESTIMATE');
END;
