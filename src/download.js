/**
 * Streams a URL to a file under DOWNLOAD_DIR: writes to <file>.part, checks the
 * size against what the LMS reported, then renames into place.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');

/** Make a string safe as a single path segment on macOS/Linux/Windows. */
function safeName(s, max = 120) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'untitled').slice(0, max).trim();
}

/**
 * Download `url` to `relPath` (relative to DOWNLOAD_DIR). Returns the size.
 * `expectedSize` (bytes) is checked when given.
 */
async function downloadTo(url, relPath, { expectedSize } = {}) {
  const dest = path.join(config.downloadDir, relPath);
  if (!dest.startsWith(config.downloadDir + path.sep)) throw new Error(`Refusing to write outside DOWNLOAD_DIR: ${relPath}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    const size = fs.statSync(part).size;
    if (expectedSize && size !== expectedSize) {
      throw new Error(`Size mismatch: got ${size} bytes, expected ${expectedSize}`);
    }
    fs.renameSync(part, dest);
    return size;
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

module.exports = { downloadTo, safeName };
