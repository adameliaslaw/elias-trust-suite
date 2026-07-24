// Backups without dependencies: the entire data directory (JSON books,
// global household file, receipt files) packed as a plain POSIX ustar
// tarball — readable by every unzip/untar tool ever shipped.
//
// Two consumers:
//   - GET /api/backup streams a fresh tarball for a one-tap download.
//   - writeSnapshot() drops the same tarball into data/backups/ on server
//     start and daily thereafter, keeping the newest KEEP_SNAPSHOTS. That
//     guards against a botched edit or corrupted JSON file; keep off-site
//     copies too (the download button, or copy the directory).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./global');

const KEEP_SNAPSHOTS = 7;
const SNAPSHOT_DIR = path.join(DATA_DIR, 'backups');

// 512-byte ustar header. Sizes/mtimes are octal, checksum is the byte sum
// of the header with the checksum field itself blanked to spaces.
function tarHeader(name, size, mtimeSec, isDir) {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0);                          // name
  buf.write(isDir ? '0000755 ' : '0000644 ', 100);         // mode (dirs need the traverse bit)
  buf.write('0000000 ', 108);                                // uid
  buf.write('0000000 ', 116);                                // gid
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124);  // size
  buf.write(Math.floor(mtimeSec).toString(8).padStart(11, '0') + ' ', 136);
  buf.write('        ', 148);                                // checksum (spaces while summing)
  buf.write(isDir ? '5' : '0', 156);                         // typeflag
  buf.write('ustar', 257);                                   // magic
  buf.write('00', 263);                                      // version
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return buf;
}

function walk(dir, prefix, out, exclude) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (exclude.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(tarHeader(rel + '/', 0, Date.now() / 1000, true));
      walk(full, rel, out, exclude);
    } else if (entry.isFile()) {
      const data = fs.readFileSync(full);
      out.push(tarHeader(rel, data.length, fs.statSync(full).mtimeMs / 1000, false));
      out.push(data);
      const pad = data.length % 512;
      if (pad) out.push(Buffer.alloc(512 - pad));
    }
  }
}

// Tar the data directory (snapshots and temp files excluded). Returns a
// Buffer ready to stream or write.
function tarball() {
  const out = [];
  if (fs.existsSync(DATA_DIR)) {
    // Exclude the snapshot dir (no nesting) AND the encryption keyfile: a
    // backup must be ciphertext-only, so a stolen tarball cannot decrypt the
    // secrets it contains (books.db holds sealed secrets). The key is held
    // separately (env or the untarred data dir). The transient SQLite journal
    // is skipped too: with journal_mode=DELETE it exists only mid-transaction,
    // and a snapshot must capture the committed books.db, not a rollback file.
    walk(DATA_DIR, 'quickbucks-data', out, new Set(['backups', '.secret.key', 'books.db-journal']));
  }
  out.push(Buffer.alloc(1024));   // end-of-archive: two zero blocks
  return Buffer.concat(out);
}

// List entry names in a tarball (used by tests and for restore guidance).
function entryNames(buf) {
  const names = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).trim(), 8) || 0;
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function writeSnapshot() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(SNAPSHOT_DIR, `quickbucks-${stamp}.tar`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, tarball());
  fs.renameSync(tmp, file);
  // Keep only the newest KEEP_SNAPSHOTS files.
  const all = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.tar')).sort();
  for (const old of all.slice(0, Math.max(all.length - KEEP_SNAPSHOTS, 0))) {
    fs.unlinkSync(path.join(SNAPSHOT_DIR, old));
  }
  return file;
}

// Snapshot now, then daily. unref() so short-lived processes (tests) exit.
function scheduleSnapshots() {
  try { writeSnapshot(); } catch { /* first boot may have no data yet */ }
  const timer = setInterval(() => {
    try { writeSnapshot(); } catch { /* disk hiccup — retry tomorrow */ }
  }, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { tarball, entryNames, writeSnapshot, scheduleSnapshots, KEEP_SNAPSHOTS, SNAPSHOT_DIR };
