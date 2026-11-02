-- v34: Attachment search ("Better" tier) — index extracted attachment text.
--
-- Adds emails.attachment_search_text (extracted PDF/doc text, hydrated by the
-- local backfill/extractor pipeline) plus extraction bookkeeping columns on
-- attachments, then rebuilds emails_fts with the new column so plain searches
-- match attachment contents. Modeled exactly on migrate-v31-search-fields.sql.
--
-- V30 LESSON: every trigger below enumerates ALL FTS columns, and the
-- UPDATE OF column lists include every indexed column — otherwise updates to
-- the missing column silently stop syncing FTS.

ALTER TABLE emails ADD COLUMN attachment_search_text TEXT;
ALTER TABLE attachments ADD COLUMN extract_status TEXT;
ALTER TABLE attachments ADD COLUMN text_extracted_at INTEGER;

DROP TRIGGER IF EXISTS emails_fts_insert;
DROP TRIGGER IF EXISTS emails_fts_delete;
DROP TRIGGER IF EXISTS emails_fts_update_delete;
DROP TRIGGER IF EXISTS emails_fts_update_insert;

DROP TABLE IF EXISTS emails_fts;

CREATE VIRTUAL TABLE emails_fts USING fts5(
    subject,
    text_content,
    from_address,
    from_name,
    to_address,
    to_addresses_json,
    cc_addresses_json,
    bcc_addresses_json,
    reply_to_addresses_json,
    attachment_names,
    attachment_search_text,
    content='emails',
    content_rowid='rowid'
);

INSERT INTO emails_fts(
    rowid,
    subject,
    text_content,
    from_address,
    from_name,
    to_address,
    to_addresses_json,
    cc_addresses_json,
    bcc_addresses_json,
    reply_to_addresses_json,
    attachment_names,
    attachment_search_text
)
    SELECT rowid,
           COALESCE(subject, ''),
           COALESCE(text_content, ''),
           COALESCE(from_address, ''),
           COALESCE(from_name, ''),
           COALESCE(to_address, ''),
           COALESCE(to_addresses_json, ''),
           COALESCE(cc_addresses_json, ''),
           COALESCE(bcc_addresses_json, ''),
           COALESCE(reply_to_addresses_json, ''),
           COALESCE(attachment_names, ''),
           COALESCE(attachment_search_text, '')
      FROM emails;

CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(
        rowid,
        subject,
        text_content,
        from_address,
        from_name,
        to_address,
        to_addresses_json,
        cc_addresses_json,
        bcc_addresses_json,
        reply_to_addresses_json,
        attachment_names,
        attachment_search_text
    )
        VALUES (
            NEW.rowid,
            COALESCE(NEW.subject, ''),
            COALESCE(NEW.text_content, ''),
            COALESCE(NEW.from_address, ''),
            COALESCE(NEW.from_name, ''),
            COALESCE(NEW.to_address, ''),
            COALESCE(NEW.to_addresses_json, ''),
            COALESCE(NEW.cc_addresses_json, ''),
            COALESCE(NEW.bcc_addresses_json, ''),
            COALESCE(NEW.reply_to_addresses_json, ''),
            COALESCE(NEW.attachment_names, ''),
            COALESCE(NEW.attachment_search_text, '')
        );
END;

CREATE TRIGGER emails_fts_delete BEFORE DELETE ON emails BEGIN
    INSERT INTO emails_fts(
        emails_fts,
        rowid,
        subject,
        text_content,
        from_address,
        from_name,
        to_address,
        to_addresses_json,
        cc_addresses_json,
        bcc_addresses_json,
        reply_to_addresses_json,
        attachment_names,
        attachment_search_text
    )
        VALUES (
            'delete',
            OLD.rowid,
            COALESCE(OLD.subject, ''),
            COALESCE(OLD.text_content, ''),
            COALESCE(OLD.from_address, ''),
            COALESCE(OLD.from_name, ''),
            COALESCE(OLD.to_address, ''),
            COALESCE(OLD.to_addresses_json, ''),
            COALESCE(OLD.cc_addresses_json, ''),
            COALESCE(OLD.bcc_addresses_json, ''),
            COALESCE(OLD.reply_to_addresses_json, ''),
            COALESCE(OLD.attachment_names, ''),
            COALESCE(OLD.attachment_search_text, '')
        );
END;

CREATE TRIGGER emails_fts_update_delete
BEFORE UPDATE OF subject, text_content, from_address, from_name, to_address, to_addresses_json, cc_addresses_json, bcc_addresses_json, reply_to_addresses_json, attachment_names, attachment_search_text ON emails
BEGIN
    INSERT INTO emails_fts(
        emails_fts,
        rowid,
        subject,
        text_content,
        from_address,
        from_name,
        to_address,
        to_addresses_json,
        cc_addresses_json,
        bcc_addresses_json,
        reply_to_addresses_json,
        attachment_names,
        attachment_search_text
    )
        VALUES (
            'delete',
            OLD.rowid,
            COALESCE(OLD.subject, ''),
            COALESCE(OLD.text_content, ''),
            COALESCE(OLD.from_address, ''),
            COALESCE(OLD.from_name, ''),
            COALESCE(OLD.to_address, ''),
            COALESCE(OLD.to_addresses_json, ''),
            COALESCE(OLD.cc_addresses_json, ''),
            COALESCE(OLD.bcc_addresses_json, ''),
            COALESCE(OLD.reply_to_addresses_json, ''),
            COALESCE(OLD.attachment_names, ''),
            COALESCE(OLD.attachment_search_text, '')
        );
END;

CREATE TRIGGER emails_fts_update_insert
AFTER UPDATE OF subject, text_content, from_address, from_name, to_address, to_addresses_json, cc_addresses_json, bcc_addresses_json, reply_to_addresses_json, attachment_names, attachment_search_text ON emails
BEGIN
    INSERT INTO emails_fts(
        rowid,
        subject,
        text_content,
        from_address,
        from_name,
        to_address,
        to_addresses_json,
        cc_addresses_json,
        bcc_addresses_json,
        reply_to_addresses_json,
        attachment_names,
        attachment_search_text
    )
        VALUES (
            NEW.rowid,
            COALESCE(NEW.subject, ''),
            COALESCE(NEW.text_content, ''),
            COALESCE(NEW.from_address, ''),
            COALESCE(NEW.from_name, ''),
            COALESCE(NEW.to_address, ''),
            COALESCE(NEW.to_addresses_json, ''),
            COALESCE(NEW.cc_addresses_json, ''),
            COALESCE(NEW.bcc_addresses_json, ''),
            COALESCE(NEW.reply_to_addresses_json, ''),
            COALESCE(NEW.attachment_names, ''),
            COALESCE(NEW.attachment_search_text, '')
        );
END;
