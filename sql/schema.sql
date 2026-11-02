-- Current fresh-install baseline, through v66 (2026-10-30).
-- Source: production sqlite_master, read-only capture; see sql/baseline/README.md.
-- Install EMPTY databases only: bun run db:init --local|--remote --config <your-config>
-- Includes tables, indexes, FTS5 and triggers. Do NOT replay migrate-v*.sql afterward.
-- Historical migrations/rollbacks remain for existing deployments, not new installs.
-- Future upgrades: forward-only migrations above version 66; record them in schema_migrations.
-- No IF NOT EXISTS: incompatible existing objects must fail, never be called current.

CREATE TABLE emails (id TEXT PRIMARY KEY, from_address TEXT NOT NULL, to_address TEXT NOT NULL, to_addresses_json TEXT, cc_addresses_json TEXT, bcc_addresses_json TEXT, reply_to_addresses_json TEXT, domain TEXT NOT NULL, mailbox TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'inbound', mailbox_state TEXT NOT NULL DEFAULT 'inbox', subject TEXT, received_at INTEGER NOT NULL, sent_at INTEGER, read_at INTEGER, html_content TEXT, text_content TEXT, message_id TEXT, provider_message_id TEXT, in_reply_to TEXT, references_header TEXT, has_attachments BOOLEAN DEFAULT FALSE, attachment_count INTEGER DEFAULT 0, category TEXT DEFAULT NULL, from_name TEXT DEFAULT NULL, interest_level TEXT DEFAULT NULL, interest_comment TEXT DEFAULT NULL, thread_id TEXT, source_type TEXT, source_path TEXT, source_folder TEXT, source_message_id TEXT, trashed_at INTEGER DEFAULT NULL, list_unsubscribe TEXT DEFAULT NULL, draft_revision INTEGER NOT NULL DEFAULT 0, editor_state_json TEXT, html_in_r2 INTEGER NOT NULL DEFAULT 0, r2_html_key TEXT DEFAULT NULL, user_kept_unread INTEGER NOT NULL DEFAULT 0, auto_read_at INTEGER, classification_uncertain INTEGER NOT NULL DEFAULT 0, sub_category TEXT, attachment_names TEXT, classify_lease_until INTEGER, classify_leased_by TEXT, attachment_search_text TEXT, action_note TEXT, action_due INTEGER, action_done_at INTEGER, action_expires_at INTEGER);

CREATE TABLE attachments (id TEXT PRIMARY KEY, email_id TEXT NOT NULL, object_key TEXT NOT NULL, filename TEXT, mime_type TEXT NOT NULL, size INTEGER NOT NULL, disposition TEXT, content_id TEXT, created_at INTEGER NOT NULL, extract_status TEXT, text_extracted_at INTEGER, FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE);

CREATE INDEX idx_emails_to_received ON emails (to_address, received_at DESC);

CREATE INDEX idx_emails_from_received ON emails (from_address, received_at DESC);

CREATE INDEX idx_emails_received ON emails (received_at DESC);

CREATE INDEX idx_emails_domain_received ON emails (domain, received_at DESC);

CREATE INDEX idx_emails_mailbox_received ON emails (mailbox, received_at DESC);

CREATE INDEX idx_emails_state_received ON emails (mailbox_state, received_at DESC);

CREATE INDEX idx_emails_direction_received ON emails (direction, received_at DESC);

CREATE INDEX idx_attachments_email_id ON attachments (email_id);

CREATE INDEX idx_emails_category_received ON emails (category, received_at DESC);

CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_workspace ON push_subscriptions (workspace_id);

CREATE TABLE sender_rules (id TEXT PRIMARY KEY, domain TEXT NOT NULL, from_pattern TEXT NOT NULL, category TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE agent_messages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, email_id TEXT, created_at INTEGER NOT NULL);

CREATE TABLE agent_memory (key TEXT NOT NULL, workspace_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, workspace_id));

CREATE TABLE classification_log (id TEXT PRIMARY KEY, email_id TEXT NOT NULL, from_address TEXT NOT NULL, subject TEXT, category TEXT, previous_category TEXT, method TEXT NOT NULL, confidence REAL, haiku_tokens_used INTEGER, created_at INTEGER NOT NULL);

CREATE INDEX idx_sender_rules_domain ON sender_rules (domain);

CREATE INDEX idx_agent_messages_workspace ON agent_messages (workspace_id, created_at DESC);

CREATE INDEX idx_agent_memory_workspace ON agent_memory (workspace_id);

CREATE INDEX idx_classification_log_email ON classification_log (email_id);

CREATE INDEX idx_classification_log_created ON classification_log (created_at DESC);

CREATE INDEX idx_emails_interest_level ON emails (interest_level) WHERE interest_level IS NOT NULL;

CREATE TABLE agent_message_metadata (
    message_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'chat',
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_message_metadata_workspace
    ON agent_message_metadata (workspace_id, created_at DESC);

CREATE INDEX idx_agent_message_metadata_type
    ON agent_message_metadata (message_type, created_at DESC);

CREATE TABLE classification_feedback (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    from_address TEXT NOT NULL,
    domain TEXT NOT NULL,
    previous_category TEXT,
    corrected_category TEXT,
    user_comment TEXT,
    resolution_scope TEXT,
    agent_summary TEXT,
    follow_up_question TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_classification_feedback_workspace_created
    ON classification_feedback (workspace_id, created_at DESC);

CREATE INDEX idx_classification_feedback_email
    ON classification_feedback (email_id);

CREATE INDEX idx_classification_feedback_domain
    ON classification_feedback (domain, created_at DESC);

CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    root_subject TEXT,
    latest_message_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 1,
    unread_count INTEGER NOT NULL DEFAULT 0,
    mailbox_state TEXT NOT NULL DEFAULT 'inbox',
    has_attachments BOOLEAN DEFAULT FALSE,
    attachment_count INTEGER DEFAULT 0,
    snippet TEXT,
    participant_names TEXT,
    participant_addresses TEXT,
    is_muted BOOLEAN DEFAULT FALSE,
    is_starred BOOLEAN DEFAULT FALSE,
    category TEXT,
    latest_email_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
, priority_category TEXT, user_pinned_category TEXT, priority_sub_category TEXT, for_person TEXT);

CREATE INDEX idx_emails_thread_id ON emails (thread_id);

CREATE INDEX idx_threads_domain_state ON threads (domain, mailbox_state, latest_message_at DESC);

CREATE INDEX idx_threads_domain_category ON threads (domain, category, latest_message_at DESC);

CREATE INDEX idx_threads_domain_muted ON threads (domain, is_muted);

CREATE INDEX idx_emails_source_type_path ON emails (source_type, source_path);

CREATE INDEX idx_emails_source_message_id ON emails (source_message_id) WHERE source_message_id IS NOT NULL;

CREATE INDEX idx_threads_mailbox_latest
ON threads (mailbox_state, latest_message_at DESC, id DESC);

CREATE INDEX idx_threads_mailbox_domain_latest
ON threads (mailbox_state, domain, latest_message_at DESC, id DESC);

CREATE INDEX idx_threads_category_latest
ON threads (category, latest_message_at DESC, id DESC);

CREATE INDEX idx_emails_html_in_r2
  ON emails (id)
  WHERE html_in_r2 = 1;

CREATE INDEX idx_threads_domain_priority
    ON threads (domain, priority_category, latest_message_at DESC);

CREATE INDEX idx_emails_aged_unread
    ON emails (received_at)
    WHERE read_at IS NULL AND user_kept_unread = 0;

CREATE INDEX idx_emails_uncertain_aged
    ON emails (received_at)
    WHERE classification_uncertain = 1 AND mailbox_state = 'inbox';

CREATE INDEX idx_emails_category_subcategory_received
    ON emails (category, sub_category, received_at DESC);

CREATE INDEX idx_threads_domain_priority_sub
    ON threads (domain, priority_category, priority_sub_category, latest_message_at DESC);

CREATE TABLE raw_email_artifacts (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    envelope_from TEXT,
    envelope_to TEXT,
    parse_status TEXT NOT NULL DEFAULT 'parsed',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX idx_raw_email_artifacts_expires
    ON raw_email_artifacts (expires_at);

CREATE INDEX idx_raw_email_artifacts_domain_stored
    ON raw_email_artifacts (domain, stored_at DESC);

CREATE TABLE email_fidelity_checks (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL UNIQUE,
    checked_at INTEGER NOT NULL,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_sha256 TEXT,
    raw_size INTEGER,
    mismatches_json TEXT NOT NULL,
    raw_headers_json TEXT NOT NULL,
    stored_headers_json TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_fidelity_checks_status_checked
    ON email_fidelity_checks (status, checked_at DESC);

CREATE INDEX idx_emails_state_domain_thread
ON emails (mailbox_state, domain, thread_id);

CREATE INDEX idx_emails_thread_state_sent_received
ON emails (thread_id, mailbox_state, sent_at DESC, received_at DESC);

CREATE INDEX idx_emails_classify_queue
    ON emails (category, direction, mailbox_state, received_at DESC)
    WHERE category IS NULL;

CREATE TABLE blocked_senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_type TEXT NOT NULL CHECK (pattern_type IN ('address','domain')),
    pattern TEXT NOT NULL COLLATE NOCASE,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(pattern_type, pattern)
);

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

CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(
        rowid, subject, text_content, from_address, from_name, to_address,
        to_addresses_json, cc_addresses_json, bcc_addresses_json,
        reply_to_addresses_json, attachment_names, attachment_search_text
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
        emails_fts, rowid, subject, text_content, from_address, from_name, to_address,
        to_addresses_json, cc_addresses_json, bcc_addresses_json,
        reply_to_addresses_json, attachment_names, attachment_search_text
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
        emails_fts, rowid, subject, text_content, from_address, from_name, to_address,
        to_addresses_json, cc_addresses_json, bcc_addresses_json,
        reply_to_addresses_json, attachment_names, attachment_search_text
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
        rowid, subject, text_content, from_address, from_name, to_address,
        to_addresses_json, cc_addresses_json, bcc_addresses_json,
        reply_to_addresses_json, attachment_names, attachment_search_text
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

CREATE INDEX idx_threads_effective_category_latest
  ON threads (
    COALESCE(user_pinned_category, priority_category, category),
    latest_message_at DESC,
    id DESC
  );

CREATE INDEX idx_emails_domain_mailbox_dates ON emails (domain, mailbox, sent_at, received_at);

CREATE INDEX idx_threads_effcat_domain_unread ON threads (COALESCE(user_pinned_category, priority_category, category), domain, unread_count);

CREATE INDEX idx_threads_subcat_unread ON threads (priority_sub_category, unread_count) WHERE priority_sub_category IS NOT NULL;

CREATE INDEX idx_threads_latest ON threads (latest_message_at DESC, id DESC);

CREATE INDEX idx_threads_domain_latest ON threads (domain, latest_message_at DESC, id DESC);

CREATE INDEX idx_emails_message_id ON emails (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX idx_threads_domain_subject_latest ON threads (domain, root_subject, latest_message_at DESC);

CREATE TABLE send_idempotency_keys (
  key_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('preparing', 'ready', 'dispatching', 'sent', 'failed', 'unknown')
  ),
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, submitted_at INTEGER, evidence_json TEXT);

CREATE INDEX idx_emails_classify_leased_by
  ON emails (classify_leased_by)
  WHERE classify_leased_by IS NOT NULL;

CREATE TABLE purged_deliveries (
  domain TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_id TEXT NOT NULL,
  purged_at INTEGER NOT NULL,
  PRIMARY KEY (domain, mailbox, direction, message_id)
) WITHOUT ROWID;

CREATE TRIGGER purged_deliveries_on_email_delete
BEFORE DELETE ON emails
WHEN OLD.message_id IS NOT NULL AND OLD.mailbox_state <> 'draft'
BEGIN
  INSERT OR IGNORE INTO purged_deliveries (domain, mailbox, direction, message_id, purged_at)
  VALUES (OLD.domain, OLD.mailbox, OLD.direction, OLD.message_id, unixepoch() * 1000);
END;

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'company', 'project', 'prospect')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  addresses_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(addresses_json)),
  parent_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  notes TEXT,
  source TEXT NOT NULL CHECK (source IN ('user', 'seed', 'model')),
  owner_threads_12m INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, name_key)
);

CREATE TABLE email_entities (
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('linked', 'rejected')),
  source TEXT NOT NULL CHECK (source IN ('user', 'model')),
  evidence_field TEXT,
  evidence_text TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email_id, entity_id)
) WITHOUT ROWID;

CREATE INDEX idx_email_entities_entity ON email_entities (entity_id, state, created_at DESC);

CREATE TABLE "sender_unsubscribe_status" (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,          -- sender address (or *@domain pattern) the decision is about
  domain TEXT NOT NULL,           -- our domain the mail arrived at
  decision TEXT NOT NULL CHECK (decision IN ('unsubscribed', 'kept', 'blocked')),
  method TEXT,                    -- how the unsubscribe was attempted, e.g. 'one_click'
  http_status INTEGER,            -- the one-click POST's status, when there was one
  error TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX idx_sender_unsubscribe_status_address_at
  ON sender_unsubscribe_status (address, at DESC);

CREATE UNIQUE INDEX uq_sender_rules_from_pattern ON sender_rules (from_pattern);

CREATE INDEX idx_threads_for_person
  ON threads (for_person, latest_message_at DESC)
  WHERE for_person IS NOT NULL;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  owner_key TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
, signed_out_at INTEGER, disabled_at INTEGER);

CREATE TABLE user_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('all', 'address', 'for_person')),
  value TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, kind, value)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  borrowed INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- v67: login throttle counters (src/database/login-attempts.ts); sha256 keys only.
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_subject ON login_attempts (subject);

CREATE INDEX idx_login_attempts_expires ON login_attempts (expires_at);

CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE INDEX idx_emails_action_open_domain
  ON emails (domain, received_at DESC)
  WHERE action_note IS NOT NULL AND action_done_at IS NULL;

CREATE TABLE device_tokens (
  account TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  token TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('sandbox', 'production')),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (token, env)
);

CREATE INDEX idx_device_tokens_account ON device_tokens(account);

CREATE TABLE ai_consent_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL CHECK (state IN ('allowed', 'declined')),
  version INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'account_deletion'))
);

CREATE TABLE account_deletions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  owner_key TEXT,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE UNIQUE INDEX idx_account_deletions_open
  ON account_deletions (user_id) WHERE completed_at IS NULL;

CREATE TABLE ai_usage (
 id TEXT PRIMARY KEY,
 instance_id TEXT NOT NULL,
 month TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('classifier','chat','feedback')),
 lease_token TEXT,
 model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','settled','failed','unknown')),
 input_bound INTEGER NOT NULL,
 output_bound INTEGER NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 cached_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 reserved_nano INTEGER NOT NULL,
 actual_nano INTEGER,
 free_nano INTEGER NOT NULL,
 paid_nano INTEGER NOT NULL,
 rate_ppm INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 settled_at INTEGER,
 overrun INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_usage_month ON ai_usage(instance_id,month);
CREATE TABLE ai_credits (
 id TEXT PRIMARY KEY,
 instance_id TEXT NOT NULL,
 amount_nano INTEGER NOT NULL CHECK(amount_nano>0),
 note TEXT NOT NULL,
 created_at INTEGER NOT NULL
);

-- Install metadata only; no users, messages, credentials or AI decisions are seeded.
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO schema_migrations (version, name) VALUES (66, 'baseline-v66-ai-usage');
