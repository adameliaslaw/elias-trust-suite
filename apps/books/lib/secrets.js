'use strict';
// Encryption at rest for the handful of genuine secrets in a company's books:
// Plaid client secret + access tokens, firm/NJ ACH origination bank details,
// and each employee's direct-deposit routing/account. These were persisted in
// plaintext inside company-<id>.json (and every backup tarball) — a stolen data
// directory or backup handed over the firm's and employees' bank credentials.
//
// Design:
//  - AES-256-GCM (authenticated: tampering with ciphertext fails decryption).
//  - The key comes from QUICKBUCKS_ENCRYPTION_KEY (any-length passphrase, hashed
//    to 32 bytes) if set; otherwise a random keyfile at data/.secret.key,
//    created 0600 on first use and DELIBERATELY excluded from backups
//    (lib/backup.js), so a stolen tarball is ciphertext-only.
//  - Only known secret leaves are encrypted; everything else stays readable
//    JSON. The in-memory db always holds plaintext — sealing happens on the way
//    to disk, opening on the way back — so callers (Plaid, NACHA) are unchanged.
//  - Plaintext values (data written before this existed) pass through decrypt
//    untouched and get sealed on the next save: migration is automatic.
//
// Honest residual: this protects a stolen JSON file or backup tarball. It does
// NOT defend against an attacker who also has the keyfile (whole-directory
// copy) or the env passphrase — separate the key from your backups.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./global');

const PREFIX = 'enc:v1:';
const KEY_FILE_NAME = '.secret.key';
const KEY_FILE = path.join(DATA_DIR, KEY_FILE_NAME);

let keyCache = null;

function resolveKey() {
  if (keyCache) return keyCache;
  const env = process.env.QUICKBUCKS_ENCRYPTION_KEY;
  if (env && env.trim()) {
    keyCache = crypto.createHash('sha256').update(env.trim(), 'utf8').digest();
    return keyCache;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    keyCache = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (keyCache.length !== 32) throw new Error('secrets: data/.secret.key is corrupt (expected 32 bytes of hex)');
  } else {
    keyCache = crypto.randomBytes(32);
    const tmp = KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, keyCache.toString('hex'), { mode: 0o600 });
    fs.renameSync(tmp, KEY_FILE);
    try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* platform without POSIX modes */ }
  }
  return keyCache;
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

function encryptValue(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already sealed — never double-encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map(b => b.toString('base64')).join(':');
}

function decryptValue(token) {
  if (!isEncrypted(token)) return token; // plaintext (pre-encryption) passes through
  const [ivB64, tagB64, ctB64] = token.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// Walk the KNOWN secret leaves of a company db, applying fn in place. Written
// explicitly rather than with a path DSL: this is security code, and an
// enumerated list is auditable and cannot accidentally reach a wrong field.
function applyToSecrets(db, fn) {
  if (!db || typeof db !== 'object') return db;
  const s = db.settings || {};
  if (s.plaid) {
    for (const k of ['secret', 'clientId']) if (s.plaid[k]) s.plaid[k] = fn(s.plaid[k]);
  }
  if (s.payroll) {
    if (s.payroll.ach) {
      for (const k of ['bankRouting', 'bankAccount', 'immediateDestination', 'immediateOrigin']) {
        if (s.payroll.ach[k]) s.payroll.ach[k] = fn(s.payroll.ach[k]);
      }
    }
    if (s.payroll.njAch) {
      for (const k of ['routing', 'account']) {
        if (s.payroll.njAch[k]) s.payroll.njAch[k] = fn(s.payroll.njAch[k]);
      }
    }
  }
  for (const c of db.bankConnections || []) {
    if (c && c.accessToken) c.accessToken = fn(c.accessToken);
  }
  for (const e of db.employees || []) {
    if (e && e.bankRouting) e.bankRouting = fn(e.bankRouting);
    if (e && e.bankAccount) e.bankAccount = fn(e.bankAccount);
  }
  return db;
}

// Return a serializable clone with secret leaves encrypted (in-memory db is
// left plaintext). The FILE_KEY symbol prop is non-enumerable, so it is
// naturally dropped by the JSON clone.
function sealForStorage(db) {
  return applyToSecrets(JSON.parse(JSON.stringify(db)), encryptValue);
}

// Decrypt secret leaves of a just-parsed db in place, returning the same object
// to become the in-memory (plaintext) db.
function openFromStorage(db) {
  return applyToSecrets(db, decryptValue);
}

// Test hook: forget the cached key (a fresh tmp DATA_DIR per test).
function _reset() {
  keyCache = null;
}

module.exports = {
  encryptValue, decryptValue, isEncrypted, sealForStorage, openFromStorage,
  KEY_FILE, KEY_FILE_NAME, _reset,
};
