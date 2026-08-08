#!/usr/bin/env node
// gdrive.mjs — create/populate/share Google Docs & Sheets DIRECTLY via the
// marketplace-pipeline service account (no Zapier, no per-session consent).
//
// This is the DEFAULT path for "build me a Google Doc / Sheet". Dependency-free
// (Node built-ins only): mints an RS256 JWT from GOOGLE_SA_KEY, exchanges it for an
// access token, then hits the Drive / Docs / Sheets REST APIs.
//
// ⚠️ The SA has NO personal Drive (storageQuota.limit = 0), so every file MUST be
// created inside a Shared Drive. Default = "Snagged Pipeline" (0ACKJ-QAwIhwLUk9PVA).
// Files are shared to rob@snagged.com after create unless --share is given.
//
// Env: GOOGLE_SA_KEY (raw JSON) or GOOGLE_SA_KEY_B64 (base64 of the JSON).
//
// Usage:
//   node scripts/gdrive.mjs doc   "<title>" [--text-file f.md | --text "..."] [--drive ID] [--share email] [--no-share]
//   node scripts/gdrive.mjs sheet "<title>" [--tsv f.tsv | --json rows.json]   [--drive ID] [--share email] [--no-share]
//   node scripts/gdrive.mjs share <fileId> <email> [--role writer|reader|commenter]
//   (doc/sheet also read content from STDIN when no --text*/--tsv/--json is given:
//    doc → plain text; sheet → TSV, one row per line, tab-separated cells)
//
// Prints the file URL on success.

import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_DRIVE = '0ACKJ-QAwIhwLUk9PVA'; // "Snagged Pipeline" shared drive
const DEFAULT_SHARE = 'rob@snagged.com';

function loadSA() {
  const raw = process.env.GOOGLE_SA_KEY
    || (process.env.GOOGLE_SA_KEY_B64 && Buffer.from(process.env.GOOGLE_SA_KEY_B64, 'base64').toString('utf8'));
  if (!raw) { console.error('GOOGLE_SA_KEY (or GOOGLE_SA_KEY_B64) is not set.'); process.exit(1); }
  return JSON.parse(raw);
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function token(scope) {
  const sa = loadSA();
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const s = b64url(crypto.createSign('RSA-SHA256').update(`${h}.${c}`).sign(sa.private_key));
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${c}.${s}` }),
  });
  const j = await res.json();
  if (!j.access_token) { console.error('token exchange failed:', res.status, JSON.stringify(j).slice(0, 400)); process.exit(1); }
  return j.access_token;
}

// tiny flag parser: --key value / --flag (boolean). Returns { _: positionals, ...flags }.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

async function createFile(A, { name, mimeType, drive }) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { ...A, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType, parents: [drive] }),
  });
  const f = await res.json();
  if (!f.id) { console.error('create failed:', res.status, JSON.stringify(f).slice(0, 500)); process.exit(1); }
  return f;
}

async function share(A, id, email, role = 'writer') {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id`, {
    method: 'POST',
    headers: { ...A, 'content-type': 'application/json' },
    body: JSON.stringify({ role, type: 'user', emailAddress: email }),
  });
  return res.status;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const drive = args.drive || DEFAULT_DRIVE;
  const shareTo = args['no-share'] ? null : (args.share && args.share !== true ? args.share : DEFAULT_SHARE);

  if (cmd === 'doc') {
    const title = args._[0];
    if (!title) { console.error('usage: gdrive.mjs doc "<title>" [--text-file f | --text "..."]'); process.exit(1); }
    const text = args['text-file'] ? fs.readFileSync(args['text-file'], 'utf8')
      : (args.text && args.text !== true) ? args.text
      : readStdin();
    const A = { Authorization: `Bearer ${await token('https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive')}` };
    const f = await createFile(A, { name: title, mimeType: 'application/vnd.google-apps.document', drive });
    if (text && text.trim()) {
      const u = await fetch(`https://docs.googleapis.com/v1/documents/${f.id}:batchUpdate`, {
        method: 'POST', headers: { ...A, 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] }),
      });
      if (!u.ok) console.error('body insert warning:', u.status, (await u.text()).slice(0, 300));
    }
    if (shareTo) await share(A, f.id, shareTo);
    console.log(f.webViewLink || `https://docs.google.com/document/d/${f.id}/edit`);
    return;
  }

  if (cmd === 'sheet') {
    const title = args._[0];
    if (!title) { console.error('usage: gdrive.mjs sheet "<title>" [--tsv f | --json rows.json]'); process.exit(1); }
    let rows;
    if (args.json && args.json !== true) rows = JSON.parse(fs.readFileSync(args.json, 'utf8'));
    else {
      const tsv = args.tsv && args.tsv !== true ? fs.readFileSync(args.tsv, 'utf8') : readStdin();
      rows = tsv.replace(/\n$/, '').split('\n').filter((l) => l.length).map((l) => l.split('\t'));
    }
    const A = { Authorization: `Bearer ${await token('https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets')}` };
    const f = await createFile(A, { name: title, mimeType: 'application/vnd.google-apps.spreadsheet', drive });
    if (rows && rows.length) {
      const u = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${f.id}/values/A1?valueInputOption=RAW`, {
        method: 'PUT', headers: { ...A, 'content-type': 'application/json' },
        body: JSON.stringify({ values: rows }),
      });
      if (!u.ok) console.error('populate warning:', u.status, (await u.text()).slice(0, 300));
    }
    if (shareTo) await share(A, f.id, shareTo);
    console.log(f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`);
    return;
  }

  if (cmd === 'share') {
    const [id, email] = args._;
    if (!id || !email) { console.error('usage: gdrive.mjs share <fileId> <email> [--role writer|reader|commenter]'); process.exit(1); }
    const A = { Authorization: `Bearer ${await token('https://www.googleapis.com/auth/drive')}` };
    const st = await share(A, id, email, args.role && args.role !== true ? args.role : 'writer');
    console.log('share', email, '→', st);
    return;
  }

  console.error('usage: gdrive.mjs <doc|sheet|share> ...');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
