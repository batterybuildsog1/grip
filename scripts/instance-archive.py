#!/usr/bin/env python3
"""Disk-backed instance archive. Stdlib only; HTTP pages and blobs never buffered together."""
import argparse
import email.policy
from email.message import EmailMessage
from email.utils import format_datetime, formataddr
import datetime
import hashlib
import gzip
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def jsonline(out, value):
    out.write(json.dumps(value, ensure_ascii=True) + '\n')


class Client:
    def __init__(self, args):
        self.host = args.host.rstrip('/')
        url = urllib.parse.urlparse(self.host)
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')):
            raise ValueError('Use HTTPS (HTTP is allowed only on loopback)')
        self.auth = Path(args.auth_file).read_text().strip().split(': ', 1)[1]
        # Refuse redirects rather than forwarding a credential or writing an HTML login page.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *unused):
                return None
        self.opener = urllib.request.build_opener(NoRedirect)

    def open(self, path, **params):
        url = self.host + '/api/export/' + path + '?' + urllib.parse.urlencode(params)
        for attempt in range(6):
            try:
                return self.opener.open(urllib.request.Request(url, headers={'Authorization': self.auth}), timeout=120)
            except urllib.error.HTTPError as e:
                if e.code not in (429, 502, 503, 504) or attempt == 5:
                    raise ValueError(f'Export HTTP {e.code} at {path}') from None
                time.sleep(min(30, max(1, int(e.headers.get('Retry-After', 2 ** attempt)))))

    def get(self, path, **params):
        with self.open(path, **params) as f:
            return json.load(f)['data']


def write_row(sql, statement):
    # D1 accepts large bound values but limits SQL text to 100 KB per statement.
    # Hex literals are exact (including NUL), but require bounded staging for large rows.
    if len(statement.encode()) <= 60000:
        sql.write(statement + '\n')
        return
    prefix, values = statement.split(' VALUES (', 1)
    counter = 0
    def stage(match):
        nonlocal counter
        literal = match.group(2)
        if len(literal) < 256:
            return match.group(0)
        counter += 1
        sql.write(f'INSERT INTO "_grip_restore_values" VALUES ({counter},X\'\');\n')
        for at in range(0, len(literal), 40000):
            chunk = literal[at:at + 40000]
            sql.write(f'UPDATE "_grip_restore_values" SET data=CAST(data || X\'{chunk}\' AS BLOB) WHERE id={counter};\n')
        select = f'(SELECT data FROM "_grip_restore_values" WHERE id={counter})'
        return f'CAST({select} AS TEXT)' if match.group(1) else select
    values = re.sub(r"(CAST\()?X'([0-9A-F]*)'( AS TEXT\))?", stage, values)
    sql.write(prefix + ' VALUES (' + values + '\n')
    sql.write('DELETE FROM "_grip_restore_values";\n')


def export(args):
    if not args.quiesced:
        raise ValueError('Pause delivery, ingestion, all edits and cron; pass --quiesced')
    dest = Path(args.directory).resolve()
    dest.mkdir(mode=0o700, parents=True, exist_ok=False)
    client = Client(args)
    db = sqlite3.connect(dest / '.working.sqlite')
    db.row_factory = sqlite3.Row
    schema = client.get('schema')
    if schema['format'] != 'grip-instance-v1':
        raise ValueError('Unsupported server format')
    with (dest / 'restore.sql').open('w') as sql:
        sql.write('PRAGMA defer_foreign_keys=ON;\nCREATE TABLE \"_grip_restore_values\" (id INTEGER PRIMARY KEY, data BLOB NOT NULL);\n')
        for definition in schema['definitions']:
            if definition['type'] == 'table' and not definition['sql'].upper().startswith('CREATE VIRTUAL'):
                sql.write(definition['sql'] + ';\n')
                db.execute(definition['sql'])
        for table in schema['tables']:
            after = None
            while True:
                page = client.get('table', name=table['name'], after=json.dumps(after))
                for row in page['rows']:
                    statement = row['__grip_sql']
                    write_row(sql, statement)
                    db.execute(statement)
                if not page['next']:
                    break
                after = page['next']
        sql.write('DROP TABLE \"_grip_restore_values\";\n')
        if schema.get('sequences'):
            sql.write('DELETE FROM sqlite_sequence;\n')
            for sequence in schema['sequences']:
                name = sequence['name'].replace("'", "''")
                sql.write(f"INSERT INTO sqlite_sequence(name,seq) VALUES ('{name}',{int(sequence['seq'])});\n")
        for definition in schema['definitions']:
            if definition['type'] != 'table' or definition['sql'].upper().startswith('CREATE VIRTUAL'):
                sql.write(definition['sql'] + ';\n')
        for definition in schema['definitions']:
            if definition['sql'].upper().startswith('CREATE VIRTUAL'):
                # Grip has external-content FTS5 only. Fail on unknown virtual engines.
                if 'USING fts5' not in definition['sql']:
                    raise ValueError('Unsupported virtual table')
                name = definition['name'].replace('"', '""')
                sql.write(f'INSERT INTO "{name}" ("{name}") VALUES (\'rebuild\');\n')
        sql.write('PRAGMA defer_foreign_keys=OFF;\n')
    db.execute('CREATE TABLE __archive_objects (key TEXT PRIMARY KEY, path TEXT, metadata TEXT)')
    (dest / 'objects').mkdir()
    cursor = None
    object_count = 0
    with (dest / 'objects.jsonl').open('w') as index:
        while True:
            page = client.get('objects', **({'cursor': cursor} if cursor else {}))
            for obj in page['objects']:
                relative = 'objects/' + hashlib.sha256(obj['key'].encode()).hexdigest()
                path = dest / relative
                with client.open('object', key=obj['key'], etag=obj['etag']) as response, path.open('wb') as out:
                    shutil.copyfileobj(response, out, 1024 * 1024)
                if path.stat().st_size != obj['size']:
                    raise ValueError('Truncated R2 object')
                obj.update(path=relative, sha256=digest(path))
                db.execute('INSERT INTO __archive_objects VALUES (?,?,?)', (obj['key'], relative, json.dumps(obj)))
                jsonline(index, obj)
                object_count += 1
            cursor = page['next']
            if not cursor:
                break

    def object_path(key, expected_size=None, expected_sha=None):
        found = db.execute('SELECT path FROM __archive_objects WHERE key=?', (key,)).fetchone()
        if not found:
            raise ValueError('Referenced R2 object missing; archive incomplete: ' + key)
        path = dest / found['path']
        if expected_size is not None and path.stat().st_size != expected_size:
            raise ValueError('Referenced R2 object size differs')
        if expected_sha and digest(path) != expected_sha:
            raise ValueError('Retained raw RFC 822 checksum differs')
        return path

    # Validate every reference, including draft attachments and retained raw with no email.
    tables = {t['name'] for t in schema['tables']}
    if 'attachments' in tables:
        for a in db.execute('SELECT object_key,size FROM attachments'):
            object_path(a['object_key'], a['size'])
    if 'raw_email_artifacts' in tables:
        for raw in db.execute('SELECT object_key,size,sha256 FROM raw_email_artifacts'):
            object_path(raw['object_key'], raw['size'], raw['sha256'])
    # MIME generation must not scan the whole attachment table for every message.
    if 'attachments' in tables:
        db.execute('CREATE INDEX __archive_attachment_lookup ON attachments(email_id,id)')
    if 'raw_email_artifacts' in tables:
        db.execute('CREATE INDEX __archive_raw_lookup ON raw_email_artifacts(email_id)')
    message_count = 0
    with (dest / 'messages.jsonl').open('w') as messages:
        for row in db.execute('SELECT * FROM emails ORDER BY rowid'):
            e = dict(row)
            msg = EmailMessage(policy=email.policy.SMTP)
            def header(name, value):
                if value:
                    # Existing imported headers may contain folding; flatten it for generated MIME.
                    msg[name] = str(value).replace('\r', '').replace('\n', ' ')
            header('From', formataddr((e.get('from_name') or '', e['from_address'])))
            for field, col in [('To', 'to_addresses_json'), ('Cc', 'cc_addresses_json'),
                               ('Bcc', 'bcc_addresses_json'), ('Reply-To', 'reply_to_addresses_json')]:
                addresses = json.loads(e.get(col) or '[]')
                header(field, ', '.join(addresses) or (e['to_address'] if field == 'To' else None))
            for field, col in [('Subject', 'subject'), ('Message-ID', 'message_id'),
                               ('In-Reply-To', 'in_reply_to'), ('References', 'references_header'),
                               ('List-Unsubscribe', 'list_unsubscribe'), ('List-Unsubscribe-Post', 'list_unsubscribe_post')]:
                header(field, e.get(col))
            msg['Date'] = format_datetime(datetime.datetime.fromtimestamp(
                (e.get('sent_at') or e['received_at']) / 1000, datetime.timezone.utc))
            msg.set_content(e.get('text_content') or '')
            html = e.get('html_content')
            if e.get('html_in_r2'):
                with gzip.open(object_path(e['r2_html_key']), 'rt', encoding='utf-8') as body:
                    html = body.read()
            if html is not None:
                msg.add_alternative(html, subtype='html')
            for attachment in db.execute('SELECT * FROM attachments WHERE email_id=? ORDER BY id', (e['id'],)):
                a = dict(attachment)
                mime = (a.get('mime_type') or 'application/octet-stream').split('/', 1)
                if len(mime) != 2:
                    mime = ['application', 'octet-stream']
                msg.add_attachment(object_path(a['object_key'], a['size']).read_bytes(),
                                   maintype=mime[0], subtype=mime[1], filename=a.get('filename'),
                                   disposition=a.get('disposition') or 'attachment', cid=a.get('content_id'))
            account = hashlib.sha256(f"{e['mailbox']}@{e['domain']}".encode()).hexdigest()[:24]
            folder = {'inbox': 'INBOX', 'sent': '.Sent', 'draft': '.Drafts',
                      'trash': '.Trash', 'archived': '.Archive'}.get(e['mailbox_state'], '.Other')
            base = Path('Maildir') / account / folder
            for sub in ('cur', 'new', 'tmp'):
                (dest / base / sub).mkdir(parents=True, exist_ok=True)
            flags = ('D' if e['mailbox_state'] == 'draft' else '') + ('S' if e.get('read_at') is not None else '')
            filename = hashlib.sha256(e['id'].encode()).hexdigest() + ':2,' + flags
            relative = str(base / 'cur' / filename)
            # Deterministic MIME boundaries make repeat exports directly diffable.
            for i, part in enumerate(msg.walk()):
                if part.is_multipart():
                    part.set_boundary('grip-' + hashlib.sha256(e['id'].encode()).hexdigest() + '-' + str(i))
            with (dest / relative).open('wb') as out:
                out.write(msg.as_bytes())
            raw = None
            if 'raw_email_artifacts' in tables:
                artifact = db.execute('SELECT object_key FROM raw_email_artifacts WHERE email_id=?', (e['id'],)).fetchone()
                if artifact:
                    raw = str(object_path(artifact['object_key']).relative_to(dest))
            jsonline(messages, dict(id=e['id'], account=f"{e['mailbox']}@{e['domain']}",
                                   maildir=relative, raw=raw, state=e['mailbox_state'],
                                   read_at=e.get('read_at'), category=e.get('category'),
                                   sub_category=e.get('sub_category'), original_rfc822=bool(raw)))
            message_count += 1
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('Source snapshot has broken foreign keys')
    if client.get('schema') != schema:
        raise ValueError('Schema changed during export')
    db.close()
    (dest / '.working.sqlite').unlink()
    # Completion marker written last. All snapshot and portable files get checksums.
    with (dest / 'checksums.jsonl').open('w') as out:
        for root, dirs, files in os.walk(dest):
            dirs.sort()
            for name in sorted(files):
                path = Path(root) / name
                if path.name == 'checksums.jsonl':
                    continue
                jsonline(out, dict(path=str(path.relative_to(dest)), sha256=digest(path), size=path.stat().st_size))
    manifest = dict(format='grip-instance-v1', quiesced=True, messages=message_count,
                    objects=object_count, checksums_sha256=digest(dest / 'checksums.jsonl'),
                    created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    scope='mail D1 + ATTACHMENTS R2; deployment configuration and MILEAGE_D1 are separate')
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(dict(archive=str(dest), messages=message_count, objects=object_count, complete=True)))


def verify(directory):
    dest = Path(directory).resolve()
    manifest = json.loads((dest / 'manifest.json').read_text())
    if manifest['format'] != 'grip-instance-v1' or digest(dest / 'checksums.jsonl') != manifest['checksums_sha256']:
        raise ValueError('Invalid archive manifest or checksum list')
    def safe(relative):
        p = (dest / relative).resolve()
        if not p.is_relative_to(dest) or p.is_symlink():
            raise ValueError('Unsafe archive path')
        return p
    with (dest / 'checksums.jsonl').open() as checks:
        for line in checks:
            entry = json.loads(line)
            path = safe(entry['path'])
            if path.stat().st_size != entry['size'] or digest(path) != entry['sha256']:
                raise ValueError('Archive checksum mismatch: ' + entry['path'])
    return dest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    exp = sub.add_parser('export')
    exp.add_argument('directory')
    exp.add_argument('--quiesced', action='store_true')
    exp.add_argument('--host', required=True)
    exp.add_argument('--auth-file', required=True)
    ver = sub.add_parser('verify')
    ver.add_argument('directory')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == 'export':
            export(args)
        else:
            print(json.dumps(dict(archive=str(verify(args.directory)), verified=True)))
    except Exception as e:
        print(json.dumps(dict(error=dict(code='ARCHIVE_FAILED', message=str(e)))), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
