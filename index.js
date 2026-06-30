const express  = require('express');
const fetch    = require('node-fetch');
const ffmpeg   = require('fluent-ffmpeg');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { v4: uuidv4 } = require('uuid');
const crypto   = require('crypto');
const admin    = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Firebase Admin init ──────────────────────────────────────────────────
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — backfill endpoint disabled');
  }
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}

// R2 config
const R2_ACCOUNT_ID = 'e8409ad0379b3627b71fdab04c341444';
const R2_ACCESS_KEY = 'cc425bd21cd519d216183baf7ef11327';
const R2_SECRET_KEY = 'c744e387a602669921334bf3c62c7d724e859c86ceb7fa1a9d61b1a864de5287';
const R2_BUCKET     = 'laugh';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const CDN_BASE      = 'https://cdn.laughclip.online';

// AWS Signature V4
function sign(key, msg, binary = false) {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(msg);
  return binary ? hmac.digest() : hmac.digest('hex');
}

async function uploadToR2(filePath, r2Key, contentType = 'video/mp4') {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const host      = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const fileBytes = fs.readFileSync(filePath);
  const payHash   = crypto.createHash('sha256').update(fileBytes).digest('hex');

  const hdrs = {
    'content-type':         contentType,
    'host':                 host,
    'x-amz-content-sha256': payHash,
    'x-amz-date':           amzDate,
  };

  const keys      = Object.keys(hdrs).sort();
  const canonHdrs = keys.map(k => `${k}:${hdrs[k]}`).join('\n') + '\n';
  const signedH   = keys.join(';');
  const credScope = `${dateStamp}/auto/s3/aws4_request`;

  const canonReq  = ['PUT', `/${R2_BUCKET}/${r2Key}`, '', canonHdrs, signedH, payHash].join('\n');
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');

  const kDate    = sign(Buffer.from('AWS4' + R2_SECRET_KEY), dateStamp, true);
  const kRegion  = sign(kDate, 'auto', true);
  const kService = sign(kRegion, 's3', true);
  const kSigning = sign(kService, 'aws4_request', true);
  const sig      = sign(kSigning, strToSign);

  const auth = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credScope}, SignedHeaders=${signedH}, Signature=${sig}`;

  const resp = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${r2Key}`, {
    method: 'PUT',
    body:   fileBytes,
    headers: {
      'Authorization': auth, 'Content-Type': contentType,
      'Host': host, 'x-amz-content-sha256': payHash,
      'x-amz-date': amzDate, 'Content-Length': String(fileBytes.length),
    }
  });

  if (resp.status !== 200 && resp.status !== 201) {
    const txt = await resp.text();
    throw new Error(`R2 upload failed: ${resp.status} - ${txt}`);
  }
  return `${CDN_BASE}/${r2Key}`;
}

async function downloadFile(url, dest) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'LaughClip-Mixer/1.0' },
    timeout: 60000,
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} for ${url}`);
  const buf = await resp.buffer();
  fs.writeFileSync(dest, buf);
}

async function generateThumbForVideo(videoUrl) {
  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_v.mp4`);
  const thumbPath = path.join(tmpDir, `${id}_thumb.jpg`);

  try {
    await downloadFile(videoUrl, videoPath);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['00:00:01'],
          filename:   path.basename(thumbPath),
          folder:     tmpDir,
          size:       '360x640',
        })
        .on('end', resolve)
        .on('error', reject);
    });

    const videoKey = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key    = videoKey.replace(/\.mp4$/, '_thumb.jpg');
    const thumbUrl = await uploadToR2(thumbPath, r2Key, 'image/jpeg');

    [videoPath, thumbPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return thumbUrl;
  } catch (err) {
    [videoPath, thumbPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    throw err;
  }
}

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'laughclip-mixer', firebaseReady: !!db });
});

// POST /mix
app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl, volume = 0.8 } = req.body;
  console.log('[MIX] Request:', { videoUrl, audioUrl, volume });

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }

  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_v.mp4`);
  const audioPath = path.join(tmpDir, `${id}_a.mp4`);
  const outPath   = path.join(tmpDir, `${id}_out.mp4`);

  try {
    console.log('[MIX] Downloading video...');
    await downloadFile(videoUrl, videoPath);

    console.log('[MIX] Downloading audio...');
    await downloadFile(audioUrl, audioPath);

    const vSize = fs.statSync(videoPath).size;
    const aSize = fs.statSync(audioPath).size;
    console.log(`[MIX] Video: ${vSize} bytes, Audio: ${aSize} bytes`);

    console.log('[MIX] Running FFmpeg...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          `[0:a]volume=0.3[va]`,
          `[1:a]volume=${volume},apad[sa]`,
          `[va][sa]amix=inputs=2:duration=first:dropout_transition=2[aout]`
        ])
        .outputOptions([
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-shortest',
          '-movflags', '+faststart',
        ])
        .output(outPath)
        .on('start', cmd => console.log('[FFmpeg]', cmd))
        .on('end', () => { console.log('[MIX] FFmpeg done'); resolve(); })
        .on('error', (err) => { console.error('[MIX] FFmpeg error:', err); reject(err); })
        .run();
    });

    const outSize = fs.statSync(outPath).size;
    console.log(`[MIX] Output: ${outSize} bytes`);

    const videoKey  = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key     = videoKey.replace(/\.mp4$/, `_mix_${id.slice(0,8)}.mp4`);
    console.log('[MIX] Uploading to R2:', r2Key);

    const mixedUrl  = await uploadToR2(outPath, r2Key);
    console.log('[MIX] Done:', mixedUrl);

    [videoPath, audioPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

    return res.json({ status: 'success', mixedUrl });

  } catch (err) {
    console.error('[MIX] Error:', err.message);
    [videoPath, audioPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return res.status(500).json({ error: err.message });
  }
});

// POST /thumbnail
app.post('/thumbnail', async (req, res) => {
  const { videoUrl } = req.body;
  console.log('[THUMB] Request:', videoUrl);

  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  try {
    const thumbUrl = await generateThumbForVideo(videoUrl);
    console.log('[THUMB] Done:', thumbUrl);
    return res.json({ status: 'success', thumbUrl });
  } catch (err) {
    console.error('[THUMB] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /compress
app.post('/compress', async (req, res) => {
  const { videoUrl, outputKey } = req.body;
  console.log('[COMPRESS] Request:', videoUrl);

  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  const tmpDir     = os.tmpdir();
  const id         = uuidv4();
  const inputPath  = path.join(tmpDir, `${id}_input.mp4`);
  const outputPath = path.join(tmpDir, `${id}_compressed.mp4`);

  try {
    console.log('[COMPRESS] Downloading...');
    await downloadFile(videoUrl, inputPath);
    const originalSize = fs.statSync(inputPath).size;
    console.log(`[COMPRESS] Original: ${(originalSize/1024/1024).toFixed(2)} MB`);

    console.log('[COMPRESS] Running FFmpeg compression...');
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-vf', 'scale=720:-2',
          '-crf', '26',
          '-preset', 'fast',
          '-b:v', '1500k',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-r', '30',
          '-g', '60',
          '-sc_threshold', '0',
        ])
        .output(outputPath)
        .on('start', cmd => console.log('[FFmpeg compress]', cmd))
        .on('end', () => { console.log('[COMPRESS] Done'); resolve(); })
        .on('error', err => { console.error('[COMPRESS] Error:', err); reject(err); })
        .run();
    });

    const compressedSize = fs.statSync(outputPath).size;
    const reduction = (((originalSize - compressedSize) / originalSize) * 100).toFixed(1);
    console.log(`[COMPRESS] Result: ${(compressedSize/1024/1024).toFixed(2)} MB (${reduction}% smaller)`);

    const videoKey  = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key     = outputKey || videoKey.replace(/\.mp4$/, `_hq.mp4`);
    console.log('[COMPRESS] Uploading to R2:', r2Key);

    const compressedUrl  = await uploadToR2(outputPath, r2Key);
    console.log('[COMPRESS] Done:', compressedUrl);

    const originalKey = videoUrl.replace(CDN_BASE + '/', '');
    if (originalKey !== r2Key) {
      try {
        // best-effort delete handled elsewhere; skipped here for backfill safety
      } catch (e) {}
    }

    [inputPath, outputPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

    return res.json({
      status: 'success',
      compressedUrl,
      originalSize,
      compressedSize,
      reduction: `${reduction}%`,
    });

  } catch (err) {
    console.error('[COMPRESS] Error:', err.message);
    [inputPath, outputPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /backfill-thumbnails ────────────────────────────────────────────
// One-time job: scan all `clips` docs missing thumbnailUrl, generate + save.
// Protected by a simple shared-secret query param to avoid accidental triggers.
let backfillRunning = false;
let backfillProgress = { total: 0, done: 0, failed: 0, skipped: 0 };

app.post('/backfill-thumbnails', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase Admin not initialized' });
  if (backfillRunning) {
    return res.json({ status: 'already_running', progress: backfillProgress });
  }

  const secret = req.query.secret || req.body.secret;
  if (secret !== 'laughclip2026') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  backfillRunning = true;
  backfillProgress = { total: 0, done: 0, failed: 0, skipped: 0 };

  // Respond immediately, run in background
  res.json({ status: 'started', message: 'Backfill running in background. Poll /backfill-status for progress.' });

  try {
    const snapshot = await db.collection('clips').get();
    const docs = snapshot.docs.filter(doc => {
      const data = doc.data();
      return !data.thumbnailUrl || data.thumbnailUrl === '';
    });

    backfillProgress.total = docs.length;
    console.log(`[BACKFILL] Found ${docs.length} clips missing thumbnails`);

    for (const doc of docs) {
      const data = doc.data();
      const videoUrl = data.url;

      if (!videoUrl || !videoUrl.includes('cdn.laughclip.online')) {
        backfillProgress.skipped++;
        console.log(`[BACKFILL] Skipped ${doc.id} - no valid R2 url`);
        continue;
      }

      try {
        const thumbUrl = await generateThumbForVideo(videoUrl);
        await db.collection('clips').doc(doc.id).update({ thumbnailUrl: thumbUrl });
        backfillProgress.done++;
        console.log(`[BACKFILL] ✅ ${doc.id} -> ${thumbUrl} (${backfillProgress.done}/${backfillProgress.total})`);
      } catch (e) {
        backfillProgress.failed++;
        console.error(`[BACKFILL] ❌ ${doc.id} failed: ${e.message}`);
      }
    }

    console.log('[BACKFILL] Complete:', backfillProgress);
  } catch (e) {
    console.error('[BACKFILL] Fatal error:', e.message);
  } finally {
    backfillRunning = false;
  }
});

app.get('/backfill-status', (req, res) => {
  res.json({ running: backfillRunning, progress: backfillProgress });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LaughClip Mixer running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
