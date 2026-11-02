-- v31: Expand email FTS recall beyond sender/subject/body.
--
-- This lets searches match outbound recipients, copied parties, reply-to
-- addresses, and attachment filenames. PDF/body extraction is handled outside
-- the Worker for now; this migration gives MailClaw better recall on
-- the metadata it already stores.

ALTER TABLE emails ADD COLUMN attachment_names TEXT;

UPDATE emails
   SET attachment_names = COALESCE((
	   SELECT GROUP_CONCAT(COALESCE(filename, ''), ' ')
	     FROM attachments
	    WHERE attachments.email_id = emails.id
   ), '')
 WHERE has_attachments = 1;

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
    attachment_names
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
           COALESCE(attachment_names, '')
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
        attachment_names
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
            COALESCE(NEW.attachment_names, '')
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
        attachment_names
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
            COALESCE(OLD.attachment_names, '')
        );
END;

CREATE TRIGGER emails_fts_update_delete
BEFORE UPDATE OF subject, text_content, from_address, from_name, to_address, to_addresses_json, cc_addresses_json, bcc_addresses_json, reply_to_addresses_json, attachment_names ON emails
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
        attachment_names
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
            COALESCE(OLD.attachment_names, '')
        );
END;

CREATE TRIGGER emails_fts_update_insert
AFTER UPDATE OF subject, text_content, from_address, from_name, to_address, to_addresses_json, cc_addresses_json, bcc_addresses_json, reply_to_addresses_json, attachment_names ON emails
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
        attachment_names
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
            COALESCE(NEW.attachment_names, '')
        );
END;
