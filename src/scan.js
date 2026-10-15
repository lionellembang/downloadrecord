/**
 * One scan: walk period → components → classes → sessions → resources over the
 * LMS API, record every recording and material file, and download the material
 * files that aren't on disk yet.
 *
 * Recordings: only sessions that had a Zoom meeting can have one. A 404 from the
 * recording endpoint means "not ready yet" (they appear some days after class),
 * so those are re-checked every scan. Recording links are never stored; the web
 * UI fetches a fresh one (~12h) when you open it.
 *
 * Materials: Document / PDF / Archive resources. Their detail call returns a
 * ~6h pre-signed blob URL, fetched right before each download.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const lms = require('./lms');
const store = require('./store');
const { downloadTo, safeName } = require('./download');

const MATERIAL_TYPES = new Set(['document', 'pdf', 'archive']);

let running = null;

/** Run a scan; if one is already running, return that one. */
function runScan() {
  if (running) return running;
  running = scan().finally(() => {
    running = null;
  });
  return running;
}

const isScanning = () => !!running;

async function scan() {
  const startedAt = Date.now();
  console.log('=== scan start', new Date().toISOString(), '===');
  config.ensureDirs();
  const summary = { periods: [], classes: 0, sessions: 0, recordings: { new: 0, notYet: 0 }, materials: { downloaded: 0, failed: 0 } };

  for (const period of await resolvePeriods()) {
    summary.periods.push(period);
    for (const component of (await lms.classComponents(period)) || []) {
      for (const cls of (await lms.classes(period, component)) || []) {
        summary.classes++;
        await scanClass(period, component, cls, summary);
      }
    }
  }

  store.setMeta('last_scan', new Date().toISOString());
  summary.ms = Date.now() - startedAt;
  console.log(`✓ scan done in ${summary.ms}ms: ${JSON.stringify(summary)}`);
  return summary;
}

/** PERIODS from .env, or the currently active period. */
async function resolvePeriods() {
  if (config.periods.length) return config.periods;
  const all = (await lms.academicPeriods()) || [];
  const active = all.find((p) => p.isActiveRunningPeriod) || all.find((p) => p.isRunningPeriod);
  if (!active) throw new Error('No active academic period found — set PERIODS in .env.');
  return [active.academicPeriod];
}

async function scanClass(period, component, cls, summary) {
  const detail = await lms.classDetail(cls.classId);
  const base = {
    period,
    classId: cls.classId,
    courseCode: detail.courseCode || cls.courseCode,
    courseTitle: detail.courseTitleEn || cls.courseName,
    component,
    classCode: detail.classCode || cls.classCode,
  };

  for (const s of detail.sessions || []) {
    if (new Date(s.dateEnd) > new Date()) continue; // hasn't happened yet
    summary.sessions++;
    const sd = await lms.sessionDetail(s.id);
    const ctx = {
      ...base,
      sessionId: s.id,
      sessionNumber: Number(s.classSessionNumber),
      sessionDate: sd.dateStart || s.dateEnd,
    };
    await trackRecording(ctx, sd, summary);
    if (config.downloadMaterials) await collectMaterials(ctx, sd, summary);
  }
}

async function trackRecording(ctx, sd, summary) {
  if (!sd.joinUrl || sd.deliveryMode === 'GSLC') return; // no meeting → no recording
  const id = `recording:${ctx.sessionId}`;
  const known = store.getItem(id);
  if (known && known.status !== 'not_yet') return; // already found

  const rec = await lms.zoomRecording(ctx.sessionId);
  const status = store.upsertItem(
    { ...ctx, id, kind: 'recording', title: `Session ${ctx.sessionNumber} recording` },
    rec && rec.recordingUrl ? 'available' : 'not_yet'
  );
  if (status === 'available') {
    summary.recordings.new++;
    console.log(`  + recording: ${ctx.courseCode} ${ctx.component} session ${ctx.sessionNumber}`);
  } else summary.recordings.notYet++;
}

async function collectMaterials(ctx, sd, summary) {
  for (const r of sd.resources || []) {
    if (!MATERIAL_TYPES.has(String(r.resourceType).toLowerCase())) continue;
    const id = `material:${r.id}`;
    store.upsertItem({ ...ctx, id, kind: 'material', resourceId: r.id, title: r.name }, 'available');

    const item = store.getItem(id);
    if (item.status === 'downloaded' && item.file_path && fs.existsSync(path.join(config.downloadDir, item.file_path))) continue;

    try {
      const res = await lms.resourceDetail(ctx.sessionId, r.id);
      if (!res || !res.url) throw new Error('No download URL for this resource.');
      const fileName = safeName(decodeURIComponent(path.posix.basename(new URL(res.url).pathname)) || r.name);
      const rel = path.join(
        safeName(ctx.period),
        safeName(`${ctx.courseCode} ${ctx.courseTitle} (${ctx.component})`),
        safeName(`S${String(ctx.sessionNumber).padStart(2, '0')}`),
        fileName
      );
      const size = await downloadTo(res.url, rel, { expectedSize: res.contentLength || undefined });
      store.markDownloaded(id, rel, size);
      summary.materials.downloaded++;
      console.log(`  ↓ ${rel} (${size} B)`);
    } catch (err) {
      store.markFailed(id, err.message);
      summary.materials.failed++;
      console.error(`  ✗ ${ctx.courseCode} S${ctx.sessionNumber} "${r.name}": ${err.message}`);
    }
  }
}

module.exports = { runScan, isScanning };
