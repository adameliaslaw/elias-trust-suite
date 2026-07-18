// Receipt attachments for expenses: photos (phone camera) or PDFs, stored
// as plain files under data/receipts/ next to the JSON books, so a copy of
// the data directory is always a complete backup. The expense record holds
// only small metadata ({filename, mime, size, name}); the bytes live on
// disk, never inside the JSON.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./global');

const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const MAX_BYTES = 10 * 1024 * 1024;   // 10 MB decoded

// iPhone camera gives HEIC; keep it even though browsers may download
// rather than display it.
const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf'
};

function decode(dataBase64) {
  const raw = String(dataBase64 || '').replace(/^data:[^;]*;base64,/, '');
  return Buffer.from(raw, 'base64');
}

// Validate and persist an upload. Returns { error } or { receipt } metadata
// to store on the expense.
function saveReceipt(companyId, expenseId, body) {
  const mime = String(body.type || '').toLowerCase();
  if (!(mime in ALLOWED)) {
    return { error: 'Receipts can be photos (JPEG/PNG/WebP/HEIC) or PDFs' };
  }
  const buf = decode(body.dataBase64);
  if (!buf.length) return { error: 'The file is empty' };
  if (buf.length > MAX_BYTES) return { error: 'Receipts are capped at 10 MB' };
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  const filename = `${companyId}-${expenseId}.${ALLOWED[mime]}`;
  const tmp = path.join(RECEIPTS_DIR, filename + '.tmp');
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(RECEIPTS_DIR, filename));
  return {
    receipt: {
      filename, mime, size: buf.length,
      name: String(body.name || 'receipt').slice(0, 200),
      uploadedAt: new Date().toISOString().slice(0, 10)
    }
  };
}

function readReceipt(receipt) {
  if (!receipt || !receipt.filename) return null;
  const file = path.join(RECEIPTS_DIR, path.basename(receipt.filename));
  if (!fs.existsSync(file)) return null;
  return { buffer: fs.readFileSync(file), mime: receipt.mime };
}

function deleteReceipt(receipt) {
  if (!receipt || !receipt.filename) return;
  const file = path.join(RECEIPTS_DIR, path.basename(receipt.filename));
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { MAX_BYTES, ALLOWED, saveReceipt, readReceipt, deleteReceipt };
